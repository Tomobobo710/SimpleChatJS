// Block - a structured content segment within a Message.
// Block types: "chat", "thinking", "tool", "codeblock", "error".
// Blocks are created by StreamingMessageProcessor from raw text content.

class Block {
    constructor({ blockType = '', content = '', metadata = {} } = {}) {
        this.blockType = blockType;
        this.content = content;
        this.metadata = metadata;
    }

    isChat() {
        return this.blockType === 'chat';
    }

    isThinking() {
        return this.blockType === 'thinking';
    }

    isTool() {
        return this.blockType === 'tool';
    }

    isCode() {
        return this.blockType === 'codeblock';
    }

    isError() {
        return this.blockType === 'error';
    }

    static fromObject(obj) {
        return new Block(obj);
    }
}
