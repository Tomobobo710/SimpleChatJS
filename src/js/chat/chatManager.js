// Chat Manager - Chat list management, switching, and history

// Sidebar and project state (shared with main.js)
window.sidebarView = 'chat';
window.currentProjectId = null;
window.projects = [];

// Utility function to safely extract text content from multimodal or string content
function getTextContent(content) {
    if (typeof content === 'string') {
        // Check if it's a JSON string that needs parsing
        if (content.startsWith('[') || content.startsWith('{')) {
            try {
                const parsed = JSON.parse(content);
                return getTextContent(parsed); // Recursively process parsed content
            } catch (e) {
                // If parsing fails, return the string as-is
                return content;
            }
        }
        return content;
    }
    if (Array.isArray(content)) {
        // Extract text from multimodal array
        const textPart = content.find(part => part.type === 'text');
        const filesPart = content.find(part => part.type === 'files');
        const imageParts = content.filter(part => part.type === 'image');
        
        // Priority: text content first
        if (textPart && textPart.text) {
            // If there's text plus other content, show text with indicators
            const extras = [];
            if (filesPart && filesPart.files && filesPart.files.length > 0) {
                if (filesPart.files.length === 1) {
                    const file = filesPart.files[0];
                    const fileName = file.fileName || file.name || file.originalName || 'Unknown file';
                    extras.push(`[File] ${fileName}`);
                } else {
                    extras.push(`[${filesPart.files.length} files]`);
                }
            }
            if (imageParts.length > 0) {
                if (imageParts.length === 1) {
                    extras.push('[Image]');
                } else {
                    extras.push(`[${imageParts.length} images]`);
                }
            }
            
            if (extras.length > 0) {
                return `${textPart.text} + ${extras.join(' + ')}`;
            }
            return textPart.text;
        } 
        // No text content, show files/images only
        else {
            const parts = [];
            if (filesPart && filesPart.files && filesPart.files.length > 0) {
                if (filesPart.files.length === 1) {
                    const file = filesPart.files[0];
                    const fileName = file.fileName || file.name || file.originalName || 'Unknown file';
                    parts.push(`[File] ${fileName}`);
                } else {
                    parts.push(`[${filesPart.files.length} files]`);
                }
            }
            if (imageParts.length > 0) {
                if (imageParts.length === 1) {
                    parts.push('[Image]');
                } else {
                    parts.push(`[${imageParts.length} images]`);
                }
            }
            if (parts.length > 0) {
                return parts.join(' + ');
            } else {
                return '[Multimodal content]';
            }
        }
    }
    // Handle any other data types gracefully
    if (typeof content === 'object' && content !== null) {
        // Try to extract something meaningful from unknown objects
        if (content.type) {
            return `[${content.type}]`;
        }
        if (content.name || content.fileName) {
            return `[File] ${content.name || content.fileName}`;
        }
        if (Array.isArray(content)) {
            return content.map(item => getTextContent(item)).join(' + ');
        }
        return '[Content]';
    }
    const result = String(content || '');
    // Prevent [object Object] from ever appearing
    if (result === '[object Object]') {
        return '[Content]';
    }
    return result;
}

// Utility function to get preview text with length limit
function getPreviewText(content, maxLength = 50) {
    const textContent = getTextContent(content);
    if (textContent.length > maxLength) {
        return textContent.substring(0, maxLength) + '...';
    }
    return textContent;
}

// Load chat list from backend
async function loadChatList() {
    try {
        const url = window.sidebarView === 'chat' 
            ? `${API_BASE}/api/chats?freeform=true` 
            : `${API_BASE}/api/chats`;
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        
        const chats = await response.json();
        
        // Clear existing list
        chatList.innerHTML = '';
        
        if (chats.length === 0) {
            // No existing chats, create an initial one
            currentChatId = generateId();
            try {
                await createNewChatInDatabase(currentChatId, 'New Chat', 
                    (sidebarView === 'code' && currentProjectId) ? currentProjectId : null);
                addChatToList(currentChatId, 'New Chat', '', new Date()); // This is already local time
                selectChat(currentChatId);
                updateChatTitle('New Chat');
                chatInfo.textContent = `Chat ID: ${currentChatId}`;
            } catch (error) {
                logger.error('Failed to create initial chat:', error, true);
                chatList.innerHTML = '<div style="padding: 8px; color: #666; font-style: italic; text-align: center;">Error creating initial chat.</div>';
            }
            return;
        }
        
        // Add each chat to the list (backend returns newest-first, so append to maintain order)
        chats.forEach(chat => {
            addChatToListAtEnd(chat.chat_id, chat.title, chat.last_message, new Date(chat.last_updated));
        });
        
        // Auto-select the most recent chat
        if (chats.length > 0) {
            const mostRecent = chats[0];
            currentChatId = mostRecent.chat_id;
            selectChat(currentChatId);
            loadChatHistory(currentChatId);
        }
        
    } catch (error) {
        logger.error('Error loading chat list:', error, true);
        chatList.innerHTML = '<div style="padding: 8px; color: #666; font-style: italic; text-align: center;">No chats available.</div>';
    }
}

