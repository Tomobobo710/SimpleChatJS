class StreamManager {
    constructor() {
        this.activeStreamState = new Map();
    }

    register(chatId, entry) {
        this.activeStreamState.set(chatId, entry);
        this.updateStreamIndicator(chatId, true);
    }

    unregister(chatId) {
        this.activeStreamState.delete(chatId);
        this.updateStreamIndicator(chatId, false);
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

    refreshSendButton() {
        if (typeof setLoading === "function") {
            setLoading(this.activeStreamState.has(currentChatId));
        }
    }

    reapplyIndicators() {
        for (const chatId of this.activeStreamState.keys()) {
            this.updateStreamIndicator(chatId, true);
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
        newTempContainer.style.width = "100%";
        newTempContainer.style.boxSizing = "border-box";
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
