// Slash Commands - "/" command palette for the chat input.
//
// When the input's first character is "/", a filtered popup of commands appears above
// the input. Tab (or Enter on the highlighted item) completes the command; Arrow keys
// move the selection; Escape dismisses. A command whose input is submitted runs its
// handler instead of being sent to the model.
//
// The registry is intentionally tiny and open for extension — add entries to
// SLASH_COMMANDS. Each command: { name, args?, description, run(argStr) }.

const SLASH_COMMANDS = [
    {
        name: "compact",
        args: "",
        description: "Compact this chat's context — summarize older turns into an anchored summary.",
        run: (argStr) => runCompactCommand(argStr),
    },
];

// --- matching -----------------------------------------------------------------

// Split "/compact truncate" -> { cmd: "compact", rest: "truncate" }. Leading slash
// already guaranteed by the caller. rest is the raw remainder (may be empty).
function parseSlashInput(value) {
    const withoutSlash = value.slice(1);
    const spaceIdx = withoutSlash.indexOf(" ");
    if (spaceIdx === -1) return { cmd: withoutSlash, rest: "", complete: false };
    return {
        cmd: withoutSlash.slice(0, spaceIdx),
        rest: withoutSlash.slice(spaceIdx + 1),
        complete: true, // a space was typed, so the command name is committed
    };
}

// Fuzzy-ish prefix/substring match, ranked: exact prefix beats substring.
function matchCommands(cmdFragment) {
    const frag = (cmdFragment || "").toLowerCase();
    if (!frag) return SLASH_COMMANDS.slice();
    const scored = [];
    for (const c of SLASH_COMMANDS) {
        const name = c.name.toLowerCase();
        if (name.startsWith(frag)) scored.push({ c, score: 0 });
        else if (name.includes(frag)) scored.push({ c, score: 1 });
    }
    scored.sort((a, b) => a.score - b.score);
    return scored.map((s) => s.c);
}

// --- popup state --------------------------------------------------------------

let popupEl = null;
let activeMatches = [];
let selectedIndex = 0;

function isPopupOpen() {
    return popupEl !== null;
}

function ensurePopup() {
    if (popupEl) return popupEl;
    popupEl = document.createElement("div");
    popupEl.className = "slash-command-popup";
    // Anchor it above the input, inside the input container so it positions correctly.
    const container = document.getElementById("inputContainer") || document.body;
    container.appendChild(popupEl);
    return popupEl;
}

function closeSlashPopup() {
    if (popupEl) {
        popupEl.remove();
        popupEl = null;
    }
    activeMatches = [];
    selectedIndex = 0;
}

function renderPopup() {
    const el = ensurePopup();
    el.innerHTML = "";
    if (activeMatches.length === 0) {
        closeSlashPopup();
        return;
    }
    activeMatches.forEach((cmd, i) => {
        const row = document.createElement("div");
        row.className = "slash-command-item" + (i === selectedIndex ? " selected" : "");
        row.innerHTML = `
            <div class="slash-command-name">/${escapeHtml(cmd.name)}${cmd.args ? ` <span class="slash-command-args">${escapeHtml(cmd.args)}</span>` : ""}</div>
            <div class="slash-command-desc">${escapeHtml(cmd.description)}</div>
        `;
        row.addEventListener("mousedown", (e) => {
            // mousedown (not click) so it fires before the input blurs.
            e.preventDefault();
            completeCommand(activeMatches[i]);
        });
        el.appendChild(row);
    });
}

// Fill the input with the chosen command name + trailing space, ready for args.
function completeCommand(cmd) {
    const input = messageInput;
    input.value = `/${cmd.name} `;
    input.focus();
    // Move caret to end.
    input.selectionStart = input.selectionEnd = input.value.length;
    closeSlashPopup();
}

// --- public hooks (called from ui.js) -----------------------------------------

// Called on every input event. Opens/updates/closes the popup based on the value.
function handleSlashInput() {
    const value = messageInput.value;
    if (!value.startsWith("/")) {
        closeSlashPopup();
        return;
    }
    const { cmd, complete } = parseSlashInput(value);
    // Once a space commits the command name, the popup gets out of the way (the user
    // is typing args now).
    if (complete) {
        closeSlashPopup();
        return;
    }
    activeMatches = matchCommands(cmd);
    selectedIndex = 0;
    renderPopup();
}