// Add chat to the sidebar list
// Helper function to format date/time smartly
function formatChatDateTime(date) {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
    const chatDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    
    const timeStr = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    
    if (chatDate.getTime() === today.getTime()) {
        return `Today ${timeStr}`;
    } else if (chatDate.getTime() === yesterday.getTime()) {
        return `Yesterday ${timeStr}`;
    } else {
        const dateStr = date.toLocaleDateString('en-US', { 
            month: 'numeric', 
            day: 'numeric', 
            year: 'numeric' 
        });
        return `${dateStr} ${timeStr}`;
    }
}

function addChatToList(chatId, title, lastMessage, lastUpdated) {
    const chatItem = document.createElement('div');
    chatItem.className = 'chat-item';
    chatItem.dataset.chatId = chatId;
    
    const dateTimeStr = formatChatDateTime(lastUpdated);
    
    chatItem.innerHTML = `
        <div class="chat-item-header">
            <div class="chat-item-datetime">${dateTimeStr}</div>
            <button class="chat-delete-btn" title="Delete chat"><span class="x-icon"></span></button>
        </div>
        <div class="chat-item-content">
            <div class="chat-item-title">${escapeHtml(title)}</div>
            <div class="chat-item-preview">${escapeHtml(getPreviewText(lastMessage, 50))}</div>
        </div>
    `;
    
    // Add click handler for the main chat content (but not the header)
    const chatContent = chatItem.querySelector('.chat-item-content');
    chatContent.addEventListener('click', () => {
        switchToChat(chatId);
    });
    
    // Also allow clicking the main chat item (but not header or delete button)
    chatItem.addEventListener('click', (e) => {
        if (!e.target.closest('.chat-item-header')) {
            switchToChat(chatId);
        }
    });
    
    // Add click handler for the delete button
    const deleteBtn = chatItem.querySelector('.chat-delete-btn');
    deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation(); // Prevent chat selection
        handleDeleteChat(chatId, title);
    });
    
    // Insert at the top (most recent first)
    chatList.insertBefore(chatItem, chatList.firstChild);
}
// Add chat to the sidebar list at the end (for loading from database)
function addChatToListAtEnd(chatId, title, lastMessage, lastUpdated) {
    const chatItem = document.createElement('div');
    chatItem.className = 'chat-item';
    chatItem.dataset.chatId = chatId;
    
    const dateTimeStr = formatChatDateTime(lastUpdated);
    
    chatItem.innerHTML = `
        <div class="chat-item-header">
            <div class="chat-item-datetime">${dateTimeStr}</div>
            <button class="chat-delete-btn" title="Delete chat"><span class="x-icon"></span></button>
        </div>
        <div class="chat-item-content">
            <div class="chat-item-title">${escapeHtml(title)}</div>
            <div class="chat-item-preview">${escapeHtml(getPreviewText(lastMessage, 50))}</div>
        </div>
    `;
    
    // Add click handler for the main chat content (but not the header)
    const chatContent = chatItem.querySelector('.chat-item-content');
    chatContent.addEventListener('click', () => {
        switchToChat(chatId);
    });
    
    // Also allow clicking the main chat item (but not header or delete button)
    chatItem.addEventListener('click', (e) => {
        if (!e.target.closest('.chat-item-header')) {
            switchToChat(chatId);
        }
    });
    
    // Add click handler for the delete button
    const deleteBtn = chatItem.querySelector('.chat-delete-btn');
    deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation(); // Prevent chat selection
        handleDeleteChat(chatId, title);
    });
    
    // Append at the end (maintain backend order)
    chatList.appendChild(chatItem);
}

