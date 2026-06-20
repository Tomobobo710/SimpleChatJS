const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { log } = require('../utils/logger');
const { getUserdataPath } = require('../utils/pathUtils');

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

function getToolDefinitions() {
    return [
        {
            name: 'read_file',
            description: 'Read a UTF-8 text file and return its content. Use for: viewing files, reading code, inspecting configs. Required: path (absolute or relative to workspace).',
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
            description: 'Create a new file or overwrite an existing file with the given content. Use for: creating files, replacing entire file content. Required: path, content.',
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
            description: 'Replace the first occurrence of old_string with new_string in an existing file. The old_string must match exactly (including whitespace). Use for: targeted code modifications. Required: path, old_string, new_string.',
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
            description: 'Run a shell command and return its output. Use for: executing commands, scripts, build tools, git operations. Output is capped at 12KB. Required: command.',
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

async function executeSimpleTool(toolName, args) {
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
            return doBashRun(args);
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

async function doBashRun(args) {
    const command = args?.command;
    if (!command) {
        throw new Error('Missing required field: command');
    }

    try {
        const shell = process.platform === 'win32' ? 'cmd' : 'sh';
        const shellArg = process.platform === 'win32' ? '/C' : '-c';
        const result = execSync(`${shell} ${shellArg} "${command.replace(/"/g, '\\"')}"`, {
            encoding: 'utf8',
            maxBuffer: 12_000 * 2,
            windowsHide: true
        });

        const output = result || '';
        const exitCode = 0;

        if (output.length > 12_000) {
            return {
                success: true,
                output: output.substring(0, 12_000),
                truncated: true,
                total_output_size: output.length,
                exit_code: exitCode,
                error: null
            };
        }
        return {
            success: true,
            output,
            exit_code: exitCode,
            error: null
        };
    } catch (error) {
        const stdout = error.stdout?.toString() || '';
        const stderr = error.stderr?.toString() || '';
        const exitCode = error.status ?? 1;

        const result = {
            success: false,
            output: stdout,
            exit_code: exitCode,
            error: stderr || error.message
        };

        if (stdout.length > 12_000) {
            result.output = stdout.substring(0, 12_000);
            result.truncated = true;
            result.total_output_size = stdout.length;
        }

        return result;
    }
}

module.exports = {
    loadConfig,
    saveConfig,
    isToolEnabled,
    getToolDefinitions,
    executeSimpleTool
};
