export function widgetSyncKey(widget) {
    return widget.dataset.widgetFrontendSyncKey || '';
}

export function syncedWidgetsFor(widget, selector = '.widget') {
    const syncKey = widgetSyncKey(widget);
    if (!syncKey) return [widget];

    return [...document.querySelectorAll(`${selector}[data-widget-frontend-sync-key]`)].filter((other) => widgetSyncKey(other) === syncKey);
}

export function setupFrontendWidgetSync() {
    const widgets = document.querySelectorAll('.widget[data-widget-frontend-sync-key]');
    const keyCounts = {};

    for (let i = 0; i < widgets.length; i++) {
        const key = widgetSyncKey(widgets[i]);
        keyCounts[key] = (keyCounts[key] || 0) + 1;
    }

    for (let i = 0; i < widgets.length; i++) {
        const key = widgetSyncKey(widgets[i]);
        if (keyCounts[key] < 2) widgets[i].removeAttribute('data-widget-frontend-sync-key');
    }
}