// Handle chat deletion with confirmation
async function handleDeleteChat(chatId, title) {
    // Use custom confirm instead of browser popup
    showCustomConfirm(
        `Delete chat "${title}"?\n\nThis will permanently delete all messages in this chat.`,
        async () => {
            await performChatDeletion(chatId, title);
        }
    );
}

// Perform the actual chat deletion
async function performChatDeletion(chatId, title) {
    try {
        const response = await fetch(`${API_BASE}/api/chat/${chatId}`, {
            method: 'DELETE'
        });
        
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        
        const chatItem = document.querySelector(`[data-chat-id="${chatId}"]`);
        if (chatItem) {
            chatItem.remove();
        }
        
        if (currentChatId === chatId) {
            const remainingChats = document.querySelectorAll('.chat-item');
            if (remainingChats.length > 0) {
                const firstChatId = remainingChats[0].dataset.chatId;
                await switchToChat(firstChatId);
            } else {
                if (window.currentProjectId) {
                    await loadProjectChats(window.currentProjectId);
                } else {
                    await loadChatList();
                }
            }
        }
        
        logger.info('Chat deleted successfully:', chatId);
        
    } catch (error) {
        logger.error('Failed to delete chat:', error, true);
        showError(`Failed to delete chat: ${error.message}`);
    }
}

// Select a chat in the UI
function selectChat(chatId) {
    // Remove active class from all chat items
    document.querySelectorAll('.chat-item').forEach(item => {
        item.classList.remove('active');
    });
    
    // Add active class to selected chat
    const selectedItem = document.querySelector(`[data-chat-id="${chatId}"]`);
    if (selectedItem) {
        selectedItem.classList.add('active');
    }
}

// Switch to a different chat
async function switchToChat(chatId) {
    if (chatId === currentChatId) return;
    
    currentChatId = chatId;
    selectChat(chatId);
    
    // Load chat history
    await loadChatHistory(chatId);
    
    // Focus input
    messageInput.focus();
}

// Reconstruct tool content from message relationships
function reconstructToolContent(messages) {
    const processedMessages = [];
    let i = 0;
    
    while (i < messages.length) {
        const msg = messages[i];
        
        // Check if this is an assistant message with tool calls
        if (msg.role === 'assistant' && hasToolCalls(msg)) {
            // Find all subsequent tool messages that belong to this assistant message
            const toolResults = [];
            let j = i + 1;
            
            // Collect all tool messages that follow this assistant message
            while (j < messages.length && messages[j].role === 'tool') {
                toolResults.push(messages[j]);
                j++;
            }
            
            // Keep original content clean - no injection of fake markers
            let reconstructedContent = msg.content || '';
            
            // Add the message with tool data for SSE simulation
            processedMessages.push({
                ...msg,
                content: reconstructedContent,
                tool_results: toolResults  // Add tool results for SSE simulation
            });
            
            // Skip the tool messages since we've absorbed them
            i = j;
        } else {
            // Regular message, add as-is
            processedMessages.push(msg);
            i++;
        }
    }
    
    return processedMessages;
}

// Group messages by turn_number for proper turn-based rendering
function groupMessagesByTurn(messages) {
    const turnGroups = new Map();
    
    messages.forEach(msg => {
        const turnNumber = msg.turn_number || 0;
        if (!turnGroups.has(turnNumber)) {
            turnGroups.set(turnNumber, []);
        }
        turnGroups.get(turnNumber).push(msg);
    });
    
    // Check for duplicate turn numbers in the groups  
    const turnNumbers = Array.from(turnGroups.keys());
    const duplicateTurns = turnNumbers.filter((turn, index) => turnNumbers.indexOf(turn) !== index);
    
    if (duplicateTurns.length > 0) {
        console.error(`[GROUP-MESSAGES] DUPLICATE TURN NUMBERS DETECTED: ${duplicateTurns}`);
    }
    
    turnGroups.forEach((msgs, turnNum) => {
        const assistantCount = msgs.filter(m => m.role === 'assistant').length;
        if (assistantCount > 1) {
            console.warn(`[GROUP-MESSAGES] Turn ${turnNum} has ${assistantCount} assistant messages!`);
        }
    });
    
    // Convert to array and sort by turn number
    return Array.from(turnGroups.entries())
        .sort(([a], [b]) => a - b)
        .map(([turnNumber, turnMessages]) => ({ turnNumber, messages: turnMessages }));
}

