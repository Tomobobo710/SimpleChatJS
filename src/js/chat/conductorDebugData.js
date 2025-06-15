// Conductor Debug Data - Manages debug tracking, context injection logging, and phase data aggregation

class ConductorDebugData {
    constructor() {
        this.phases = [];           // Raw backend debug data from each API call
        this.injectionEvents = [];  // Context injection events
    }

    // Track context injections for debug
    trackContextInjection(phaseKey, prompt) {
        logger.info(`[CONDUCTOR] Context injection: ${phaseKey}`);
        
        this.injectionEvents.push({
            phaseKey: phaseKey,
            prompt: prompt,
            timestamp: new Date().toISOString()
        });
    }
    
    // Store API call data for later debug aggregation
    addPhaseData(apiCallData) {
        this.phases.push(apiCallData);
        logger.info(`[CONDUCTOR] API call completed for phase ${apiCallData.conductorPhase}, messageId: ${apiCallData.messageId}`);
        logger.info(`[CONDUCTOR] Total API calls stored: ${this.phases.length}`);
    }

    // Fetch and aggregate all debug data from backend
    async createDebugData() {
        const allSequences = [];
        let stepCounter = 1;
        
        logger.info(`[CONDUCTOR] Fetching debug data for ${this.phases.length} API calls`);
        
        // Fetch debug data for each API call
        for (let i = 0; i < this.phases.length; i++) {
            const apiCall = this.phases[i];
            logger.info(`[CONDUCTOR] Fetching debug data for API call ${i + 1}: messageId ${apiCall.messageId}`);
            
            // Try to fetch debug data with proper retries
            let debugData = null;
            let attempts = 5; // More attempts since we're doing this at the end
            
            while (attempts > 0 && !debugData) {
                try {
                    await new Promise(resolve => setTimeout(resolve, 100)); // Give backend time
                    const debugResponse = await fetch(`${window.location.origin}/api/debug/${apiCall.messageId}`);
                    if (debugResponse.ok) {
                        debugData = await debugResponse.json();
                        logger.info(`[CONDUCTOR] Got debug data for ${apiCall.messageId}: ${debugData.sequence?.length || 0} steps`);
                        break;
                    } else {
                        logger.debug(`[CONDUCTOR] Debug data not ready for ${apiCall.messageId} (${debugResponse.status})`);
                    }
                } catch (error) {
                    logger.debug(`[CONDUCTOR] Debug fetch error for ${apiCall.messageId}:`, error);
                }
                
                attempts--;
                if (attempts > 0) {
                    await new Promise(resolve => setTimeout(resolve, 300));
                }
            }
            
            if (debugData && debugData.sequence) {
                // Add each step from this API call's debug data
                debugData.sequence.forEach(step => {
                    const clonedStep = {
                        ...step,
                        step: stepCounter++,
                        data: {
                            ...step.data,
                            conductorPhase: apiCall.conductorPhase,
                            stoppedOn: apiCall.stoppedOn,
                            stopConditions: apiCall.stopConditions
                        }
                    };
                    allSequences.push(clonedStep);
                });
            } else {
                logger.warn(`[CONDUCTOR] No debug data for messageId ${apiCall.messageId} - adding fallback`);
                // Fallback when debug data unavailable
                const fallbackStep = {
                    type: 'conductor_api_call',
                    step: stepCounter++,
                    timestamp: apiCall.timestamp,
                    data: {
                        message: `Conductor phase ${apiCall.conductorPhase} API call (no debug data)`,
                        conductorPhase: apiCall.conductorPhase,
                        stoppedOn: apiCall.stoppedOn,
                        stopConditions: apiCall.stopConditions,
                        messageId: apiCall.messageId,
                        rawResponseLength: apiCall.rawResponseContent?.length || 0,
                        backendDebugUnavailable: true
                    }
                };
                allSequences.push(fallbackStep);
            }
        }
        
        logger.info(`[CONDUCTOR] Final debug data: ${allSequences.length} total steps from ${this.phases.length} API calls`);
        
        return {
            // Combined sequence from all API calls
            sequence: allSequences,
            
            // Metadata
            metadata: {
                endpoint: 'surgical_conductor_individual_messages',
                timestamp: new Date().toISOString(),
                total_api_calls: this.phases.length,
                total_steps: allSequences.length
            }
        };
    }
}