class StreamManager {
    constructor() {
        this.activeStreamState = new Map();
        // Per-chat queue of steers the user typed while a response was streaming.
        // chatId -> Array<{ turnId, parentTurnId, content }>. Each entry is
        // already saved to the DB and rendered as a request turn; the queue is
        // drained at the next stream break to fire a continuation request.
        this.steeringQueue = new Map();
        // Per-chat promise chain that serializes steer saves. Each steer's save
        // runs only after the previous one returns its backend-minted turn_id, so
        // the next steer can read it as its parent. The backend stays the sole
        // turn_id authority — the frontend never mints them.
        this.steerChain = new Map();
    }

    // Push a steer that has already been persisted + rendered.
    enqueueSteer(chatId, entry) {
        if (!this.steeringQueue.has(chatId)) this.steeringQueue.set(chatId, []);
        this.steeringQueue.get(chatId).push(entry);
    }

    // Atomically remove and return all queued steers for a chat.
    drainSteeringQueue(chatId) {
        const q = this.steeringQueue.get(chatId);
        if (!q || q.length === 0) return [];
        this.steeringQueue.set(chatId, []);
        return q;
    }

    hasSteers(chatId) {
        const q = this.steeringQueue.get(chatId);
        return !!(q && q.length > 0);
    }

    // Update a queued steer's cached content after an in-place edit, so the
    // continuation's debug view reflects the edit. Scans every chat's queue.
    updateSteerContent(turnId, content) {
        if (!turnId) return;
        for (const q of this.steeringQueue.values()) {
            const entry = q.find((e) => e.turnId === turnId);
            if (entry) { entry.content = content; return; }
        }
    }

    register(chatId, entry) {
        this.activeStreamState.set(chatId, entry);
        this.updateStreamIndicator(chatId, true);
        if (entry.projectId) this.updateProjectIndicator(entry.projectId);
    }

    unregister(chatId) {
        const entry = this.activeStreamState.get(chatId);
        this.activeStreamState.delete(chatId);
        this.updateStreamIndicator(chatId, false);
        if (entry && entry.projectId) this.updateProjectIndicator(entry.projectId);
    }

    isStreaming(chatId) {
        return this.activeStreamState.has(chatId);
    }

    getStream(chatId) {
        return this.activeStreamState.get(chatId) || null;
    }

    async stopChatStream(chatId) {
        const ss = this.activeStreamState.get(chatId);
        if (!ss) return false;
        if (ss.requestId && typeof cancelRequest === "function") {
            await cancelRequest(ss.requestId);
        }
        if (ss.abortController) {
            ss.abortController.abort();
        }
        return true;
    }

    updateStreamIndicator(chatId, active) {
        const chatItem = document.querySelector(`[data-chat-id="${chatId}"]`);
        if (!chatItem) return;
        let spinner = chatItem.querySelector(".stream-spinner");
        if (active) {
            if (!spinner) {
                spinner = document.createElement("span");
                spinner.className = "stream-spinner";
                const deleteBtn = chatItem.querySelector(".chat-delete-btn");
                if (deleteBtn) {
                    let actionsWrap = chatItem.querySelector(".chat-item-actions");
                    if (!actionsWrap) {
                        actionsWrap = document.createElement("div");
                        actionsWrap.className = "chat-item-actions";
                        deleteBtn.parentNode.insertBefore(actionsWrap, deleteBtn);
                        actionsWrap.appendChild(deleteBtn);
                    }
                    actionsWrap.insertBefore(spinner, deleteBtn);
                }
            }
            spinner.style.display = "";
        } else if (spinner) {
            spinner.style.display = "none";
        }
        this.refreshSendButton();
    }

    updateProjectIndicator(projectId) {
        const projectItem = document.querySelector(`[data-project-id="${projectId}"]`);
        if (!projectItem) return;
        const active = [...this.activeStreamState.values()].some(e => e.projectId === projectId);
        let spinner = projectItem.querySelector(".stream-spinner");
        if (active) {
            if (!spinner) {
                spinner = document.createElement("span");
                spinner.className = "stream-spinner";
                const nameEl = projectItem.querySelector(".project-item-name");
                if (nameEl) nameEl.after(spinner);
                else projectItem.querySelector(".project-item-header").appendChild(spinner);
            }
            spinner.style.display = "";
        } else if (spinner) {
            spinner.style.display = "none";
        }
    }

    refreshSendButton() {
        if (typeof setLoading !== "function") return;
        const streaming = this.activeStreamState.has(currentChatId);
        const hasContent = typeof messageInputHasContent === "function" ? messageInputHasContent() : false;
        setLoading(streaming, hasContent);
        // Grey out the regenerate actions (Retry / Edit & Retry) on the viewed
        // chat's turns while it streams — they'd start a competing turn (clicks
        // are also guarded in the handlers).
        if (typeof turnsContainer !== "undefined" && turnsContainer) {
            turnsContainer.classList.toggle("chat-streaming", streaming);
        }
    }

    reapplyIndicators() {
        const projectIds = new Set();
        for (const [chatId, entry] of this.activeStreamState.entries()) {
            this.updateStreamIndicator(chatId, true);
            if (entry.projectId) projectIds.add(entry.projectId);
        }
        for (const projectId of projectIds) {
            this.updateProjectIndicator(projectId);
        }
        this.refreshSendButton();
    }

    reconnectStreaming(chatId) {
        const ss = this.activeStreamState.get(chatId);
        if (!ss) return;

        // Only reconnect if the stream's request turn is still in the DOM
        // after loadChatHistory re-rendered. If the turn was pruned (branch
        // navigation) or doesn't exist (chat switch), the DOM won't contain
        // the request turn — skip reconnection to avoid splicing the live
        // stream into an unrelated branch.
        if (ss.requestTurnId && !turnsContainer.querySelector(`[data-turn-id="${ss.requestTurnId}"]`)) return;

        if (ss.responseTurnId) {
            const existingTurn = turnsContainer.querySelector(`[data-turn-id="${ss.responseTurnId}"]`);
            if (existingTurn) existingTurn.remove();
        }

        if (ss.parentTurnId) {
            const siblings = turnsContainer.querySelectorAll(`.response-turn[data-parent-turn-id="${ss.parentTurnId}"]`);
            for (const sibling of siblings) {
                sibling.remove();
            }
        }

        const { processor } = ss;
        const newTempContainer = document.createElement("div");
        newTempContainer.className = "live-stream-container";
        const newLiveRenderer = new ChatRenderer(newTempContainer);

        const newResponseTurnDiv = document.createElement("div");
        newResponseTurnDiv.className = "turn response-turn";
        turnsContainer.appendChild(newResponseTurnDiv);
        newResponseTurnDiv.appendChild(newTempContainer);

        ss.tempContainer = newTempContainer;
        ss.liveRenderer = newLiveRenderer;
        ss.responseTurnDiv = newResponseTurnDiv;

        updateLiveRendering(processor, newLiveRenderer, newTempContainer);
    }
}

const streamManager = new StreamManager();
