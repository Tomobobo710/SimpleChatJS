// Compaction Service - Context compaction for chats.
//
// A compaction is persisted as an ordinary message row with turn_type='compaction'.
// It carries the (optional) summary text in `content` and a `debug_data.compaction`
// blob describing HOW it was made (which turns it covers/keeps, the prompt, and the
// model used). Because it lives in the
// normal lineage (its own turn_id, parent_turn_id = the last turn it covers), it:
//   - survives reload for free,
//   - participates in branch/steer/retry lineage ordering,
//   - is returned by both the UI history endpoint and getChatHistoryForAPI.
//
// applyCompaction() is the history transform: given the already-assembled linear AI
// message array (from getChatHistoryForAPI), it finds the latest compaction boundary
// and drops the messages the boundary replaces, keeping [summary?, ...messagesAfter].
// The compaction record itself is strategy-agnostic to the transform — the record just
// declares its boundary and (optionally) a summary system message to inject.

const https = require("https");
const http = require("http");
const { log } = require("../utils/logger");
const { getCurrentSettings, DEFAULT_COMPACTION_TEMPLATE } = require("./settingsService");
const { saveMessage, getChatHistoryForAPI } = require("./messageRepository");
const { getTurnInfo, getAncestorTurnIds } = require("./turnService");
const responseAdapterFactory = require("../adapters/ResponseAdapterFactory");
const UnifiedResponse = require("../adapters/UnifiedResponse");
const { addToolEvent } = require("./toolEventService");


const TOOL_OUTPUT_MAX_CHARS = 2000;

function truncate(str, max = TOOL_OUTPUT_MAX_CHARS) {
    if (typeof str !== "string") str = JSON.stringify(str ?? "");
    return str.length <= max ? str : str.slice(0, max) + "\n[truncated]";
}

// Flatten one AI message into a readable transcript line for the summary prompt.
function serializeMessage(msg) {
    const textOf = (content) => {
        if (typeof content === "string") return content;
        if (Array.isArray(content)) {
            return content
                .map((p) => (p.type === "text" ? p.text : `[${p.type}]`))
                .filter(Boolean)
                .join("\n");
        }
        return "";
    };

    if (msg.role === "user") return `[User]: ${textOf(msg.content)}`;
    if (msg.role === "system") return `[System]: ${textOf(msg.content)}`;
    if (msg.role === "tool") return `[Tool result]: ${truncate(textOf(msg.content))}`;
    if (msg.role === "assistant") {
        const parts = [];
        const text = textOf(msg.content);
        if (text) parts.push(`[Assistant]: ${text}`);
        if (msg.reasoning) parts.push(`[Assistant reasoning]: ${truncate(msg.reasoning)}`);
        if (Array.isArray(msg.tool_calls)) {
            for (const tc of msg.tool_calls) {
                const name = tc.function?.name || "tool";
                const args = tc.function?.arguments || "";
                parts.push(`[Assistant tool call]: ${name}(${truncate(args, 500)})`);
            }
        }
        return parts.join("\n");
    }
    return "";
}

// The compaction prompt TEMPLATE — user-editable (System tab, compactionPromptTemplate);
// falls back to the shipped default. It's the instruction/template/rules middle of the
// prompt; the dynamic head and history wrapper are added around it below.
function summaryTemplate() {
    const s = getCurrentSettings() || {};
    const t = typeof s.compactionPromptTemplate === "string" ? s.compactionPromptTemplate.trim() : "";
    return t || DEFAULT_COMPACTION_TEMPLATE;
}

// Build the prompt SHELL: the dynamic instruction (create / update-with-previous-summary)
// + the editable template/rules. The SHELL contains NO transcript and no placeholder —
// the conversation history is appended AFTER it at model-call time (expandSummaryPrompt).
// This is what's stored on the request row, shown in the dropdown, and edited by Edit &
// Retry — so the transcript is uneditable by construction (it isn't in the shell).
function buildSummaryPromptShell(previousSummary) {
    const head = previousSummary
        ? `Update the anchored summary below using the conversation history that follows.\nPreserve still-true details, remove stale details, and merge in the new facts.\n<previous-summary>\n${previousSummary}\n</previous-summary>`
        : "Create a new anchored summary from the conversation history that follows.";
    return `${head}\n\n${summaryTemplate()}`;
}

