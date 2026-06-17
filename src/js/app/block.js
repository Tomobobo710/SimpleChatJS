// Block - a structured content segment within a Message.
// Block types: "chat", "thinking", "tool", "codeblock", "error".
// Blocks are created by StreamingMessageProcessor from raw text content.

class Block {
    constructor({ type = '', content = '', metadata = {} } = {}) {
        this.type = type;
        this.content = content;
        this.metadata = metadata;
    }
}
