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
const SHELL_TRUNCATE_NOTICE = 'NOTICE: The output of this tool call was truncated.. additional content above is omitted.\n';

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
const READ_FILE_TPL = "Read the contents of a file at the given path. You'll use this the most to read content.\nYou are on {os_name}.\nFile path example: {example_path}\nOptional: start_line and end_line to read a specific line range; line_numbers (boolean) to prefix each line with its number.\nOutput is capped at {read_cap_kb}KB; if a file exceeds that, read a portion with start_line/end_line.\nRequired: path.";
const WRITE_FILE_TPL = 'Create or overwrite a file at the given path with the specified content.\nYou are on {os_name}.\nFile path example: {example_path}\nRequired: path, content.';
const EDIT_FILE_TPL = 'This is the primary tool for modifying files — prefer it over shell commands (sed, awk, Set-Content, etc.) for any edit.\nApplies one or more exact-text find/replace edits to a file. Provide an "edits" array; each edit has old_string (exact text to find, including whitespace and newlines) and new_string (replacement).\nEdits apply in order, each operating on the result of the previous one. Either all edits apply or none do — if any old_string is not found, nothing is written and the error names which edit failed.\nYou are on {os_name}.\nFile path example: {example_path}\nRequired: path, edits.';
const SHELL_RUN_TPL = 'Run a {shell_name} command and return its output. This tool should be used for non-file operations, use read_file, write_file, and edit_file for those operations. Use for: executing commands, scripts, build tools, git operations.\nYou are on {os_name} using {shell_name}.\n{shell_syntax}\nOutput is capped at {shell_cap_kb}KB; if exceeded, the top is truncated and only the last lines are returned. Required: command.';

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

function fillTemplate(tpl, shellName, limitKb) {
    const os = getOsValues();
    const shell = getShellValues(shellName);
    return tpl
        .replaceAll('{os_name}', os.osName)
        .replaceAll('{example_path}', os.examplePath)
        .replaceAll('{shell_name}', shell.shellName)
        .replaceAll('{shell_syntax}', shell.shellSyntax)
        .replaceAll('{read_cap_kb}', String(limitKb))
        .replaceAll('{shell_cap_kb}', String(limitKb - 1));
}

