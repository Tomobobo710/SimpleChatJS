// Tool Event Service - Handle real-time tool events via Server-Sent Events
const { log } = require('../utils/logger');

// Tool events storage - separate from content stream
const toolEventsStore = new Map(); // requestId -> { events: [], listeners: Set }

// Debug data storage - separate from content stream
const debugDataStore = new Map(); // requestId -> debugData

// Generate unique request ID
function generateRequestId() {
    return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// Initialize tool events for a request
function initializeToolEvents(requestId) {
    log(`[TOOL-EVENT-SERVICE] Initializing tool events for requestId: ${requestId}`);
    
    // Preserve existing toolData if it exists (e.g., from SSE connection)
    const existingToolData = toolEventsStore.get(requestId);
    if (existingToolData) {
        log(`[TOOL-EVENT-SERVICE] Tool data already exists, preserving ${existingToolData.listeners.size} listeners`);
        return;
    }
    
    toolEventsStore.set(requestId, {
        events: [],
        listeners: new Set()
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
        // Notify all listeners
        toolData.listeners.forEach(listener => {
            try {
                listener.write(`data: ${JSON.stringify(event)}\n\n`);
                log(`[TOOL-EVENT-SERVICE] Event sent to listener: ${event.type}`);
            } catch (e) {
                log(`[TOOL-EVENT-SERVICE] Failed to send to listener, removing: ${e.message}`);
                // Remove dead listeners
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
    
    // Set up SSE headers
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*'
    });
    
    // Send initial connection event
    res.write(`data: ${JSON.stringify({ type: 'connected', data: { requestId: requestId, timestamp: new Date().toISOString() } })}\n\n`);
    
    let toolData = toolEventsStore.get(requestId);
    if (!toolData) {
        // Initialize toolData if SSE connects before chat request
        toolData = {
            events: [],
            listeners: new Set()
        };
        toolEventsStore.set(requestId, toolData);
        log(`[TOOL-EVENTS] Initialized toolData for early SSE connection: ${requestId}`);
    }
    log(`[TOOL-EVENTS] Tool data exists for ${requestId}: ${!!toolData}, available requestIds:`, Array.from(toolEventsStore.keys()));
    if (toolData) {
        log(`[TOOL-EVENTS] Sending ${toolData.events.length} existing events to client`);
        // Send any existing events
        toolData.events.forEach(event => {
            res.write(`data: ${JSON.stringify(event)}\n\n`);
        });
        
        // Add this response to listeners for future events
        toolData.listeners.add(res);
        log(`[TOOL-EVENTS] Added listener, now have ${toolData.listeners.size} listeners for requestId: ${requestId}`);
        log(`[TOOL-EVENTS] Current store has ${toolEventsStore.size} requestIds:`, Array.from(toolEventsStore.keys()));
        
        // Clean up when client disconnects
        req.on('close', () => {
            toolData.listeners.delete(res);
            log(`[TOOL-EVENTS] Client disconnected from tool events for request: ${requestId}`);
        });
    } else {
        // No tool data yet, initialize it and keep connection open
        log(`[TOOL-EVENTS] No tool data yet for request: ${requestId}, initializing and keeping connection open`);
        toolEventsStore.set(requestId, {
            events: [],
            listeners: new Set([res])
        });
        
        // Clean up when client disconnects
        req.on('close', () => {
            const data = toolEventsStore.get(requestId);
            if (data) {
                data.listeners.delete(res);
                log(`[TOOL-EVENTS] Client disconnected from tool events for request: ${requestId}`);
            }
        });
    }
}

// Store debug data
function storeDebugData(requestId, debugData) {
    debugDataStore.set(requestId, debugData);
    log(`[DEBUG-SEPARATION] Stored debug data for request: ${requestId}`);
}

// Get debug data
function getDebugData(requestId) {
    return debugDataStore.get(requestId);
}

// Handle debug data endpoint
function handleDebugDataRequest(req, res) {
    const requestId = req.params.requestId;
    const debugData = debugDataStore.get(requestId);
    
    log(`[DEBUG-SEPARATION] Debug data requested for request: ${requestId}`);
    
    if (debugData) {
        log(`[DEBUG-SEPARATION] Debug data found and sent for request: ${requestId}`);
        res.json(debugData);
        // Optional: Clean up old debug data after sending
        // debugDataStore.delete(requestId);
    } else {
        log(`[DEBUG-SEPARATION] Debug data not found for request: ${requestId}`);
        res.status(404).json({ error: 'Debug data not found' });
    }
}

module.exports = {
    generateRequestId,
    initializeToolEvents,
    addToolEvent,
    handleToolEventsStream,
    storeDebugData,
    getDebugData,
    handleDebugDataRequest
};