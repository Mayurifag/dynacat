import { syncedWidgetsFor } from './widget-sync.js';
import { widgetActionURL, widgetById } from './utils.js';

let tickTickPageData = null;
let tickTickApplyWidgetUpdate = null;
let tickTickInitialized = false;
const tickTickActionQueues = new Map();

async function postTickTickAction(widget, actionParts, body) {
    try {
        const response = await fetch(widgetActionURL(tickTickPageData.baseURL, widget.dataset.widgetId, ...actionParts), {
            method: 'POST',
            headers: body ? { 'Content-Type': 'application/json' } : undefined,
            body: body ? JSON.stringify(body) : undefined,
        });
        if (!response.ok) return null;
        return await response.text();
    } catch (_) {
        return null;
    }
}

function tickTickWidgetForAction(actionTarget) {
    const widget = actionTarget.closest('.widget-type-ticktick');
    if (widget) return widget;

    const widgetId = actionTarget.dataset.widgetId;
    if (!widgetId) return null;

    const targetWidget = widgetById(widgetId);
    if (!targetWidget || !targetWidget.classList.contains('widget-type-ticktick')) return null;
    return targetWidget;
}

function applySyncedTickTickHTML(widgets, html) {
    const inputStates = widgets.map(function (widget) {
        const input = tickTickAddInput(widget);
        return {
            widgetId: widget.dataset.widgetId,
            value: input ? input.value : null,
            focused: input === document.activeElement,
            selectionStart: input ? input.selectionStart : null,
            selectionEnd: input ? input.selectionEnd : null,
            selectionDirection: input ? input.selectionDirection : null,
        };
    });

    widgets.forEach((widget) => tickTickApplyWidgetUpdate(widget.dataset.widgetId, html));

    inputStates.forEach(function (state) {
        if (state.value == null) return;

        const widget = widgetById(state.widgetId);
        if (!widget) return;

        const input = tickTickAddInput(widget);
        if (!input) return;

        input.value = state.value;
        if (!state.focused) return;

        input.focus();
        input.setSelectionRange(state.selectionStart, state.selectionEnd, state.selectionDirection);
    });
}

function tickTickQueueKey(widget) {
    return widget.dataset.widgetFrontendSyncKey || `widget:${widget.dataset.widgetId}`;
}

function tickTickLiveWidgets(widgets) {
    return widgets.map(function (widget) {
        return widgetById(widget.dataset.widgetId);
    }).filter(Boolean);
}

function queueTickTickAction(widget, syncedWidgets, action, optimisticAction) {
    const key = tickTickQueueKey(widget);
    let queue = tickTickActionQueues.get(key);
    const entry = {
        rollback: optimisticAction(syncedWidgets),
        replay: function () {
            return optimisticAction(tickTickLiveWidgets(syncedWidgets));
        }
    };

    if (!queue) {
        queue = { tail: Promise.resolve(), entries: [] };
        tickTickActionQueues.set(key, queue);
    }

    queue.entries.push(entry);
    queue.tail = queue.tail.catch(function () {}).then(function () {
        return Promise.resolve().then(action).catch(function () { return null; }).then(function (html) {
            const entryIndex = queue.entries.indexOf(entry);
            if (entryIndex !== -1) queue.entries.splice(entryIndex, 1);

            if (html == null) {
                entry.rollback();
                return;
            }

            const pendingEntries = queue.entries.slice();
            pendingEntries.forEach(function (entry) {
                if (entry.rollback.revert) entry.rollback.revert();
                else entry.rollback();
            });
            applySyncedTickTickHTML(syncedWidgets, html);
            pendingEntries.forEach(function (entry) { entry.rollback = entry.replay(); });
        }).then(function () {
            if (queue.entries.length === 0) tickTickActionQueues.delete(key);
        });
    });
}

function tickTickList(widget) {
    return widget.querySelector('.ticktick-list');
}

function tickTickContainer(widget) {
    return widget.querySelector('.ticktick');
}

function rollbackAll(rollbacks) {
    return function () {
        rollbacks.forEach(function (rollback) { rollback(); });
    };
}

function optimisticAcrossWidgets(widgets, action) {
    return rollbackAll(widgets.map(action));
}

