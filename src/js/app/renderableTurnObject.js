// RenderableTurnObject - a transient render object produced by Turn.renderable().
// This is not persisted — it is computed on demand from Message source data.
// The UI renders directly from this object.

class RenderableTurnObject {
    constructor({ role = 'other', content = '', blocks = null, turnNumber = 0, turnId = null, parentTurnId = null, debugData = null, debugDataAll = null, editCount = 0, dropdownStates = {} } = {}) {
        this.role = role;
        this.content = content;
        this.blocks = blocks;
        this.turnNumber = turnNumber;
        this.turnId = turnId;
        this.parentTurnId = parentTurnId;
        this.debugData = debugData;
        this.debugDataAll = debugDataAll;
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
            turnId: message.turnId,
            parentTurnId: message.parentTurnId,
            debugData: message.debugData,
            editCount: message.editCount,
        });
    }

    static fromStreamingProcessor({ processor, turnNumber, turnId = null, parentTurnId = null, debugData = null, debugDataAll = null, dropdownStates = {} }) {
        return new RenderableTurnObject({
            role: 'assistant',
            content: processor.getRawContent() || '',
            blocks: processor.getBlocks(),
            turnNumber,
            turnId,
            parentTurnId,
            debugData,
            debugDataAll,
            dropdownStates,
        });
    }
}
