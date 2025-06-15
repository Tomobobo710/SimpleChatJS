// Tool Handler - Tool event processing and utilities

// Create tool blocks from debug data for simple chat mode
function createToolBlocksFromDebugData(chatBlocks, debugData) {
    if (!debugData || !debugData.sequence) {
        return chatBlocks;
    }
    
    const toolBlocks = [];
    const toolCallsMap = new Map(); // Track tool calls by step
    
    // Extract tool calls from debug sequence
    debugData.sequence.forEach(step => {
        if (step.type === 'tool_execution') {
            const toolName = step.data.tool_name || 'unknown_tool';
            const stepKey = step.step;
            
            if (!toolCallsMap.has(stepKey)) {
                toolCallsMap.set(stepKey, {
                    name: toolName,
                    arguments: step.data.arguments || {},
                    step: step.step
                });
            }
        } else if (step.type === 'tool_result') {
            const toolName = step.data.tool_name || 'unknown_tool';
            const stepKey = step.step;
            
            // Find the corresponding tool execution
            for (const [key, toolData] of toolCallsMap.entries()) {
                if (toolData.name === toolName && !toolData.result) {
                    toolData.result = step.data.result || step.data;
                    toolData.status = step.data.status || 'completed';
                    break;
                }
            }
        }
    });
    
    // Create tool blocks from collected data
    toolCallsMap.forEach(toolData => {
        if (toolData.result) {
            const toolContent = `[${toolData.name}]:\nArguments: ${JSON.stringify(toolData.arguments, null, 2)}\nResult: ${typeof toolData.result === 'string' ? toolData.result : JSON.stringify(toolData.result, null, 2)}`;
            const toolBlock = {
                type: 'tool',
                content: toolContent,
                metadata: { toolName: toolData.name, step: toolData.step }
            };
            toolBlocks.push(toolBlock);
        }
    });
    return [...toolBlocks, ...chatBlocks];
}

// Handle real-time tool events from the tool events stream
function handleToolEvent(toolEvent, processor, liveRenderer, tempContainer) {
    logger.debug(`[TOOL-EVENT] Received: ${toolEvent.type}`, toolEvent.data);
    
    switch (toolEvent.type) {
        case 'connected':
            logger.debug('[TOOL-EVENT] Connected to tool events stream');
            break;
            
        case 'tool_call_detected':
            // Tool call detected - create placeholder tool block
            const placeholderContent = `[${toolEvent.data.name}]:\nArguments: Loading...\nResult: Executing...`;
            const placeholderBlock = {
                type: 'tool',
                content: placeholderContent,
                metadata: { 
                    toolName: toolEvent.data.name,
                    id: toolEvent.data.id,
                    status: 'executing'
                }
            };
            processor.blocks.push(placeholderBlock);
            updateLiveRendering(processor, liveRenderer, tempContainer);
            break;
            
        case 'tool_execution_start':
            // Update the placeholder with actual arguments
            const startBlock = processor.blocks.find(b => 
                b.type === 'tool' && b.metadata?.id === toolEvent.data.id
            );
            if (startBlock) {
                const argsContent = `[${toolEvent.data.name}]:\nArguments: ${JSON.stringify(toolEvent.data.arguments, null, 2)}\nResult: Executing...`;
                startBlock.content = argsContent;
                startBlock.metadata.status = 'executing';
                startBlock.metadata.arguments = toolEvent.data.arguments;
                updateLiveRendering(processor, liveRenderer, tempContainer);
            }
            break;
            
        case 'tool_execution_complete':
            // Update with final result
            const completeBlock = processor.blocks.find(b => 
                b.type === 'tool' && b.metadata?.id === toolEvent.data.id
            );
            if (completeBlock) {
                const resultContent = toolEvent.data.status === 'success' 
                    ? toolEvent.data.result 
                    : `ERROR: ${toolEvent.data.error}`;
                    
                const finalContent = `[${toolEvent.data.name}]:\nArguments: ${JSON.stringify(completeBlock.metadata.arguments || {}, null, 2)}\nResult: ${resultContent}`;
                completeBlock.content = finalContent;
                completeBlock.metadata.status = toolEvent.data.status;
                completeBlock.metadata.execution_time_ms = toolEvent.data.execution_time_ms;
                updateLiveRendering(processor, liveRenderer, tempContainer);
            }
            break;
            
        default:
            logger.warn(`[TOOL-EVENT] Unknown event type: ${toolEvent.type}`);
    }
}