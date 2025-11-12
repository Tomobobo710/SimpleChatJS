# SimpleChatJS – Node 25 + SQLite Plan

Goal: Run SimpleChatJS on Node.js 25 while keeping the existing SQLite-based persistence and branch system, minimizing code changes.

Key Files:
- [`backend/config/database.js`](backend/config/database.js:1)
- [`backend/server.js`](backend/server.js:1)
- [`package.json`](package.json:1)

---

## 1. Current Architecture Snapshot

- Backend:
  - Express server entry: [`backend/server.js`](backend/server.js:1)
  - SQLite integration via better-sqlite3:
    - [`backend/config/database.js`](backend/config/database.js:1)
    - Creates/uses `userdata/chats.db`
    - Manages:
      - `chats`
      - `settings`
      - `chat_branches`
      - `branch_messages`
      - Migration from legacy tables into branch-based model
- Frontend:
  - Static assets served from project root (per `express.static` in [`backend/server.js`](backend/server.js:25))
  - Chat API endpoints backed by the DB and services.

The DB layer already uses the canonical better-sqlite3 pattern:

- `const Database = require('better-sqlite3');`
- `const db = new Database(dbPath);`
- Exposes `db`, `initializeDatabase()`, `closeDatabase()`.

No schema or query changes are required for Node 25.

---

## 2. Node 25-Compatible SQLite Strategy

Decision:

- Keep using better-sqlite3.
- Pin to a Node 25-compatible release (9.6.x or newer).
- Keep synchronous API and all existing DB logic untouched.
- Rely on:
  - Official prebuilt binaries when available for Node 25.
  - Otherwise compile from source with a C++20-capable toolchain.

Concretely (in `package.json`):

- Ensure:
  - `"better-sqlite3": "^9.6.0"` (or latest 9.6.x)
- Other dependencies remain:
  - `"express": "^4.18.2"`
  - `"@modelcontextprotocol/sdk": "^1.0.0"`
  - `"open": "^8.4.2"`

Rationale:

- Newer better-sqlite3 supports modern Node versions.
- Existing `backend/config/database.js` is fully compatible with these versions.
- All branch-based and migration logic remains stable.

---

## 3. Required Code/Config Changes

Planned minimal edits:

1. package.json
   - Set/confirm:
     - `"better-sqlite3": "^9.6.0"` in dependencies.
   - Ensure scripts:
     - `"start": "node backend/server.js"`
     - `"dev": "nodemon backend/server.js"`
     - `"pure": "echo Pure 1998 JavaScript - no build tools needed! && node backend/server.js"`

2. backend/config/database.js
   - No behavior changes.
   - Keep:
     - Direct better-sqlite3 usage.
     - Migrations and branch system.
   - Optionally (non-breaking) log a more explicit DB init banner if desired.

3. No changes to:
   - [`backend/server.js`](backend/server.js:1)
   - Route/service files consuming `db`
   - Frontend code

This keeps runtime behavior identical; only dependency alignment changes.

---

## 4. Environment / Tooling Expectations (Node 25)

To install on Node 25:

- Prerequisites:
  - Node.js: 18+ (Node 25 supported).
  - If on Windows:
    - Visual Studio 2022 Build Tools (Desktop development with C++) or equivalent,
    - So C++20 is available for native addons when building from source.

Install flow:

- Normal:
  - `npm install`
  - Uses prebuilt better-sqlite3 binary when available.

- If install fails with C++20 / build errors:
  - Ensure VS 2022 / modern toolchain is installed.
  - Retry:
    - `npm install --verbose`
    - Optionally:
      - `npm install better-sqlite3 --build-from-source`

---

## 5. Updated Start Instructions

For README / docs:

1. Install dependencies:
   - `npm install`

2. Start the app:
   - `npm start`
   - Server runs at:
     - `http://localhost:50505`
   - [`backend/server.js`](backend/server.js:42) will attempt to auto-open the browser.

3. Optional:
   - Use `npm run dev` for automatic restarts during backend changes (requires `nodemon`).

Notes:

- SQLite database file:
  - `userdata/chats.db`
- All chat history, branches, and settings persist there.
- No manual DB setup required.

---

## 6. Summary

- SQLite schema and branch model remain unchanged.
- We align better-sqlite3 to a Node 25-compatible version.
- We rely on prebuilt binaries where possible, else build with a proper C++20 toolchain.
- Runtime code stays clean and simple; only `package.json` needs adjustment plus documentation of prerequisites.