// Check if a message has tool calls
function hasToolCalls(msg) {
    // Check if tool_calls field exists
    if (msg.tool_calls && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
        return true;
    }
    
    // Check if content mentions tool calls (legacy format)
    if (msg.content && msg.content.includes('tool_calls')) {
        return true;
    }
    
    return false;
}

// Track if we're already loading to prevent concurrent calls
let isLoadingHistory = false;

// Load chat history for a specific chat
async function loadChatHistory(chatId) {
    if (isLoadingHistory) {
        console.warn(`[LOAD-GUARD] Already loading history, ignoring duplicate call for chatId: ${chatId}`);
        return;
    }
    
    isLoadingHistory = true;
    
    try {
        setLoading(true);
        
        const history = await getCompleteChatHistory(chatId);
        
        // Validate history data
        if (!history || !history.messages || !Array.isArray(history.messages)) {
            console.error('[LOAD-HISTORY] Invalid history data received:', history);
            throw new Error('Invalid chat history data received from server');
        }
        
        // Filter out any malformed messages
        const validMessages = history.messages.filter(msg => {
            if (!msg || !msg.role || msg.turn_number === undefined) {
                console.warn('[LOAD-HISTORY] Skipping malformed message:', msg);
                return false;
            }
            return true;
        });
        
        if (validMessages.length !== history.messages.length) {
            console.warn(`[LOAD-HISTORY] Filtered out ${history.messages.length - validMessages.length} malformed messages`);
        }
        
        // Replace with filtered messages
        history.messages = validMessages;
        
        // Initialize turn tracking for this chat
        await initializeTurnTrackingForChat(chatId);
        
        // Clear current turns
        turnsContainer.innerHTML = '';
        
        // Reset auto-scroll state when loading new chat
        isUserAtBottom = true;
        
        // Update chat info
        const chatItem = document.querySelector(`[data-chat-id="${chatId}"]`);
        const title = chatItem ? chatItem.querySelector('.chat-item-title').textContent : 'Chat';
        chatTitle.textContent = title; // Just update the UI title, don't save to database
        chatInfo.textContent = `Chat ID: ${chatId} | ${history.messages.length} messages`;
        
        // Using proper SSE simulation without content injection
        logger.info('[UNIFIED-RENDERING] Processing chat history through SSE simulation');
        
        // Prepare messages with tool data for SSE simulation
        const processedMessages = reconstructToolContent(history.messages);
        
        // Group messages by turn_number for proper turn-based rendering
        const turnGroups = groupMessagesByTurn(processedMessages);
        
        // Process each turn using the exact same pipeline as live rendering
        turnGroups.forEach((group, groupIndex) => {
            const { turnNumber, messages: turnMessages } = group;
            
            // Separate user and assistant messages (like live rendering does)
            const userMessages = turnMessages.filter(msg => msg.role === 'user');
            const assistantMessages = turnMessages.filter(msg => msg.role === 'assistant');
            
            // Check if any messages in this turn are errored
            const hasErrors = turnMessages.some(msg => msg.error_state);
            const errorMessages = turnMessages.filter(msg => msg.error_state);
            
            // Check for duplicate assistant messages in the same turn
            if (assistantMessages.length > 1) {
                console.warn(`[LOAD-HISTORY] WARNING: Turn ${turnNumber} has ${assistantMessages.length} assistant messages!`);
                console.warn(`[LOAD-HISTORY] Assistant message IDs:`, assistantMessages.map(m => ({id: m.id, content: getPreviewText(m.content, 50)})));
            }
            
            // Render user messages directly (exactly like live rendering)
            userMessages.forEach(userMsg => {
                chatRenderer.renderTurn({
                    id: userMsg.id,
                    role: 'user',
                    content: userMsg.content,
                    turn_number: turnNumber,
                    edit_count: userMsg.edit_count,
                    edited_at: userMsg.edited_at,
                    debug_data: userMsg.debug_data  // Include debug data for user messages
                }, false);
            });
            
            // Handle error messages - render them with special error styling
            if (hasErrors && errorMessages.length > 0) {
                errorMessages.forEach(errorMsg => {
                    // Create error message with debug panel
                    chatRenderer.renderTurn({
                        id: errorMsg.id,
                        role: 'assistant',
                        content: errorMsg.content,
                        turn_number: turnNumber,
                        error_state: errorMsg.error_state,
                        debug_data: errorMsg.debug_data,
                        edit_count: errorMsg.edit_count,
                        edited_at: errorMsg.edited_at,
                        blocks: [{
                            type: 'error',
                            content: errorMsg.content,
                            metadata: {
                                error_type: errorMsg.error_state,
                                debug_data: errorMsg.debug_data
                            }
                        }]
                    }, false);
                });
            }
            
            // Process assistant messages separately (exactly like live rendering)
            if (assistantMessages.length > 0 && !hasErrors) {
                
                // Create a processor only for assistant content
                const processor = new StreamingMessageProcessor();
                
                // Create a temp container for use with updateLiveRendering (required by handleToolEvent)
                const tempContainer = document.createElement('div');
                const liveRenderer = new ChatRenderer(tempContainer);
                
                let turnDebugData = null;
                let primaryAssistantMessage = null;
                
                assistantMessages.forEach((msg, msgIndex) => {
                    // Track the primary assistant message
                    if (msg.content) {
                        if (primaryAssistantMessage) {
                            console.warn(`[LOAD-HISTORY] Multiple assistant messages with content! Previous: ${primaryAssistantMessage.id}, Current: ${msg.id}`);
                        }
                        primaryAssistantMessage = msg;
                        turnDebugData = msg.debug_data;
                    }
                    
                    // Handle only assistant content - this properly processes <think> and <thinking> tags and normal text
                    if (msg.content) {
                        // Check if content is multimodal (array) - if so, only process text parts for streaming processor
                        if (Array.isArray(msg.content)) {
                            const textParts = msg.content.filter(part => part.type === 'text');
                            textParts.forEach(part => {
                                if (part.text) {
                                    processor.addChunk(part.text);
                                }
                            });
                        } else {
                            // Regular string content
                            processor.addChunk(msg.content);
                        }
                    }
                    
                    // Simulate SSE tool events using the same structured data
                    if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
                        msg.tool_calls.forEach((toolCall, toolIdx) => {
                            const toolName = toolCall.function?.name || 'unknown_tool';
                            let args;
                            try {
                                args = JSON.parse(toolCall.function?.arguments || '{}');
                            } catch (e) {
                                args = { raw: toolCall.function?.arguments || '{}' };
                            }
                            
                            // Find corresponding tool result
                            const toolResult = msg.tool_results?.find(tr => tr.tool_call_id === toolCall.id);
                            
                            // Simulate the exact same tool event sequence that live rendering receives
                            // 1. Tool call detected
                            handleToolEvent({
                                type: 'tool_call_detected',
                                data: {
                                    id: toolCall.id,
                                    name: toolName
                                }
                            }, processor, liveRenderer, tempContainer);
                            
                            // 2. Tool execution started
                            handleToolEvent({
                                type: 'tool_execution_start',
                                data: {
                                    id: toolCall.id,
                                    name: toolName,
                                    arguments: args
                                }
                            }, processor, liveRenderer, tempContainer);
                            
                            // 3. Tool execution completed
                            let resultContent = { content: 'No result available' };
                            if (toolResult) {
                                try {
                                    resultContent = JSON.parse(toolResult.content);
                                } catch (e) {
                                    resultContent = { content: toolResult.content };
                                }
                            }
                            
                            handleToolEvent({
                                type: 'tool_execution_complete',
                                data: {
                                    id: toolCall.id,
                                    name: toolName,
                                    status: 'success',
                                    result: resultContent,
                                    execution_time_ms: 0
                                }
                            }, processor, liveRenderer, tempContainer);
                        });
                    }
                });
                
                // Finalize the processor after processing all assistant messages
                processor.finalize();
                
                // Get the blocks that were created through the exact same pipeline as live rendering
                let blocks = processor.getBlocks();
                
                // Determine content to render - preserve multimodal content if it exists
                let contentToRender = processor.getRawContent() || '';
                if (primaryAssistantMessage?.content && Array.isArray(primaryAssistantMessage.content)) {
                    // Use original multimodal content to preserve images
                    contentToRender = primaryAssistantMessage.content;
                    
                    // CRITICAL FIX: Create complete blocks that include multimodal content
                    // The processor only created blocks from text parts, but we need to include images too
                    const hasImages = primaryAssistantMessage.content.some(part => part.type === 'image');
                    
                    if (hasImages && blocks.length > 0) {
                        // Replace the first chat block with the complete multimodal content
                        const firstChatBlockIndex = blocks.findIndex(block => block.type === 'chat');
                        if (firstChatBlockIndex !== -1) {
                            blocks[firstChatBlockIndex] = {
                                type: 'chat',
                                content: primaryAssistantMessage.content, // Full multimodal array
                                metadata: {}
                            };
                        }
                    } else if (hasImages && blocks.length === 0) {
                        // No blocks were created (probably no text), but we have images - create a multimodal block
                        blocks = [{
                            type: 'chat',
                            content: primaryAssistantMessage.content, // Full multimodal array
                            metadata: {}
                        }];
                    }
                }
                
                // Render assistant turn with complete blocks (including images)
                chatRenderer.renderTurn({
                    id: primaryAssistantMessage?.id,
                    role: 'assistant',
                    blocks: blocks, // Now includes complete multimodal content
                    content: contentToRender,
                    debug_data: turnDebugData,
                    turn_number: turnNumber,
                    edit_count: primaryAssistantMessage?.edit_count,
                    edited_at: primaryAssistantMessage?.edited_at
                }, false); // false = don't scroll for each turn
            }
        });
        
        // Force scroll to bottom when loading chat history
        scrollToBottom(scrollContainer);
        
    } catch (error) {
        logger.error('Error loading chat history:', error, true);
        showError(`Failed to load chat history: ${error.message}`);
    } finally {
        setLoading(false);
        isLoadingHistory = false;
    }
}

