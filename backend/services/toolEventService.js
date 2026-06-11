// Tool Event Service - Handle real-time tool events via SSE.
const { log } = require('../utils/logger');

// TTL for in-memory stores (5 minutes)
const STORE_TTL_MS = 5 * 60 * 1000;

// Tool events storage - separate from content stream
const toolEventsStore = new Map(); // requestId -> { events: [], listeners: Set, timestamp: number }

// TTL cleanup interval
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
    }, 60 * 1000); // Check every minute
}

// Start cleanup on module load
startTtlCleanup();

// Generate unique request ID
function generateRequestId() {
    return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// Initialize tool events for a request
function initializeToolEvents(requestId) {
    log(`[TOOL-EVENT-SERVICE] Initializing tool events for requestId: ${requestId}`);
    
    const existingToolData = toolEventsStore.get(requestId);
    if (existingToolData) {
        log(`[TOOL-EVENT-SERVICE] Tool data already exists, preserving ${existingToolData.listeners.size} listeners`);
        return;
    }
    
    toolEventsStore.set(requestId, {
        events: [],
        listeners: new Set(),
        timestamp: Date.now()
    });
    log(`[TOOL-EVENT-SERVICE] Tool events initialized, store now has ${toolEventsStore.size} entries`);
}

// Add tool event
function addToolEvent(requestId, event) {
    const toolData = toolEventsStore.get(requestId);
    log(`[TOOL-EVENT-SERVICE] Adding event ${event.type} for requestId: ${requestId}, toolData exists: ${!!toolData}`);
    if (toolData) {
        toolData.events.push(event);
        log(`[TOOL-EVENT-SERVICE] Event buffered, notifying ${toolData.listeners.size} listeners`);
        toolData.listeners.forEach(listener => {
            try {
                listener.write(`data: ${JSON.stringify(event)}\n\n`);
                log(`[TOOL-EVENT-SERVICE] Event sent to listener: ${event.type}`);
            } catch (e) {
                log(`[TOOL-EVENT-SERVICE] Failed to send to listener, removing: ${e.message}`);
                toolData.listeners.delete(listener);
            }
        });
    } else {
        log(`[TOOL-EVENT-SERVICE] No toolData found for requestId: ${requestId}, available requestIds:`, Array.from(toolEventsStore.keys()));
    }
}

// Handle tool events SSE endpoint
function handleToolEventsStream(req, res) {
    const requestId = req.params.requestId;
    
    log(`[TOOL-EVENTS] Tool events stream requested for request: ${requestId}`);
    
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*'
    });
    
    res.write(`data: ${JSON.stringify({ type: 'connected', data: { requestId: requestId, timestamp: new Date().toISOString() } })}\n\n`);
    
    let toolData = toolEventsStore.get(requestId);
    if (!toolData) {
        toolData = {
            events: [],
            listeners: new Set(),
            timestamp: Date.now()
        };
        toolEventsStore.set(requestId, toolData);
        log(`[TOOL-EVENTS] Initialized toolData for early SSE connection: ${requestId}`);
    }
    log(`[TOOL-EVENTS] Tool data exists for ${requestId}: ${!!toolData}, available requestIds:`, Array.from(toolEventsStore.keys()));
    if (toolData) {
        log(`[TOOL-EVENTS] Sending ${toolData.events.length} existing events to client`);
        toolData.events.forEach(event => {
            res.write(`data: ${JSON.stringify(event)}\n\n`);
        });
        
        toolData.listeners.add(res);
        log(`[TOOL-EVENTS] Added listener, now have ${toolData.listeners.size} listeners for requestId: ${requestId}`);
        log(`[TOOL-EVENTS] Current store has ${toolEventsStore.size} requestIds:`, Array.from(toolEventsStore.keys()));
        
        req.on('close', () => {
            toolData.listeners.delete(res);
            log(`[TOOL-EVENTS] Client disconnected from tool events for request: ${requestId}`);
        });
    } else {
        toolEventsStore.set(requestId, {
            events: [],
            listeners: new Set([res]),
            timestamp: Date.now()
        });
        
        req.on('close', () => {
            const data = toolEventsStore.get(requestId);
            if (data) {
                data.listeners.delete(res);
                log(`[TOOL-EVENTS] Client disconnected from tool events for request: ${requestId}`);
            }
        });
    }
}

module.exports = {
    generateRequestId,
    initializeToolEvents,
    addToolEvent,
    handleToolEventsStream
};
