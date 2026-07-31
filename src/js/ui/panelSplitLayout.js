// Keeps --chat-header-height in sync with the chat header's REAL rendered
// height (padding/font-size/zoom-dependent, not a fixed number) so the side
// panels (jobs-panel.css) can start their `top` right below it instead of
// overlapping it. A ResizeObserver (not a one-time read) because the header's
// height can change after load — e.g. Ctrl+wheel zoom (electron-preload.js)
// changes font sizes, and the sidebar-toggle button appears/disappears at the
// narrow-layout breakpoint (layout.css).
function initChatHeaderHeightSync() {
    const header = document.querySelector('.chat-header');
    if (!header) return;
    const apply = () => {
        document.documentElement.style.setProperty('--chat-header-height', header.getBoundingClientRect().height + 'px');
    };
    apply();
    if (typeof ResizeObserver !== 'undefined') {
        new ResizeObserver(apply).observe(header);
    } else {
        window.addEventListener('resize', apply);
    }
}
document.addEventListener('DOMContentLoaded', initChatHeaderHeightSync);

// Shared layout helper for the Processes and Web Tabs side panels: when both
// are open at once, split the same right-hand column vertically instead of
// doubling total width (web-tool-plan.md section 6.2). Called by each panel's
// open()/close(). Safe to call from either — it only ever reads both panels'
// current state and applies classes, never toggles them itself.
function syncPanelSplitLayout() {
    const processesPanel = document.getElementById('processesPanel');
    const webTabsPanel = document.getElementById('webTabsPanel');
    if (!processesPanel || !webTabsPanel) return;

    const processesOpen = processesPanel.classList.contains('panel-open');
    const webTabsOpen = webTabsPanel.classList.contains('panel-open');
    const bothOpen = processesOpen && webTabsOpen;

    processesPanel.classList.toggle('panel-split-top', bothOpen);
    processesPanel.classList.toggle('panel-split-bottom', false);
    webTabsPanel.classList.toggle('panel-split-bottom', bothOpen);
    webTabsPanel.classList.toggle('panel-split-top', false);
}