function tickTickTaskElement(widget, projectId, taskId) {
    const elements = widget.querySelectorAll('[data-project-id][data-task-id]');
    for (let i = 0; i < elements.length; i++) {
        if (elements[i].dataset.projectId === projectId && elements[i].dataset.taskId === taskId) {
            return elements[i].closest('.ticktick-task');
        }
    }
    return null;
}

function tickTickTitleInput(widget, projectId, taskId) {
    const inputs = widget.querySelectorAll('[data-ticktick-title]');
    for (let i = 0; i < inputs.length; i++) {
        if (inputs[i].dataset.projectId === projectId && inputs[i].dataset.taskId === taskId) return inputs[i];
    }
    return null;
}

function tickTickAddInput(widget) {
    const liveWidget = widgetById(widget.dataset.widgetId) || widget;
    const form = liveWidget.querySelector('[data-ticktick-add]');
    return form ? form.elements.title : null;
}

function tickTickSubtaskButton(widget, projectId, taskId, itemId) {
    const buttons = widget.querySelectorAll('[data-ticktick-action="complete-item"]');
    for (let i = 0; i < buttons.length; i++) {
        if (buttons[i].dataset.projectId === projectId && buttons[i].dataset.taskId === taskId && buttons[i].dataset.itemId === itemId) return buttons[i];
    }
    return null;
}

function optimisticRemove(element) {
    if (!element) return function () {};

    const marker = document.createComment('');

    element.after(marker);
    element.remove();

    const rollback = function () {
        if (marker.parentNode) marker.parentNode.insertBefore(element, marker);
        marker.remove();
    };
    return rollback;
}

function optimisticCompleteTask(element) {
    return optimisticRemove(element);
}

function optimisticCompleteItem(button) {
    if (!button) return function () {};

    const item = button.closest('.ticktick-popover-subtask');
    if (!item) return function () {};

    button.hidden = true;
    item.classList.add('ticktick-popover-subtask-done', 'ticktick-pending');

    const rollback = function () {
        button.hidden = false;
        item.classList.remove('ticktick-popover-subtask-done', 'ticktick-pending');
    };
    return rollback;
}

function optimisticAddTask(widget, title) {
    const container = tickTickContainer(widget);
    if (!container) return function () {};

    let list = tickTickList(widget);
    const empty = widget.querySelector('.ticktick-empty');

    if (!list) {
        list = document.createElement('ul');
        list.className = 'ticktick-list';
        container.appendChild(list);
        if (empty) empty.hidden = true;
    }

    const task = document.createElement('li');
    task.className = 'ticktick-task ticktick-pending';
    task.innerHTML = '<div class="ticktick-task-row"><button type="button" class="ticktick-check" disabled></button><div class="ticktick-task-body"><input class="ticktick-title" disabled></div></div>';
    task.querySelector('.ticktick-title').value = title;
    list.appendChild(task);

    const rollback = function () {
        task.remove();
        if (empty && list.children.length === 0) empty.hidden = false;
        if (list.children.length === 0) list.remove();
    };
    return rollback;
}

function optimisticUpdateTitle(widgets, input, title, originalTitle) {
    return rollbackAll(widgets.map(function (widget) {
        const syncedInput = tickTickTitleInput(widget, input.dataset.projectId, input.dataset.taskId);
        if (!syncedInput) return function () {};

        const previousTitle = syncedInput === input ? originalTitle : syncedInput.value;
        const task = syncedInput.closest('.ticktick-task');
        syncedInput.value = title;
        if (task) task.classList.add('ticktick-pending');

        const rollback = function () {
            syncedInput.value = previousTitle;
            if (task) task.classList.remove('ticktick-pending');
        };
        return rollback;
    }));
}

function submitTickTickTitle(input) {
    const widget = tickTickWidgetForAction(input);
    if (!widget) return;

    const title = input.value.trim();
    const originalTitle = input.dataset.originalTitle || input.defaultValue;

    if (!title) {
        input.value = originalTitle;
        return;
    }

    if (title === originalTitle) return;

    const syncedWidgets = syncedWidgetsFor(widget, '.widget-type-ticktick');
    queueTickTickAction(widget, syncedWidgets, function () {
        return postTickTickAction(widget, ['update', input.dataset.projectId, input.dataset.taskId], { title: title });
    }, function (widgets) {
        return optimisticUpdateTitle(widgets, input, title, originalTitle);
    });
}