// Called from the input keydown handler BEFORE the send logic. Returns true if the
// keystroke was consumed by the palette (caller should stop).
function handleSlashKeydown(e) {
    if (!isPopupOpen()) return false;

    if (e.key === "ArrowDown") {
        e.preventDefault();
        selectedIndex = (selectedIndex + 1) % activeMatches.length;
        renderPopup();
        return true;
    }
    if (e.key === "ArrowUp") {
        e.preventDefault();
        selectedIndex = (selectedIndex - 1 + activeMatches.length) % activeMatches.length;
        renderPopup();
        return true;
    }
    if (e.key === "Tab") {
        e.preventDefault();
        const chosen = activeMatches[selectedIndex];
        if (chosen) completeCommand(chosen);
        return true;
    }
    if (e.key === "Escape") {
        e.preventDefault();
        closeSlashPopup();
        return true;
    }
    if (e.key === "Enter" && !e.shiftKey) {
        // If the highlighted command matches exactly what's typed (no args form),
        // Enter completes it; otherwise let Enter fall through to run/submit.
        const { rest } = parseSlashInput(messageInput.value);
        if (!rest) {
            e.preventDefault();
            const chosen = activeMatches[selectedIndex];
            if (chosen) completeCommand(chosen);
            return true;
        }
    }
    return false;
}

// Called from onSubmitRequest BEFORE building a message. If the input is a slash
// command, run it and return true (so the normal send is skipped).
async function maybeRunSlashCommand() {
    const value = messageInput.value;
    if (!value.startsWith("/")) return false;
    const { cmd, rest } = parseSlashInput(value.trim());
    const match = SLASH_COMMANDS.find((c) => c.name.toLowerCase() === cmd.toLowerCase());
    if (!match) return false; // unknown command → send as a normal message

    closeSlashPopup();
    messageInput.value = "";
    try {
        await match.run(rest.trim());
    } catch (error) {
        logger.error(`Slash command /${cmd} failed:`, error);
        showError(`/${cmd} failed: ${error.message}`);
    }
    return true;
}

// --- /compact -----------------------------------------------------------------

async function runCompactCommand(argStr) {
    const chatId = currentChatId;
    const anchorTurnId = await getActiveTerminalTurnId(chatId);
    await runCompaction(chatId, { anchorTurnId });
    messageInput.focus();
}

