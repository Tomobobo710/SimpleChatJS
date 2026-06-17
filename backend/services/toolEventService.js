const { log } = require('../utils/logger');

const STORE_TTL_MS = 5 * 60 * 1000;

const toolEventsStore = new Map();

let cleanupInterval = null;

function startTtlCleanup() {
    if (cleanupInterval) return;
    cleanupInterval = setInterval(() => {
        const now = Date.now();
        for (const [key, entry] of toolEventsStore) {
            if (now - entry.timestamp > STORE_TTL_MS) {
                entry.listeners.forEach(l => {
                    try { l.end(); } catch (_) {}
                });
                toolEventsStore.delete(key);
            }
        }
    }, 60 * 1000);
}

startTtlCleanup();

function generateRequestId() {
    return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

function initializeToolEvents(requestId) {
    const existingToolData = toolEventsStore.get(requestId);
    if (existingToolData) return;

    toolEventsStore.set(requestId, {
        events: [],
        listeners: new Set(),
        timestamp: Date.now()
    });
}

function addToolEvent(requestId, event) {
    const toolData = toolEventsStore.get(requestId);
    if (toolData) {
        toolData.events.push(event);
        toolData.listeners.forEach(listener => {
            try {
                listener.write(`data: ${JSON.stringify(event)}\n\n`);
            } catch (e) {
                toolData.listeners.delete(listener);
            }
        });
    }
}

function handleToolEventsStream(req, res) {
    const requestId = req.params.requestId;

    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*'
    });

    res.write(`data: ${JSON.stringify({ type: 'connected', data: { requestId, timestamp: new Date().toISOString() } })}\n\n`);

    let toolData = toolEventsStore.get(requestId);
    if (!toolData) {
        toolData = { events: [], listeners: new Set(), timestamp: Date.now() };
        toolEventsStore.set(requestId, toolData);
    }

    toolData.events.forEach(event => {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
    });

    toolData.listeners.add(res);

    req.on('close', () => {
        toolData.listeners.delete(res);
    });
}

module.exports = {
    generateRequestId,
    initializeToolEvents,
    addToolEvent,
    handleToolEventsStream
};