// Update chat title
async function updateChatTitle(title) {
    // Convert objects properly using text extraction
    let cleanTitle = title;
    
    // If title is an object/array, extract text content
    if (typeof title === 'object') {
        cleanTitle = getTextContent(title) || 'New Chat';
    }
    
    // Fallback for invalid strings
    if (!cleanTitle || cleanTitle === 'undefined' || cleanTitle === 'null' || cleanTitle.includes('[object Object]')) {
        cleanTitle = 'New Chat';
    }
    
    chatTitle.textContent = cleanTitle;
    
    // Update the chat item in the list too
    const chatItem = document.querySelector(`[data-chat-id="${currentChatId}"]`);
    if (chatItem) {
        const titleEl = chatItem.querySelector('.chat-item-title');
        if (titleEl) {
            titleEl.textContent = cleanTitle;
            
            // Update the title in the database
            try {
                await updateChatTitleInDatabase(currentChatId, cleanTitle);
            } catch (error) {
                logger.error('Error updating chat title in database:', error);
                // Continue anyway - UI is updated even if DB update fails
            }
        }
    }
}

// Update chat preview in the list
function updateChatPreview(chatId, message) {
    const chatItem = document.querySelector(`[data-chat-id="${chatId}"]`);
    if (chatItem) {
        const previewEl = chatItem.querySelector('.chat-item-preview');
        if (previewEl) {
            // Process the message through getTextContent first to handle multimodal content
            const processedText = getTextContent(message);
            previewEl.textContent = getPreviewText(processedText, 50);
        }
        
        // Update timestamp
        const timeEl = chatItem.querySelector('.chat-item-time');
        if (timeEl) {
            const now = new Date();
            timeEl.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        }
        
        // Keep chat in its original position (ordered by creation time)
    }
}

