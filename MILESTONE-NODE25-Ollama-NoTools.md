# Milestone: Node 25 + SQLite + Ollama (No Tools) Working in SimpleChatJS

This document summarizes what changed, why replies were disappearing before, and the current stable setup.

Key files:
- [`package.json`](package.json:1)
- [`backend/config/database.js`](backend/config/database.js:1)
- [`backend/routes/chat.js`](backend/routes/chat.js:1)
- [`backend/services/chatService.js`](backend/services/chatService.js:1)
- [`src/js/ui/debugPanel.js`](src/js/ui/debugPanel.js:1)

---

## 1. What Was Broken

Initial symptoms:

1. `npm install` failed on Node 25:
   - `better-sqlite3` native build error
   - C++20 toolchain mismatch on Windows

2. After partial fixes:
   - Backend 500s due to:
     - direct `db.prepare` calls with `db` no longer matching exports
     - async helpers returning Promises but callers treating them like values
   - Chat branch creation and history endpoints throwing:
     - `Cannot read properties of undefined (reading 'prepare')`
     - `messages.push is not a function`

3. With Ollama:
   - Requests sent with tools enabled to models like `gemma3:270m`, which:
     - returned `400` `"does not support tools"`
   - No assistant replies despite valid local Ollama.

4. Frontend debug UI:
   - `SequentialDebugPanel` assumed `completeMessageHistory` is always an array.
   - When backend sent other shapes, it threw `messages.filter is not a function`,
     which caused:
     - “Simple chat failed”
     - replies visually disappearing or appearing then vanishing.

---

## 2. What We Changed (High-Level)

Goal: minimal, surgical changes to make SimpleChatJS:

- run under Node 25
- use SQLite with `better-sqlite3`
- talk to Ollama via OpenAI-compatible API
- not break UI when debug data is slightly off
- avoid tools for incompatible models

Summary of edits:

1) Dependencies:
- [`package.json`](package.json:1)
  - `"better-sqlite3": "^9.6.0"`
  - `"engines": { "node": ">=18.0.0" }`
- This aligns with Node 25 and keeps the existing DB API valid.

2) Database module:
- [`backend/config/database.js`](backend/config/database.js:1)
  - Keeps synchronous `better-sqlite3` connection and migration logic.
  - Exports stable DB interface used by services.
- No schema changes; the branch-based schema is preserved.

3) Chat+branch services:
- [`backend/services/chatService.js`](backend/services/chatService.js:1)
  - Fixed core integration issues:
    - `getChatHistoryForAPI` now async and correctly awaited.
    - `saveMessageToBranch` uses exported helpers instead of raw `db.prepare`.
    - `createChatBranch`, `getChatBranches`, `getActiveChatBranch`, `setActiveChatBranch`
      refactored to use shared DB helpers consistently.
    - Turn number logic updated so:
      - user messages and assistant messages are recorded with sensible `turn_number`
      - no `[object Promise]` turn numbers.
  - Hard-disabled tools in unified request:
    - In `handleChatWithTools`:
      - `responseAdapterFactory.createUnifiedRequest(messages, [], currentSettings.modelName);`
    - This prevents sending `tool_calls` to models/endpoints that don’t support tools
      (e.g. Ollama `gemma3` / `deepseek` images), resolving 400 errors.

4) Chat routes:
- [`backend/routes/chat.js`](backend/routes/chat.js:1)
  - Updated to:
    - Use async handlers where DB helpers are async.
    - Use `exec/all/get` instead of direct `db.prepare` where applicable.
    - Fix `/chat/:id/title` to use the shared helpers.

5) Debug UI robustness:
- [`src/js/ui/debugPanel.js`](src/js/ui/debugPanel.js:1)
  - Patched to not break when debug data is not in the ideal format:
    - `getMessagesForTurn` now guards:
      - returns `[]` if `messages` is not an array.
    - `Complete Message History` block:
      - checks `Array.isArray` before `.length` / `JSON.stringify`.
      - shows a safe note instead of throwing if shape is unexpected.
  - Result:
    - `messages.filter is not a function` no longer kills the simple chat flow.
    - Debug panel can fail gracefully without hiding assistant messages.

---

## 3. Why Replies Were Disappearing Before

Chain of issues:

1) Backend would stream or assemble a response.
2) But:
   - Tool-enabled requests to non-tool models triggered 400 errors.
   - Or debug data / history was malformed due to async/turn bugs.
3) Frontend `debugPanel.js` assumed a strict structure:
   - Called `messages.filter` on something that was not an array.
   - Threw `TypeError`.
4) In `simpleChatMode` / renderer:
   - That error bubbled into “Simple chat failed” and UI cleanup paths.
   - Assistant bubble would flash then be removed or never properly render.

Once we:

- disabled tools in request construction,
- fixed DB/turn-number async issues,
- hardened `debugPanel.js` to handle non-ideal debug payloads,

the pipeline became:

- user message saved
- provider called successfully
- assistant message streamed/assembled
- assistant message saved to SQLite
- chat history reloads from `branch_messages`
- UI renders bubbles and keeps them; debug view no longer breaks the flow

Your final logs confirm:

- `[CHAT-SAVE] Successfully saved final assistant response to history`
- `[CHAT-HISTORY] Retrieved 2 messages from branch 'main'`
- No subsequent errors; bubbles persist in the UI.

---

## 4. Current Stable Usage Pattern

With the current code:

- Requirements:
  - Node 18+ (you’re on Node 25): ok.
  - `npm install` succeeds with `better-sqlite3@^9.6.0`.

- Start:
  - `npm start`
  - Visit `http://localhost:50505`

- For Ollama:
  - Use your OpenAI-compatible endpoint:
    - Typically `http://localhost:11434/v1/chat/completions`
  - Set `modelName` to an installed chat model.
  - Tools are effectively disabled by default in backend request builder, so:
    - No accidental `tool_calls` for non-tool models.

- Behavior:
  - New chat:
    - main branch auto-created.
  - Send message:
    - user message → `branch_messages`
    - assistant reply → `branch_messages`
    - branch + turn tracking logged and consistent.
  - Reply stays visible in chat UI.

---

## 5. Notes / Next Steps (Optional)

Future iterative improvements (not required for current milestone):

- Introduce explicit “Tools On/Off” toggle in settings:
  - Wire that into `handleChatWithTools` instead of hard-coded empty tools.
- Normalize debug payload shape so `debugPanel` always receives arrays:
  - reduce need for defensive checks.
- Add a small health-check endpoint to quickly verify:
  - DB connectivity
  - model API reachability
  - configuration sanity.

But as of this milestone, the essential stack is working:

Node 25 + better-sqlite3 + SQLite branch persistence + Ollama chat (no tools) + stable UI rendering of assistant replies.