// The actual prompt sent to the model = the shell, then the transcript wrapped in a
// <conversation-history> block appended after it.
function expandSummaryPrompt(shell, transcript) {
    return `${shell}\n\n<conversation-history>\n${transcript}\n</conversation-history>`;
}

// STREAM a summary completion from the active provider, invoking onDelta(text) for
// each new chunk of assistant text as it arrives, and resolving with the full text.
// Reuses the adapter's request conversion + streaming chunk parser (processChunk),
// so it handles every provider the normal response path does. onDelta lets callers
// forward the summary to the UI live (SSE), the same way tool dropdowns stream.
function requestSummary(promptText, onDelta) {
    return new Promise((resolve, reject) => {
        const settings = getCurrentSettings();
        const adapter = responseAdapterFactory.getAdapter(settings);

        const unified = responseAdapterFactory.createUnifiedRequest(
            [{ role: "user", content: promptText }],
            [],
            settings.modelName
        );
        const requestData = adapter.convertRequest(unified, settings);
        requestData.stream = true;
        // Never let tools sneak into a summary call.
        delete requestData.tools;

        const targetUrl = adapter.getEndpointUrl(settings);
        const headers = { ...adapter.getHeaders(settings) };
        const body = JSON.stringify(requestData);
        headers["Content-Length"] = Buffer.byteLength(body);

        const url = new URL(targetUrl);
        const options = {
            hostname: url.hostname,
            port: url.port,
            path: url.pathname + url.search,
            method: "POST",
            headers,
        };
        const transport = url.protocol === "https:" ? https : http;

        const response = new UnifiedResponse().setProvider(adapter.providerName);
        const context = adapter.createContext(settings.modelName, null);
        let emitted = 0; // chars of response.content already forwarded via onDelta

        const flushDelta = () => {
            const full = response.content || "";
            if (full.length > emitted) {
                const delta = full.slice(emitted);
                emitted = full.length;
                if (typeof onDelta === "function") {
                    try { onDelta(delta); } catch (_) {}
                }
            }
        };

        const apiReq = transport.request(options, (apiRes) => {
            if (apiRes.statusCode !== 200) {
                let errRaw = "";
                apiRes.on("data", (c) => (errRaw += c));
                apiRes.on("end", () => reject(new Error(`Summary provider error [${apiRes.statusCode}]: ${truncate(errRaw, 500)}`)));
                return;
            }
            apiRes.on("data", (chunk) => {
                try {
                    adapter.processChunk(chunk, response, context);
                    flushDelta();
                } catch (e) {
                    // A malformed chunk shouldn't abort the whole summary; keep going.
                    log(`[COMPACT] summary chunk parse error: ${e.message}`);
                }
            });
            apiRes.on("end", () => {
                flushDelta();
                const text = (response.content || "").trim();
                if (!text) return reject(new Error("Summary provider returned empty text"));
                resolve(text);
            });
        });
        apiReq.on("error", reject);
        apiReq.write(body);
        apiReq.end();
    });
}

// A compaction is a request/response PAIR of ordinary message rows, exactly like a
// normal user/assistant exchange — and, like one, the REQUEST is persisted FIRST (it's
// the call we're about to make), then the RESPONSE is persisted when it comes back.
//   - compaction_request: role 'user'. content = the prompt SHELL (instruction +
//     template; NO transcript — that's appended at send time). OWNS the boundary metadata
//     (coveredTurnIds/keptTurnIds/model) + the expanded prompt (debug panel).
//   - compaction_response: role 'system'. content = the summary. Links back to its
//     request (requestTurnId); where applyCompaction starts collection.
// Request and response are related but NOT the same node. A request may exist WITHOUT a
// response (the summary call failed) — that orphan stays, is retryable, and is ignored
// by applyCompaction (which keys off the response).

