// Chat Checkpoints - per-turn checkpoint button in the message-actions bar
// (not a side panel: checkpoints are attached to the turn they belong to, so
// the natural place to see/act on them is right there on that turn).
//
// Data flow: once per chat load, fetch the full checkpoint list for the chat
// and index it by turn_id. addMessageActions (chatRenderer.js) calls
// attachButton() for every request/response turn as it's rendered, which
// looks up that turn's row (if any) and renders the button's state from it.
// Rows still 'pending' get individually polled until they resolve, updating
// just that one button in place — no global poll loop, no side panel.
const ChatCheckpoints = {
    _chatId: null,
    _isProjectScoped: false,
    _byTurnId: new Map(), // turn_id -> checkpoint row
    _pollTimers: new Map(), // checkpoint row id -> interval handle (pending rows)
    _discoveryPolls: new Map(), // turnId -> interval handle (turns with no row yet)

    // Call once after a chat's history has loaded (and on every subsequent
    // switch/creation) — mirrors the old panel's onChatSwitched hook point.
    async onChatLoaded(chatId) {
        this._clearPolls();
        this._chatId = chatId;
        this._byTurnId = new Map();
        this._isProjectScoped = false;

        if (!chatId) return;

        let projectPath = null;
        try {
            projectPath = await getChatProjectPath(chatId);
        } catch (e) {
            projectPath = null;
        }
        this._isProjectScoped = !!projectPath;
        if (!this._isProjectScoped) return;

        try {
            const rows = await fetchCheckpoints(chatId);
            for (const row of rows) {
                if (row.turn_id) this._byTurnId.set(row.turn_id, row);
            }
        } catch (e) {
            logger.warn("Failed to load checkpoints for chat:", e);
        }

        // Re-render any already-mounted turn buttons for this chat (covers
        // the case where turns rendered before this fetch resolved).
        this._refreshMountedButtons();
    },

    buildButton(turnId, kind) {
        if (!this._isProjectScoped || !turnId) return null;

        const btn = document.createElement("button");
        btn.className = "action-btn checkpoint-btn";
        btn.dataset.turnId = turnId;
        btn.dataset.kind = kind;
        btn.addEventListener("click", () => this._handleClick(btn));

        const existing = this._byTurnId.get(turnId) || null;

        if (existing) {
            this._renderButtonState(btn, existing);
        } else {
            // No checkpoint row yet. The backend creates checkpoints
            // asynchronously when a turn completes, so show a "creating"
            // state immediately and poll for the row to appear. If no
            // checkpoint is created (no file changes, not first turn),
            // the poll gives up and the button goes grey.
            this._renderCreating(btn);
            this._pollForNewRow(turnId, btn);
        }

        return btn;
    },

    // Short-lived discovery poll for a turn whose checkpoint row doesn't
    // exist in our snapshot yet. Distinct from _ensurePolling (which tracks a
    // KNOWN pending row by id) — this one is looking for the row to appear
    // at all, and gives up after a bounded number of attempts so a turn that
    // genuinely has no checkpoint (freeform edge cases, pre-feature history)
    // doesn't poll forever.
    _renderCreating(btn) {
        btn.classList.remove("loading", "checkpoint-error", "checkpoint-ready");
        btn.textContent = "Checkpoint…";
        btn.title = "Creating checkpoint…";
        btn.classList.add("loading");
        btn.disabled = true;
    },

    _pollForNewRow(turnId, btn) {
        let attempts = 0;
        const maxAttempts = 8; // ~12s at 1.5s interval
        const timer = setInterval(async () => {
            attempts++;
            if (!this._chatId || !document.body.contains(btn)) {
                clearInterval(timer);
                this._discoveryPolls.delete(turnId);
                return;
            }
            try {
                const rows = await fetchCheckpoints(this._chatId);
                const row = rows.find((r) => r.turn_id === turnId);
                if (row) {
                    this._byTurnId.set(turnId, row);
                    this._renderButtonState(btn, row);
                    clearInterval(timer);
                    this._discoveryPolls.delete(turnId);
                    return;
                }
            } catch (e) {
                logger.warn("Failed to poll for new checkpoint row:", e);
            }
            if (attempts >= maxAttempts) {
                clearInterval(timer);
                this._discoveryPolls.delete(turnId);
                this._renderButtonState(btn, null);
            }
        }, 1500);
        this._discoveryPolls.set(turnId, timer);
    },

    _stopDiscoveryPoll(turnId) {
        const timer = this._discoveryPolls.get(turnId);
        if (timer) {
            clearInterval(timer);
            this._discoveryPolls.delete(turnId);
        }
    },

    _refreshMountedButtons() {
        document.querySelectorAll(".checkpoint-btn").forEach((btn) => {
            const turnId = btn.dataset.turnId;
            const row = this._byTurnId.get(turnId) || null;
            if (row) {
                this._renderButtonState(btn, row);
            } else {
                this._stopDiscoveryPoll(turnId);
                this._renderButtonState(btn, null);
            }
        });
    },

    _renderButtonState(btn, row) {
        btn.classList.remove("loading", "checkpoint-error", "checkpoint-ready");
        btn.disabled = false;

        if (!row) {
            // No checkpoint recorded for this turn (e.g. a no-op commit that
            // was dropped, or the request/response predates this feature).
            btn.textContent = "Checkpoint";
            btn.title = "No checkpoint available for this turn";
            btn.disabled = true;
            return;
        }

        if (row.status === "pending") {
            btn.textContent = "Checkpoint…";
            btn.title = "Creating checkpoint…";
            btn.classList.add("loading");
            btn.disabled = true;
            this._ensurePolling(row);
        } else if (row.status === "error") {
            btn.textContent = "Checkpoint";
            btn.title = `Checkpoint failed: ${row.error || "unknown error"}`;
            btn.classList.add("checkpoint-error");
            btn.disabled = false; // clickable to surface the error message
        } else {
            btn.textContent = "Checkpoint";
            btn.title = "Restore project files to this checkpoint";
            btn.classList.add("checkpoint-ready");
        }
    },

    _ensurePolling(row) {
        if (this._pollTimers.has(row.id)) return;
        const timer = setInterval(async () => {
            if (!this._chatId) return;
            try {
                const rows = await fetchCheckpoints(this._chatId);
                const updated = rows.find((r) => r.id === row.id);
                const btn = document.querySelector(`.checkpoint-btn[data-turn-id="${row.turn_id}"]`);
                if (!updated) {
                    // Row was dropped (no-op commit) - stop polling and clear
                    // any stale map entry so the button reads as "no checkpoint".
                    this._byTurnId.delete(row.turn_id);
                    this._stopPolling(row.id);
                    if (btn) this._renderButtonState(btn, null);
                    return;
                }
                this._byTurnId.set(updated.turn_id, updated);
                if (updated.status !== "pending") {
                    this._stopPolling(row.id);
                }
                if (btn) this._renderButtonState(btn, updated);
            } catch (e) {
                logger.warn("Failed to poll checkpoint status:", e);
            }
        }, 1500);
        this._pollTimers.set(row.id, timer);
    },

    _stopPolling(rowId) {
        const timer = this._pollTimers.get(rowId);
        if (timer) {
            clearInterval(timer);
            this._pollTimers.delete(rowId);
        }
    },

    _clearPolls() {
        this._pollTimers.forEach((timer) => clearInterval(timer));
        this._pollTimers.clear();
        this._discoveryPolls.forEach((timer) => clearInterval(timer));
        this._discoveryPolls.clear();
    },

    async _handleClick(btn) {
        // Don't allow restore while a response is streaming - restoring
        // would overwrite project files while the AI may be actively
        // writing to them.
        const turnsContainer = document.getElementById("messages");
        if (turnsContainer && turnsContainer.classList.contains("chat-streaming")) return;

        const turnId = btn.dataset.turnId;
        const row = this._byTurnId.get(turnId);
        if (!row) return;

        if (row.status === "error") {
            if (typeof showError === "function") {
                showError(`Checkpoint failed: ${row.error || "unknown error"}`);
            }
            return;
        }

        if (row.status !== "done" || !row.commit_hash) return;

        if (typeof showCustomConfirm !== "function") return;
        showCustomConfirm(
            "Restore your project files to this checkpoint? This overwrites any uncommitted changes made since, including anything done outside the app.",
            () => {
                restoreCheckpoint(this._chatId, row.id)
                    .then(() => {
                        if (typeof showNotification === "function") {
                            showNotification("Project files restored to this checkpoint.", "info");
                        }
                    })
                    .catch((e) => {
                        logger.warn("Failed to restore checkpoint:", e);
                        if (typeof showError === "function") showError(`Failed to restore checkpoint: ${e.message}`);
                    });
            },
            "Restore"
        );
    }
};
