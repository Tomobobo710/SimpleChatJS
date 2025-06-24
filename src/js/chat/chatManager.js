// Chat Manager - Chat list management, switching, and history

// Handle new chat
async function handleNewChat() {
    try {
        // Create new chat ID
        currentChatId = generateId();
        
        // Create chat in database
        await createNewChatInDatabase(currentChatId, 'New Chat');
        
        // Clear turns
        turnsContainer.innerHTML = '';        
        // Reset turn tracking for new chat
        resetTurnTracking();
        
        // Update UI
        updateChatTitle('New Chat');
        chatInfo.textContent = `Chat ID: ${currentChatId}`;
        
        // Add to chat list
        addChatToList(currentChatId, 'New Chat', '', new Date());
        
        // Select this chat
        selectChat(currentChatId);
        
    } catch (error) {
        logger.error('Failed to create new chat:', error, true);
        showError('Failed to create new chat');
    }
    
    // Focus input
    messageInput.focus();
}

// Load chat list from backend
async function loadChatList() {
    try {
        const response = await fetch(`${API_BASE}/api/chats`);
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
                await createNewChatInDatabase(currentChatId, 'New Chat');
                addChatToList(currentChatId, 'New Chat', '', new Date());
                selectChat(currentChatId);
                updateChatTitle('New Chat');
                chatInfo.textContent = `Chat ID: ${currentChatId}`;
            } catch (error) {
                logger.error('Failed to create initial chat:', error, true);
                chatList.innerHTML = '<div style="padding: 8px; color: #666; font-style: italic; text-align: center;">Error creating initial chat.</div>';
            }
            return;
        }
        
        // Add each chat to the list
        chats.forEach(chat => {
            addChatToList(chat.chat_id, chat.title, chat.last_message, new Date(chat.last_updated));
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
function addChatToList(chatId, title, lastMessage, lastUpdated) {
    const chatItem = document.createElement('div');
    chatItem.className = 'chat-item';
    chatItem.dataset.chatId = chatId;
    
    const timeStr = lastUpdated.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    
    chatItem.innerHTML = `
        <div class="chat-item-content">
            <div class="chat-item-time">${timeStr}</div>
            <div class="chat-item-title">${escapeHtml(title)}</div>
            <div class="chat-item-preview">${escapeHtml(lastMessage.substring(0, 50))}${lastMessage.length > 50 ? '...' : ''}</div>
        </div>
        <button class="chat-delete-btn" title="Delete chat">×</button>
    `;
    
    // Add click handler for the main chat content
    const chatContent = chatItem.querySelector('.chat-item-content');
    chatContent.addEventListener('click', () => {
        switchToChat(chatId);
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

// Handle chat deletion with confirmation
async function handleDeleteChat(chatId, title) {
    const confirmed = confirm(`Are you sure you want to delete "${title}"?\n\nThis will permanently delete all messages in this chat.`);
    
    if (!confirmed) {
        return;
    }
    
    try {
        const response = await fetch(`${API_BASE}/api/chat/${chatId}`, {
            method: 'DELETE'
        });
        
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        
        // Remove the chat item from the UI
        const chatItem = document.querySelector(`[data-chat-id="${chatId}"]`);
        if (chatItem) {
            chatItem.remove();
        }
        
        // If this was the current chat, switch to another or clear
        if (currentChatId === chatId) {
            const remainingChats = document.querySelectorAll('.chat-item');
            if (remainingChats.length > 0) {
                // Switch to the first remaining chat
                const firstChatId = remainingChats[0].dataset.chatId;
                await switchToChat(firstChatId);
            } else {
                // No chats left, create a new one
                await handleNewChat();
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

// Load chat history for a specific chat
async function loadChatHistory(chatId) {
    try {
        setLoading(true);
        
        const history = await getChatHistory(chatId);        
        // Initialize turn tracking for this chat
        await initializeTurnTrackingForChat(chatId);
        
        // Clear current turns
        turnsContainer.innerHTML = '';
        
        // Reset auto-scroll state when loading new chat
        isUserAtBottom = true;
        
        // Update chat info
        const chatItem = document.querySelector(`[data-chat-id="${chatId}"]`);
        const title = chatItem ? chatItem.querySelector('.chat-item-title').textContent : 'Chat';
        updateChatTitle(title);
        chatInfo.textContent = `Chat ID: ${chatId} | ${history.messages.length} messages`;
        
        // Using proper SSE simulation without content injection
        logger.info('[UNIFIED-RENDERING] Processing chat history through SSE simulation');
        
        // Prepare messages with tool data for SSE simulation
        const processedMessages = reconstructToolContent(history.messages);
        
        // Group messages by turn_number for proper turn-based rendering
        const turnGroups = groupMessagesByTurn(processedMessages);
        
        // Process each turn using the exact same pipeline as live rendering
        turnGroups.forEach(({ turnNumber, messages: turnMessages }) => {
            // Separate user and assistant messages (like live rendering does)
            const userMessages = turnMessages.filter(msg => msg.role === 'user');
            const assistantMessages = turnMessages.filter(msg => msg.role === 'assistant');
            
            // Render user messages directly (exactly like live rendering)
            userMessages.forEach(userMsg => {
                chatRenderer.renderTurn({
                    id: userMsg.id,
                    role: 'user',
                    content: userMsg.content,
                    turn_number: turnNumber,
                    edit_count: userMsg.edit_count,
                    edited_at: userMsg.edited_at
                }, false);
            });
            
            // Process assistant messages separately (exactly like live rendering)
            if (assistantMessages.length > 0) {
                // Create a processor only for assistant content
                const processor = new StreamingMessageProcessor();
                
                // Create a temp container for use with updateLiveRendering (required by handleToolEvent)
                const tempContainer = document.createElement('div');
                const liveRenderer = new ChatRenderer(tempContainer);
                
                let turnDebugData = null;
                let primaryAssistantMessage = null;
                
                assistantMessages.forEach(msg => {
                    // Track the primary assistant message
                    if (msg.content) {
                        primaryAssistantMessage = msg;
                        turnDebugData = msg.debug_data;
                    }
                    
                    // Handle only assistant content - this properly processes <think> tags and normal text
                    if (msg.content) {
                        processor.addChunk(msg.content);
                    }
                    
                    // Simulate SSE tool events using the same structured data
                    if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
                        msg.tool_calls.forEach(toolCall => {
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
                const blocks = processor.getBlocks();
                
                // Render assistant turn with all blocks
                chatRenderer.renderTurn({
                    id: primaryAssistantMessage?.id,
                    role: 'assistant',
                    blocks: blocks,
                    content: processor.getRawContent() || '',
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
    }
}

// Update chat title
async function updateChatTitle(title) {
    chatTitle.textContent = title;
    
    // Update the chat item in the list too
    const chatItem = document.querySelector(`[data-chat-id="${currentChatId}"]`);
    if (chatItem) {
        const titleEl = chatItem.querySelector('.chat-item-title');
        if (titleEl) {
            titleEl.textContent = title;
            
            // Update the title in the database
            try {
                await updateChatTitleInDatabase(currentChatId, title);
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
            const preview = message.substring(0, 50);
            previewEl.textContent = preview + (message.length > 50 ? '...' : '');
        }
        
        // Update timestamp
        const timeEl = chatItem.querySelector('.chat-item-time');
        if (timeEl) {
            const now = new Date();
            timeEl.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        }
        
        // Move to top of list
        chatList.insertBefore(chatItem, chatList.firstChild);
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