// Persist the compaction request up front, before the model call.
async function saveCompactionRequest(chatId, {
    promptShell, expandedPrompt, parentTurnId, coveredTurnIds, keptTurnIds, model,
}) {
    const reqInfo = getTurnInfo(parentTurnId, null);
    reqInfo.turn_type = "compaction_request";
    const requestMeta = {
        coveredTurnIds, keptTurnIds,
        model: model || null,
        expandedPrompt,          // the real prompt sent — surfaced in the debug panel
        createdAt: new Date().toISOString(),
    };
    await saveMessage(chatId, {
        role: "user",
        content: promptShell || "",
        turn_type: "compaction_request",
        debug_data: { compaction: requestMeta },
    }, reqInfo, null);
    return { request_turn_id: reqInfo.turn_id, parent_turn_id: reqInfo.parent_turn_id, meta: requestMeta };
}

// Persist the compaction response after the summary streams, parented on the request.
// The response turn is SELF-CONTAINED — it holds everything below the hard boundary:
//   1. the summary as a `system` message (first), then
//   2. a COPY of each kept-tail message (roles preserved), as its own new row sharing
//      this turn's turn_id.
// This is what makes the boundary hard: collection never looks above the line — it takes
// this turn's messages (summary + kept copies) + everything after. The originals above
// stay as frozen archive. `keptMessages` = the raw kept-tail message objects to copy.
async function saveCompactionResponse(chatId, {
    summary, requestTurnId, keptMessages, coveredTurnIds, keptTurnIds, model,
}) {
    const resInfo = getTurnInfo(requestTurnId, null);
    resInfo.turn_type = "compaction_response";
    const responseMeta = {
        requestTurnId,
        // Informational only now (debug panel / "what was folded/kept"); NOT used by
        // collection, which slices at the boundary rather than subtracting by id.
        coveredTurnIds, keptTurnIds,
        model: model || null,
        createdAt: new Date().toISOString(),
    };

    // 1) The summary (system), first message of the turn.
    await saveMessage(chatId, {
        role: "system",
        content: summary || "",
        turn_type: "compaction_response",
        debug_data: { compaction: responseMeta },
    }, resInfo, null);

    // 2) A copy of each kept-tail message, sharing this turn's turn_id (so they belong to
    //    the response turn). compaction_kept marks them as boundary-carried copies —
    //    rendered only inside the dropdown, never as standalone chat turns.
    for (const km of (keptMessages || [])) {
        await saveMessage(chatId, {
            role: km.role,
            content: km.content,
            tool_calls: km.tool_calls || null,
            tool_call_id: km.tool_call_id || null,
            tool_name: km.tool_name || null,
            reasoning: km.reasoning || null,
            turn_type: "compaction_kept",
        }, resInfo, null);
    }

    return { turn_id: resInfo.turn_id, parent_turn_id: resInfo.parent_turn_id, meta: responseMeta };
}

// Group a linear AI-message array into turns (by turn_id), preserving order. Each
// turn carries its parent_turn_id and turn_type. Used to decide the compaction split.
function groupTurns(messages) {
    const turns = [];
    const index = new Map();
    for (const m of messages) {
        const key = m.turn_id || "__none__";
        if (!index.has(key)) {
            const t = { turnId: m.turn_id || null, parentTurnId: m.parent_turn_id || null, turnType: m.turn_type || null, messages: [] };
            index.set(key, t);
            turns.push(t);
        }
        index.get(key).messages.push(m);
    }
    return turns;
}

// Boundary turn types a compaction emits: the request, the response (summary), and the
// copied kept messages. They are NOT source conversation content — they define/carry the
// boundary. Excluded from what a re-compaction folds, and stripped when no boundary
// applies. (compaction_kept rows share the response's turn_id, so at the TURN level they
// group under the response; this set matters at the message level.)
const BOUNDARY_TURN_TYPES = new Set(["compaction_request", "compaction_response", "compaction_kept"]);
function isBoundaryTurnType(t) { return BOUNDARY_TURN_TYPES.has(t); }

// Latest summary text on the SAME BRANCH as the anchor (newest compaction_response
// among the anchor's ancestor turn IDs wins), or null. Lineage-scoped so a summary
// from a different branch never leaks into this branch's prompt shell. Returns null
// if the anchor has no compaction ancestor (first compaction on this branch).
function getLatestSummary(chatId, anchorTurnId = null) {
    const { db } = require("../config/database");
    if (!anchorTurnId) return null;
    const ancestorIds = getAncestorTurnIds(chatId, anchorTurnId);
    if (!ancestorIds.length) return null;
    const placeholders = ancestorIds.map(() => "?").join(",");
    const row = db
        .prepare(`SELECT content FROM messages WHERE chat_id = ? AND turn_type = 'compaction_response' AND content != '' AND turn_id IN (${placeholders}) ORDER BY id DESC LIMIT 1`)
        .get(chatId, ...ancestorIds);
    return row ? row.content : null;
}

