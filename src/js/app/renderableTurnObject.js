// RenderableTurnObject - a transient render object produced by Turn.renderable().
// This is not persisted — it is computed on demand from Message source data.
// The UI renders directly from this object.

class RenderableTurnObject {
    constructor({ identity = 'request', content = '', blocks = null, turnId = null, parentTurnId = null, debugData = null, responseDebugData = null, turnMessages = null, editCount = 0, activeEditVersion = 0, dropdownStates = {} } = {}) {
        this.identity = identity;
        this.content = content;
        this.blocks = blocks;
        this.turnId = turnId;
        this.parentTurnId = parentTurnId;
        this.debugData = debugData;
        this.responseDebugData = responseDebugData;
        this.turnMessages = turnMessages;
        this.editCount = editCount;
        this.activeEditVersion = activeEditVersion;
        this.dropdownStates = dropdownStates;
    }

    static fromStreamingProcessor({ processor, turnId = null, parentTurnId = null, debugData = null, responseDebugData = null, turnMessages = null, dropdownStates = {} }) {
        return new RenderableTurnObject({
            identity: 'response',
            content: processor.getRawContent() || '',
            blocks: processor.getBlocks(),
            turnId,
            parentTurnId,
            debugData,
            responseDebugData,
            turnMessages,
            dropdownStates,
        });
    }
}
