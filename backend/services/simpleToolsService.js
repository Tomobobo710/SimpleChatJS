const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { log } = require('../utils/logger');
const { getUserdataPath } = require('../utils/pathUtils');
const shellService = require('./shellService');

const CONFIG_FILE = 'simple_tools_config.json';

function getConfigPath() {
    return getUserdataPath(CONFIG_FILE);
}

const DEFAULT_CONFIG = {
    read_file: true,
    write_file: true,
    edit_file: true,
    shell_run: true
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

// Madlibs-style description templates. Placeholders are filled at request time
// based on the detected shell binary name. Every tool description states the
// OS and shell, with a concrete example path so the AI uses the right path
// format (prevents /home/Tom/... being written to C:\home\Tom\... on Windows).
const READ_FILE_TPL = 'Read the contents of a file at the given path.\nYou are on {os_name} using {shell_name}.\nFile path example: {example_path}\nOutput is capped at 12KB. Required: path.';
const WRITE_FILE_TPL = 'Create or overwrite a file at the given path with the specified content.\nYou are on {os_name} using {shell_name}.\nFile path example: {example_path}\nRequired: path, content.';
const EDIT_FILE_TPL = 'Replace text in a file. Specify the file path, exact text to find, and replacement text.\nYou are on {os_name} using {shell_name}.\nFile path example: {example_path}\nRequired: path, old_string, new_string.';
const SHELL_RUN_TPL = 'Run a {shell_name} command and return its output. Use for: executing commands, scripts, build tools, git operations.\nYou are on {os_name} using {shell_name}.\n{shell_syntax}\nOutput is capped at 12KB. Required: command.';

// Per-binary template values. Keyed by the binary basename returned from
// shellService.getPreferredShell().
const SHELL_TEMPLATES = {
    bash: {
        osName: 'Windows',
        shellName: 'bash',
        examplePath: '/home/Tom/Desktop/file.txt',
        shellSyntax: 'Use && to chain commands. Use double quotes for paths with spaces.'
    },
    sh: {
        osName: 'Linux/macOS',
        shellName: 'sh',
        examplePath: '/home/user/file.txt',
        shellSyntax: 'Use && to chain commands. Use double quotes for paths with spaces.'
    },
    zsh: {
        osName: 'Linux/macOS',
        shellName: 'zsh',
        examplePath: '/home/user/file.txt',
        shellSyntax: 'Use && to chain commands. Use double quotes for paths with spaces.'
    },
    ksh: {
        osName: 'Linux/macOS',
        shellName: 'ksh',
        examplePath: '/home/user/file.txt',
        shellSyntax: 'Use && to chain commands. Use double quotes for paths with spaces.'
    },
    dash: {
        osName: 'Linux/macOS',
        shellName: 'dash',
        examplePath: '/home/user/file.txt',
        shellSyntax: 'Use && to chain commands. Use double quotes for paths with spaces.'
    },
    pwsh: {
        osName: 'Windows',
        shellName: 'PowerShell 7+',
        examplePath: 'C:\\Users\\Tom\\Desktop\\file.txt',
        shellSyntax: 'Use && to chain commands. Use & "path with spaces\\script.ps1" for executables with spaces.'
    },
    powershell: {
        osName: 'Windows',
        shellName: 'PowerShell 5.1',
        examplePath: 'C:\\Users\\Tom\\Desktop\\file.txt',
        shellSyntax: 'Use ; to chain commands. Use & "path with spaces\\script.ps1" for executables with spaces.'
    },
    cmd: {
        osName: 'Windows',
        shellName: 'cmd.exe',
        examplePath: 'C:\\Users\\Tom\\Desktop\\file.txt',
        shellSyntax: 'Use && to chain commands. Use double quotes for paths with spaces. Use %VAR% for environment variables.'
    }
};

// Resolve template values for a shell binary name, falling back to cmd on
// Windows / sh on Unix when the name is unknown.
function getTemplateValues(shellName) {
    if (SHELL_TEMPLATES[shellName]) return SHELL_TEMPLATES[shellName];
    const fallback = process.platform === 'win32' ? SHELL_TEMPLATES.cmd : SHELL_TEMPLATES.sh;
    return fallback;
}

function fillTemplate(tpl, shellName) {
    const v = getTemplateValues(shellName);
    return tpl
        .replace('{os_name}', v.osName)
        .replace('{shell_name}', v.shellName)
        .replace('{example_path}', v.examplePath)
        .replace('{shell_syntax}', v.shellSyntax);
}

function getToolDefinitions(shellInfo) {
    const shellName = shellInfo && shellInfo.name ? shellInfo.name : 'cmd';
    return [
        {
            name: 'read_file',
            description: fillTemplate(READ_FILE_TPL, shellName),
            input_schema: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'File path to read (absolute or relative)' }
                },
                required: ['path'],
                additionalProperties: false
            }
        },
        {
            name: 'write_file',
            description: fillTemplate(WRITE_FILE_TPL, shellName),
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
            description: fillTemplate(EDIT_FILE_TPL, shellName),
            input_schema: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'File path to edit (absolute or relative)' },
                    old_string: { type: 'string', description: 'Exact string to find and replace' },
                    new_string: { type: 'string', description: 'Replacement string' }
                },
                required: ['path', 'old_string', 'new_string'],
                additionalProperties: false
            }
        },
        {
            name: 'shell_run',
            description: fillTemplate(SHELL_RUN_TPL, shellName),
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

    switch (toolName) {
        case 'read_file':
            return doReadFile(args);
        case 'write_file':
            return doWriteFile(args);
        case 'edit_file':
            return doEdit(args);
        case 'shell_run':
            return doShellRun(args, opts);
        default:
            throw new Error(`Unknown SimpleTool: ${toolName}`);
    }
}

