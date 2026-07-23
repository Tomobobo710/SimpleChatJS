const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { log } = require('../utils/logger');
const { getUserdataPath } = require('../utils/pathUtils');
const shellService = require('./shellService');

const CONFIG_FILE = 'simple_tools_config.json';

// Output size cap, user-configurable (in KB) via output_limit_kb in the config.
// read_file refuses over the cap; shell_run keeps the last (cap - 1KB) chars and
// prepends a notice (1KB headroom leaves room for the notice line). 1KB = 1000
// chars here, matching the historical 99_000 = 99KB. Min 2KB so shell stays >=1KB.
const DEFAULT_OUTPUT_LIMIT_KB = 99;
const MIN_OUTPUT_LIMIT_KB = 2;
const KB = 1000;
const SHELL_TRUNCATE_NOTICE = 'NOTICE: Output was too long and was truncated to the most recent lines (this is not an error) — earlier content was omitted.\n';

// Resolve the configured limit in KB, clamped to the minimum; falls back to the
// default for missing/invalid values. read cap = limitKb * KB; shell cap is 1KB
// less to leave room for the truncation notice.
function getLimitKb(config) {
    const v = Number(config && config.output_limit_kb);
    if (!Number.isFinite(v)) return DEFAULT_OUTPUT_LIMIT_KB;
    return Math.max(MIN_OUTPUT_LIMIT_KB, Math.floor(v));
}

function getConfigPath() {
    return getUserdataPath(CONFIG_FILE);
}

const DEFAULT_CONFIG = {
    read_file: true,
    write_file: true,
    edit_file: true,
    shell_run: true,
    output_limit_kb: DEFAULT_OUTPUT_LIMIT_KB
};

function loadConfig() {
    try {
        const configPath = getConfigPath();
        if (fs.existsSync(configPath)) {
            const data = fs.readFileSync(configPath, 'utf8');
            return { ...DEFAULT_CONFIG, ...JSON.parse(data) };
        }
    } catch (error) {
        log('[SIMPLETOOLS] Config load error:', error.message);
    }
    const config = { ...DEFAULT_CONFIG };
    saveConfig(config);
    return config;
}