function getToolDefinitions(shellInfo, config) {
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
                    end_line: { type: 'integer', description: 'Optional 1-based last line to read (inclusive). Defaults to start_line when omitted.' },
                    line_numbers: { type: 'boolean', description: 'Optional. When true, prefix each returned line with its line number.' }
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
            description: fillTemplate(SHELL_RUN_TPL, shellName, limitKb),
            input_schema: {
                type: 'object',
                properties: {
                    command: { type: 'string', description: 'Shell command to execute' }
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
            return doReadFile(args, readCap);
        case 'write_file':
            return doWriteFile(args);
        case 'edit_file':
            return doEdit(args);
        case 'shell_run':
            return doShellRun(args, opts, shellCap);
        default:
            throw new Error(`Unknown SimpleTool: ${toolName}`);
    }
}

async function doReadFile(args, readCap = DEFAULT_OUTPUT_LIMIT_KB * KB) {
    const filePath = args?.path;
    if (!filePath) {
        throw new Error('Missing required field: path');
    }

    const startLine = args?.start_line;
    const endLine = args?.end_line;
    const lineNumbers = args?.line_numbers === true;
    const hasRange = startLine !== undefined && startLine !== null;

    let content;
    try {
        content = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
        if (error.code === 'ENOENT') {
            throw new Error(`Cannot read '${filePath}': file not found (${error.message})`);
        }
        if (error.code === 'EACCES') {
            throw new Error(`Cannot read '${filePath}': permission denied (${error.message})`);
        }
        if (error.code === 'EISDIR') {
            throw new Error(`Cannot read '${filePath}': is a directory`);
        }
        throw new Error(`Cannot read '${filePath}': I/O error (${error.message})`);
    }

    const totalLines = content.split('\n').length;

    // No range + too big: refuse instead of truncating, so the model is told the
    // file is large and pages it explicitly rather than silently losing content.
    if (!hasRange && content.length > readCap) {
        return {
            success: false,
            error: 'File too large',
            message: `File '${filePath}' is ${content.length} characters (${totalLines} lines), which exceeds the ${readCap}-character limit. Read a portion with start_line/end_line.`,
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

    const finalContent = lineNumbers
        ? outText.split('\n').map((line, i) => `${firstLine + i}\t${line}`).join('\n')
        : outText;

    const result = {
        success: true,
        content: finalContent,
        size: outText.length
    };
    if (hasRange) {
        result.start_line = firstLine;
        result.end_line = firstLine + outText.split('\n').length - 1;
        result.total_lines = totalLines;
    }
    return result;
}

async function doWriteFile(args) {
    const filePath = args?.path;
    if (!filePath) {
        throw new Error('Missing required field: path');
    }

    const content = args?.content;
    if (content === undefined || content === null) {
        throw new Error('Missing required field: content');
    }

    const contentStr = String(content);

    try {
        const dir = path.dirname(filePath);
        if (dir && !fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(filePath, contentStr, 'utf8');
        return {
            success: true,
            path: filePath,
            bytes_written: Buffer.byteLength(contentStr, 'utf8')
        };
    } catch (error) {
        throw new Error(`Failed to write file '${filePath}': ${error.message}`);
    }
}

async function doEdit(args) {
    const filePath = args?.path;
    if (!filePath) {
        throw new Error('Missing required field: path');
    }

    const edits = args?.edits;
    if (!Array.isArray(edits) || edits.length === 0) {
        throw new Error('Missing required field: edits (must be a non-empty array of {old_string, new_string})');
    }

    let content;
    try {
        content = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
        const kind = error.code === 'ENOENT' ? 'file not found'
            : error.code === 'EACCES' ? 'permission denied'
            : error.code === 'EISDIR' ? 'is a directory'
            : 'I/O error';
        throw new Error(`Cannot read '${filePath}': ${kind} (${error.message})`);
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
        fs.writeFileSync(filePath, working, 'utf8');
        return {
            success: true,
            path: filePath,
            edits_applied: edits.length,
            edit_lines: editLines
        };
    } catch (error) {
        throw new Error(`Failed to write file '${filePath}': ${error.message}`);
    }
}

// Shell output keeps the TAIL, not the head — for build logs, test runs, and
// stack traces the important content (errors, summaries, final result) is at the
// end. When truncated, trim to the next line boundary and prepend a notice so the
// model knows content above was dropped.
function truncateShellOutput(text, cap) {
    if (text.length <= cap) {
        return { output: text, truncated: false };
    }
    let tail = text.slice(text.length - cap);
    const nl = tail.indexOf('\n');
    if (nl !== -1) {
        tail = tail.slice(nl + 1);
    }
    return { output: SHELL_TRUNCATE_NOTICE + tail, truncated: true };
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
function runShellAsync(shell, argv, options, onChunk) {
    return new Promise((resolve) => {
        let child;
        try {
            child = spawn(shell, argv, options);
        } catch (error) {
            resolve({ stdout: '', stdout_total: 0, stderr: '', status: null, error });
            return;
        }

        let stdout = '';
        let stdoutTotal = 0;
        let stderr = '';
        let spawnError = null;

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
        child.on('close', (code) => {
            resolve({ stdout, stdout_total: stdoutTotal, stderr, status: code, error: spawnError });
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

    try {
        // spawn passes args as an array — no shell interpolation, no double-quoting
        // of the command by an outer shell. Async so it doesn't block the event loop.
        const result = await runShellAsync(shellArgs.shell, shellArgs.args, {
            windowsHide: true,
            cwd
        }, opts.onChunk);

        const stdout = result.stdout || '';
        const stderr = result.stderr || '';
        const exitCode = result.status ?? 0;
        const failed = result.status !== 0 || result.error;

        const { output, truncated } = truncateShellOutput(stdout, shellCap);

        const base = {
            success: !failed,
            output,
            exit_code: exitCode,
            error: failed ? (stderr || (result.error ? result.error.message : 'Command failed')) : null
        };
        if (truncated) {
            base.truncated = true;
            base.total_output_size = result.stdout_total ?? stdout.length;
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
