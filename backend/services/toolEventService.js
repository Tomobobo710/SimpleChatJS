// Tool Event Service - Handle real-time tool events via Server-Sent Events
const { log } = require('../utils/logger');

// Tool events storage - separate from content stream
const toolEventsStore = new Map(); // messageId -> { events: [], listeners: Set }

// Debug data storage - separate from content stream
const debugDataStore = new Map(); // messageId -> debugData

// Generate unique message ID
function generateMessageId() {
    return `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// Initialize tool events for a message
function initializeToolEvents(messageId) {
    log(`[TOOL-EVENT-SERVICE] Initializing tool events for messageId: ${messageId}`);
    toolEventsStore.set(messageId, {
        events: [],
        listeners: new Set()
    });
    log(`[TOOL-EVENT-SERVICE] Tool events initialized, store now has ${toolEventsStore.size} entries`);
}

// Add tool event
function addToolEvent(messageId, event) {
    const toolData = toolEventsStore.get(messageId);
    log(`[TOOL-EVENT-SERVICE] Adding event ${event.type} for messageId: ${messageId}, toolData exists: ${!!toolData}`);
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
        log(`[TOOL-EVENT-SERVICE] No toolData found for messageId: ${messageId}, available messageIds:`, Array.from(toolEventsStore.keys()));
    }
}

// Handle tool events SSE endpoint
function handleToolEventsStream(req, res) {
    const messageId = req.params.messageId;
    
    log(`[TOOL-EVENTS] Tool events stream requested for message: ${messageId}`);
    
    // Set up SSE headers
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*'
    });
    
    // Send initial connection event
    res.write(`data: ${JSON.stringify({ type: 'connected', data: { messageId: messageId, timestamp: new Date().toISOString() } })}\n\n`);
    
    const toolData = toolEventsStore.get(messageId);
    log(`[TOOL-EVENTS] Tool data exists for ${messageId}: ${!!toolData}, available messageIds:`, Array.from(toolEventsStore.keys()));
    if (toolData) {
        log(`[TOOL-EVENTS] Sending ${toolData.events.length} existing events to client`);
        // Send any existing events
        toolData.events.forEach(event => {
            res.write(`data: ${JSON.stringify(event)}\n\n`);
        });
        
        // Add this response to listeners for future events
        toolData.listeners.add(res);
        log(`[TOOL-EVENTS] Added listener, now have ${toolData.listeners.size} listeners for messageId: ${messageId}`);
        
        // Clean up when client disconnects
        req.on('close', () => {
            toolData.listeners.delete(res);
            log(`[TOOL-EVENTS] Client disconnected from tool events for message: ${messageId}`);
        });
    } else {
        // No tool data yet, initialize it and keep connection open
        log(`[TOOL-EVENTS] No tool data yet for message: ${messageId}, initializing and keeping connection open`);
        toolEventsStore.set(messageId, {
            events: [],
            listeners: new Set([res])
        });
        
        // Clean up when client disconnects
        req.on('close', () => {
            const data = toolEventsStore.get(messageId);
            if (data) {
                data.listeners.delete(res);
                log(`[TOOL-EVENTS] Client disconnected from tool events for message: ${messageId}`);
            }
        });
    }
}

// Store debug data
function storeDebugData(messageId, debugData) {
    debugDataStore.set(messageId, debugData);
    log(`[DEBUG-SEPARATION] Stored debug data for message: ${messageId}`);
}

// Get debug data
function getDebugData(messageId) {
    return debugDataStore.get(messageId);
}

// Handle debug data endpoint
function handleDebugDataRequest(req, res) {
    const messageId = req.params.messageId;
    const debugData = debugDataStore.get(messageId);
    
    log(`[DEBUG-SEPARATION] Debug data requested for message: ${messageId}`);
    
    if (debugData) {
        log(`[DEBUG-SEPARATION] Debug data found and sent for message: ${messageId}`);
        res.json(debugData);
        // Optional: Clean up old debug data after sending
        // debugDataStore.delete(messageId);
    } else {
        log(`[DEBUG-SEPARATION] Debug data not found for message: ${messageId}`);
        res.status(404).json({ error: 'Debug data not found' });
    }
}

module.exports = {
    generateMessageId,
    initializeToolEvents,
    addToolEvent,
    handleToolEventsStream,
    storeDebugData,
    getDebugData,
    handleDebugDataRequest
};