class TurnRequest {
    constructor({
        messages,
        parentTurnId = null,
        turnId = null,
        requestOrigin = "send",
        truncateContainer = null,
        chatId = null,
    }) {
        this.messages = messages || [];
        this.parentTurnId = parentTurnId;
        this.turnId = turnId;
        this.requestOrigin = requestOrigin;
        this.truncateContainer = truncateContainer;
        this.chatId = chatId || currentChatId;
    }

    static generateRequestId() {
        return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    async saveRequest(requestId) {
        if (this.requestOrigin === "retry") return null;
        // Steering continuation: the queued steers are already persisted; the
        // last steer acts as the request turn. Return its lineage synthetically
        // (no DB write) so execute() builds the right continuation request.
        if (this.requestOrigin === "steer_continuation") {
            return { turn_id: this.turnId, parent_turn_id: this.parentTurnId };
        }
        if (this.messages.length === 0) return null;

        const { turn_id, parent_turn_id } = await this._saveMessages();
        return { turn_id, parent_turn_id };
    }

    async _saveMessages() {
        let firstSave = null;

        for (let i = 0; i < this.messages.length; i++) {
            const msg = this.messages[i];
            const contentForDb = Array.isArray(msg.content) ? JSON.stringify(msg.content) : msg.content;
            const dbEntry = { role: msg.role, content: contentForDb, turn_type: 'request' };

            const params = i === 0
                ? (this.parentTurnId ? { parent_turn_id: this.parentTurnId } : null)
                : { turn_id: firstSave.turn_id, parent_turn_id: firstSave.parent_turn_id };

            const result = await saveCompleteMessage(this.chatId, dbEntry, params);
            if (i === 0) {
                if (!result || !result.turn_id) {
                    throw new Error("saveCompleteMessage returned no turn_id; cannot proceed without lineage anchor");
                }
                firstSave = result;
            }
        }

        return { turn_id: firstSave.turn_id, parent_turn_id: firstSave.parent_turn_id };
    }

    async renderRequestTurn(requestTurnInfo, requestId) {
        if (this.requestOrigin === "retry") return;
        // Steering continuation: the steer turns are already in the DOM (rendered
        // when each was enqueued), so there's nothing to render here.
        if (this.requestOrigin === "steer_continuation") return;
        if (!requestTurnInfo) return;

        const parentTurnId = this.parentTurnId;
        const requestMessages = this.messages.map(entry => ({
            role: entry.role || 'user',
            content: Array.isArray(entry.content) ? entry.content : [{ type: 'text', text: entry.content }]
        }));

        const requestBody = {
            chat_id: this.chatId,
            enabled_tools: loadEnabledTools(),
            request_id: requestId,
            parent_turn_id: parentTurnId,
            turn_id: requestTurnInfo.turn_id,
            history_anchor_turn_id: requestTurnInfo.turn_id,
            message: this.messages[0]?.content
        };

        const requestDebugData = {
            sequence: [
                {
                    type: "user_http_request",
                    step: 1,
                    timestamp: new Date().toISOString(),
                    data: { requestBody }
                },
                {
                    type: "ai_http_request",
                    step: 2,
                    timestamp: new Date().toISOString(),
                    data: { requestBody: { messages: requestMessages } }
                }
            ],
            metadata: {
                endpoint: "request_input_retry",
                timestamp: new Date().toISOString(),
                tools: Object.keys(loadEnabledTools()).length
            },
            apiRequest: {
                url: `${window.location.origin}/api/chat`,
                method: "POST",
                requestId,
                timestamp: new Date().toISOString()
            }
        };
        try {
            await saveTurnData(this.chatId, requestTurnInfo.turn_id, requestDebugData);
        } catch (e) { logger.warn("Failed to save turn debug data:", e); }

        const messages = this.messages.map((msg, i) => new Message({
            id: null,
            role: msg.role,
            content: msg.content,
            turn_id: requestTurnInfo.turn_id,
            parent_turn_id: i === 0 ? requestTurnInfo.parent_turn_id : requestTurnInfo.turn_id,
            edit_count: 0,
        }));

       const turn = new Turn(messages, requestTurnInfo.turn_id, requestTurnInfo.parent_turn_id, null, 'request');
        chatRenderer.renderTurn(turn.renderable(), true);

        const turnMessages = turn.renderable().turnMessages || this.messages;
        this._listenForRequestDebug(requestId, turnMessages);

        if (this.requestOrigin === "edit_retry") {
            const branchParentKey = parentTurnId || "root";
            const scopeKey = `${this.chatId}::${branchParentKey}`;
            selectedSiblings[scopeKey] = requestTurnInfo.turn_id;
            const scopedMap = Object.fromEntries(
                Object.entries(selectedSiblings).filter(([k]) => k.startsWith(`${this.chatId}::`))
            );
            try {
                await saveBranchSelections(this.chatId, scopedMap);
            } catch (e) { logger.warn("Failed to persist branch selection:", e); }

            await loadChatHistory(this.chatId);
        }
    }

    computeLineageIds(requestTurnInfo) {
        const effectiveParentTurnId = requestTurnInfo ? requestTurnInfo.parent_turn_id : this.parentTurnId;
        const effectiveTurnId = requestTurnInfo ? requestTurnInfo.turn_id : this.turnId;
        const effectiveHistoryAnchor = requestTurnInfo ? requestTurnInfo.turn_id : this.parentTurnId;
        return { effectiveParentTurnId, effectiveTurnId, effectiveHistoryAnchor };
    }

    initiateApiCall(requestId, effectiveParentTurnId, effectiveTurnId, effectiveHistoryAnchor) {
        const enabledToolsFlags = loadEnabledTools();
        return initiateMessageRequest(
            enabledToolsFlags,
            requestId,
            effectiveParentTurnId,
            effectiveTurnId,
            effectiveHistoryAnchor
        );
    }

    async stream({ fetchPromise, requestId, requestTurnInfo, container, expectedParentTurnId, abortController }) {
        const activeChatId = currentChatId;
        const processor = new StreamingMessageProcessor();
        // Live stream (not a reload/replay) — lets the shell console linger a few
        // seconds after a command finishes before auto-collapsing.
        processor._live = true;
        const tempContainer = document.createElement("div");
        tempContainer.className = "live-stream-container";
        const liveRenderer = new ChatRenderer(tempContainer);

        const responseTurnDiv = document.createElement("div");
        responseTurnDiv.className = "turn response-turn";
        responseTurnDiv.innerHTML = "";
        container.appendChild(responseTurnDiv);
        responseTurnDiv.appendChild(tempContainer);

        // The response owns its identity: the backend mints the response turn_id
        // and announces it in the X-Response-Turn-Id header. We expose it on the
        // entry as a promise so a steer issued before the header lands can await
        // the announcement rather than the request having to pre-mint it.
        let announceResponseTurnId;
        const responseTurnIdPromise = new Promise((resolve) => { announceResponseTurnId = resolve; });
        const streamEntry = { processor, tempContainer, liveRenderer, responseTurnDiv, responseTurnId: null, responseTurnIdPromise, parentTurnId: expectedParentTurnId, requestTurnId: requestTurnInfo?.turn_id || null, abortController, requestId };
        streamEntry.projectId = window.currentProjectId || null;
        streamManager.register(activeChatId, streamEntry);

        // Resolve the announcement promise once, with the response's id (on the
        // header) or null (if the stream ends/errors before announcing one), so
        // an awaiting steer never hangs. Double-resolve is a no-op.
        const announce = (id) => { if (announceResponseTurnId) announceResponseTurnId(id || null); };

        // Per-round response wire-debug, delivered live over the same SSE channel
        // (mirrors request_debug). Persisted on each assistant message too; this is
        // just the live feed so the panel has it at finalization without a re-fetch.
        const collectedResponseDebug = [];
        let toolEventSource = null;
        try {
            toolEventSource = new EventSource(`${window.location.origin}/api/tools/${requestId}`);
            toolEventSource.onmessage = (event) => {
                try {
                    const toolEvent = JSON.parse(event.data);
                    processor.handleToolEvent(toolEvent);
                    const ss = streamManager.getStream(activeChatId);
                    if (ss) updateLiveRendering(processor, ss.liveRenderer, ss.tempContainer);
                } catch (parseError) {
                    logger.warn("Failed to parse tool event:", parseError);
                }
            };
            toolEventSource.onerror = () => {};
        } catch (error) {
            logger.warn("Failed to connect to tool events:", error);
        }

        let savedResponseTurn = null;
        let errorAlreadyHandled = false;

        const drainBodyForError = async (response) => {
            let text = "";
            try { text = await response.text(); } catch (_) {}
            if (!text) return "";
            try { const json = JSON.parse(text); return json.error || json.message || text; } catch (_) { return text; }
        };

        const cleanupAndError = (err) => {
            errorAlreadyHandled = true;
            announce(streamEntry.responseTurnId);
            if (toolEventSource) toolEventSource.close();
            streamManager.unregister(activeChatId);
            streamEntry.tempContainer.remove();
            streamEntry.responseTurnDiv.remove();
            return { err, processor, requestTurnInfo, savedResponseTurn };
        };

        try {
            const response = await fetchPromise;

            if (!response.ok) {
                const errorText = await drainBodyForError(response);
                const err = new Error(errorText || `HTTP ${response.status}`);
                err.streamErrorType = "api_error";
                err.errorText = errorText || `HTTP ${response.status}`;
                err.httpStatus = response.status;
                const ctx = cleanupAndError(err);
                await this.fireError(ctx.err, ctx);
                throw err;
            }

            const responseTurnId = response.headers.get("X-Response-Turn-Id");
            const responseParentTurnId = response.headers.get("X-Response-Parent-Turn-Id");
            if (!responseTurnId || !responseParentTurnId) {
                const errorText = await drainBodyForError(response);
                const err = new Error(errorText || "Backend did not emit required response-turn headers");
                err.streamErrorType = "api_error";
                err.errorText = errorText || "Backend did not emit required response-turn headers";
                const ctx = cleanupAndError(err);
                await this.fireError(ctx.err, ctx);
                throw err;
            }
            savedResponseTurn = { turn_id: responseTurnId, parent_turn_id: responseParentTurnId };
            streamEntry.responseTurnId = responseTurnId;
            announce(responseTurnId);

            const streamErrorType = response.headers.get("X-Stream-Error");
            if (streamErrorType) {
                const errorText = await drainBodyForError(response);
                const streamError = new Error(errorText || `Backend stream error: ${streamErrorType}`);
                streamError.streamErrorType = streamErrorType;
                streamError.errorText = errorText;
                // Any rounds that completed before the error fed collectedResponseDebug
                // live; the error itself is persisted on its message (shown on reload).
                const responseDebugData = collectedResponseDebug.length ? collectedResponseDebug : null;
                streamError.responseDebugData = responseDebugData;
                const ctx = cleanupAndError(streamError);
                ctx.responseDebugData = responseDebugData;
                await this.fireError(ctx.err, ctx);
                throw streamError;
            }

            for await (const event of streamSSEEvents(response)) {
                try {
                    switch (event.type) {
                        case 'reasoning_start': processor.startReasoningBlock(event.data.blockId); break;
                        case 'reasoning_delta': processor.addReasoningDelta(event.data.blockId, event.data.text); break;
                        case 'reasoning_end': processor.finishReasoningBlock(event.data.blockId); break;
                        case 'content_delta': processor.addContentDelta(event.data.text); break;
                        case 'response_debug': if (event.data) collectedResponseDebug.push(event.data); break;
                        case 'done': processor.finalize(event.data); break;
                    }
                    const sseSs = streamManager.getStream(activeChatId);
                    if (sseSs) updateLiveRendering(processor, sseSs.liveRenderer, sseSs.tempContainer);
                    if (typeof smartScrollToBottom === "function") smartScrollToBottom(scrollContainer);
                } catch (eventError) {
                    logger.error("Error processing SSE event:", eventError);
                }
            }

            if (toolEventSource) toolEventSource.close();
            streamManager.unregister(activeChatId);

            const responseDebugData = collectedResponseDebug.length ? collectedResponseDebug : null;

            const dropdownStates = {};
            const streamingDropdowns = streamEntry.tempContainer.querySelectorAll(".streaming-dropdown");
            let thinkingIndex = 0, toolIndex = 0;
            streamingDropdowns.forEach((sd) => {
                const inst = sd._streamingDropdownInstance;
                if (inst) {
                    const sk = inst.type === "thinking" ? "thinking_" + thinkingIndex++ : inst.type === "tool" ? "tool_" + toolIndex++ : null;
                    if (sk) dropdownStates[sk] = !inst.isCollapsed;
                }
            });

            streamEntry.tempContainer.remove();
            streamEntry.responseTurnDiv.remove();

            const rto = RenderableTurnObject.fromStreamingProcessor({
                processor, turnId: savedResponseTurn?.turn_id || null,
                parentTurnId: savedResponseTurn?.parent_turn_id || null, responseDebugData,
                turnMessages: processor.getToolMessages(), dropdownStates
            });

            if (currentChatId === activeChatId) chatRenderer.renderTurn(rto, true);

            return { savedResponseTurn, responseDebugData, processor, chatId: activeChatId };
        } catch (error) {
            if (!errorAlreadyHandled) {
                announce(streamEntry.responseTurnId);
                if (toolEventSource) toolEventSource.close();
                streamManager.unregister(activeChatId);
                streamEntry.tempContainer.remove();
                streamEntry.responseTurnDiv.remove();
                const responseDebugData = collectedResponseDebug.length ? collectedResponseDebug : null;
                error.responseDebugData = responseDebugData;
                await this.fireError(error, { processor, requestTurnInfo, savedResponseTurn, responseDebugData });
            }
            if (error.name === 'AbortError') return { savedResponseTurn, responseDebugData: null, processor, chatId: activeChatId };
            throw error;
        }
    }

    async fireError(err, { processor, requestTurnInfo, savedResponseTurn, responseDebugData } = {}) {
        const errorType = err.name === "AbortError"
            ? "user_stopped"
            : (err.streamErrorType || "api_error");
        const errorText = err.errorText
            || (err.name === "AbortError" ? "Generation stopped by user." : "")
            || err.message || "";

        logger.error(`Turn request failed (${errorType}): ${errorText}`);

        if (processor && typeof processor.finalize === "function") processor.finalize();

        const blocks = (processor && typeof processor.getBlocks === "function") ? processor.getBlocks() : [];
        const partialContent = (processor && typeof processor.getRawContent === "function") ? (processor.getRawContent() || "") : "";

        // Mirror the system message the backend persists on error, so it shows LIVE
        // too (not just on reload). Same gate as the backend (only when content
        // streamed — the zero-content case stays silent) and same per-type wording.
        if (partialContent.trim() !== "") {
            const SYSTEM_TEXT = {
                user_stopped: "Generation stopped by user.",
                connection_error: "Connection error while receiving response.",
            };
            blocks.push(new Block({ type: 'system', content: SYSTEM_TEXT[errorType] || "Error while receiving response." }));
        }

        const errorBlock = new Block({ type: 'error', content: errorText, metadata: { error_type: errorType } });
        blocks.push(errorBlock);

        const rto = new RenderableTurnObject({
            identity: 'response', content: partialContent, blocks,
            turnId: savedResponseTurn?.turn_id || null, parentTurnId: savedResponseTurn?.parent_turn_id || null,
            responseDebugData: responseDebugData || null,
        });
        chatRenderer.renderTurn(rto, true);

        updateChatPreview(this.chatId, partialContent);
        if (this.requestOrigin === "send") this._updateChatTitleFromMessage();

        if (savedResponseTurn?.turn_id) {
            const parentKey = this.parentTurnId || "root";
            const scopeKey = `${this.chatId}::${parentKey}`;
            selectedSiblings[scopeKey] = savedResponseTurn.turn_id;
            const scopedMap = Object.fromEntries(
                Object.entries(selectedSiblings).filter(([k]) => k.startsWith(`${this.chatId}::`))
            );
            saveBranchSelections(this.chatId, scopedMap).catch((e) =>
                logger.warn("[RETRY] Failed to persist branch selection:", e)
            );
        }
    }

    _updateChatTitleFromMessage() {
        const first = this.messages.find(m => m.role !== 'system');
        if (!first?.content) return;
        const content = first.content;
        const currentTitle = document.getElementById('chatTitle').textContent;
        if (currentTitle !== 'New Chat' && currentTitle !== 'Chat') return;
        const textContent = typeof content === 'string'
            ? content
            : (Array.isArray(content) ? (content.find(p => p.type === "text")?.text || "") : "");
        const shortTitle = textContent.length > 30 ? textContent.substring(0, 30) + '...' : textContent;
        if (shortTitle) updateChatTitle(shortTitle);
    }

    async finalize({ processor, savedResponseTurn, responseDebugData, requestTurnInfo, requestId } = {}) {
        const rawContent = processor?.getRawContent?.() || "";
        updateChatPreview(this.chatId, rawContent);

        if (this.requestOrigin === "send") this._updateChatTitleFromMessage();

        if (savedResponseTurn?.turn_id) {
            const parentKey = this.parentTurnId || "root";
            const scopeKey = `${this.chatId}::${parentKey}`;
            selectedSiblings[scopeKey] = savedResponseTurn.turn_id;
            const scopedMap = Object.fromEntries(
                Object.entries(selectedSiblings).filter(([k]) => k.startsWith(`${this.chatId}::`))
            );
            saveBranchSelections(this.chatId, scopedMap).catch((e) =>
                logger.warn("[TURN] Failed to persist branch selection:", e)
            );
        }

        const responseTurnInfo = savedResponseTurn
            ? { turn_id: savedResponseTurn.turn_id, parent_turn_id: savedResponseTurn.parent_turn_id }
            : null;

        return { requestTurnInfo, responseTurnInfo, requestId };
    }

    _listenForRequestDebug(requestId, turnMessages) {
        if (!requestId) return;
        let source;
        try { source = new EventSource(`${window.location.origin}/api/tools/${requestId}`); } catch (error) { logger.warn('Failed to open request-debug event stream:', error); return; }
        source.onmessage = (event) => {
            let evt;
            try { evt = JSON.parse(event.data); } catch (_) { return; }
            if (evt.type !== 'request_debug') return;
            const requestDebugData = evt.data || {};
            requestDebugData.turnMessages = turnMessages;
            this._attachRequestDebugPanel(requestDebugData);
            source.close();
        };
        source.onerror = () => {};
    }

    _removeDescendantTurns(parentTurnId) {
        const container = this.truncateContainer || turnsContainer;
        const queue = [parentTurnId];
        while (queue.length > 0) {
            const currentParent = queue.shift();
            const children = container.querySelectorAll(
                `.turn[data-parent-turn-id="${currentParent}"]`
            );
            for (const child of children) {
                const childTurnId = child.dataset.turnId;
                child.remove();
                if (childTurnId) queue.push(childTurnId);
            }
        }
    }

    _attachRequestDebugPanel(requestDebugData) {
        const requestMessages = turnsContainer.querySelectorAll('.turn.request-turn, .message.user');
        const lastRequestMessage = requestMessages[requestMessages.length - 1];
        if (!lastRequestMessage) return;
        const messageId = lastRequestMessage.dataset.messageId || `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        lastRequestMessage.dataset.messageId = messageId;
        for (const sel of ['.debug-panel-container', '.debug-toggle']) {
            const el = lastRequestMessage.querySelector(sel);
            if (el) el.remove();
        }
        lastRequestMessage.classList.add('has-debug');
        const debugToggle = document.createElement('button');
        debugToggle.className = 'debug-toggle';
        debugToggle.dataset.messageId = messageId;
        debugToggle.innerHTML = '+';
        debugToggle.title = 'Show debug info';
        const settings = loadSettings();
        if (!settings.debugPanels) debugToggle.style.display = 'none';
        debugToggle.addEventListener('click', () => {
            const dp = lastRequestMessage.querySelector('.debug-panel-container');
            if (dp) { const h = dp.style.display === 'none'; dp.style.display = h ? 'block' : 'none'; debugToggle.innerHTML = h ? '−' : '+'; debugToggle.classList.toggle('active', h); }
        });
        // Place the toggle rightmost in the message-actions bar (next to branch nav),
        // matching addDebugPanel. Fall back to the turn if the bar isn't present yet.
        const rightCluster = lastRequestMessage.querySelector('.message-actions .message-actions-right');
        if (rightCluster) {
            rightCluster.appendChild(debugToggle);
        } else {
            lastRequestMessage.appendChild(debugToggle);
        }
        lastRequestMessage.appendChild(createDebugPanel(lastRequestMessage, messageId, requestDebugData, 0));
    }

    // Persist + render a request turn WITHOUT firing an API call. Used to queue
    // a steer: the message lands in the DB and the DOM immediately; the
    // continuation request is fired later when the in-flight stream breaks.
    async saveAndRender() {
        const requestTurnInfo = await this.saveRequest(null);
        // requestId=null → renderRequestTurn skips the request-debug listener;
        // there is no API call associated with the enqueue itself.
        await this.renderRequestTurn(requestTurnInfo, null);
        return requestTurnInfo;
    }

    async execute() {
        const requestId = TurnRequest.generateRequestId();
        const requestTurnInfo = await this.saveRequest(requestId);

        // Remove previous turns for this lineage if retrying
        if (this.truncateContainer && this.turnId) {
            const oldResponse = this.truncateContainer.querySelector(
                `.response-turn[data-parent-turn-id="${this.turnId}"]`
            );
            if (oldResponse) {
                const removedTurnId = oldResponse.dataset.turnId;
                oldResponse.remove();
                // Remove all descendants of the old response (cascading branch removal)
                if (removedTurnId) {
                    this._removeDescendantTurns(removedTurnId);
                }
            }

            if (this.requestOrigin === "edit_retry") {
                const oldRequest = this.truncateContainer.querySelector(
                    `.request-turn[data-turn-id="${this.turnId}"]`
                );
                if (oldRequest) oldRequest.remove();
            }
        }

        await this.renderRequestTurn(requestTurnInfo, requestId);

        const lineage = this.computeLineageIds(requestTurnInfo);

        const effectiveRequestTurnInfo =
            requestTurnInfo || (this.requestOrigin === "retry" && this.turnId
                ? { turn_id: this.turnId, parent_turn_id: this.parentTurnId }
                : null);

        const container = this.truncateContainer || turnsContainer;

        const requestInfo = this.initiateApiCall(
            requestId,
            lineage.effectiveParentTurnId,
            lineage.effectiveTurnId,
            lineage.effectiveHistoryAnchor
        );

        // A steering continuation skips renderRequestTurn, so wire its
        // request-debug panel onto the last steer turn here instead.
        if (this.requestOrigin === "steer_continuation") {
            this._listenForRequestDebug(requestId, this.messages);
        }

        const result = await this.stream({
            fetchPromise: requestInfo.fetchPromise,
            requestId,
            requestTurnInfo: effectiveRequestTurnInfo,
            container,
            expectedParentTurnId: lineage.effectiveParentTurnId,
            abortController: requestInfo.controller
        });

        await this.finalize({
            processor: result.processor,
            savedResponseTurn: result.savedResponseTurn,
            responseDebugData: result.responseDebugData,
            requestTurnInfo,
            requestId
        });

        // At the stream break, drain any steers queued for this chat and
        // continue the conversation from them.
        await this._maybeContinueSteering(result.savedResponseTurn);

        return { requestTurnInfo, responseTurnInfo: null, requestId };
    }

    // After a stream break, drain queued steers and fire a single continuation.
    // No lineage surgery: each steer was already saved with its correct parent
    // at enqueue time (§3.1). Re-runs (via the continuation's own execute) until
    // the queue is empty, so steers that arrive mid-continuation are caught (§5.7).
    async _maybeContinueSteering(savedResponseTurn) {
        const chatId = this.chatId;
        // Steer saves are serialized on streamManager.steerChain; wait for any
        // in-flight save to settle so the queue holds their backend-minted
        // turn_ids (and DB rows exist) before we build the continuation.
        const chain = streamManager.steerChain.get(chatId);
        if (chain) { try { await chain; } catch (_) {} }
        const steers = streamManager.drainSteeringQueue(chatId);
        if (!steers || steers.length === 0) return;

        for (const steer of steers) {
            const el = turnsContainer.querySelector(`.request-turn[data-turn-id="${steer.turnId}"]`);
            if (!el) continue;
            // Drain wins over an open edit: discard any in-progress edit on a
            // steer we're about to answer (§5.6).
            if (el.classList.contains("editing") && typeof chatRenderer?.cancelTurnEdit === "function") {
                chatRenderer.cancelTurnEdit(el);
            }
        }

        // Reconcile the just-broken response turn from the DB. A break ends the
        // turn the instant the tool round finishes, which races the tool-result
        // event (`tool_execution_complete`) — that event rides the separate
        // /api/tools EventSource channel and can lose to the main stream's `done`,
        // leaving the live dropdown stuck on "Executing...". The DB already has
        // the result (saved before `done`), so re-render that one turn from it.
        if (savedResponseTurn?.turn_id && currentChatId === chatId
            && typeof chatRenderer?.rerenderTurnInPlace === "function") {
            await chatRenderer.rerenderTurnInPlace(savedResponseTurn.turn_id);
        }

        // The steers were appended while the response was still streaming, so the
        // DOM currently has them above the final response. Put the response back
        // on top to match the linear lineage order.
        this._reorderResponseBeforeSteers(savedResponseTurn?.turn_id, steers);

        const last = steers[steers.length - 1];
        const cont = new TurnRequest({
            messages: steers.map(s => ({ role: "user", content: s.content })),
            parentTurnId: last.parentTurnId,
            turnId: last.turnId,
            requestOrigin: "steer_continuation",
            chatId,
        });
        await cont.execute();
    }

    _reorderResponseBeforeSteers(responseTurnId, steers) {
        if (!responseTurnId || !steers.length) return;
        const responseEl = turnsContainer.querySelector(`.response-turn[data-turn-id="${responseTurnId}"]`);
        const firstSteerEl = turnsContainer.querySelector(`.request-turn[data-turn-id="${steers[0].turnId}"]`);
        if (!responseEl || !firstSteerEl) return;
        // If the first steer currently precedes the response, move the response
        // up so the visual order matches the lineage (response → steers).
        const pos = responseEl.compareDocumentPosition(firstSteerEl);
        if (pos & Node.DOCUMENT_POSITION_PRECEDING) {
            firstSteerEl.parentNode.insertBefore(responseEl, firstSteerEl);
        }
    }
}