function saveConfig(config) {
    try {
        const configPath = getConfigPath();
        const dir = path.dirname(configPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
        log('[SIMPLETOOLS] Config saved');
        return { success: true };
    } catch (error) {
        log('[SIMPLETOOLS] Config save error:', error.message);
        return { error: error.message };
    }
}

function isToolEnabled(toolName, config) {
    const key = toolName.replace(/-/g, '_');
    return config[key] === true;
}

// Description templates. Placeholders are filled at request time from the OS
// (os_name, example_path) and the detected shell (shell_name, shell_syntax).
// File tools use Node fs and don't touch the shell, so they only mention the OS
// and a native example path. Only shell_run names the shell and its syntax.
const READ_FILE_TPL = "Read the contents of a file at the given path. You'll use this the most to read content.\nYou are on {os_name}.\nFile path example: {example_path}\nOptional: start_line and end_line to read a specific line range.\nOutput is capped at {read_cap_kb}KB; if a file exceeds that, read a portion with start_line/end_line.\nRequired: path.";
const WRITE_FILE_TPL = 'Create or overwrite a file at the given path with the specified content.\nYou are on {os_name}.\nFile path example: {example_path}\nRequired: path, content.';
const EDIT_FILE_TPL = 'This is the primary tool for modifying files — prefer it over shell commands (sed, awk, Set-Content, etc.) for any edit.\nApplies one or more exact-text find/replace edits to a file. Provide an "edits" array; each edit has old_string (exact text to find, including whitespace and newlines) and new_string (replacement).\nEdits apply in order, each operating on the result of the previous one. Either all edits apply or none do — if any old_string is not found, nothing is written and the error names which edit failed.\nYou are on {os_name}.\nFile path example: {example_path}\nRequired: path, edits.';
const SHELL_RUN_TPL = 'Run a {shell_name} command and return its output. This tool should be used for non-file operations, use read_file, write_file, and edit_file for those operations. Use for: executing commands, scripts, build tools, git operations.\nYou are on {os_name} using {shell_name}.\n{shell_syntax}\nKeep output focused to avoid unnecessary context usage. When a command may be verbose, use its filtering, limiting, or summary options where practical (for example, targeted tests, focused searches, summary output, or limited logs), but do not filter away errors or information needed to verify the result.\nConsecutive exactly repeated lines or multi-line blocks may be losslessly compacted between markers that state the copy and line counts. Output is capped at {shell_cap_kb}KB; if exceeded, the top is truncated and only the last lines are returned.\nCommands are killed after {shell_timeout_sec}s by default; pass timeout_sec to override for a single call. Required: command.';

// OS display names keyed by process.platform.
const OS_NAMES = {
    win32: 'Windows',
    linux: 'Linux',
    darwin: 'macOS'
};

// Build an OS-appropriate example file path from the real home directory of the
// machine running this. File tools use Node fs, which speaks the native OS path
// format regardless of which shell is selected, so the example must come from
// the OS, not the shell. On Windows we use forward slashes (e.g. C:/Users/...),
// which work in both Node fs and Git Bash, avoiding the POSIX-path trap.
function getOsValues() {
    const osName = OS_NAMES[process.platform] || 'Linux';
    let home = os.homedir() || (process.platform === 'win32' ? 'C:\\Users\\user' : '/home/user');
    if (process.platform === 'win32') {
        home = home.replace(/\\/g, '/');
    }
    const examplePath = `${home}/file.txt`;
    return { osName, examplePath };
}

// Shell-derived template values. Keyed by the binary basename returned from
// shellService.getPreferredShell(). These decide the shell display name and the
// command syntax used only by shell_run.
const SHELL_TEMPLATES = {
    bash: { shellName: 'bash', shellSyntax: 'Use && to chain commands. Use double quotes for paths with spaces.' },
    sh: { shellName: 'sh', shellSyntax: 'Use && to chain commands. Use double quotes for paths with spaces.' },
    zsh: { shellName: 'zsh', shellSyntax: 'Use && to chain commands. Use double quotes for paths with spaces.' },
    ksh: { shellName: 'ksh', shellSyntax: 'Use && to chain commands. Use double quotes for paths with spaces.' },
    dash: { shellName: 'dash', shellSyntax: 'Use && to chain commands. Use double quotes for paths with spaces.' },
    pwsh: { shellName: 'PowerShell 7+', shellSyntax: 'Use && to chain commands. Use & "path with spaces\\script.ps1" for executables with spaces.' },
    powershell: { shellName: 'PowerShell 5.1', shellSyntax: 'Use ; to chain commands. Use & "path with spaces\\script.ps1" for executables with spaces.' },
    cmd: { shellName: 'cmd.exe', shellSyntax: 'Use && to chain commands. Use double quotes for paths with spaces. Use %VAR% for environment variables.' }
};

// Resolve shell template values for a shell binary name, falling back to cmd on
// Windows / sh on Unix when the name is unknown.
function getShellValues(shellName) {
    if (SHELL_TEMPLATES[shellName]) return SHELL_TEMPLATES[shellName];
    return process.platform === 'win32' ? SHELL_TEMPLATES.cmd : SHELL_TEMPLATES.sh;
}

function fillTemplate(tpl, shellName, limitKb, timeoutSec) {
    const os = getOsValues();
    const shell = getShellValues(shellName);
    return tpl
        .replaceAll('{os_name}', os.osName)
        .replaceAll('{example_path}', os.examplePath)
        .replaceAll('{shell_name}', shell.shellName)
        .replaceAll('{shell_syntax}', shell.shellSyntax)
        .replaceAll('{read_cap_kb}', String(limitKb))
        .replaceAll('{shell_cap_kb}', String(limitKb - 1))
        .replaceAll('{shell_timeout_sec}', String(timeoutSec));
}

function getToolDefinitions(shellInfo, config, defaultTimeoutSec = 360) {
    const shellName = shellInfo && shellInfo.name ? shellInfo.name : 'cmd';
    const limitKb = getLimitKb(config);
    return [
        {
            name: 'read_file',
            description: fillTemplate(READ_FILE_TPL, shellName, limitKb),
            input_schema: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'File path to read (absolute or relative)' },
                    start_line: { type: 'integer', description: 'Optional 1-based first line to read. Required to read files larger than the size cap.' },
                    end_line: { type: 'integer', description: 'Optional 1-based last line to read (inclusive). Defaults to start_line when omitted.' }
                },
                required: ['path'],
                additionalProperties: false
            }
        },
        {
            name: 'write_file',
            description: fillTemplate(WRITE_FILE_TPL, shellName, limitKb),
            input_schema: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'File path to write (absolute or relative)' },
                    content: { type: 'string', description: 'Content to write to the file' }
                },
                required: ['path', 'content'],
                additionalProperties: false
            }
        },
        {
            name: 'edit_file',
            description: fillTemplate(EDIT_FILE_TPL, shellName, limitKb),
            input_schema: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'File path to edit (absolute or relative)' },
                    edits: {
                        type: 'array',
                        description: 'Edits to apply in order. Each replaces the first occurrence of old_string (in the file as modified by preceding edits) with new_string.',
                        items: {
                            type: 'object',
                            properties: {
                                old_string: { type: 'string', description: 'Exact text to find, including whitespace and newlines' },
                                new_string: { type: 'string', description: 'Replacement text' }
                            },
                            required: ['old_string', 'new_string'],
                            additionalProperties: false
                        }
                    }
                },
                required: ['path', 'edits'],
                additionalProperties: false
            }
        },
        {
            name: 'shell_run',
            description: fillTemplate(SHELL_RUN_TPL, shellName, limitKb, defaultTimeoutSec),
            input_schema: {
                type: 'object',
                properties: {
                    command: { type: 'string', description: 'Shell command to execute' },
                    timeout_sec: { type: 'integer', description: `Optional. Override the default ${defaultTimeoutSec}s timeout for this command.` }
                },
                required: ['command'],
                additionalProperties: false
            }
        }
    ];
}

