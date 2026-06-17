// SimpleSyntax.js - Universal syntax highlighter for SimpleChatJS
// One highlighter to rule them all - works reasonably well for most languages

class SimpleSyntax {
    static highlight(code, language = '') {
        if (!code || typeof code !== 'string') return code;
        
        // Process line by line to avoid conflicts
        const lines = code.split('\n');
        const highlightedLines = lines.map(line => this.highlightLine(line));
        return highlightedLines.join('\n');
    }
    
    static highlightLine(line) {
        // Escape HTML first
        line = this.escapeHtml(line);
        
        // Check if this line is a comment (starts with // or #)
        const trimmed = line.trim();
        if (trimmed.startsWith('#') || trimmed.startsWith('//')) {
            return `<span class="syntax-comment">${line}</span>`;
        }
        
        // Check for inline comments and split the line
        const commentMatch = line.match(/^(.*?)(\/\/.*|#.*)$/);
        if (commentMatch) {
            const beforeComment = commentMatch[1];
            const comment = commentMatch[2];
            return this.highlightCodePart(beforeComment) + `<span class="syntax-comment">${comment}</span>`;
        }
        
        // No comments, just highlight the code
        return this.highlightCodePart(line);
    }
    
    static highlightCodePart(code) {
        // Highlight strings first using our safe "split by HTML tags" approach
        code = this.highlightStrings(code);
        
        // Highlight keywords
        code = this.highlightKeywords(code);
        
        // Highlight numbers
        code = this.highlightNumbers(code);
        
        // Highlight functions
        code = this.highlightFunctions(code);
        
        return code;
    }
    
    // Strings: "text", 'text', `text` (avoid matching inside HTML tags)
    static highlightStrings(code) {
        
        const stringPatterns = [
            // Double quotes (NOT escaped - they stay as regular quotes!)
            { regex: /(")(.*?)(")/g, replacement: '<span class="syntax-string">$1$2$3</span>' },
            // Single quotes (NOT escaped - they stay as regular quotes!)
            { regex: /(')(.*?)(')/g, replacement: '<span class="syntax-string">$1$2$3</span>' },
            // Backticks
            { regex: /(`)(.*?)(`)/g, replacement: '<span class="syntax-string">$1$2$3</span>' }
        ];
        
        stringPatterns.forEach(pattern => {
            const parts = code.split(/(<[^>]*>)/);
            for (let i = 0; i < parts.length; i += 2) {
                if (parts[i]) {
                    parts[i] = parts[i].replace(pattern.regex, pattern.replacement);
                }
            }
            code = parts.join('');
        });
        
        return code;
    }
    
    static escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
    
    // Common keywords across languages (avoid matching inside HTML)
    static highlightKeywords(code) {
        const keywords = [
            // JavaScript/TypeScript
            'function', 'var', 'let', 'const', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default',
            'try', 'catch', 'finally', 'throw', 'return', 'break', 'continue', 'class', 'extends', 'super',
            'this', 'new', 'typeof', 'instanceof', 'async', 'await', 'import', 'export', 'from',
            
            // Python
            'def', 'lambda', 'pass', 'with', 'yield', 'global', 'nonlocal', 'assert', 'del',
            'and', 'or', 'not', 'elif', 'except', 'raise', 'finally',
            
            // Common values
            'true', 'false', 'null', 'undefined', 'None', 'True', 'False'
        ];
        
        keywords.forEach(keyword => {
            // Split by HTML tags and only process text outside tags
            const parts = code.split(/(<[^>]*>)/);
            for (let i = 0; i < parts.length; i += 2) { // Only process even indices (text outside tags)
                if (parts[i]) {
                    const regex = new RegExp(`\\b${keyword}\\b`, 'g');
                    parts[i] = parts[i].replace(regex, `<span class="syntax-keyword">${keyword}</span>`);
                }
            }
            code = parts.join('');
        });
        
        return code;
    }
    
    // Numbers: integers, floats, hex, binary (avoid matching inside HTML)
    static highlightNumbers(code) {
        const patterns = [
            { regex: /\b0x[0-9a-fA-F]+\b/g, replacement: '<span class="syntax-number">$&</span>' },
            { regex: /\b0b[01]+\b/g, replacement: '<span class="syntax-number">$&</span>' },
            { regex: /\b\d+\.?\d*([eE][+-]?\d+)?\b/g, replacement: '<span class="syntax-number">$&</span>' }
        ];
        
        patterns.forEach(pattern => {
            const parts = code.split(/(<[^>]*>)/);
            for (let i = 0; i < parts.length; i += 2) {
                if (parts[i]) {
                    parts[i] = parts[i].replace(pattern.regex, pattern.replacement);
                }
            }
            code = parts.join('');
        });
        
        return code;
    }
    
    // Function calls: something() (avoid matching inside HTML)
    static highlightFunctions(code) {
        const parts = code.split(/(<[^>]*>)/);
        for (let i = 0; i < parts.length; i += 2) {
            if (parts[i]) {
                parts[i] = parts[i].replace(/\b([a-zA-Z_$][a-zA-Z0-9_$]*)\s*(?=\()/g, '<span class="syntax-function">$1</span>');
            }
        }
        return parts.join('');
    }
    
}

// Export for use in other files
window.SimpleSyntax = SimpleSyntax;