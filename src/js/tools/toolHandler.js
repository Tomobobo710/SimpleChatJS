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
            const toolBlock = new Block({
                type: 'tool',
                content: toolContent,
                metadata: { toolName: toolData.name, step: toolData.step }
            });
            toolBlocks.push(toolBlock);
        }
    });
    return [...toolBlocks, ...chatBlocks];
}