async function executeSimpleTool(toolName, args, opts = {}) {
    const config = loadConfig();
    if (!isToolEnabled(toolName, config)) {
        throw new Error(`SimpleTool '${toolName}' is disabled. Enable it in Settings > Tools.`);
    }

    const limitKb = getLimitKb(config);
    const readCap = limitKb * KB;
    const shellCap = (limitKb - 1) * KB;

    switch (toolName) {
        case 'read_file':
            return doReadFile(args, readCap, opts.cwd);
        case 'write_file':
            return doWriteFile(args, opts.cwd);
        case 'edit_file':
            return doEdit(args, opts.cwd);
        case 'shell_run':
            return doShellRun(args, opts, shellCap);
        default:
            throw new Error(`Unknown SimpleTool: ${toolName}`);
    }
}

async function doReadFile(args, readCap = DEFAULT_OUTPUT_LIMIT_KB * KB, cwd) {
    const filePath = args?.path;
    if (!filePath) {
        throw new Error('Missing required field: path');
    }
    const resolvedPath = (cwd && !path.isAbsolute(filePath))
        ? path.resolve(cwd, filePath)
        : filePath;

    const startLine = args?.start_line;
    const endLine = args?.end_line;
    const hasRange = startLine !== undefined && startLine !== null;

    let content;
    try {
        content = fs.readFileSync(resolvedPath, 'utf8');
    } catch (error) {
        if (error.code === 'ENOENT') {
            throw new Error(`Cannot read '${resolvedPath}': file not found (${error.message})`);
        }
        if (error.code === 'EACCES') {
            throw new Error(`Cannot read '${resolvedPath}': permission denied (${error.message})`);
        }
        if (error.code === 'EISDIR') {
            throw new Error(`Cannot read '${resolvedPath}': is a directory`);
        }
        throw new Error(`Cannot read '${resolvedPath}': I/O error (${error.message})`);
    }

    const totalLines = content.split('\n').length;

    // No range + too big: refuse instead of truncating, so the model is told the
    // file is large and pages it explicitly rather than silently losing content.
    if (!hasRange && content.length > readCap) {
        return {
            success: false,
            error: 'File too large',
            message: `File '${resolvedPath}' is ${content.length} characters (${totalLines} lines), which exceeds the ${readCap}-character limit. Read a portion with start_line/end_line.`,
            total_size: content.length,
            line_count: totalLines
        };
    }

    // Resolve the slice to return.
    let outText = content;
    let firstLine = 1;
    if (hasRange) {
        const lines = content.split('\n');
        const startIdx = Math.max(0, startLine - 1);
        const endIdx = (endLine !== undefined && endLine !== null) ? endLine : startIdx + 1;
        const slice = lines.slice(startIdx, endIdx);
        outText = slice.join('\n');
        firstLine = startIdx + 1;
    }

    // Even a requested range can exceed the cap; refuse and ask for a smaller one.
    if (outText.length > readCap) {
        return {
            success: false,
            error: 'Selected range too large',
            message: `The requested range is ${outText.length} characters, which exceeds the ${readCap}-character limit. Request a smaller start_line/end_line range.`,
            total_size: content.length,
            line_count: totalLines
        };
    }

    const result = {
        success: true,
        content: outText,
        size: outText.length
    };
    if (hasRange) {
        result.start_line = firstLine;
        result.end_line = firstLine + outText.split('\n').length - 1;
        result.total_lines = totalLines;
    }
    return result;
}

