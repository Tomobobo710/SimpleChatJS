# SimpleChatJS — Conversation Persistence, Branching, and Editing Architecture

This document is the "secret manual" for how SimpleChatJS persists conversations, manages branches, supports editing/retrying, and ties everything together via the database. It is written so you can reimplement the same behavior in a modern stack (Next.js + Vercel AI SDK + TypeScript + React + Postgres + Redis + Clerk) while preserving the core ideas.

References:
- [`backend/config/dbClient.js`](backend/config/dbClient.js:1)
- [`backend/config/database.js`](backend/config/database.js:1)
- [`backend/services/chatService.js`](backend/services/chatService.js:1)
- [`backend/routes/chat.js`](backend/routes/chat.js:1)
- [`src/js/app/api.js`](src/js/app/api.js:1)
- [`src/js/render/chatRenderer.js`](src/js/render/chatRenderer.js:1)

---

## 1. Design Goals

SimpleChatJS is intentionally more robust than a typical "append messages to an array" chat.

Core goals:

- Durable: all important state is persisted server-side.
- Deterministic: given a chat and active branch, the system can reconstruct the exact message history used for any model call.
- Branch-aware: retries/edits create new branches instead of mutating history destructively.
- Turn-based: each interaction is tracked as a turn number, enabling precise debug and branching behavior.
- Tool-aware: tool calls and tool outputs are first-class citizens in persistence.
- Debuggable: rich debug logs (including actual HTTP payloads) are correlated with chat turns.

The database is not an afterthought; it is the backbone of:
- chat identity
- branching structure
- message history
- error isolation
- debug observability

---

## 2. Data Model (libSQL / conceptual schema)

Key tables (see [`backend/config/database.js`](backend/config/database.js:18)):

1. `chats`
   - `id` (TEXT, PK): stable chat identifier (UUID-like).
   - `title`
   - `created_at`, `updated_at`
   - `turn_number` (INTEGER): current turn index for this chat.

2. `chat_branches`
   - `id` (INTEGER, PK)
   - `chat_id` (TEXT, FK → chats.id)
   - `branch_name` (TEXT)
   - `parent_branch_id` (INTEGER, nullable)
   - `branch_point_turn` (INTEGER, nullable)
   - `is_active` (BOOLEAN)
   - Unique constraint: `(chat_id, branch_name)`
   - Represents the tree of branches for a single chat.

3. `branch_messages`
   - `id` (INTEGER, PK)
   - `branch_id` (INTEGER, FK → chat_branches.id)
   - `original_message_id` (INTEGER, nullable)
   - `role` (TEXT) — `user`, `assistant`, `tool`, `system`
   - `content` (TEXT) — may be:
     - plain text
     - JSON-encoded multimodal content
   - `turn_number` (INTEGER)
   - `tool_calls`, `tool_call_id`, `tool_name` (TEXT, nullable)
   - `blocks` (TEXT, nullable) — for UI blocks / structured chunks
   - `debug_data` (TEXT, nullable) — JSON
   - `original_content` (TEXT, nullable) — raw multimodal structure
   - `file_metadata` (TEXT, nullable) — JSON describing files/images
   - `error_state` (TEXT, nullable) — classifies failures
   - `edit_count`, `edited_at`
   - `timestamp` (DATETIME DEFAULT CURRENT_TIMESTAMP)

4. (Legacy / versioning tables)
   - `turn_versions`, `message_versions`
   - Used for older editing/versioning; the new "everything-is-a-branch" system supersedes most of this, but the concept is:
     - Keep historical snapshots of turns, not just the latest state.

---

## 3. DB Adapter: libSQL Compatibility Layer

File: [`backend/config/dbClient.js`](backend/config/dbClient.js:1)

Goals:
- Provide a better-sqlite3-like API on top of `@libsql/client` so existing logic can be mostly reused.
- Normalize parameters, provide `prepare().get/all/run()`, support transactions.

Core concepts:

