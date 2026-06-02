// Turn - a first-class concept representing a collection of messages grouped by turn_number.
// Turns are never persisted — they are computed from Message source data.

class Turn {
    constructor(turnNumber, messages = []) {
        this.turnNumber = turnNumber;
        this.messages = messages;
    }

    get errorMessages() {
        return this.messages.filter(m => m.isError());
    }

    get userMessages() {
        return this.messages.filter(m => m.isUser());
    }

    get assistantMessages() {
        return this.messages.filter(m => m.isAssistant());
    }

    hasErrors() {
        return this.errorMessages.length > 0;
    }

    hasUserMessages() {
        return this.userMessages.length > 0;
    }

    hasAssistantMessages() {
        return this.assistantMessages.length > 0;
    }

    static fromMessagesByTurn(messages) {
        const groups = new Map();
        for (const msg of messages) {
            const key = msg.turnNumber;
            if (!groups.has(key)) {
                groups.set(key, []);
            }
            groups.get(key).push(msg);
        }
        return Array.from(groups.entries())
            .sort(([a], [b]) => a - b)
            .map(([turnNumber, msgs]) => new Turn(turnNumber, msgs));
    }
}