// Run a compaction for a chat on the active branch. `anchorTurnId` restricts history
// to that lineage (pass the current terminal turn); null = full history.
// One control: keep the last N turns (from settings, default 4; 0 = keep none), fold the
// rest into the summary. No token budget, no threshold, no guard — if you asked to
// compact, it compacts. The only non-op is an empty chat.
// Returns { ok, record, reason }.
// `promptOverride` (optional): an edited prompt SHELL to use instead of the templated
// one — from Edit & Retry on a compaction request. The fresh transcript is appended
// after it, so the override is just the instruction/template text.
async function compactChat(chatId, { keepTurns, anchorTurnId = null, requestId = null, promptOverride = null } = {}) {
    const s = getCurrentSettings() || {};
    const keep = Number.isFinite(keepTurns)
        ? keepTurns
        : (Number.isFinite(s.compactionKeepTurns) ? s.compactionKeepTurns : 4);

    const messages = getChatHistoryForAPI(chatId, anchorTurnId);
    if (!messages.length) return { ok: false, reason: "empty_history" };

    // Content turns only (prior compaction boundary turns aren't content). Keep the last
    // `keep` of them; fold everything older into the summary.
    const turns = groupTurns(messages);
    const contentTurns = turns.filter((t) => !isBoundaryTurnType(t.turnType));
    if (contentTurns.length === 0) return { ok: false, reason: "empty_history" };

    const keepN = Math.max(0, Math.floor(keep) || 0);
    const splitAt = Math.max(0, contentTurns.length - keepN);
    const headTurns = contentTurns.slice(0, splitAt);
    const tailTurns = contentTurns.slice(splitAt);

    // Nothing older than the kept tail — the keep count already covers the whole chat.
    if (headTurns.length === 0) return { ok: false, reason: "nothing_to_compact" };

    const coveredTurnIds = headTurns.map((t) => t.turnId).filter(Boolean);
    const keptTurnIds = tailTurns.map((t) => t.turnId).filter(Boolean);
    // The kept tail's messages — these get COPIED into the response turn (the hard
    // boundary carries everything below it). Roles/tool fields preserved.
    const keptMessages = tailTurns.flatMap((t) => t.messages).map((m) => ({
        role: m.role,
        content: m.content,
        tool_calls: m.tool_calls || null,
        tool_call_id: m.tool_call_id || null,
        tool_name: m.tool_name || null,
        reasoning: m.reasoning || null,
    }));
    // Parent = the terminal turn of the branch, so the compaction pair threads inline at
    // the tip (it becomes the new leaf); the next user message parents onto it.
    const parentTurnId =
        anchorTurnId ||
        keptTurnIds[keptTurnIds.length - 1] ||
        coveredTurnIds[coveredTurnIds.length - 1] ||
        null;

    // Find a previous summary to update rather than start fresh. Compaction records
    // are lineage-transparent (their parent is the last covered turn, not on the tail's
    // ancestor chain), so the anchored history query may not include them — look the
    // latest one up directly instead of scanning `turns`.
    const previousSummary = getLatestSummary(chatId, anchorTurnId);

    // Compaction is summarize-only. Build the prompt SHELL (stored on the request), then
    // append the transcript for the model call. An edited shell (Edit & Retry) is used
    // verbatim; the transcript is appended after it either way.
    const headMessages = headTurns.flatMap((t) => t.messages);
    const transcript = headMessages.map(serializeMessage).filter(Boolean).join("\n\n");
    const promptShell = (promptOverride && promptOverride.trim())
        ? promptOverride
        : buildSummaryPromptShell(previousSummary);
    const expandedPrompt = expandSummaryPrompt(promptShell, transcript);
    const model = getCurrentSettings().modelName || null;

    log(`[COMPACT] Summarizing ${headMessages.length} message(s) across ${headTurns.length} turn(s) for chat ${chatId}`);

    // 1) Persist the REQUEST up front — it's the call we're about to make. It exists in
    //    the DB (and renders) before the model responds, just like a normal request.
    const req = await saveCompactionRequest(chatId, {
        promptShell, expandedPrompt, parentTurnId, coveredTurnIds, keptTurnIds, model,
    });

    // Announce start WITH the request turn so the client can render the request turn
    // immediately, then stream the response beneath it.
    if (requestId) {
        addToolEvent(requestId, {
            type: "compaction_start",
            data: {
                strategy: "summarize", model, coveredTurnCount: headTurns.length,
                request_turn_id: req.request_turn_id,
                parent_turn_id: req.parent_turn_id,
                shell: promptShell,
                coveredTurnIds, keptTurnIds, expandedPrompt,
            },
        });
    }

    // 2) Stream the summary. On failure the request row STAYS (orphan, retryable) — we
    //    surface the error and let the caller decide; applyCompaction ignores it.
    let summary;
    try {
        summary = await requestSummary(expandedPrompt, (delta) => {
            if (requestId) addToolEvent(requestId, { type: "compaction_delta", data: { text: delta } });
        });
    } catch (err) {
        log(`[COMPACT] Summary failed; leaving orphan request ${req.request_turn_id}: ${err.message}`);
        if (requestId) {
            addToolEvent(requestId, {
                type: "compaction_failed",
                data: { request_turn_id: req.request_turn_id, message: err.message },
            });
        }
        return { ok: false, reason: "summary_failed", request: req, error: err.message };
    }

    // 3) Persist the RESPONSE parented on the request — summary + copied kept messages.
    const res = await saveCompactionResponse(chatId, {
        summary, requestTurnId: req.request_turn_id, keptMessages, coveredTurnIds, keptTurnIds, model,
    });

    if (requestId) {
        addToolEvent(requestId, {
            type: "compaction_done",
            data: {
                turn_id: res.turn_id,
                parent_turn_id: res.parent_turn_id,
                request_turn_id: req.request_turn_id,
                summary, coveredTurnIds, keptTurnIds, model,
            },
        });
    }

    log(`[COMPACT] Saved compaction for chat ${chatId} (response turn ${res.turn_id})`);
    return { ok: true, record: { request_turn_id: req.request_turn_id, turn_id: res.turn_id, parent_turn_id: res.parent_turn_id, meta: res.meta } };
}