- `execute(sql, args?)`
- `execMultiple(sqlScript)`
- `get(sql, args?)`
- `all(sql, args?)`
- `run(sql, args?)` → `{ changes, lastInsertRowid }`
- `prepare(sql)` → `{ get, all, run }`
- Special handling for `BEGIN`, `COMMIT`, `ROLLBACK` so transactional code in services works.

This is your pattern to emulate if you move to:
- Postgres: expose a small facade with `prepare/get/all/run`, backed by `pg` or an ORM.
- Vercel AI + Next.js: keep a minimal DB helper so chat logic stays readable and framework-agnostic.

---

## 4. Everything-Is-A-Branch Model

All meaningful history uses branches.

Key functions: [`backend/services/chatService.js`](backend/services/chatService.js:1475)

### 4.1 Active Branch

- Each chat has one `is_active = TRUE` branch in `chat_branches`.
- `getActiveChatBranch(chatId)`:
  - SELECT `id, branch_name` WHERE `chat_id = ? AND is_active = TRUE LIMIT 1`.
- `setActiveChatBranch(chatId, branchId)`:
  - Transaction:
    - Set all branches for chat to `is_active = FALSE`.
    - Set target branch `is_active = TRUE`.

In your Postgres/Next.js version:
- Model `chat_branches` similarly.
- Always fetch `active_branch_id` or compute via `is_active`.
- Consider denormalizing `active_branch_id` onto `chats` for faster lookups.

### 4.2 Creating Branches (including Retry)

Function: `createChatBranch(chatId, branchPoint = null)`.

Algorithm:
1. Begin transaction.
2. Count existing branches for `chat_id`:
   - If 0 → first branch is `'main'`, `is_active = TRUE`.
   - Else → `Branch N`.
3. Get current active branch (if any).
4. Insert new branch with:
   - `parent_branch_id = activeBranch.id` (when branching from existing).
   - `branch_point_turn = branchPoint`.
5. If `branchPoint` provided:
   - Copy all messages from active branch with `turn_number < branchPoint` into the new branch.
   - Reset `chats.turn_number` to `branchPoint - 1` for the retry branch.
   - Delete messages in new branch `turn_number >= branchPoint` to ensure a clean path.
6. Commit.
7. Return `{ branchId, branchName, branchPoint }`.

This yields:
- Tree-like branching where each retry is a child of the previous timeline.
- Each branch is a coherent, linear history from its defined branch point forward.

In Next.js/Postgres:
- Implement a similar function in a server action / route handler.
- Wrap in a transaction; use `SELECT ... FOR UPDATE` to avoid race conditions.

---

## 5. Saving Messages — Robust, Branch-Aware

Functions:
- `saveCompleteMessageToDatabase(chatId, messageData, blocks, turnNumber, errorState)`
- `saveMessageToBranch(chatId, messageData, blocks, turnNumber, errorState)`
  (see [`chatService.js`](backend/services/chatService.js:461))

Key steps:

1. Resolve active branch:
   - If none exists, create a main branch and activate it.
2. Normalize message:
   - `role`
   - `content`:
     - If `Array` (multimodal) → `JSON.stringify`.
     - If string → store as-is.
   - Tool metadata:
     - `tool_calls` (JSON), `tool_call_id`, `tool_name`
   - `blocks`, `debug_data` → JSON strings.
   - `original_content`, `file_metadata` for file-aware inputs:
     - `original_content` stores the high-fidelity structure.
     - `file_metadata` tracks counts and descriptors.
3. Turn number:
   - If explicit `turnNumber` provided → use it.
   - Else → `getCurrentTurnNumber(chatId)` (from `chats.turn_number`).
4. Insert into `branch_messages`:
   - Always scoped to `branch_id`.
5. Update `chats.updated_at`.

This design:
- Makes every message append deterministic and branch-scoped.
- Avoids mixing branches or losing context when you introduce retries.

In Next.js/Postgres:
- Use a `messages` table scoped by `branch_id`.
- Always insert with a `turn_number` and preserve `original_content` / `file_metadata` style fields.

Example (TS/Prisma-style pseudo):