// Shared compaction runner used by the /compact command and auto-compact-on-overflow.
// Compaction is summarize-only. Streams the summary LIVE into the Compaction Response
// dropdown (via the request-scoped /api/tools SSE channel), and shows the chat-list
// spinner for this chat. Returns the server result ({ success, ... }).
// `retryResponseRequestTurnId` (optional): when set, this is a RESPONSE retry — regenerate
// the summary under that EXISTING compaction request (new response sibling, request
// untouched). The branch then happens on the RESPONSE (fork = the request turn, keyed to
// the new response id at `compaction_done`), mirroring a normal assistant-response retry.
// When unset, it's a request-level compaction (fork = the anchor, keyed to the new request
// at `compaction_start`).
async function runCompaction(chatId, { anchorTurnId, promptOverride = null, retryResponseRequestTurnId = null } = {}) {
    setLoading(true);
    const isResponseRetry = !!retryResponseRequestTurnId;

    // Mint a request id so we can subscribe to the summary stream BEFORE the POST
    // returns. Events are buffered server-side, so connecting slightly late is safe.
    const requestId = `cmp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    if (typeof streamManager?.updateStreamIndicator === "function") {
        streamManager.updateStreamIndicator(chatId, true);
    }

    // Live flow mirrors a normal Edit & Retry (TurnRequest): the request row is already
    // in the DB when `compaction_start` fires, so we SWITCH the branch to it and reload
    // FIRST — via the same loadChatHistory pathway that renders every turn with its branch
    // nav — and only THEN stream the summary into the response box on the switched branch.
    // Doing the switch first (not last) is what makes the old branch vanish, the new
    // request box + nav appear immediately, and the summary land in the right place.
    //
    // `compaction_delta` can arrive before that async switch finishes, so deltas are
    // buffered until the live response box exists, then flushed — nothing is dropped.
    let live = null;
    let switching = null;      // promise for the start-time switch+reload+open sequence
    let pendingSummary = "";   // deltas that arrived before `live` existed
    let source = null;
    try {
        source = new EventSource(`${API_BASE}/api/tools/${requestId}`);
        source.onmessage = (event) => {
            let evt;
            try { evt = JSON.parse(event.data); } catch (_) { return; }
            if (chatId !== currentChatId) return;
            if (evt.type === "compaction_start") {
                const startData = evt.data || {};
                const newReqTurnId = startData.request_turn_id || null;
                const parentKey = startData.parent_turn_id || "root";
                switching = (async () => {
                    // Switch to the new request sibling and persist BEFORE the reload
                    // (loadChatHistory re-seeds selectedSiblings from the DB), same as
                    // TurnRequest's edit_retry path. First-time /compact has one sibling,
                    // so this is a harmless no-op there.
                    if (newReqTurnId) {
                        selectedSiblings[`${chatId}::${parentKey}`] = newReqTurnId;
                        const scopedMap = Object.fromEntries(
                            Object.entries(selectedSiblings).filter(([k]) => k.startsWith(`${chatId}::`))
                        );
                        try { await saveBranchSelections(chatId, scopedMap); }
                        catch (e) { logger.warn("[COMPACT] Failed to persist branch selection:", e); }
                    }
                    if (chatId === currentChatId) await loadChatHistory(chatId);
                    // For a RESPONSE retry the request box is unchanged and already on
                    // screen, but the reload also rendered the OLD response under it. Remove
                    // that old response node so the live one streams in its place (not below
                    // a stale sibling). The new response is selected at `compaction_done`.
                    if (isResponseRetry && newReqTurnId) {
                        document
                            .querySelectorAll(`.compaction-response-turn[data-parent-turn-id="${newReqTurnId}"]`)
                            .forEach((el) => el.remove());
                    }
                    // Open the live response beneath the request (parent = the request turn)
                    // and flush any deltas that arrived while we were switching.
                    if (typeof chatRenderer?.startCompactionStream === "function") {
                        live = chatRenderer.startCompactionStream({ parentTurnId: newReqTurnId });
                        if (pendingSummary) { live.appendSummary(pendingSummary); pendingSummary = ""; }
                    }
                })();
            } else if (evt.type === "compaction_delta") {
                const text = evt.data?.text || "";
                if (live) live.appendSummary(text);
                else pendingSummary += text; // buffer until the switch opens the live box
            } else if (evt.type === "compaction_done") {
                // For a RESPONSE retry, the fork is on the response: select the NEW response
                // (turn_id) under its request so the final reload lands on it. (For a request
                // compaction the switch already happened at `start`.)
                if (isResponseRetry && evt.data?.turn_id && evt.data?.request_turn_id) {
                    selectedSiblings[`${chatId}::${evt.data.request_turn_id}`] = evt.data.turn_id;
                    const scopedMap = Object.fromEntries(
                        Object.entries(selectedSiblings).filter(([k]) => k.startsWith(`${chatId}::`))
                    );
                    saveBranchSelections(chatId, scopedMap).catch((e) =>
                        logger.warn("[COMPACT] Failed to persist response-retry selection:", e));
                }
                // Finalize only after the switch has opened the live box (and flushed).
                const finish = () => { if (live) live.finalize(evt.data); };
                if (switching) switching.then(finish); else finish();
            } else if (evt.type === "compaction_failed") {
                const fail = () => { if (live) { live.remove(); live = null; } };
                if (switching) switching.then(fail); else fail();
            }
        };
        source.onerror = () => {};
    } catch (_) { /* streaming is best-effort; the POST still completes */ }

    try {
        const result = isResponseRetry
            ? await retryCompactionResponse(chatId, { requestTurnId: retryResponseRequestTurnId, requestId })
            : await compactChatContext(chatId, { anchorTurnId, requestId, promptOverride });
        if (!result.success) {
            // summary_failed: the request was persisted (and we already switched to it at
            // `compaction_start`); the summary call errored. Reload shows the orphan request
            // from the DB — retryable via its Edit & Retry.
            if (result.reason === "summary_failed") {
                if (chatId === currentChatId) await loadChatHistory(chatId);
                showError(`Compact: summary failed — ${result.error || "provider error"}. The request was kept; retry from its Edit & Retry.`);
                return result;
            }
            // empty_history / nothing_to_compact: no request was persisted; clear the UI.
            const reasonText = {
                empty_history: "this chat is empty.",
                nothing_to_compact: "the whole chat is within your kept-turns count — nothing older to fold. Lower \"Keep recent turns\" in the Tokens tab to compact.",
            }[result.reason] || `compaction did not run (${result.reason}).`;
            if (live) live.remove();
            showError(`Compact: ${reasonText}`);
            return result;
        }
        // The branch was already switched at `compaction_start` (see the SSE handler).
        // Let the switch/stream sequence settle, then reload so the pair renders from the
        // DB (canonical) and the lineage is trimmed — replacing the live dropdown.
        if (switching) { try { await switching; } catch (_) {} }
        if (chatId === currentChatId) await loadChatHistory(chatId);
        return result;
    } catch (error) {
        if (live) live.fail(error.message);
        throw error;
    } finally {
        if (source) { try { source.close(); } catch (_) {} }
        // If we reloaded, the live dropdown was replaced by loadChatHistory; otherwise
        // clear any leftover progress node.
        if (typeof chatRenderer?.removeCompactionProgress === "function") {
            chatRenderer.removeCompactionProgress();
        }
        if (typeof streamManager?.updateStreamIndicator === "function") {
            if (!(streamManager.isStreaming && streamManager.isStreaming(chatId))) {
                streamManager.updateStreamIndicator(chatId, false);
            }
        }
        setLoading(false);
    }
}

window.runCompaction = runCompaction;
window.handleSlashInput = handleSlashInput;
window.handleSlashKeydown = handleSlashKeydown;
window.maybeRunSlashCommand = maybeRunSlashCommand;
window.closeSlashPopup = closeSlashPopup;
