// Jobs Panel - Processes side panel: lists background jobs for the current
// chat, lets the user kill/inspect them, and supports "locate" jumps from a
// live shell console block in chat (see web-tool-plan.md sections 6, 9.3).
//
// Live-updates via polling while the panel is open (simplest robust approach —
// avoids one SSE connection per job just to keep a summary list fresh; the
// in-chat console block already has its own SSE subscription for live output).

const JobsPanel = {
    _pollTimer: null,
    _pollIntervalMs: 2000,
    _isOpen: false,

    init() {
        const toggleBtn = document.getElementById('processesPanelToggleBtn');
        const closeBtn = document.getElementById('processesPanelCloseBtn');
        if (toggleBtn) toggleBtn.addEventListener('click', () => this.toggle());
        if (closeBtn) closeBtn.addEventListener('click', () => this.close());
    },

    toggle() {
        if (this._isOpen) this.close();
        else this.open();
    },

    open() {
        const panel = document.getElementById('processesPanel');
        const btn = document.getElementById('processesPanelToggleBtn');
        if (!panel) return;
        panel.classList.add('panel-open');
        panel.setAttribute('aria-hidden', 'false');
        if (btn) btn.classList.add('active');
        this._isOpen = true;
        this.refresh();
        this._startPolling();
        if (typeof syncPanelSplitLayout === 'function') syncPanelSplitLayout();
    },

    close() {
        const panel = document.getElementById('processesPanel');
        const btn = document.getElementById('processesPanelToggleBtn');
        if (!panel) return;
        panel.classList.remove('panel-open');
        panel.setAttribute('aria-hidden', 'true');
        if (btn) btn.classList.remove('active');
        this._isOpen = false;
        this._stopPolling();
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
            const res = await fetch(`/api/jobs?chat_id=${encodeURIComponent(currentChatId)}`);
            if (!res.ok) return;
            const data = await res.json();
            const jobs = data.jobs || [];
            // Skip the DOM rebuild when nothing changed since the last poll —
            // see the identical comment in webTabsPanel.js for why this matters.
            const signature = JSON.stringify(jobs.map(j => [j.id, j.status, j.startedBy, j.killedBy, j.meta?.exit_code]));
            if (signature === this._lastSignature) return;
            this._lastSignature = signature;
            this._render(jobs, data.other_running_count || 0);
            this._updateBadge(jobs);
        } catch (e) {
            logger.warn('Failed to refresh jobs panel:', e);
        }
    },

    _updateBadge(jobs) {
        const badge = document.getElementById('processesPanelBadge');
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
        const body = document.getElementById('processesPanelBody');
        const otherCountEl = document.getElementById('processesOtherCount');
        if (!body) return;

        if (otherCountEl) {
            if (otherRunningCount > 0) {
                otherCountEl.textContent = `${otherRunningCount} other job${otherRunningCount === 1 ? '' : 's'} running elsewhere`;
                otherCountEl.style.display = '';
            } else {
                otherCountEl.style.display = 'none';
            }
        }

        if (jobs.length === 0) {
            body.innerHTML = '<div class="side-panel-empty">No background processes for this chat.</div>';
            return;
        }

        // Newest first.
        const sorted = [...jobs].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        body.innerHTML = sorted.map(job => this._renderRow(job)).join('');

        sorted.forEach(job => {
            const killBtn = body.querySelector(`.job-row[data-job-id="${cssEscape(job.id)}"] .kill-btn`);
            if (killBtn) killBtn.addEventListener('click', () => this._killJob(job.id));
        });
    },

    _renderRow(job) {
        const statusClass = job.status;
        const startedByLabel = job.startedBy === 'ai' ? 'AI' : 'You';
        const killedByNote = job.killedBy ? ` &middot; killed by ${job.killedBy === 'ai' ? 'AI' : 'you'}` : '';
        const exitNote = (job.meta && job.meta.exit_code !== null && job.meta.exit_code !== undefined)
            ? ` &middot; exit ${job.meta.exit_code}`
            : '';
        const canKill = job.status === 'running';
        return `
            <div class="job-row" data-job-id="${escapeHtml(job.id)}">
                <div class="job-row-top">
                    <span class="job-row-label" title="${escapeHtml(job.label)}">${escapeHtml(job.label)}</span>
                    <span class="job-row-status ${statusClass}">${escapeHtml(job.status)}</span>
                </div>
                <div class="job-row-meta">
                    <span>started by ${startedByLabel}${exitNote}${killedByNote}</span>
                </div>
                <div class="job-row-actions">
                    <button class="job-row-btn kill-btn" ${canKill ? '' : 'disabled'}>Kill</button>
                </div>
            </div>
        `;
    },

    async _killJob(jobId) {
        try {
            const res = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/kill`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ killed_by: 'user' })
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                logger.warn('Failed to kill job:', err.error || res.status);
                return;
            }
            this.refresh();
        } catch (e) {
            logger.warn('Failed to kill job:', e);
        }
    },

    // Called from a "locate" button embedded in an in-chat shell console
    // header (section 9.3). Opens the panel if needed and flashes the row.
    async locateJob(jobId) {
        this.open();
        await this.refresh();
        const row = document.querySelector(`#processesPanelBody .job-row[data-job-id="${cssEscape(jobId)}"]`);
        if (!row) return; // job cleared/gone — nothing to locate
        row.scrollIntoView({ block: 'center', behavior: 'smooth' });
        row.classList.remove('job-locate-flash');
        // Force reflow so re-triggering the animation on repeated clicks works.
        void row.offsetWidth;
        row.classList.add('job-locate-flash');
    },

    // Whether a job is still known to the registry (for the console's
    // "locate" button — hidden/disabled once the job is gone; see 9.3).
    async jobExists(jobId) {
        try {
            const res = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`);
            return res.ok;
        } catch (e) {
            return false;
        }
    }
};

// Minimal CSS.escape fallback (selector-safe id quoting) — job ids are our
// own generated `job_<ts>_<rand>` format so this is defensive, not load-bearing.
function cssEscape(str) {
    if (window.CSS && CSS.escape) return CSS.escape(str);
    return String(str).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
}

document.addEventListener('DOMContentLoaded', () => JobsPanel.init());
