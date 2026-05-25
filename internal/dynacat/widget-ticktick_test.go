package dynacat

import "testing"

func TestTickTickTaskPopoverShowsSubtasks(t *testing.T) {
	widget := &ticktickWidget{}
	task := ticktickTask{Items: []ticktickChecklist{{Title: "Subtask"}}}

	if !widget.ShouldShowTaskPopover(task) {
		t.Fatal("expected task with subtasks to show popover")
	}
}

func TestSortTickTickTasksMatchesTickTickSortOrder(t *testing.T) {
	tasks := sortTicktickTasks([]ticktickTask{
		{ID: "second", SortOrder: -3298534883328},
		{ID: "first", SortOrder: -2199023255552},
	})

	if tasks[0].ID != "first" || tasks[1].ID != "second" {
		t.Fatalf("unexpected order: %s, %s", tasks[0].ID, tasks[1].ID)
	}
}

func TestTickTickLocationFromDatedTasksUsesDatedTaskTimezone(t *testing.T) {
	location, ok := ticktickLocationFromDatedTasks([]ticktickTask{
		{Title: "Welcome", TimeZone: "Asia/Shanghai"},
		{Title: "User task", StartDate: "2026-05-24T20:00:00.000+0000", TimeZone: "Asia/Tbilisi"},
	})

	if !ok {
		t.Fatal("expected location")
	}
	if location.String() != "Asia/Tbilisi" {
		t.Fatalf("unexpected location: %s", location)
	}
}
