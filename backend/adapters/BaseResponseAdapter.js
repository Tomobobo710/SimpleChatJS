/**
 * Base Response Adapter
 * 
 * Abstract base class that all provider adapters extend.
 * Defines the interface for converting provider responses to unified format.
 */

const UnifiedResponse = require('./UnifiedResponse');

class BaseResponseAdapter {
    constructor(providerName) {
        this.providerName = providerName;
    }

    /**
     * Process a streaming chunk from the provider
     * @param {string} chunk - Raw chunk from provider
     * @param {UnifiedResponse} response - Unified response to update
     * @param {Object} context - Adapter context/state
     * @returns {Object} Processing result with events
     */
    processChunk(chunk, response, context) {
        throw new Error('processChunk must be implemented by provider adapter');
    }

    /**
     * Convert provider request format to provider-specific format
     * @param {Object} unifiedRequest - Standard request format
     * @returns {Object} Provider-specific request
     */
    convertRequest(unifiedRequest) {
        throw new Error('convertRequest must be implemented by provider adapter');
    }

    /**
     * Get provider-specific endpoint URL
     * @param {Object} settings - Current settings
     * @returns {string} Provider endpoint URL
     */
    getEndpointUrl(settings) {
        throw new Error('getEndpointUrl must be implemented by provider adapter');
    }

    /**
     * Get provider-specific headers
     * @param {Object} settings - Current settings
     * @returns {Object} HTTP headers
     */
    getHeaders(settings) {
        return {
            'Content-Type': 'application/json'
        };
    }

    /**
     * Detect if provider is configured
     * @param {Object} settings - Current settings
     * @returns {boolean} True if this provider should handle the request
     */
    canHandle(settings) {
        throw new Error('canHandle must be implemented by provider adapter');
    }

    /**
     * Initialize context for processing
     * @returns {Object} Initial context state
     */
    createContext() {
        return {
            buffer: '',
            currentToolCall: null,
            processingState: 'content'
        };
    }

    /**
     * Emit tool-related events during processing
     * @param {string} eventType - Event type
     * @param {Object} data - Event data
     * @param {string} requestId - Request ID
     */
    emitToolEvent(eventType, data, requestId) {
        // This will be injected by the chat service
        if (this.toolEventEmitter) {
            this.toolEventEmitter(eventType, data, requestId);
        }
    }

    /**
     * Set the tool event emitter function
     * @param {Function} emitter - Tool event emitter function
     */
    setToolEventEmitter(emitter) {
        this.toolEventEmitter = emitter;
    }
}

module.exports = BaseResponseAdapter;
