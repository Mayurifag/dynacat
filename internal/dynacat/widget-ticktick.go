package dynacat

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"html/template"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
)

var ticktickWidgetTemplate = mustParseTemplate("ticktick.html", "widget-base.html")

const ticktickAPIBaseURL = "https://api.ticktick.com"

var ticktickTasksCache = newWidgetResultCache[[]ticktickTask]()

type ticktickWidget struct {
	widgetBase   `yaml:",inline"`
	Frameless    bool           `yaml:"frameless"`
	AccessToken  string         `yaml:"access-token"`
	AddProjectID string         `yaml:"add-project-id"`
	Show         string         `yaml:"show"`
	Tasks        []ticktickTask `yaml:"-"`
	location     *time.Location
}

type ticktickProject struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Closed bool   `json:"closed"`
	Kind   string `json:"kind"`
}

type ticktickTaskFilter struct {
	ProjectIDs []string `json:"projectIds,omitempty"`
	StartDate  string   `json:"startDate,omitempty"`
	EndDate    string   `json:"endDate,omitempty"`
	Status     []int    `json:"status,omitempty"`
}

type ticktickTask struct {
	ID            string              `json:"id"`
	ProjectID     string              `json:"projectId"`
	ParentID      string              `json:"parentId,omitempty"`
	Title         string              `json:"title"`
	Content       string              `json:"content,omitempty"`
	Desc          string              `json:"desc,omitempty"`
	IsAllDay      bool                `json:"isAllDay,omitempty"`
	StartDate     string              `json:"startDate,omitempty"`
	DueDate       string              `json:"dueDate,omitempty"`
	TimeZone      string              `json:"timeZone,omitempty"`
	RepeatFlag    string              `json:"repeatFlag,omitempty"`
	Reminders     []string            `json:"reminders,omitempty"`
	Tags          []string            `json:"tags,omitempty"`
	Priority      int                 `json:"priority,omitempty"`
	Status        int                 `json:"status"`
	CompletedTime string              `json:"completedTime,omitempty"`
	SortOrder     int64               `json:"sortOrder,omitempty"`
	Items         []ticktickChecklist `json:"items,omitempty"`
	Kind          string              `json:"kind,omitempty"`
}

type ticktickChecklist struct {
	ID            string `json:"id,omitempty"`
	Status        int    `json:"status"`
	Title         string `json:"title"`
	SortOrder     int64  `json:"sortOrder,omitempty"`
	StartDate     string `json:"startDate,omitempty"`
	IsAllDay      bool   `json:"isAllDay,omitempty"`
	TimeZone      string `json:"timeZone,omitempty"`
	CompletedTime string `json:"completedTime,omitempty"`
}

func (widget *ticktickWidget) initialize() error {
	widget.withTitle("TickTick").withCacheDuration(5 * time.Minute)

	if widget.AccessToken == "" {
		return errors.New("access-token is required")
	}
	if widget.Show == "" {
		widget.Show = "today"
	}
	if widget.Show != "today" && widget.Show != "inbox" {
		return errors.New("show must be either \"today\" or \"inbox\"")
	}

	widget.frontendSyncKey = widget.clientSyncKey()

	if widget.UpdateInterval == nil {
		interval := updateIntervalField(5 * time.Minute)
		widget.UpdateInterval = &interval
	}

	if *widget.UpdateInterval <= 0 {
		return errors.New("update-interval must be greater than 0")
	}

	return nil
}

func (widget *ticktickWidget) update(ctx context.Context) {
	location, err := widget.ticktickLocation(ctx)
	if !widget.canContinueUpdateAfterHandlingErr(err) {
		return
	}
	widget.location = location

	tasks, err := ticktickTasksCache.GetForWidget(ctx, &widget.widgetBase, widget.tasksCacheKey(), widget.fetchTasks)
	if !widget.canContinueUpdateAfterHandlingErr(err) {
		return
	}

	widget.Tasks = tasks
}

func (widget *ticktickWidget) Render() template.HTML {
	return widget.renderTemplate(widget, ticktickWidgetTemplate)
}

