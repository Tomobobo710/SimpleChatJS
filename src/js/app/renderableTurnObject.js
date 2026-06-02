// RenderableTurnObject - a transient render object produced by Turn.renderable().
// This is not persisted — it is computed on demand from Message source data.
// The UI renders directly from this object.

class RenderableTurnObject {
    constructor({ role = 'other', content = '', blocks = null, turnNumber = 0, debugData = null, editCount = 0, dropdownStates = {} } = {}) {
        this.role = role;
        this.content = content;
        this.blocks = blocks;
        this.turnNumber = turnNumber;
        this.debugData = debugData;
        this.editCount = editCount;
        this.dropdownStates = dropdownStates;
    }

    isUser() {
        return this.role === 'user';
    }

    isAssistant() {
        return this.role === 'assistant';
    }

    isError() {
        return this.role === 'error';
    }

    static fromUserMessage(message) {
        return new RenderableTurnObject({
            role: 'user',
            content: message.content,
            blocks: null,
            turnNumber: message.turnNumber,
            debugData: message.debugData,
            editCount: message.editCount,
        });
    }

    static fromStreamingProcessor({ processor, turnNumber, debugData = null, dropdownStates = {} }) {
        return new RenderableTurnObject({
            role: 'assistant',
            content: processor.getRawContent() || '',
            blocks: processor.getBlocks(),
            turnNumber,
            debugData,
            dropdownStates,
        });
    }
}
