# SimpleChatJS libSQL Migration Checklist

Reference compass for Node 25 + libSQL (file:chats.db) migration state.

## Legend

- [x] = Implemented and smoke-tested (basic validation)
- [-] = Implemented but not fully tested / may have edge cases
- [ ] = Not implemented yet

---

## 1. Dependencies / Environment

- [x] Replace better-sqlite3 with @libsql/client in [`package.json`](package.json:1)
- [x] `npm install` works on Node 25 without native build errors

Notes:
- Completed. No better-sqlite3 build issues.

---

## 2. Core DB Adapter

- [x] Create libSQL client adapter in [`backend/config/dbClient.js`](backend/config/dbClient.js:1)
  - [x] Uses userdata dir (PORTABLE_USERDATA_PATH or ./userdata)
  - [x] Uses `file:.../userdata/chats.db` by default
  - [x] Supports `LIBSQL_URL` + `LIBSQL_AUTH_TOKEN` override
  - [x] Exposes:
    - `execute(statement, args?)`
    - `execMultiple(sqlScript)`
    - `all(sql, args?)`
    - `get(sql, args?)`
    - `run(sql, args?)` → `{ changes, lastInsertRowid }`
    - `prepare(sql)` → `{ get, all, run }`
    - `close()`
  - [x] Normalizes undefined → null in bound args to satisfy libSQL

Status:
- Implemented; used by higher-level database module.

---

## 3. Database Facade

- [x] Refactor [`backend/config/database.js`](backend/config/database.js:1) to use dbClient
  - [x] Use libSQL client instead of better-sqlite3
  - [x] Implement `initializeDatabase()` async:
    - [x] Create `chats`, `settings`, `chat_branches`, `branch_messages`
    - [x] Apply `ALTER TABLE` migrations with duplicate-column-safe try/catch
    - [x] Run full migration from legacy tables if present
  - [x] Implement `closeDatabase()` via dbClient.close()
  - [x] Export:
    - `db` compatibility wrapper: `{ prepare, all, get, run }`
    - Direct helpers: `prepare, all, get, run, initializeDatabase, closeDatabase`

Status:
- Implemented. Initialization/migration logs confirm working.

---

## 4. Routes: backend/routes/chat.js

Core goal: all DB interactions async/await via libSQL-backed `db`.

- [x] `/chats` (GET)
  - Uses `await db.prepare(query).all()`
- [x] `/chats` (POST)
  - Uses `await db.prepare(...).run(...)`
  - Uses `await existingBranchStmt.get(chat_id)`
  - Calls `createChatBranch` / `setActiveChatBranch` (chatService must be async-safe)

- [x] `/chat/:id/history-complete` (GET)
  - Async, uses:
    - `await activeBranchStmt.get(chatId)`
    - `await messagesStmt.all(activeBranch.id)`
  - Fixes `branchMessages.map is not a function`

- [x] `/chat/:id/history` (GET)
  - Async, uses:
    - `await activeBranchStmt.get(chatId)`
    - `await messagesStmt.all(activeBranch.id)`

- [x] `/chat/:id/api-history` (GET)
  - Async, uses `await getChatHistoryForAPI(chatId)`

- [x] `/chat/:id/current-turn` (GET)
  - Async, uses `await getCurrentTurnNumber(chatId)`

- [x] Turn debug endpoints
  - `/chat/:id/turns/:turnNumber` (GET) → async/await `getTurnDebugData`
  - `/chat/:id/turns` (GET) → async/await `getAllTurnDebugData`
  - `/chat/:id/turn/:turnNumber` (GET) → async/await db for active branch and messages

- [x] Branch endpoints
  - `/chat/:id/branches` (GET) → async/await `getChatBranches`, `getActiveChatBranch`
  - `/chat/:id/branch/:branchId/activate` (POST) → async/await `setActiveChatBranch`
  - `/chat/:id/turn/:turnNumber/retry` (POST) → async/await `createChatBranch` + `setActiveChatBranch`

- [x] Message edit endpoints
  - `/message/:id` (PATCH/GET) → async, all db calls awaited