```ts
// pseudo: src/server/chat/saveMessage.ts
await db.message.create({
  data: {
    branchId,
    role,
    content: serializedContent,
    turnNumber,
    toolCalls: toolCallsJson,
    toolCallId,
    toolName,
    blocks: blocksJson,
    debugData: debugJson,
    originalContent,
    fileMetadata,
    errorState,
  },
});
```

---

## 6. Building AI History — Filtered, File-Aware

Function: `getChatHistoryForAPI(chat_id)` (see [`chatService.js`](backend/services/chatService.js:356)).

Algorithm:

1. If no `chat_id` → return `[]`.
2. Get active branch for chat.
3. Query `branch_messages`:
   - Only this `branch_id`.
   - `error_state IS NULL` (failed turns are persisted but excluded from prompt context).
   - ORDER BY `timestamp ASC`.
4. For each row:
   - Start with `row.content` as `finalContent`.
   - If `original_content` + `file_metadata` exist:
     - Decode JSON.
     - If `fileMetadata.hasFiles`, recompute `aiContent` using `processMessageForAI` so:
       - AI sees concatenated document text.
       - We preserve original structure for UX.
   - If `finalContent` is a JSON array string, parse it as multimodal.
   - Attach tool-related fields.

Result:
- A clean, consistent message array ready for Vercel AI SDK / OpenAI / etc.
- Historical errors do not poison the context but are still available in DB.

In Next.js/Vercel AI:
- Implement `getMessagesForModel(chatId)` server function using the same filtering rules.
- Feed directly into `streamText` or `OpenAIChatCompletion` as `messages`.

---

## 7. Turn System — Deterministic Interactions

Functions:
- `getCurrentTurnNumber(chat_id)`
- `incrementTurnNumber(chat_id)` (see [`chatService.js`](backend/services/chatService.js:320))

Patterns:

- `chats.turn_number` tracks how many complete interaction cycles have occurred.
- When a user sends a message:
  - Determine `currentTurn`:
    - Provided by frontend, or
    - `getCurrentTurnNumber(chatId) + 1`.
- All messages for that *interaction* (user message, tools, assistant) share the same `turn_number`.
- `incrementTurnNumber` is called once the assistant response is finalized (or when error handling decides to "burn" a turn).

Benefits:
- Stable grouping: you can query "all messages for turn N".
- Makes branching and debugging precise.

In your new stack:
- Keep `turn_number` on a `chats` row or compute as `MAX(turn_number)` per branch.
- Use transactions to update `turn_number` atomically after each cycle.

---

## 8. Editing, Retrying, and Branching Behavior

The innovative part: retries/editing are first-class branch operations, not hacks.

### 8.1 High-Level Principles

- Do NOT overwrite history in-place for retries.
- Instead:
  - Capture the prior timeline.
  - Fork a new branch at the chosen `branch_point_turn`.
  - Rebuild subsequent messages on that branch.

### 8.2 Branch Creation for Retry

When user hits "retry from turn X":

- Call `createChatBranch(chatId, branchPoint = X)`:
  - New branch:
    - Has all messages `< X` copied.
    - No messages at or after X.
  - `chats.turn_number` is set to `X-1`.
- New generation runs on this clean branch.
- UI shows branch navigation (e.g., main vs Branch 2).

In Next.js:
- Provide a `/api/chats/:id/branches/retry` route:
  - Accepts `branchPointTurn`.
  - Executes the same branching algorithm.
  - Returns new `branchId` to the client.

---

## 9. Tool Calls, MCP, and Debugging

Tool calls are streamed and persisted through the same branch-aware pipeline.

Key behaviors:
- `handleChatWithTools`:
  - Wraps provider-specific logic via adapters.
  - Streams content to client.
  - Records:
    - `unifiedResponse.content`
    - `unifiedResponse.toolCalls`
    - HTTP request/response metadata
    - Errors as `error_state` rows.

- `executeToolCallsAndContinue`:
  - Appends tool messages (`role: 'tool'`) to:
    - in-memory `messages` array for AI
    - `branch_messages` in DB (turn-scoped)