func (widget *ticktickWidget) ShouldShowTaskPopover(task ticktickTask) bool {
	return task.Content != "" || task.Desc != "" || len(task.Items) > 0
}

func (widget *ticktickWidget) EmptyMessage() string {
	if widget.Show == "inbox" {
		return "No open inbox tasks"
	}

	return "Nothing scheduled today"
}

func (widget *ticktickWidget) handleRequest(w http.ResponseWriter, r *http.Request) {
	action := r.PathValue("action")
	parts := strings.Split(strings.Trim(action, "/"), "/")

	switch {
	case len(parts) == 3 && parts[0] == "complete":
		if err := widget.completeTask(r.Context(), parts[1], parts[2]); err != nil {
			http.Error(w, "complete failed", http.StatusInternalServerError)
			return
		}
		widget.writeActionResponse(w, r)

	case len(parts) == 4 && parts[0] == "complete-item":
		if err := widget.completeChecklistItem(r.Context(), parts[1], parts[2], parts[3]); err != nil {
			http.Error(w, "complete failed", http.StatusInternalServerError)
			return
		}
		widget.writeActionResponse(w, r)

	case len(parts) == 3 && parts[0] == "update":
		title, ok := readTicktickTaskTitle(w, r)
		if !ok {
			return
		}
		if err := widget.updateTaskTitle(r.Context(), parts[1], parts[2], title); err != nil {
			http.Error(w, "update failed", http.StatusInternalServerError)
			return
		}
		widget.writeActionResponse(w, r)

	case len(parts) == 3 && parts[0] == "delete":
		if err := widget.deleteTask(r.Context(), parts[1], parts[2]); err != nil {
			http.Error(w, "delete failed", http.StatusInternalServerError)
			return
		}
		widget.writeActionResponse(w, r)

	case len(parts) == 1 && parts[0] == "add":
		title, ok := readTicktickTaskTitle(w, r)
		if !ok {
			return
		}
		if err := widget.addTask(r.Context(), title); err != nil {
			http.Error(w, "add failed", http.StatusInternalServerError)
			return
		}
		widget.writeActionResponse(w, r)

	default:
		http.Error(w, "invalid action", http.StatusBadRequest)
	}
}