// Get chat history from backend
async function getChatHistory(chatId) {
    try {
        const response = await fetch(`${API_BASE}/api/chat/${chatId}/history`);
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        
        return await response.json();
    } catch (error) {
        logger.error('Error fetching chat history:', error);
        throw error;
    }
}

// Get complete chat history including error messages (for UI display)
async function getCompleteChatHistory(chatId) {
    try {
        const response = await fetch(`${API_BASE}/api/chat/${chatId}/history-complete`);
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        
        return await response.json();
    } catch (error) {
        logger.error('Error fetching complete chat history:', error);
        throw error;
    }
}

// ===== PROJECT MANAGEMENT =====

// Sidebar and project state (shared with main.js)
window.sidebarView = 'chat';
window.currentProjectId = null;
window.projects = [];

// Get current bottom bar state
function getBottomBarState() {
    if (window.currentProjectId) {
        return 'projectChat';
    }
    if (window.sidebarView === 'code') {
        return 'newProject';
    }
    return 'newChat';
}

// Update bottom bar label based on current state
function updateBottomBar() {
    const label = document.getElementById('bottomBarLabel');
    const backBtn = document.getElementById('bottomBarBackBtn');
    const state = getBottomBarState();
    
    if (!label) return;
    
    switch (state) {
        case 'newChat':
            label.textContent = 'New Chat';
            if (backBtn) backBtn.style.display = 'none';
            break;
        case 'newProject':
            label.textContent = 'New Project';
            if (backBtn) backBtn.style.display = 'none';
            break;
        case 'projectChat':
            label.textContent = 'Back to Projects';
            if (backBtn) backBtn.style.display = 'flex';
            break;
    }
}