Debug flows:
- `saveTurnDebugData`, `getTurnDebugData`, `getAllTurnDebugData`:
  - Map turn → debug JSON.
  - Allow frontend debug panel to display:
    - Exact request payloads.
    - Streaming chunks.
    - Tool sequences.

Design outcome:
- You can always reconstruct:
  - What was sent to the AI.
  - What came back.
  - What tools ran.
  - How that maps to turns and branches.

In your new stack:
- Store debug JSON either:
  - In a `debug_data` JSONB column (Postgres), or
  - In Redis keyed by `{chatId}:{turnNumber}`.
- The structure from SimpleChatJS is already well-shaped for that.

---

## 10. Error Handling as Data, Not Side Effects

`error_state` on `branch_messages`:

- When HTTP/API errors occur:
  - Save a synthetic assistant message with:
    - `role: 'assistant'`
    - `content`: human-readable error
    - `debug_data`: detailed failure context
    - `error_state`: `api_error` or `connection_error`
  - Increment turn_number ("burn" the turn).
- `getChatHistoryForAPI` filters out `error_state IS NOT NULL`:
  - So broken attempts don't pollute future prompts.
- UI can still display them from DB for transparency.

This creates:
- A clean separation between:
  - "What the model should see next"
  - "What the user and developer need to debug"

---

## 11. How to Rebuild This in Next.js + Vercel AI + Postgres

When porting, preserve concepts, not exact SQL.

Recommended mapping:

- `chats` → `chats` table (Postgres)
  - Include `id`, `title`, `turn_number`, timestamps.
- `chat_branches` → `chat_branches` table
  - Include `chat_id`, `branch_name`, `parent_branch_id`, `branch_point_turn`, `is_active`.
- `branch_messages` → `messages` table
  - Include:
    - `branch_id` (FK)
    - `role`, `content`, `turn_number`
    - `tool_calls` (JSONB), `tool_call_id`, `tool_name`
    - `blocks` (JSONB)
    - `debug_data` (JSONB)
    - `original_content` (JSONB or TEXT)
    - `file_metadata` (JSONB)
    - `error_state`
    - `edit_count`, `edited_at`
    - `created_at`
- Debug:
  - `debug_data` as JSONB.
  - Optionally split into `turn_debug` table.

Key server functions (you should recreate):

1. `getActiveBranch(chatId)`
2. `setActiveBranch(chatId, branchId)`
3. `createBranch(chatId, branchPointTurn?)`
4. `saveMessage(chatId, branchId, messageData, turnNumber?, errorState?)`
5. `getHistoryForModel(chatId)`:
   - Branch-scoped
   - Filter `error_state`
   - File-aware recomposition
6. `getCurrentTurnNumber(chatId)` / `incrementTurnNumber(chatId)`
7. `saveTurnDebugData(chatId, turnNumber, data)` / `getTurnDebugData(...)`
8. `retryFromTurn(chatId, fromTurn)` → creates branch, returns branch id.

Then, wire these into:
- Next.js route handlers (e.g. `/api/chat`, `/api/chats/[id]/branches`, `/api/chats/[id]/history`).
- Vercel AI SDK:
  - On each request:
    - Call `getHistoryForModel(chatId)` for `messages`.
    - After streaming:
      - Save final assistant message.
      - Increment turn.
      - Record tools and debug data.

---

## 12. Summary — Why This Architecture Is Robust

This system is innovative and robust because it:

- Treats the database as the single source of truth for:
  - Conversations
  - Branches
  - Turns
  - Tools
  - Debug data
- Provides:
  - Non-destructive retries via branching.
  - File-aware and multimodal-safe storage.
  - Deterministic reconstruction of model input.
  - Strong observability (every turn is traceable).
- Avoids:
  - Ad-hoc in-memory state.
  - Overwriting history when experimenting.
  - Polluting prompts with failed/error messages.

If you replicate these patterns in your Next.js + Vercel AI SDK + Postgres architecture, you get a production-grade conversation system that is:
- debuggable,
- auditable,
- friendly to advanced features (tools, branches, edit history),
- and future-proof for more complex UX.