func readTicktickTaskTitle(w http.ResponseWriter, r *http.Request) (string, bool) {
	r.Body = http.MaxBytesReader(w, r.Body, 4096)
	var body struct {
		Title string `json:"title"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid body", http.StatusBadRequest)
		return "", false
	}
	title := strings.TrimSpace(body.Title)
	if title == "" {
		http.Error(w, "title is required", http.StatusBadRequest)
		return "", false
	}

	return title, true
}

func (widget *ticktickWidget) writeActionResponse(w http.ResponseWriter, r *http.Request) {
	ticktickTasksCache.Clear()
	widget.nextUpdate = time.Time{}
	widget.update(r.Context())
	w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Write([]byte(widget.Render()))
}

func (widget *ticktickWidget) ticktickRequest(ctx context.Context, method, path string, body any, out any) error {
	var bodyReader *bytes.Reader
	if body != nil {
		bodyBytes, err := json.Marshal(body)
		if err != nil {
			return err
		}
		bodyReader = bytes.NewReader(bodyBytes)
	} else {
		bodyReader = bytes.NewReader(nil)
	}

	req, err := http.NewRequestWithContext(ctx, method, ticktickAPIBaseURL+path, bodyReader)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+widget.AccessToken)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := defaultHTTPClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("ticktick returned status %d", resp.StatusCode)
	}

	if out == nil {
		return nil
	}

	return json.NewDecoder(resp.Body).Decode(out)
}

func (widget *ticktickWidget) fetchTasks(ctx context.Context) ([]ticktickTask, error) {
	location := widget.location
	if location == nil {
		return nil, errors.New("ticktick timezone is not available")
	}
	now := time.Now().In(location)
	start := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, location)
	end := start.AddDate(0, 0, 1).Add(-time.Second)
	filter := ticktickTaskFilter{
		Status: []int{0},
	}
	if widget.Show == "today" {
		filter.StartDate = formatTicktickTime(start)
		filter.EndDate = formatTicktickTime(end)
	} else if widget.Show == "inbox" && len(filter.ProjectIDs) == 0 {
		projectID, err := widget.addProjectID(ctx)
		if err != nil {
			return nil, err
		}
		filter.ProjectIDs = []string{projectID}
	}

	var tasks []ticktickTask
	if err := widget.ticktickRequest(ctx, http.MethodPost, "/open/v1/task/filter", filter, &tasks); err != nil {
		return nil, err
	}

	return sortTicktickTasks(tasks), nil
}

func (widget *ticktickWidget) clientSyncKey() string {
	return strings.Join([]string{
		"ticktick",
		hashString(widget.AccessToken),
		widget.Show,
		widget.AddProjectID,
	}, "|")
}

func (widget *ticktickWidget) tasksCacheKey() string {
	location := widget.location
	locationName := ""
	date := ""
	if location != nil {
		locationName = location.String()
		date = time.Now().In(location).Format("2006-01-02")
	}
	addProjectID := ""
	if widget.Show == "inbox" {
		addProjectID = widget.AddProjectID
	}
	return strings.Join([]string{
		hashString(widget.AccessToken),
		widget.Show,
		addProjectID,
		locationName,
		date,
	}, "|")
}

func sortTicktickTasks(tasks []ticktickTask) []ticktickTask {
	sort.SliceStable(tasks, func(i, j int) bool {
		return tasks[i].SortOrder > tasks[j].SortOrder
	})
	return tasks
}

func formatTicktickTime(t time.Time) string {
	return t.Format("2006-01-02T15:04:05-0700")
}

func ticktickLocationFromDatedTasks(tasks []ticktickTask) (*time.Location, bool) {
	for _, task := range tasks {
		if task.TimeZone != "" && (task.StartDate != "" || task.DueDate != "") {
			location, err := time.LoadLocation(task.TimeZone)
			if err == nil {
				return location, true
			}
		}
		for _, item := range task.Items {
			if item.TimeZone != "" && item.StartDate != "" {
				location, err := time.LoadLocation(item.TimeZone)
				if err == nil {
					return location, true
				}
			}
		}
	}

	return nil, false
}

func ticktickLocationFromTasks(tasks []ticktickTask) (*time.Location, bool) {
	for _, task := range tasks {
		if task.TimeZone != "" {
			location, err := time.LoadLocation(task.TimeZone)
			if err == nil {
				return location, true
			}
		}
		for _, item := range task.Items {
			if item.TimeZone != "" {
				location, err := time.LoadLocation(item.TimeZone)
				if err == nil {
					return location, true
				}
			}
		}
	}

	return nil, false
}

func (widget *ticktickWidget) ticktickLocation(ctx context.Context) (*time.Location, error) {
	var fallback *time.Location

	for _, filter := range []ticktickTaskFilter{
		{Status: []int{0}},
		{Status: []int{0, 2}},
		{},
	} {
		var tasks []ticktickTask
		if err := widget.ticktickRequest(ctx, http.MethodPost, "/open/v1/task/filter", filter, &tasks); err != nil {
			return nil, err
		}
		if location, ok := ticktickLocationFromDatedTasks(tasks); ok {
			return location, nil
		}
		if fallback == nil {
			if location, ok := ticktickLocationFromTasks(tasks); ok {
				fallback = location
			}
		}
	}

	var projects []ticktickProject
	if err := widget.ticktickRequest(ctx, http.MethodGet, "/open/v1/project", nil, &projects); err != nil {
		if fallback != nil {
			return fallback, nil
		}
		return nil, err
	}
	for _, project := range projects {
		var data struct {
			Tasks []ticktickTask `json:"tasks"`
		}
		path := "/open/v1/project/" + url.PathEscape(project.ID) + "/data"
		if err := widget.ticktickRequest(ctx, http.MethodGet, path, nil, &data); err != nil {
			continue
		}
		if location, ok := ticktickLocationFromDatedTasks(data.Tasks); ok {
			return location, nil
		}
		if fallback == nil {
			if location, ok := ticktickLocationFromTasks(data.Tasks); ok {
				fallback = location
			}
		}
	}

	if fallback != nil {
		return fallback, nil
	}

	return nil, errors.New("ticktick did not return a task timezone")
}

func (widget *ticktickWidget) completeTask(ctx context.Context, projectID, taskID string) error {
	path := "/open/v1/project/" + url.PathEscape(projectID) + "/task/" + url.PathEscape(taskID) + "/complete"
	return widget.ticktickRequest(ctx, http.MethodPost, path, nil, nil)
}

func (widget *ticktickWidget) updateTaskTitle(ctx context.Context, projectID, taskID, title string) error {
	var task ticktickTask
	path := "/open/v1/project/" + url.PathEscape(projectID) + "/task/" + url.PathEscape(taskID)
	if err := widget.ticktickRequest(ctx, http.MethodGet, path, nil, &task); err != nil {
		return err
	}
	task.Title = title
	return widget.ticktickRequest(ctx, http.MethodPost, "/open/v1/task/"+url.PathEscape(taskID), task, nil)
}

func (widget *ticktickWidget) deleteTask(ctx context.Context, projectID, taskID string) error {
	path := "/open/v1/project/" + url.PathEscape(projectID) + "/task/" + url.PathEscape(taskID)
	return widget.ticktickRequest(ctx, http.MethodDelete, path, nil, nil)
}

func (widget *ticktickWidget) completeChecklistItem(ctx context.Context, projectID, taskID, itemID string) error {
	location, err := widget.ticktickLocation(ctx)
	if err != nil {
		return err
	}
	widget.location = location

	var task ticktickTask
	path := "/open/v1/project/" + url.PathEscape(projectID) + "/task/" + url.PathEscape(taskID)
	if err := widget.ticktickRequest(ctx, http.MethodGet, path, nil, &task); err != nil {
		return err
	}

	found := false
	completedTime := formatTicktickTime(time.Now().In(widget.location))
	for i := range task.Items {
		if task.Items[i].ID == itemID {
			task.Items[i].Status = 1
			task.Items[i].CompletedTime = completedTime
			found = true
			break
		}
	}
	if !found {
		return errors.New("checklist item not found")
	}

	return widget.ticktickRequest(ctx, http.MethodPost, "/open/v1/task/"+url.PathEscape(taskID), task, nil)
}

func (widget *ticktickWidget) addTask(ctx context.Context, title string) error {
	location, err := widget.ticktickLocation(ctx)
	if err != nil {
		return err
	}
	widget.location = location

	projectID, err := widget.addProjectID(ctx)
	if err != nil {
		return err
	}

	now := time.Now().In(location)
	body := ticktickTask{
		Title:     title,
		ProjectID: projectID,
		IsAllDay:  true,
		StartDate: formatTicktickTime(now),
		DueDate:   formatTicktickTime(now),
		TimeZone:  location.String(),
		Status:    0,
	}
	return widget.ticktickRequest(ctx, http.MethodPost, "/open/v1/task", body, nil)
}

func (widget *ticktickWidget) addProjectID(ctx context.Context) (string, error) {
	if widget.AddProjectID != "" {
		return widget.AddProjectID, nil
	}

	var projects []ticktickProject
	if err := widget.ticktickRequest(ctx, http.MethodGet, "/open/v1/project", nil, &projects); err != nil {
		return "", err
	}

	for _, project := range projects {
		if !project.Closed && (project.Kind == "" || project.Kind == "TASK") && strings.EqualFold(project.Name, "Inbox") {
			return project.ID, nil
		}
	}

	var tasks []ticktickTask
	if err := widget.ticktickRequest(ctx, http.MethodPost, "/open/v1/task/filter", ticktickTaskFilter{Status: []int{0}}, &tasks); err != nil {
		return "", err
	}
	for _, task := range tasks {
		if strings.HasPrefix(strings.ToLower(task.ProjectID), "inbox") {
			return task.ProjectID, nil
		}
	}

	return "", errors.New("no inbox project found")
}