// Retry a compaction RESPONSE: regenerate ONLY the summary, parented on the EXISTING
// request — a new response sibling under the same request, exactly like retrying a normal
// assistant response makes a new response under the same user turn. The request is NOT
// touched (no new request row), so the branch happens on the response, not the request.
// Reuses the request's stored prompt + boundary metadata verbatim.
async function retryCompactionResponse(chatId, { requestTurnId, requestId = null } = {}) {
    const { db } = require("../config/database");
    if (!requestTurnId) return { ok: false, reason: "no_request" };

    // Load the existing request row: its content is the prompt shell; debug_data.compaction
    // holds the exact expanded prompt sent, plus the covered/kept boundary ids.
    const reqRow = db
        .prepare("SELECT turn_id, parent_turn_id, content, debug_data FROM messages WHERE chat_id = ? AND turn_id = ? AND turn_type = 'compaction_request' LIMIT 1")
        .get(chatId, requestTurnId);
    if (!reqRow) return { ok: false, reason: "no_request" };

    let meta = {};
    try { meta = (JSON.parse(reqRow.debug_data || "{}").compaction) || {}; } catch (_) {}
    const expandedPrompt = meta.expandedPrompt;
    const coveredTurnIds = meta.coveredTurnIds || [];
    const keptTurnIds = meta.keptTurnIds || [];
    const model = meta.model || getCurrentSettings().modelName || null;
    if (!expandedPrompt) return { ok: false, reason: "no_prompt" };

    // Rebuild the kept-tail messages to copy into the new response, from the same kept turn
    // ids the original request recorded (they still live above the boundary as originals).
    const keptMessages = [];
    for (const tid of keptTurnIds) {
        const rows = db
            .prepare("SELECT role, content, tool_calls, tool_call_id, tool_name, reasoning FROM messages WHERE chat_id = ? AND turn_id = ? AND (error_state IS NULL OR (role='assistant' AND content!='')) ORDER BY id ASC")
            .all(chatId, tid);
        for (const m of rows) {
            keptMessages.push({
                role: m.role,
                content: m.content,
                tool_calls: m.tool_calls || null,
                tool_call_id: m.tool_call_id || null,
                tool_name: m.tool_name || null,
                reasoning: m.reasoning || null,
            });
        }
    }

    if (requestId) {
        addToolEvent(requestId, {
            type: "compaction_start",
            data: {
                strategy: "summarize", model,
                // No NEW request — the live path threads the new response under the EXISTING
                // request turn. request_turn_id IS that existing request; parent_turn_id is
                // its parent (the anchor) so the branch-switch keys correctly.
                request_turn_id: reqRow.turn_id,
                parent_turn_id: reqRow.parent_turn_id,
                retryResponse: true,
                shell: reqRow.content, coveredTurnIds, keptTurnIds, expandedPrompt,
            },
        });
    }

    let summary;
    try {
        summary = await requestSummary(expandedPrompt, (delta) => {
            if (requestId) addToolEvent(requestId, { type: "compaction_delta", data: { text: delta } });
        });
    } catch (err) {
        log(`[COMPACT] Response retry summary failed for request ${requestTurnId}: ${err.message}`);
        if (requestId) {
            addToolEvent(requestId, { type: "compaction_failed", data: { request_turn_id: requestTurnId, message: err.message } });
        }
        return { ok: false, reason: "summary_failed", error: err.message };
    }

    const res = await saveCompactionResponse(chatId, {
        summary, requestTurnId, keptMessages, coveredTurnIds, keptTurnIds, model,
    });

    if (requestId) {
        addToolEvent(requestId, {
            type: "compaction_done",
            data: {
                turn_id: res.turn_id, parent_turn_id: res.parent_turn_id,
                request_turn_id: requestTurnId, summary, coveredTurnIds, keptTurnIds, model,
            },
        });
    }

    log(`[COMPACT] Retried response for request ${requestTurnId} (new response turn ${res.turn_id})`);
    return { ok: true, record: { request_turn_id: requestTurnId, turn_id: res.turn_id, parent_turn_id: res.parent_turn_id, meta: res.meta } };
}

