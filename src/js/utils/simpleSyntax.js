// SimpleSyntax.js - Universal syntax highlighter for SimpleChatJS
// "Simple because it's fake": no real grammar, just a per-line left-to-right scan
// that disambiguates strings vs comments vs code by whichever opens first (so a
// `//` inside a URL stays a string, not a comment), plus per-language configs.
// Stays line-scoped so it's safe to run on partial/streaming code.
//
// ENHANCED: operators, punctuation, variables, properties, classes, decorators,
// regex literals, template interpolations, arrow functions, JSON keys, HTML tags,
// and more — giving ~10 distinct color groups instead of the old ~3.

function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Keyword sets (kept reasonable, not exhaustive — it's a fake highlighter).
const KW_JS = [
    'function', 'var', 'let', 'const', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default',
    'try', 'catch', 'finally', 'throw', 'return', 'break', 'continue', 'class', 'extends', 'super',
    'this', 'new', 'typeof', 'instanceof', 'in', 'of', 'async', 'await', 'import', 'export', 'from',
    'yield', 'delete', 'void', 'static', 'get', 'set',
    'true', 'false', 'null', 'undefined', 'NaN', 'Infinity'
];
const KW_PY = [
    'def', 'class', 'lambda', 'pass', 'with', 'as', 'yield', 'global', 'nonlocal', 'assert', 'del',
    'and', 'or', 'not', 'is', 'in', 'if', 'elif', 'else', 'for', 'while', 'try', 'except', 'finally',
    'raise', 'return', 'break', 'continue', 'import', 'from', 'async', 'await',
    'True', 'False', 'None', 'self'
];
const KW_CLIKE = [
    'int', 'float', 'double', 'char', 'void', 'bool', 'long', 'short', 'unsigned', 'signed',
    'struct', 'enum', 'union', 'typedef', 'class', 'public', 'private', 'protected', 'static', 'const',
    'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default', 'break', 'continue', 'return',
    'goto', 'sizeof', 'new', 'delete', 'this', 'namespace', 'using', 'template', 'typename', 'virtual',
    'override', 'final', 'try', 'catch', 'throw', 'import', 'package', 'func', 'var', 'let', 'mut',
    'fn', 'impl', 'trait', 'pub', 'use', 'mod', 'match', 'where', 'async', 'await', 'defer', 'go',
    'chan', 'interface', 'map', 'range', 'type', 'extends', 'implements',
    'true', 'false', 'null', 'nullptr', 'nil', 'None', 'NULL'
];
const KW_SHELL = [
    'if', 'then', 'elif', 'else', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac', 'in',
    'function', 'select', 'time', 'echo', 'cd', 'export', 'local', 'return', 'exit', 'set', 'unset',
    'readonly', 'declare', 'source', 'alias', 'true', 'false'
];
const KW_SQL = [
    'select', 'from', 'where', 'insert', 'into', 'update', 'delete', 'create', 'table', 'drop', 'alter',
    'add', 'join', 'inner', 'left', 'right', 'outer', 'full', 'on', 'group', 'by', 'order', 'having',
    'limit', 'offset', 'as', 'and', 'or', 'not', 'null', 'is', 'in', 'like', 'between', 'distinct',
    'union', 'all', 'values', 'set', 'primary', 'key', 'foreign', 'references', 'index', 'view', 'asc', 'desc'
];

// Multi-character operators (longest first so `===` beats `=`).
const OPS = [
    '=>', '===', '!==', '==', '!=', '<=', '>=', '&&', '||', '??', '?.',
    '+=', '-=', '*=', '/=', '%=', '**=', '<<', '>>', '>>>',
    '!', '&&', '||', '++', '--', '...', '@', '#'
];

// Per-language config: line-comment tokens, block-comment [open, close] (or null),
// string delimiters, keyword list, and case-insensitivity (SQL).
const LANGS = {
    javascript: { line: ['//'], block: ['/*', '*/'], strings: ['"', "'", '`'], kw: KW_JS },
    python:     { line: ['#'],  block: null,          strings: ['"', "'"],      kw: KW_PY },
    clike:      { line: ['//'], block: ['/*', '*/'], strings: ['"', "'"],      kw: KW_CLIKE },
    shell:      { line: ['#'],  block: null,          strings: ['"', "'", '`'], kw: KW_SHELL },
    sql:        { line: ['--'], block: ['/*', '*/'], strings: ["'", '"'],      kw: KW_SQL, ci: true },
    css:        { line: [],     block: ['/*', '*/'], strings: ['"', "'"],      kw: [] },
    html:       { line: [],     block: null,          strings: ['"', "'"],      kw: [] },
    xml:        { line: [],     block: null,          strings: ['"', "'"],      kw: [] },
    json:       { line: [],     block: null,          strings: ['"', "'"],      kw: [] },
    markdown:   { line: [],     block: null,          strings: ['"', "'"],      kw: [] },
    default:    { line: ['//', '#'], block: ['/*', '*/'], strings: ['"', "'", '`'], kw: KW_JS.concat(KW_PY) }
};

// Map common fence languages to a config.
const LANG_ALIASES = {
    js: 'javascript', javascript: 'javascript', ts: 'javascript', typescript: 'javascript',
    jsx: 'javascript', tsx: 'javascript', node: 'javascript', mjs: 'javascript', cjs: 'javascript',
    py: 'python', python: 'python',
    c: 'clike', h: 'clike', cpp: 'clike', 'c++': 'clike', cc: 'clike', hpp: 'clike',
    java: 'clike', cs: 'clike', csharp: 'clike', go: 'clike', golang: 'clike',
    rust: 'clike', rs: 'clike', php: 'clike', swift: 'clike', kotlin: 'clike', kt: 'clike',
    dart: 'clike', scala: 'clike',
    sh: 'shell', bash: 'shell', zsh: 'shell', shell: 'shell', console: 'shell', ps1: 'shell',
    sql: 'sql', mysql: 'sql', postgres: 'sql', postgresql: 'sql', sqlite: 'sql',
    css: 'css', scss: 'css', less: 'css',
    html: 'html', xhtml: 'html',
    xml: 'xml', svg: 'xml',
    json: 'json', yaml: 'json', yml: 'json', toml: 'json',
    md: 'markdown', markdown: 'markdown',
};

class SimpleSyntax {
    static highlight(code, language = '') {
        if (!code || typeof code !== 'string') return code;
        // No language label → don't guess; return plain (escaped) text. Guessing
        // with a default config only mislabels code we can't identify.
        if (!language || !language.trim()) return this.escapeHtml(code);
        const cfg = this.config(language);
        const lines = code.split('\n');
        let inBlock = false;
        const out = [];
        for (const line of lines) {
            const res = this.highlightLine(line, cfg, inBlock);
            out.push(res.html);
            inBlock = res.inBlock;
        }
        return out.join('\n');
    }

    // Streaming highlighter for live-rendered content. Re-highlighting the full text on
    // every chunk is O(n²) (a 600-line block costs seconds); this highlights only the
    // NEWLY-COMPLETED lines each push (carrying the block-comment state forward), so the
    // consumer can APPEND them and rebuild nothing — O(n) total. The last line is always
    // the still-growing tail, returned separately so the consumer can replace just it.
    static createStreamingHighlighter(language) {
        // Empty/unknown language → plain-escape each line (don't mislabel non-code as code),
        // still incrementally. Real language → per-line highlight carrying block state.
        const useHl = !!(language && language.trim());
        const cfg = useHl ? this.config(language) : null;
        let inBlock = false; // block-comment state entering the next line
        let consumed = 0;    // index in fullText up to which lines are committed (after last '\n')
        let committed = 0;   // count of committed lines
        const doLine = (line) => useHl
            ? SimpleSyntax.highlightLine(line, cfg, inBlock)
            : { html: SimpleSyntax.escapeHtml(line), inBlock };
        return {
            // push(fullText) -> { lines: [html for each newly-completed line], tail, committedBefore }.
            // O(new chars): scans only the unprocessed suffix via indexOf from `consumed`, so
            // re-pushing the whole growing string each chunk stays O(1) amortized per token.
            push: (text) => {
                text = String(text == null ? '' : text);
                const committedBefore = committed;
                const lines = [];
                let from = consumed, nl;
                while ((nl = text.indexOf('\n', from)) !== -1) {
                    const r = doLine(text.slice(from, nl));
                    inBlock = r.inBlock;
                    lines.push(r.html);
                    committed++;
                    from = nl + 1;
                }
                consumed = from;                       // everything up to the last '\n' is frozen
                const tail = doLine(text.slice(consumed)).html;  // only the current line, re-done
                return { lines, tail, committedBefore };
            }
        };
    }

    // Resolve + memoize a language config (compiles the keyword regex once).
    static config(language) {
        const raw = (language || '').toLowerCase();
        const key = LANG_ALIASES[raw] || (LANGS[raw] ? raw : 'default');
        const cfg = LANGS[key];
        if (cfg._kwRegex === undefined) {
            cfg._kwRegex = cfg.kw && cfg.kw.length
                ? new RegExp('\\b(' + cfg.kw.map(escapeRegExp).join('|') + ')\\b', cfg.ci ? 'gi' : 'g')
                : null;
        }
        if (cfg._opRegex === undefined) {
            cfg._opRegex = OPS.length
                ? new RegExp('(?:' + OPS.map(escapeRegExp).join('|') + ')', 'g')
                : null;
        }
        return cfg;
    }

    // Scan one line, emitting string/comment/code segments by whichever opens
    // first. Carries (and returns) the multi-line block-comment state.
    static highlightLine(line, cfg, inBlock) {
        let html = '';
        let buf = '';
        const flush = () => { if (buf) { html += this.highlightCode(buf, cfg); buf = ''; } };
        const comment = (text) => `<span class="syntax-comment">${this.escapeHtml(text)}</span>`;

        // Continuing a block comment from a previous line.
        if (inBlock && cfg.block) {
            const close = line.indexOf(cfg.block[1]);
            if (close === -1) return { html: comment(line), inBlock: true };
            const end = close + cfg.block[1].length;
            html += comment(line.slice(0, end));
            line = line.slice(end);
        }

        let i = 0;
        while (i < line.length) {
            // Block comment open?
            if (cfg.block && line.startsWith(cfg.block[0], i)) {
                flush();
                const close = line.indexOf(cfg.block[1], i + cfg.block[0].length);
                if (close === -1) {
                    html += comment(line.slice(i));
                    return { html, inBlock: true };
                }
                const end = close + cfg.block[1].length;
                html += comment(line.slice(i, end));
                i = end;
                continue;
            }
            // Line comment?
            let lc = null;
            for (const tok of cfg.line) { if (line.startsWith(tok, i)) { lc = tok; break; } }
            if (lc) {
                flush();
                html += comment(line.slice(i));
                return { html, inBlock: false };
            }
            // String? Consume to the matching unescaped quote (or end of line).
            const q = line[i];
            if (cfg.strings.indexOf(q) !== -1) {
                flush();
                let j = i + 1;
                while (j < line.length) {
                    if (line[j] === '\\') { j += 2; continue; }
                    if (line[j] === q) { j++; break; }
                    j++;
                }
                html += `<span class="syntax-string">${this.escapeHtml(line.slice(i, j))}</span>`;
                i = j;
                continue;
            }
            // Plain code char.
            buf += line[i];
            i++;
        }
        flush();
        return { html, inBlock: false };
    }

    // Highlight a pure-code segment (no strings/comments): escape, then keywords,
    // numbers, functions, operators, variables, properties, classes, decorators,
    // regex literals, template interpolations, JSON keys, HTML tags.
    static highlightCode(raw, cfg) {
        let code = this.escapeHtml(raw);
        code = this.highlightKeywords(code, cfg._kwRegex);
        code = this.highlightOperators(code);
        code = this.highlightNumbers(code);
        code = this.highlightFunctions(code);
        code = this.highlightVariables(code);
        code = this.highlightProperties(code);
        code = this.highlightClasses(code);
        code = this.highlightDecorators(code, cfg);
        code = this.highlightRegexLiterals(code);
        code = this.highlightTemplateInterpolations(code);
        code = this.highlightJsonKeys(code);
        code = this.highlightHtmlTags(code);
        return code;
    }

    static escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // ---- per-pass helpers that skip over existing <span> tags ----
    // splitByTags returns an array where even indices are text, odd are tags.
    static _split(code) {
        return code.split(/(<[^>]*>)/);
    }

    // ---- Keywords ----
    static highlightKeywords(code, kwRegex) {
        if (!kwRegex) return code;
        const parts = this._split(code);
        for (let i = 0; i < parts.length; i += 2) {
            if (parts[i]) parts[i] = parts[i].replace(kwRegex, '<span class="syntax-keyword">$1</span>');
        }
        return parts.join('');
    }

    // ---- Operators ----
    static highlightOperators(code) {
        const parts = this._split(code);
        for (let i = 0; i < parts.length; i += 2) {
            if (parts[i]) {
                // Multi-char operators first
                parts[i] = parts[i].replace(/(=>|===|!==|==|!=|<=|>=|&&|\|\||\?\?|\?\.)|(\+\=|\-\=|\*\=|\/=|\%=|\*\*=|<<|>>|>>>)|(!|\+\+|\-\-|\.\.\.|\@)/g,
                    (match) => `<span class="syntax-operator">${match}</span>`);
                // # as decorator/annotation, but NOT as CSS color (#569cd6)
                parts[i] = parts[i].replace(/#(?![0-9a-fA-F]{3,8}\b)/g, '<span class="syntax-operator">#</span>');
            }
        }
        return parts.join('');
    }

    // ---- Numbers: hex, binary, decimal (int/float/sci) ----
    static highlightNumbers(code) {
        const patterns = [
            /\b0x[0-9a-fA-F]+(?:_[0-9a-fA-F]+)*\b/g,
            /\b0b[01]+(?:_[01]+)*\b/g,
            /\b\d+(?:_\d+)*\b/g,
            /\b\d+(?:_\d+)*\.\d+(?:_\d+)*(?:[eE][+-]?\d+)?\b/g
        ];
        patterns.forEach(regex => {
            const parts = this._split(code);
            for (let i = 0; i < parts.length; i += 2) {
                if (parts[i]) parts[i] = parts[i].replace(regex, '<span class="syntax-number">$&</span>');
            }
            code = parts.join('');
        });
        return code;
    }

    // ---- Function calls: identifier immediately before "(" ----
    static highlightFunctions(code) {
        const parts = this._split(code);
        for (let i = 0; i < parts.length; i += 2) {
            if (parts[i]) {
                parts[i] = parts[i].replace(/\b([a-zA-Z_$][a-zA-Z0-9_$]*)\s*(?=\()/g, '<span class="syntax-function">$1</span>');
            }
        }
        return parts.join('');
    }

    // ---- Variables: camelCase identifiers in code (not keywords, not functions) ----
    // Catches things like `myVar`, `requestBody`, `chatList` that appear as standalone
    // identifiers or after operators/punctuation.
    static highlightVariables(code) {
        const parts = this._split(code);
        for (let i = 0; i < parts.length; i += 2) {
            if (parts[i]) {
                // Match camelCase words that aren't already inside a span
                parts[i] = parts[i].replace(/\b([a-z]+[A-Z][a-zA-Z0-9]*)\b/g, (match) => {
                    // Skip if it's a single uppercase (class) or all-uppercase (constant)
                    if (/^[A-Z]+$/.test(match)) return match;
                    // Skip if it's a known keyword pattern (already handled)
                    if (/^[a-z]+$/.test(match)) return match;
                    return `<span class="syntax-variable">${match}</span>`;
                });
            }
        }
        return parts.join('');
    }

    // ---- Properties: identifier after "." ----
    // Catches `obj.property`, `.length`, `.forEach`, etc.
    static highlightProperties(code) {
        const parts = this._split(code);
        for (let i = 0; i < parts.length; i += 2) {
            if (parts[i]) {
                parts[i] = parts[i].replace(/\.([a-zA-Z_$][a-zA-Z0-9_$]*)/g, '.<span class="syntax-property">$1</span>');
            }
        }
        return parts.join('');
    }

    // ---- Classes: PascalCase identifiers ----
    // Catches things like `MyClass`, `ResponseAdapter`, `ChatRenderer`
    // Only matches words with at least one lowercase letter after the initial uppercase,
    // so all-caps words (SQL keywords, constants) are not matched.
    static highlightClasses(code) {
        const parts = this._split(code);
        for (let i = 0; i < parts.length; i += 2) {
            if (parts[i]) {
                parts[i] = parts[i].replace(/\b([A-Z][a-z]+[a-zA-Z0-9]*)\b/g, '<span class="syntax-class">$1</span>');
            }
        }
        return parts.join('');
    }

    // ---- Decorators / Annotations: @word, #word (Python) ----
    static highlightDecorators(code, cfg) {
        const parts = this._split(code);
        for (let i = 0; i < parts.length; i += 2) {
            if (parts[i]) {
                // @decorator (JS/TS), # decorator / @decorator (Python)
                parts[i] = parts[i].replace(/(@|#)\s*([a-zA-Z_$][a-zA-Z0-9_$]*)/g,
                    '<span class="syntax-decorator">$1$2</span>');
            }
        }
        return parts.join('');
    }

    // ---- Regex literals: /pattern/flags (naive — not inside strings) ----
    static highlightRegexLiterals(code) {
        const parts = this._split(code);
        for (let i = 0; i < parts.length; i += 2) {
            if (parts[i]) {
                // Match /.../ followed by optional flags, but not // (comment) or /= (assign)
                parts[i] = parts[i].replace(/(?<!=)\/([^/\\]|\\.)*\/[gimsuy]*/g, (match) => {
                    // Skip if it looks like a division or assignment
                    if (/^\/=$/.test(match)) return match;
                    return `<span class="syntax-regex">${match}</span>`;
                });
            }
        }
        return parts.join('');
    }

    // ---- Template interpolations: ${...} inside backtick strings ----
    // This only works for complete `${...}` blocks already inside the string span.
    // We highlight the ${ and } separately for visual distinction.
    static highlightTemplateInterpolations(code) {
        const parts = this._split(code);
        for (let i = 0; i < parts.length; i += 2) {
            if (parts[i]) {
                parts[i] = parts[i].replace(/\$\{([^}]*)\}/g,
                    '<span class="syntax-interpolation">{$1}</span>');
            }
        }
        return parts.join('');
    }

    // ---- JSON keys: "key": patterns ----
    static highlightJsonKeys(code) {
        const parts = this._split(code);
        for (let i = 0; i < parts.length; i += 2) {
            if (parts[i]) {
                parts[i] = parts[i].replace(/("([^"\\]|\\.)*")\s*:/g,
                    '<span class="syntax-json-key">$1</span>:');
            }
        }
        return parts.join('');
    }

    // ---- HTML/XML tags: <tag>, </tag>, <tag attr="val"> ----
    static highlightHtmlTags(code) {
        const parts = this._split(code);
        for (let i = 0; i < parts.length; i += 2) {
            if (parts[i]) {
                // Tag name: <word or </word
                parts[i] = parts[i].replace(/(<\/?)([a-zA-Z][a-zA-Z0-9-]*)/g,
                    '$1<span class="syntax-tag-name">$2</span>');
                // Attributes: word=" or word='
                parts[i] = parts[i].replace(/\b([a-zA-Z_:][a-zA-Z0-9_:.-]*)(?==)/g,
                    '<span class="syntax-attr">$1</span>');
            }
        }
        return parts.join('');
    }
}

// Export for use in other files
window.SimpleSyntax = SimpleSyntax;
