const path = require('path');
const fs = require('fs');
const { createClient } = require('@libsql/client');
const { log } = require('../utils/logger');

// Determine userdata directory (mirror existing logic from database.js)
let userdataDir;
if (process.env.PORTABLE_USERDATA_PATH) {
  // Electron portable mode - use path set by main process
  userdataDir = process.env.PORTABLE_USERDATA_PATH;
} else {
  // Running as normal Node.js - use project directory
  userdataDir = path.join(__dirname, '..', '..', 'userdata');
}

if (!fs.existsSync(userdataDir)) {
  fs.mkdirSync(userdataDir, { recursive: true });
}

// Database file path and URL
const dbPath = path.join(userdataDir, 'chats.db');

// Allow override for future remote/libsql setups, but default to local file
const baseUrl = process.env.LIBSQL_URL || `file:${dbPath}`;
const authToken = process.env.LIBSQL_AUTH_TOKEN;

// Create shared libSQL client
const clientConfig = authToken
  ? { url: baseUrl, authToken }
  : { url: baseUrl };

const client = createClient(clientConfig);

log(`[DBCLIENT] Using libSQL client with url=${baseUrl}`);

/**
 * Normalize parameter inputs:
 * - run(a, b, c)
 * - run([a, b, c])
 */
function normalizeParams(params) {
  let arr;
  if (params.length === 1 && Array.isArray(params[0])) {
    arr = params[0];
  } else {
    arr = Array.from(params);
  }
  // libSQL does not accept undefined as a bound value; normalize to null
  return arr.map((v) => (v === undefined ? null : v));
}

/**
 * Execute a single statement (string or { sql, args }).
 */
async function execute(statement, args = []) {
  if (typeof statement === 'string') {
    if (!args || args.length === 0) {
      return client.execute(statement);
    }
    return client.execute({ sql: statement, args });
  }
  // Assume { sql, args }
  return client.execute(statement);
}

/**
 * Execute multiple statements (schema/migrations).
 * Uses libSQL's executeMultiple which does not return rows.
 */
async function execMultiple(sqlScript) {
  if (!sqlScript || typeof sqlScript !== 'string') return;
  await client.executeMultiple(sqlScript);
}

/**
 * Return all rows.
 */
async function all(sql, args = []) {
  const res = await execute(sql, args);
  return res.rows || [];
}

/**
 * Return single row or null.
 */
async function get(sql, args = []) {
  const rows = await all(sql, args);
  return rows[0] || null;
}

/**
 * Run a modifying statement; emulate better-sqlite3-ish result.
 */
async function run(sql, args = []) {
  const res = await execute(sql, args);
  return {
    changes: typeof res.rowsAffected === 'number' ? res.rowsAffected : 0,
    lastInsertRowid:
      res.lastInsertRowid !== undefined ? res.lastInsertRowid : null,
  };
}

/**
 * prepare(sql): compatibility wrapper that returns get/all/run helpers.
 * Keeps existing db.prepare(...).get/all/run() call sites easy to port.
 */
function prepare(sql) {
  const trimmed = String(sql).trim().toUpperCase();

  // Special-case transaction control so existing patterns work:
  // BEGIN / COMMIT / ROLLBACK
  const isBegin =
    trimmed === 'BEGIN' ||
    trimmed === 'BEGIN TRANSACTION';
  const isCommit = trimmed === 'COMMIT';
  const isRollback = trimmed === 'ROLLBACK';

  return {
    async get() {
      // Not meaningful for these; but keep API consistent.
      const params = normalizeParams(arguments);
      return get(sql, params);
    },
    async all() {
      const params = normalizeParams(arguments);
      return all(sql, params);
    },
    async run() {
      const params = normalizeParams(arguments);

      // Transactions: send raw statement, ignore params.
      if (isBegin || isCommit || isRollback) {
        await client.execute(sql);
        return { changes: 0, lastInsertRowid: null };
      }

      return run(sql, params);
    },
  };
}

/**
 * Close underlying client if supported.
 */
async function close() {
  if (typeof client.close === 'function') {
    try {
      await client.close();
      log('[DBCLIENT] libSQL client closed.');
    } catch (err) {
      log('[DBCLIENT] Error closing libSQL client:', err.message || err);
    }
  }
}

module.exports = {
  client,
  execute,
  execMultiple,
  all,
  get,
  run,
  prepare,
  close,
};