// History transform — HARD BOUNDARY. The compaction_response turn is self-contained: it
// holds the summary (system) followed by copies of the kept-tail messages. So collection
// is a simple slice: find the newest compaction_response, take IT + everything after,
// drop everything before. Nothing above the line is ever read. Runs after
// getChatHistoryForAPI.
function applyCompaction(messages) {
    if (!messages || !messages.length) return messages;

    // The boundary is the newest compaction_response (the summary row). The kept copies
    // (turn_type 'compaction_kept') immediately follow it, sharing its turn_id.
    let boundaryIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].turn_type === "compaction_response") { boundaryIdx = i; break; }
    }
    if (boundaryIdx === -1) {
        // No boundary reached — strip any stray boundary rows (an orphaned request from an
        // aborted run, or stray kept copies) so they never hit the model.
        return messages.filter((m) => !isBoundaryTurnType(m.turn_type));
    }

    // Everything from the boundary onward. Drop the compaction REQUEST (a stray earlier
    // one could sit after the boundary in unusual orderings) — it's prompt bookkeeping.
    const result = [];
    for (let i = boundaryIdx; i < messages.length; i++) {
        const m = messages[i];
        if (m.turn_type === "compaction_request") continue;
        if (i === boundaryIdx) {
            // The summary row → a clean system message. (Skip if somehow empty.)
            if (m.content && String(m.content).trim()) {
                result.push({ role: "system", content: `[Summary of earlier conversation]\n${m.content}` });
            }
            continue;
        }
        if (m.turn_type === "compaction_kept") {
            // A copied kept message → send it as its real role, without the marker.
            result.push({
                role: m.role,
                content: m.content,
                ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
                ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
                ...(m.tool_name ? { tool_name: m.tool_name } : {}),
                ...(m.reasoning ? { reasoning: m.reasoning } : {}),
            });
            continue;
        }
        // Any real turn after the boundary (new conversation) passes through as-is.
        result.push(m);
    }
    return result;
}

module.exports = {
    compactChat,
    retryCompactionResponse,
    applyCompaction,
    // exported for potential reuse/testing
    groupTurns,
};