// Load projects from backend
async function loadProjects() {
    try {
        const response = await fetch(`${API_BASE}/api/projects`);
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        window.projects = await response.json();
        renderProjects();
    } catch (error) {
        logger.error('Error loading projects:', error);
    }
}

// Render projects list
function renderProjects() {
    const container = document.getElementById('projectsContainer');
    if (!container) return;
    
    container.innerHTML = '';
    
    if (window.projects.length === 0) {
        container.innerHTML = '<div style="padding: 8px; color: #666; font-style: italic; text-align: center;">No projects yet.</div>';
        return;
    }
    
    window.projects.forEach(project => {
        const projectItem = document.createElement('div');
        projectItem.className = 'project-item';
        projectItem.dataset.projectId = project.id;
        
        const projectName = project.name || project.path.split('\\').pop().split('/').pop();
        
        projectItem.innerHTML = `
            <div class="project-item-header">
                <div class="project-item-name">${escapeHtml(projectName)}</div>
                <button class="project-delete-btn" title="Delete project"><span class="x-icon"></span></button>
            </div>
            <div class="project-item-content">
                <div class="project-item-path">${escapeHtml(project.path)}</div>
            </div>
        `;
        
        // Click to open project's chat list
        projectItem.addEventListener('click', (e) => {
            if (!e.target.closest('.project-delete-btn')) {
                openProject(project.id);
            }
        });
        
        // Delete button
        const deleteBtn = projectItem.querySelector('.project-delete-btn');
        deleteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            handleDeleteProject(project.id, projectName);
        });
        
        container.appendChild(projectItem);
    });
}

// Open a project's chat list
function openProject(projectId) {
    window.currentProjectId = projectId;
    window.sidebarView = 'code';
    
    const project = window.projects.find(p => p.id === projectId);
    const projectName = project ? (project.name || project.path.split('\\').pop().split('/').pop()) : 'Project';
    
    // Show project chat header
    const projectChatHeader = document.getElementById('projectChatHeader');
    const projectChatTitle = document.getElementById('projectChatTitle');
    if (projectChatHeader) projectChatHeader.style.display = 'flex';
    if (projectChatTitle) projectChatTitle.textContent = projectName;
    
    // Show project chat list, hide projects list
    const chatList = document.getElementById('chatList');
    const projectsList = document.getElementById('projectsList');
    const chatListHeader = document.querySelector('.chat-list-header');
    if (chatList) chatList.style.display = 'block';
    if (projectsList) projectsList.style.display = 'none';
    // Hide chat-list-header since projectChatHeader shows the project name
    if (chatListHeader) chatListHeader.style.display = 'none';
    
    // Load project-scoped chats
    loadProjectChats(projectId);
    
    // Update bottom bar
    updateBottomBar();
    
    logger.info(`Opened project: ${projectName} (${projectId})`);
}

// Close current project, go back to projects list
function closeProject() {
    window.currentProjectId = null;
    
    // Hide project chat header
    const projectChatHeader = document.getElementById('projectChatHeader');
    if (projectChatHeader) projectChatHeader.style.display = 'none';
    
    // Show projects list, hide chat list
    const chatList = document.getElementById('chatList');
    const projectsList = document.getElementById('projectsList');
    if (chatList) chatList.style.display = 'none';
    if (projectsList) projectsList.style.display = 'flex';
    
    // Update sidebar list title
    const sidebarListTitle = document.getElementById('sidebarListTitle');
    if (sidebarListTitle) sidebarListTitle.textContent = 'Project List';
    
    // Update bottom bar
    updateBottomBar();
    
    logger.info('Closed project, showing projects list');
}

