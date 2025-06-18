// Chat Manager - Chat list management, switching, and history

// Handle new chat
async function handleNewChat() {
    try {
        // Create new chat ID
        currentChatId = generateId();
        
        // Create chat in database
        await createNewChatInDatabase(currentChatId, 'New Chat');
        
        // Clear messages
        messagesContainer.innerHTML = '';
        
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

// Load chat history for a specific chat
async function loadChatHistory(chatId) {
    try {
        setLoading(true);
        
        const history = await getChatHistory(chatId);
        
        // Clear current messages
        messagesContainer.innerHTML = '';
        
        // Reset auto-scroll state when loading new chat
        isUserAtBottom = true;
        
        // Update chat info
        const chatItem = document.querySelector(`[data-chat-id="${chatId}"]`);
        const title = chatItem ? chatItem.querySelector('.chat-item-title').textContent : 'Chat';
        updateChatTitle(title);
        chatInfo.textContent = `Chat ID: ${chatId} | ${history.messages.length} messages`;
        
        // Add all messages using ChatRenderer
        history.messages.forEach(msg => {
            if (msg.blocks) {
                chatRenderer.renderMessage({
                    role: msg.role,
                    blocks: msg.blocks,
                    debug_data: msg.debug_data
                }, false); // false = don't scroll for each message
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

// Update message in database at specific index
async function updateMessageInDatabase(chatId, messageIndex, updatedMessage) {
    try {
        const response = await fetch(`${API_BASE}/api/chat/${chatId}/message/${messageIndex}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                role: updatedMessage.role,
                content: updatedMessage.content,
                blocks: updatedMessage.blocks,
                debug_data: updatedMessage.debug_data
            })
        });
        
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        
        const result = await response.json();
        return result;
    } catch (error) {
        logger.error('Error updating message in database:', error);
        throw error;
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