export function setupTickTick(pageData, applyWidgetUpdate) {
    tickTickPageData = pageData;
    tickTickApplyWidgetUpdate = applyWidgetUpdate;

    if (tickTickInitialized) return;
    tickTickInitialized = true;

    document.addEventListener('click', function (event) {
        const actionTarget = event.target.closest('[data-ticktick-action]');
        if (!actionTarget) return;

        const widget = tickTickWidgetForAction(actionTarget);
        if (!widget) return;

        event.preventDefault();
        const syncedWidgets = syncedWidgetsFor(widget, '.widget-type-ticktick');

        if (actionTarget.dataset.ticktickAction === 'complete') {
            queueTickTickAction(widget, syncedWidgets, function () {
                return postTickTickAction(widget, ['complete', actionTarget.dataset.projectId, actionTarget.dataset.taskId]);
            }, function (widgets) {
                return optimisticAcrossWidgets(widgets, function (widget) {
                    return optimisticCompleteTask(tickTickTaskElement(widget, actionTarget.dataset.projectId, actionTarget.dataset.taskId));
                });
            });
            return;
        }

        if (actionTarget.dataset.ticktickAction === 'complete-item') {
            queueTickTickAction(widget, syncedWidgets, function () {
                return postTickTickAction(widget, ['complete-item', actionTarget.dataset.projectId, actionTarget.dataset.taskId, actionTarget.dataset.itemId]);
            }, function (widgets) {
                return optimisticAcrossWidgets(widgets, function (widget) {
                    return optimisticCompleteItem(tickTickSubtaskButton(widget, actionTarget.dataset.projectId, actionTarget.dataset.taskId, actionTarget.dataset.itemId));
                });
            });
            return;
        }

        if (actionTarget.dataset.ticktickAction === 'delete') {
            queueTickTickAction(widget, syncedWidgets, function () {
                return postTickTickAction(widget, ['delete', actionTarget.dataset.projectId, actionTarget.dataset.taskId]);
            }, function (widgets) {
                return optimisticAcrossWidgets(widgets, function (widget) {
                    return optimisticRemove(tickTickTaskElement(widget, actionTarget.dataset.projectId, actionTarget.dataset.taskId));
                });
            });
            return;
        }
    });

    document.addEventListener('focusin', function (event) {
        const input = event.target.closest('[data-ticktick-title]');
        if (!input) return;
        input.dataset.originalTitle = input.value;
    });

    document.addEventListener('keydown', function (event) {
        const input = event.target.closest('[data-ticktick-title]');
        if (!input) return;

        if (event.key === 'Enter') {
            event.preventDefault();
            input.blur();
            return;
        }

        if (event.key === 'Escape') {
            event.preventDefault();
            input.value = input.dataset.originalTitle || input.defaultValue;
            input.blur();
        }
    });

    document.addEventListener('change', function (event) {
        const input = event.target.closest('[data-ticktick-title]');
        if (!input) return;
        submitTickTickTitle(input);
    });

    document.addEventListener('submit', function (event) {
        const form = event.target.closest('[data-ticktick-add]');
        if (!form) return;

        event.preventDefault();
        const input = form.elements.title;
        const title = input.value.trim();
        if (!title) return;

        const widget = form.closest('.widget-type-ticktick');
        if (!widget) return;

        const syncedWidgets = syncedWidgetsFor(widget, '.widget-type-ticktick');
        input.value = '';

        queueTickTickAction(widget, syncedWidgets, function () {
            return postTickTickAction(widget, ['add'], { title: title });
        }, function (widgets) {
            const rollback = optimisticAcrossWidgets(widgets, function (widget) {
                return optimisticAddTask(widget, title);
            });
            const failureRollback = function () {
                rollback();
                const liveInput = tickTickAddInput(widget);
                if (liveInput && liveInput.value === '') liveInput.value = title;
                else if (!liveInput && input.value === '') input.value = title;
            };
            failureRollback.revert = rollback;
            return failureRollback;
        });
    });
}