// Load chats for a specific project
async function loadProjectChats(projectId) {
    try {
        const response = await fetch(`${API_BASE}/api/chats?project_id=${projectId}`);
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        
        const chats = await response.json();
        
        const chatList = document.getElementById('chatList');
        chatList.innerHTML = '';
        
        if (chats.length === 0) {
            chatList.innerHTML = '<div style="padding: 8px; color: #666; font-style: italic; text-align: center;">No chats in this project. Create one!</div>';
            return;
        }
        
        chats.forEach(chat => {
            addChatToListAtEnd(chat.chat_id, chat.title, chat.last_message, new Date(chat.last_updated));
        });
        
    } catch (error) {
        logger.error('Error loading project chats:', error);
        const chatList = document.getElementById('chatList');
        chatList.innerHTML = '<div style="padding: 8px; color: #666; font-style: italic; text-align: center;">Error loading chats.</div>';
    }
}

// Handle bottom bar plus button action
async function handleBottomBarPlus() {
    const state = getBottomBarState();
    
    switch (state) {
        case 'newChat':
            await handleNewChat();
            break;
        case 'newProject':
            await handleNewProject();
            break;
        case 'projectChat':
            await handleNewChat();
            break;
    }
}

// Handle new chat creation (with project context)
async function handleNewChat() {
    try {
        const chatId = generateId();
        
        await createNewChatInDatabase(chatId, 'New Chat', window.currentProjectId);
        
        turnsContainer.innerHTML = '';
        resetTurnTracking();
        
        updateChatTitle('New Chat');
        chatInfo.textContent = `Chat ID: ${chatId}`;
        
        addChatToList(chatId, 'New Chat', '', new Date());
        selectChat(chatId);
        
        if (window.currentProjectId) {
            await loadProjectChats(window.currentProjectId);
        } else {
            await loadChatList();
        }
        
    } catch (error) {
        logger.error('Failed to create new chat:', error, true);
        showError('Failed to create new chat');
    }
    
    messageInput.focus();
}

// Handle new project creation (opens folder picker via Electron)
async function handleNewProject() {
    let name, path;
    
    if (window.electronAPI && window.electronAPI.pickFolder) {
        try {
            const result = await window.electronAPI.pickFolder();
            if (!result) return;
            name = result.name;
            path = result.path;
        } catch (err) {
            showError('Folder picker error: ' + err.message);
            return;
        }
    } else {
        name = prompt('Project name:');
        if (!name) return;
        path = prompt('Project path:');
        if (!path) return;
    }
    
    try {
        const project = await createProject(name, path);
        window.projects.push(project);
        renderProjects();
        logger.info(`Created project: ${name} (${path})`);
    } catch (error) {
        logger.error('Failed to create project:', error, true);
        showError(`Failed to create project: ${error.message}`);
    }
}

// Handle project deletion
async function handleDeleteProject(projectId, projectName) {
    showCustomConfirm(
        `Delete project "${projectName}"?\n\nThis will keep all chats in the project but unlink them.`,
        async () => {
            try {
                await deleteProject(projectId);
                window.projects = window.projects.filter(p => p.id !== projectId);
                
                if (window.currentProjectId === projectId) {
                    closeProject();
                }
                
                renderProjects();
                logger.info(`Deleted project: ${projectName}`);
            } catch (error) {
                logger.error('Failed to delete project:', error, true);
                showError(`Failed to delete project: ${error.message}`);
            }
        }
    );
}

// Switch sidebar view (Chat / Code tab)
function switchSidebarView(view) {
    // If inside a project, close it first
    if (window.currentProjectId) {
        closeProject();
    }
    
    window.sidebarView = view;
    
    document.querySelectorAll('.sidebar-tab-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.view === view);
    });
    
    const chatList = document.getElementById('chatList');
    const projectsList = document.getElementById('projectsList');
    const chatListHeader = document.querySelector('.chat-list-header');
    const sidebarListTitle = document.getElementById('sidebarListTitle');
    
    if (view === 'chat') {
        chatList.style.display = 'block';
        projectsList.style.display = 'none';
        if (chatListHeader) chatListHeader.style.display = 'flex';
        if (sidebarListTitle) sidebarListTitle.textContent = 'Chat History';
        loadChatList();
    } else {
        chatList.style.display = 'none';
        projectsList.style.display = 'flex';
        if (chatListHeader) chatListHeader.style.display = 'none';
        if (sidebarListTitle) sidebarListTitle.textContent = 'Project List';
        loadProjects();
    }
    
    updateBottomBar();
}

// Make functions globally available for UI
window.handleNewChat = handleNewChat;
window.handleNewProject = handleNewProject;
window.switchSidebarView = switchSidebarView;
window.closeProject = closeProject;
window.handleBottomBarPlus = handleBottomBarPlus;
window.updateBottomBar = updateBottomBar;