async function doWriteFile(args, cwd) {
    const filePath = args?.path;
    if (!filePath) {
        throw new Error('Missing required field: path');
    }
    const resolvedPath = (cwd && !path.isAbsolute(filePath))
        ? path.resolve(cwd, filePath)
        : filePath;

    const content = args?.content;
    if (content === undefined || content === null) {
        throw new Error('Missing required field: content');
    }

    const contentStr = String(content);

    try {
        const dir = path.dirname(resolvedPath);
        if (dir && !fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(resolvedPath, contentStr, 'utf8');
        return {
            success: true,
            path: resolvedPath,
            bytes_written: Buffer.byteLength(contentStr, 'utf8')
        };
    } catch (error) {
        throw new Error(`Failed to write file '${resolvedPath}': ${error.message}`);
    }
}

async function doEdit(args, cwd) {
    const filePath = args?.path;
    if (!filePath) {
        throw new Error('Missing required field: path');
    }
    const resolvedPath = (cwd && !path.isAbsolute(filePath))
        ? path.resolve(cwd, filePath)
        : filePath;

    const edits = args?.edits;
    if (!Array.isArray(edits) || edits.length === 0) {
        throw new Error('Missing required field: edits (must be a non-empty array of {old_string, new_string})');
    }

    let content;
    try {
        content = fs.readFileSync(resolvedPath, 'utf8');
    } catch (error) {
        const kind = error.code === 'ENOENT' ? 'file not found'
            : error.code === 'EACCES' ? 'permission denied'
            : error.code === 'EISDIR' ? 'is a directory'
            : 'I/O error';
        throw new Error(`Cannot read '${resolvedPath}': ${kind} (${error.message})`);
    }

    // Apply all edits to an in-memory copy first. Sequential — each edit sees the
    // result of the previous one. All-or-nothing: if any edit fails to match,
    // nothing is written and the error names which edit and against what state.
    let working = content;
    // 1-based file line where each edit's old_string matched, in the content as it
    // existed when that edit applied (edit 2 sees edit 1's result). Lets the UI show
    // real file line numbers in the diff, not snippet-relative ones.
    const editLines = [];
    for (let i = 0; i < edits.length; i++) {
        const edit = edits[i] || {};
        const oldString = edit.old_string;
        const newString = edit.new_string;
        const pos = `${i + 1} of ${edits.length}`;

        if (oldString === undefined || oldString === null) {
            throw new Error(`Edit ${pos} is missing old_string. No changes were written.`);
        }
        if (newString === undefined || newString === null) {
            throw new Error(`Edit ${pos} is missing new_string. No changes were written.`);
        }

        const matchIndex = working.indexOf(oldString);
        if (matchIndex === -1) {
            const snippet = oldString.length > 200 ? oldString.slice(0, 200) + '…' : oldString;
            const against = i === 0 ? 'the original file' : `the file as modified by edits 1–${i}`;
            throw new Error(
                `Edit ${pos} failed: old_string not found.\n  old_string: ${JSON.stringify(snippet)}\n` +
                `No changes were written. old_string must match exactly, including whitespace and newlines ` +
                `(matched against ${against}).`
            );
        }

        // Line number = how many newlines precede the match, + 1.
        editLines.push(working.slice(0, matchIndex).split('\n').length);
        working = working.slice(0, matchIndex) + newString + working.slice(matchIndex + oldString.length);
    }

    try {
        fs.writeFileSync(resolvedPath, working, 'utf8');
        return {
            success: true,
            path: resolvedPath,
            edits_applied: edits.length,
            edit_lines: editLines
        };
    } catch (error) {
        throw new Error(`Failed to write file '${resolvedPath}': ${error.message}`);
    }
}

// Bound candidate width so pathological output cannot turn block detection into
// unbounded quadratic work. This still covers long stack traces and log cycles.
const MAX_REPEATED_BLOCK_LINES = 100;
const MAX_REPEATED_BLOCK_COMPARISONS = 5_000_000;
const MAX_COMPACTION_LINES = 200_000;

function blocksEqual(lines, first, second, size, budget) {
    for (let offset = 0; offset < size; offset++) {
        if (budget.remaining-- <= 0) return null;
        if (lines[first + offset] !== lines[second + offset]) return false;
    }
    return true;
}

// Losslessly compact adjacent, exactly equal line sequences in the model-facing
// result. At each position, consider every block width up to the safety bound and
// choose the match with the greatest character savings. Explicit markers retain
// the copy count and block width; streamed chunks keep the command's raw output.
function compactRepeatedBlocks(text) {
    const unchanged = { output: text, protectedRanges: [] };
    if (!text) return unchanged;

    let lineCount = 1;
    for (let newline = text.indexOf('\n'); newline !== -1; newline = text.indexOf('\n', newline + 1)) {
        if (++lineCount > MAX_COMPACTION_LINES) return unchanged;
    }

    const endsWithNewline = text.endsWith('\n');
    const lines = text.split('\n');
    if (endsWithNewline) lines.pop();
    // A CR in this position belongs to a CRLF delimiter, not the line's content.
    // Treat CRLF and LF as equivalent while retaining the original text for output.
    // An unterminated final CR remains content (for example, a progress update).
    const lineIds = [];
    const idsByContent = new Map();
    for (let i = 0; i < lines.length; i++) {
        const terminatedByLf = endsWithNewline || i < lines.length - 1;
        const content = terminatedByLf && lines[i].endsWith('\r') ? lines[i].slice(0, -1) : lines[i];
        if (!idsByContent.has(content)) idsByContent.set(content, idsByContent.size);
        lineIds.push(idsByContent.get(content));
    }
    const lineLengthPrefix = [0];
    for (const line of lines) {
        lineLengthPrefix.push(lineLengthPrefix[lineLengthPrefix.length - 1] + line.length);
    }

    const budget = { remaining: MAX_REPEATED_BLOCK_COMPARISONS };
    const entries = [];
    for (let i = 0; i < lines.length;) {
        let best = null;
        const maxBlockSize = Math.min(MAX_REPEATED_BLOCK_LINES, Math.floor((lines.length - i) / 2));

        for (let blockSize = 1; blockSize <= maxBlockSize; blockSize++) {
            const firstRepeatMatches = blocksEqual(lineIds, i, i + blockSize, blockSize, budget);
            if (firstRepeatMatches === null) return unchanged;
            if (!firstRepeatMatches) continue;

            let copies = 2;
            while (i + ((copies + 1) * blockSize) <= lines.length) {
                const nextRepeatMatches = blocksEqual(
                    lineIds,
                    i,
                    i + (copies * blockSize),
                    blockSize,
                    budget
                );
                if (nextRepeatMatches === null) return unchanged;
                if (!nextRepeatMatches) break;
                copies++;
            }

            const consumedLines = copies * blockSize;
            const sourceLength = lineLengthPrefix[i + consumedLines] - lineLengthPrefix[i] + consumedLines - 1;
            const blockLength = lineLengthPrefix[i + blockSize] - lineLengthPrefix[i] + blockSize - 1;
            const header = `<<< repeated block: ${copies} copies, ${blockSize} ${blockSize === 1 ? 'line' : 'lines'} each >>>`;
            const replacementLength = header.length + 1 + blockLength + 1 + '<<< end repeated block >>>'.length;
            const savings = sourceLength - replacementLength;
            if (savings > 0 && (!best || savings > best.savings || (savings === best.savings && blockSize < best.blockSize))) {
                best = { blockSize, copies, savings, header };
            }
        }

        if (best) {
            entries.push({
                text: [
                    best.header,
                    ...lines.slice(i, i + best.blockSize),
                    '<<< end repeated block >>>'
                ].join('\n'),
                protected: true
            });
            i += best.blockSize * best.copies;
        } else {
            entries.push({ text: lines[i], protected: false });
            i++;
        }
    }

    let output = '';
    const protectedRanges = [];
    for (let i = 0; i < entries.length; i++) {
        if (i > 0) output += '\n';
        const start = output.length;
        output += entries[i].text;
        if (entries[i].protected) protectedRanges.push({ start, end: output.length });
    }
    if (endsWithNewline) output += '\n';
    return { output, protectedRanges };
}

// Shell output keeps the TAIL, not the head — for build logs, test runs, and
// stack traces the important content (errors, summaries, final result) is at the
// end. When truncated, trim to the next line boundary and prepend a notice so the
// model knows content above was dropped. Generated repeat blocks are atomic: if
// the cutoff intersects one, omit the whole block instead of orphaning its markers.
function truncateShellOutput(text, cap, protectedRanges = []) {
    if (text.length <= cap) {
        return { output: text, truncated: false };
    }
    let cutoff = text.length - cap;
    const nl = text.indexOf('\n', cutoff);
    if (nl !== -1) {
        cutoff = nl + 1;
    }
    const intersectedRange = protectedRanges.find(range => cutoff > range.start && cutoff < range.end);
    if (intersectedRange) {
        cutoff = intersectedRange.end;
        if (text[cutoff] === '\n') cutoff++;
    }
    return { output: SHELL_TRUNCATE_NOTICE + text.slice(cutoff), truncated: true };
}

function prepareShellOutput(rawText, totalLength, cap) {
    const compacted = compactRepeatedBlocks(rawText);
    let result = truncateShellOutput(compacted.output, cap, compacted.protectedRanges);
    const captureTruncated = (totalLength ?? rawText.length) > rawText.length;
    if (captureTruncated && !result.truncated) {
        result = { output: SHELL_TRUNCATE_NOTICE + result.output, truncated: true };
    }
    return result;
}

// Upper bound on bytes held in memory per stream. We only ever return the tail,
// so a rolling slice keeps memory bounded even for runaway output while preserving
// the most recent content. A separate counter tracks the true total length.
const SHELL_MAX_CAPTURE = 10 * 1024 * 1024;

// Run the command via async spawn (NOT spawnSync) so the Node event loop stays
// free while the command runs — streaming, steering, and other requests keep
// working. Resolves to a spawnSync-shaped result { stdout, stderr, status, error }.
// onChunk(streamName, text) is invoked for each stdout/stderr chunk as it arrives,
// which is what feeds the live console in the UI (the resolved result, separately,
// is the capped text the model sees — one source, two sinks).
function runShellAsync(shell, argv, options, onChunk, timeoutMs) {
    return new Promise((resolve) => {
        let child;
        try {
            child = spawn(shell, argv, options);
        } catch (error) {
            resolve({ stdout: '', stdout_total: 0, stderr: '', stderr_total: 0, status: null, error });
            return;
        }

        let stdout = '';
        let stdoutTotal = 0;
        let stderr = '';
        let stderrTotal = 0;
        let spawnError = null;
        let timedOut = false;

        const append = (chunk, isOut) => {
            if (typeof onChunk === 'function') {
                try { onChunk(isOut ? 'stdout' : 'stderr', chunk); } catch (_) {}
            }
            if (isOut) {
                stdoutTotal += chunk.length;
                stdout += chunk;
                if (stdout.length > SHELL_MAX_CAPTURE) {
                    stdout = stdout.slice(stdout.length - SHELL_MAX_CAPTURE);
                }
            } else {
                stderrTotal += chunk.length;
                stderr += chunk;
                if (stderr.length > SHELL_MAX_CAPTURE) {
                    stderr = stderr.slice(stderr.length - SHELL_MAX_CAPTURE);
                }
            }
        };

        if (child.stdout) {
            child.stdout.setEncoding('utf8');
            child.stdout.on('data', (d) => append(d, true));
        }
        if (child.stderr) {
            child.stderr.setEncoding('utf8');
            child.stderr.on('data', (d) => append(d, false));
        }
        child.on('error', (err) => { spawnError = err; });

        let timer = null;
        if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
            timer = setTimeout(() => {
                timedOut = true;
                try { child.kill(); } catch (_) {}
            }, timeoutMs);
        }

        child.on('close', (code) => {
            if (timer) clearTimeout(timer);
            resolve({ stdout, stdout_total: stdoutTotal, stderr, stderr_total: stderrTotal, status: code, error: spawnError, timedOut });
        });
    });
}