async function doReadFile(args) {
    const filePath = args?.path;
    if (!filePath) {
        throw new Error('Missing required field: path');
    }

    try {
        const content = fs.readFileSync(filePath, 'utf8');
        const size = content.length;
        if (size > 12_000) {
            return {
                success: true,
                content: content.substring(0, 12_000),
                truncated: true,
                total_size: size,
                message: `File contents truncated to 12KB (${size} bytes total)`
            };
        }
        return {
            success: true,
            content,
            size
        };
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

    const oldString = args?.old_string;
    if (oldString === undefined || oldString === null) {
        throw new Error('Missing required field: old_string');
    }

    const newString = args?.new_string;
    if (newString === undefined || newString === null) {
        throw new Error('Missing required field: new_string');
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

    if (!content.includes(oldString)) {
        throw new Error(
            `old_string not found in '${filePath}'.\n\nThe old_string must match exactly, including whitespace and newlines.\n\nHint: Use read_file to view the file content first.`
        );
    }

    const newContent = content.replace(oldString, newString);
    try {
        fs.writeFileSync(filePath, newContent, 'utf8');
        return {
            success: true,
            path: filePath,
            replacements: 1
        };
    } catch (error) {
        throw new Error(`Failed to write file '${filePath}': ${error.message}`);
    }
}

async function doShellRun(args, opts = {}) {
    const command = args?.command;
    if (!command) {
        throw new Error('Missing required field: command');
    }

    const shellInfo = opts.shellInfo || shellService.getPreferredShell('auto');
    const shellArgs = shellService.getShellArgs(shellInfo, command);

    try {
        // spawnSync passes args as an array — no shell interpolation, no
        // double-quoting of the command by an outer shell.
        const result = spawnSync(shellArgs.shell, shellArgs.args, {
            encoding: 'utf8',
            maxBuffer: 12_000 * 2,
            windowsHide: true,
            cwd: process.cwd()
        });

        const stdout = result.stdout || '';
        const stderr = result.stderr || '';
        const exitCode = result.status ?? 0;
        const failed = result.status !== 0 || result.error;

        if (failed) {
            const errResult = {
                success: false,
                output: stdout,
                exit_code: exitCode,
                error: stderr || (result.error ? result.error.message : 'Command failed')
            };
            if (stdout.length > 12_000) {
                errResult.output = stdout.substring(0, 12_000);
                errResult.truncated = true;
                errResult.total_output_size = stdout.length;
            }
            return errResult;
        }

        if (stdout.length > 12_000) {
            return {
                success: true,
                output: stdout.substring(0, 12_000),
                truncated: true,
                total_output_size: stdout.length,
                exit_code: exitCode,
                error: null
            };
        }
        return {
            success: true,
            output: stdout,
            exit_code: exitCode,
            error: null
        };
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