Status:
- Implemented.
- Behavior improved; no more Promise-vs-array issues from routes code.

---

## 5. Services: backend/services/chatService.js

This file is central for branches, history, and message saving.
Some fixes applied; several items still pending or partially migrated.

Implemented:
- [-] Import libSQL helpers:
  - `const { prepare, get, all, run } = require('../config/database');`
- [x] `processChatRequest`:
  - Fixed ReferenceError: uses `chatId` instead of undefined `chat_id` in error path.
- [-] `updateMessageDebugData`:
  - Uses `prepare(...)` and `await stmt.run(...)`.

Pending / needs verification (this is where current NOT NULL errors originate):

- [ ] Make all DB interactions async/await:
  - Anywhere using `db.prepare(...).get/all/run` directly or expecting sync behavior must be updated to:
    - Use `prepare(...)` from database.js.
    - Await `get/all/run`.

- [ ] Branch management:
  - createChatBranch(chatId, fromTurnNumber?)
    - Should:
      - Be async.
      - Choose correct branch name (main vs Branch N).
      - Insert with `await prepare(...).run(...)`.
      - Set `is_active = 1` for main branch on first creation.
      - Return `{ branchId, branchName, branchPoint }` with a real `branchId`.
  - getActiveChatBranch(chatId)
    - Should:
      - Be async.
      - `const row = await prepare('SELECT id, branch_name FROM chat_branches WHERE chat_id = ? AND is_active = TRUE LIMIT 1').get(chatId);`
      - Return row or null.
  - setActiveChatBranch(chatId, branchId)
    - Should:
      - Be async.
      - Wrap in BEGIN/COMMIT with await.
      - Clear previous `is_active`, set new one.
      - Return boolean.

- [ ] saveMessageToBranch(chatId, message, turnNumber, ...)
  - Must:
    - Be async.
    - `let activeBranch = await getActiveChatBranch(chatId);`
    - If none:
      - `const newBranch = await createChatBranch(chatId);`
      - `await setActiveChatBranch(chatId, newBranch.branchId);`
      - `activeBranch = await getActiveChatBranch(chatId);`
    - Only then insert into branch_messages with valid `branch_id`.
  - This will fix:
    - `SQLITE_CONSTRAINT_NOTNULL: branch_messages.branch_id` errors.

- [ ] getChatHistoryForAPI(chatId)
  - Should:
    - Be async.
    - Use `await prepare(...).get/all`.
    - Return arrays; no forEach/map on non-arrays.

- [ ] Turn tracking helpers:
  - getCurrentTurnNumber(chatId):
    - Async; selects from chats via libSQL helpers.
  - incrementTurnNumber(chatId):
    - Async; updates chats row.
  - Ensure all call sites in routes await these.

Status:
- This is the main remaining area to complete for full stability.

---

## 6. Frontend / Debug Resilience

Recommended (not fully implemented in this branch yet):

- [ ] Harden [`src/js/ui/debugPanel.js`](src/js/ui/debugPanel.js:1):
  - Guard all uses of `.map`, `.filter`, `.length` with `Array.isArray`.
  - Avoid throwing when `messages` or debug data shape is unexpected.

Status:
- To do. Prevents UI from hiding messages if backend returns slightly different debug payloads.

---

## 7. Docs / DX

- [ ] Update [`README.md`](README.md:1) / [`BUILD.md`](BUILD.md:1):
  - Document:
    - Node >= 18 / tested on Node 25.
    - Local DB: `file:userdata/chats.db` via libSQL.
    - Optional `LIBSQL_URL` / `LIBSQL_AUTH_TOKEN`.
    - No native SQLite addons required.

---

## Summary

As of this checklist:

- libSQL adapter is in place and used.
- chat.js is largely aligned with async libSQL usage.
- Migrations run under libSQL; baseline schema is correct.
- Remaining issues (NOT NULL branch_id, any lingering history errors) are localized to:
  - async correctness and branch/turn helpers in [`backend/services/chatService.js`](backend/services/chatService.js:1),
  - and optional debug UI hardening.

Use this file as the authoritative roadmap in future sessions.