async function doShellRun(args, opts = {}, shellCap = (DEFAULT_OUTPUT_LIMIT_KB - 1) * KB) {
    const command = args?.command;
    if (!command) {
        throw new Error('Missing required field: command');
    }

    const shellInfo = opts.shellInfo || shellService.getPreferredShell('auto');
    const shellArgs = shellService.getShellArgs(shellInfo, command);
    // cwd is resolved per-chat by the caller (project dir / defaultCwd / home).
    // Never fall back to process.cwd() — it reflects how the app was launched,
    // not a meaningful working directory.
    const os = require('os');
    const cwd = opts.cwd || os.homedir();

    const defaultTimeoutSec = Number.isFinite(opts.defaultTimeoutSec) ? opts.defaultTimeoutSec : 360;
    const requestedTimeoutSec = Number(args?.timeout_sec);
    const timeoutSec = Number.isFinite(requestedTimeoutSec) && requestedTimeoutSec > 0 ? requestedTimeoutSec : defaultTimeoutSec;

    try {
        // spawn passes args as an array — no shell interpolation, no double-quoting
        // of the command by an outer shell. Async so it doesn't block the event loop.
        const result = await runShellAsync(shellArgs.shell, shellArgs.args, {
            windowsHide: true,
            cwd
        }, opts.onChunk, timeoutSec * 1000);

        const exitCode = result.status ?? 0;
        const failed = (result.status !== 0 || result.error) && !result.timedOut;
        const rawStdout = result.stdout || '';
        const preparedOutput = prepareShellOutput(rawStdout, result.stdout_total, shellCap);
        const rawStderr = result.stderr || '';
        const preparedError = (failed || result.timedOut) && rawStderr
            ? prepareShellOutput(rawStderr, result.stderr_total, shellCap)
            : { output: rawStderr, truncated: false };
        const timeoutError = `Command timed out after ${timeoutSec}s`
            + (preparedError.output ? `\n${preparedError.output}` : '');

        const base = {
            success: !failed && !result.timedOut,
            output: preparedOutput.output,
            exit_code: exitCode,
            error: result.timedOut ? timeoutError
                : failed ? (preparedError.output || (result.error ? result.error.message : 'Command failed'))
                : null
        };
        if (result.timedOut) base.timed_out = true;
        if (preparedOutput.truncated) {
            base.truncated = true;
            base.total_output_size = result.stdout_total ?? rawStdout.length;
        }
        if (preparedError.truncated) {
            base.error_truncated = true;
            base.total_error_size = result.stderr_total ?? rawStderr.length;
        }
        return base;
    } catch (error) {
        return {
            success: false,
            output: '',
            exit_code: 1,
            error: error.message
        };
    }
}

module.exports = {
    loadConfig,
    saveConfig,
    isToolEnabled,
    getToolDefinitions,
    executeSimpleTool
};
