// Web Tabs Panel - side panel listing browser_tab jobs for the current chat.
// Mirrors JobsPanel (Processes panel) closely — same polling/open/close/kill
// pattern — but rows show URL/title + a thumbnail, and add reveal/hide
// (show/focus or hide the tab's real window) alongside kill/close.
// See web-tool-plan.md sections 5, 6.

const WebTabsPanel = {
    _pollTimer: null,
    _pollIntervalMs: 2000,
    _isOpen: false,
    _thumbnailTimer: null,
    // jobId -> last-successful thumbnail data URI. Survives across _render
    // rebuilds (which fire on any job field change, e.g. title/url updating
    // as a page navigates — not just visual changes) so a row keeps showing
    // its last real preview instead of flashing back to "Loading preview…"
    // on every unrelated metadata update.
    _thumbCache: {},

    init() {
        const toggleBtn = document.getElementById('webTabsPanelToggleBtn');
        const closeBtn = document.getElementById('webTabsPanelCloseBtn');
        if (toggleBtn) toggleBtn.addEventListener('click', () => this.toggle());
        if (closeBtn) closeBtn.addEventListener('click', () => this.close());
        // Always poll so the header badge stays current even when the panel
        // is closed - refresh() gates the DOM rebuild and thumbnail fetches
        // on _isOpen, so the only work done while closed is the fetch + badge.
        this._startPolling();
    },

    toggle() {
        if (this._isOpen) this.close();
        else this.open();
    },

    open() {
        const panel = document.getElementById('webTabsPanel');
        const btn = document.getElementById('webTabsPanelToggleBtn');
        if (!panel) return;
        panel.classList.add('panel-open');
        panel.setAttribute('aria-hidden', 'false');
        if (btn) btn.classList.add('active');
        this._isOpen = true;
        this.refresh();
        if (typeof syncPanelSplitLayout === 'function') syncPanelSplitLayout();
    },

    close() {
        const panel = document.getElementById('webTabsPanel');
        const btn = document.getElementById('webTabsPanelToggleBtn');
        if (!panel) return;
        panel.classList.remove('panel-open');
        panel.setAttribute('aria-hidden', 'true');
        if (btn) btn.classList.remove('active');
        this._isOpen = false;
        if (typeof syncPanelSplitLayout === 'function') syncPanelSplitLayout();
    },

    _startPolling() {
        this._stopPolling();
        this._pollTimer = setInterval(() => this.refresh(), this._pollIntervalMs);
    },

    _stopPolling() {
        if (this._pollTimer) {
            clearInterval(this._pollTimer);
            this._pollTimer = null;
        }
    },

    async refresh() {
        if (!currentChatId) return;
        try {
            const res = await fetch(`/api/jobs?chat_id=${encodeURIComponent(currentChatId)}&type=browser_tab`);
            if (!res.ok) return;
            const data = await res.json();
            const jobs = data.jobs || [];
            // Always update the badge (even when closed) so the header
            // button reflects running tabs without needing the panel open.
            this._updateBadge(jobs);
            // Thumbnails and DOM rebuild only matter when the panel is
            // actually open - skip them while closed to avoid wasted work.
            if (!this._isOpen) return;
            // Always refresh thumbnails for running tabs on every poll -
            // decoupled from the DOM rebuild below so a visually-changing
            // page still gets a fresh preview even when no job metadata
            // (title/url/status/visible) changed. _refreshThumbnails swaps
            // the <img src> in place after a successful fetch, so the old
            // thumbnail stays visible until the new one is ready - no flash.
            const runningIds = jobs.filter(j => j.status === 'running').map(j => j.id);
            if (runningIds.length > 0) {
                this._refreshThumbnails(runningIds);
            }
            // Skip the DOM rebuild when nothing actually changed since the last
            // poll — without this, every 2s tick nukes the row list (losing
            // hover state, in-progress clicks, etc.) even when idle. Signature
            // covers everything a row renders, so a real change is never missed.
            const signature = JSON.stringify(jobs.map(j => [j.id, j.status, j.startedBy, j.killedBy, j.meta?.title, j.meta?.url, j.meta?.visible]));
            if (signature === this._lastSignature) return;
            this._lastSignature = signature;
            this._render(jobs, data.other_running_count || 0);
        } catch (e) {
            logger.warn('Failed to refresh web tabs panel:', e);
        }
    },

    _updateBadge(jobs) {
        const badge = document.getElementById('webTabsPanelBadge');
        if (!badge) return;
        const runningCount = jobs.filter(j => j.status === 'running').length;
        if (runningCount > 0) {
            badge.textContent = runningCount;
            badge.style.display = '';
        } else {
            badge.style.display = 'none';
        }
    },

    _render(jobs, otherRunningCount) {
        const body = document.getElementById('webTabsPanelBody');
        const otherCountEl = document.getElementById('webTabsOtherCount');
        if (!body) return;

        if (otherCountEl) {
            if (otherRunningCount > 0) {
                otherCountEl.textContent = `${otherRunningCount} other tab${otherRunningCount === 1 ? '' : 's'} open elsewhere`;
                otherCountEl.style.display = '';
            } else {
                otherCountEl.style.display = 'none';
            }
        }

        if (jobs.length === 0) {
            body.innerHTML = '<div class="side-panel-empty">No browser tabs for this chat.</div>';
            return;
        }

        const sorted = [...jobs].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        body.innerHTML = sorted.map(job => this._renderRow(job)).join('');

        sorted.forEach(job => {
            const row = body.querySelector(`.job-row[data-job-id="${cssEscapeWT(job.id)}"]`);
            if (!row) return;
            const closeBtn = row.querySelector('.kill-btn');
            if (closeBtn) closeBtn.addEventListener('click', () => this._closeTab(job.id));
            const revealBtn = row.querySelector('.reveal-btn');
            if (revealBtn) revealBtn.addEventListener('click', () => this._toggleReveal(job.id, revealBtn));
        });
    },

    _renderRow(job) {
        const statusClass = job.status;
        const startedByLabel = job.startedBy === 'ai' ? 'AI' : 'You';
        const killedByNote = job.killedBy ? ` &middot; closed by ${job.killedBy === 'ai' ? 'AI' : 'you'}` : '';
        const title = (job.meta && job.meta.title) || '';
        const url = (job.meta && job.meta.url) || job.label || '';
        const canClose = job.status === 'running';
        // meta.visible reflects the REAL window state (see browserToolService.js's
        // setTabVisibleMeta) — reading it from every poll instead of trusting
        // the button's own last-clicked label means the label stays correct
        // even when visibility changed some other way, e.g. the user clicking
        // the OS window's own close button (which now hides rather than kills).
        const isVisible = !!(job.meta && job.meta.visible);
        const cachedThumb = this._thumbCache[job.id];
        const thumbInner = cachedThumb
            ? `<img src="${cachedThumb}" alt="tab preview">`
            : `<span class="web-tab-thumb-placeholder">${canClose ? 'Loading preview&hellip;' : 'Closed'}</span>`;
        return `
            <div class="job-row web-tab-row" data-job-id="${escapeHtml(job.id)}">
                <div class="web-tab-thumb" id="thumb-${escapeHtml(job.id)}">
                    ${thumbInner}
                </div>
                <div class="job-row-top">
                    <span class="job-row-label" title="${escapeHtml(url)}">${escapeHtml(title || url)}</span>
                    <span class="job-row-status ${statusClass}">${escapeHtml(job.status)}</span>
                </div>
                <div class="job-row-meta">
                    <span title="${escapeHtml(url)}">${escapeHtml(url)}</span>
                </div>
                <div class="job-row-meta">
                    <span>started by ${startedByLabel}${killedByNote}</span>
                </div>
                <div class="job-row-actions">
                    <button class="job-row-btn reveal-btn" ${canClose ? '' : 'disabled'}>${isVisible ? 'Hide' : 'Reveal'}</button>
                    <button class="job-row-btn kill-btn" ${canClose ? '' : 'disabled'}>Close</button>
                </div>
            </div>
        `;
    },

    async _refreshThumbnails(jobIds) {
        for (const jobId of jobIds) {
            try {
                const res = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/thumbnail`);
                if (!res.ok) continue;
                const data = await res.json();
                if (!data.image_base64) continue;
                const dataUri = `data:${data.mime_type};base64,${data.image_base64}`;
                this._thumbCache[jobId] = dataUri;
                // Update the live DOM directly (not via _render) so an
                // in-flight fetch never triggers a full row rebuild — just
                // swaps the image in place, no placeholder flash either way.
                const thumbEl = document.getElementById(`thumb-${jobId}`);
                if (thumbEl) {
                    const img = thumbEl.querySelector('img');
                    if (img) img.src = dataUri;
                    else thumbEl.innerHTML = `<img src="${dataUri}" alt="tab preview">`;
                }
            } catch (e) {
                // Best-effort — a failed thumbnail just keeps showing the placeholder.
            }
        }
    },

    async _closeTab(jobId) {
        try {
            const res = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/kill`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ killed_by: 'user' })
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                logger.warn('Failed to close tab:', err.error || res.status);
                return;
            }
            this.refresh();
        } catch (e) {
            logger.warn('Failed to close tab:', e);
        }
    },

    async _toggleReveal(jobId, btn) {
        const revealing = btn.textContent === 'Reveal';
        try {
            const res = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/${revealing ? 'reveal' : 'hide'}`, { method: 'POST' });
            if (!res.ok) return;
            btn.textContent = revealing ? 'Hide' : 'Reveal';
        } catch (e) {
            logger.warn('Failed to toggle tab visibility:', e);
        }
    },

    async locateJob(jobId) {
        this.open();
        await this.refresh();
        const row = document.querySelector(`#webTabsPanelBody .job-row[data-job-id="${cssEscapeWT(jobId)}"]`);
        if (!row) return;
        row.scrollIntoView({ block: 'center', behavior: 'smooth' });
        row.classList.remove('job-locate-flash');
        void row.offsetWidth;
        row.classList.add('job-locate-flash');
    },

    async jobExists(jobId) {
        try {
            const res = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`);
            return res.ok;
        } catch (e) {
            return false;
        }
    }
};

function cssEscapeWT(str) {
    if (window.CSS && CSS.escape) return CSS.escape(str);
    return String(str).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
}

document.addEventListener('DOMContentLoaded', () => WebTabsPanel.init());
