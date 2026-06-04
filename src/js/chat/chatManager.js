// Chat Manager - Chat list management, switching, and history

// Sidebar and project state (shared with main.js)
window.sidebarView = 'chat';
window.currentProjectId = null;
window.projects = [];

// Turn navigation state: maps `${chatId}::${parentTurnId}` → selected sibling
// turn_id. Scoped per-chat (M2) so switching chats does not leak selections
// from a different chat's branch tree.
let selectedSiblings = {};

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

// Group messages by turn_number into Turn instances
function groupMessagesByTurn(messages) {
    const groups = new Map();
    for (const msg of messages) {
        const key = `${msg.turn_id || 'missing'}::${msg.turn_number || 0}::${msg.parent_turn_id || 'root'}`;
        if (!groups.has(key)) {
            groups.set(key, []);
        }
        groups.get(key).push(msg);
    }
    return Array.from(groups.entries())
        .sort(([a], [b]) => {
            const [, aTurn] = a.split('::');
            const [, bTurn] = b.split('::');
            return parseInt(aTurn) - parseInt(bTurn);
        })
        .map(([key, msgs]) => {
            const [turnId, turnNumber, parentTurnId] = key.split('::');
            return new Turn(parseInt(turnNumber), msgs.map(m => Message.fromObject(m)), turnId, parentTurnId === 'root' ? null : parentTurnId);
        });
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

// Build the rendered turn list using lineage-based filtering.
// Walks turns in turn_number order. At each branch point (siblings),
// selects the sibling whose turn_id matches selectedSiblings[`${chatId}::${parentTurnId}`].
// Only renders turns that are on the selected lineage path.
// `chatId` scopes the selection so different chats don't leak (M2).
function buildRenderedTurns(allTurns, chatId) {
    return walkActiveBranch(allTurns, chatId);
}

// Walk the DAG down from 'root' using selectedSiblings picks and return
// the array of chosen Turn objects in render order. This is the
// authoritative "active branch" walk: the renderer, the fresh-send
// parent resolver, and the branch-nav state all share this single
// source of truth so they cannot drift (Phase 9 M11 follow-up).
//
// Side effect: writes back the default selected sibling for any parent
// key that has no persisted choice (so the in-memory map stays
// consistent with the walk's output). `chatId` scopes the selection so
// different chats don't leak (M2).
function walkActiveBranch(allTurns, chatId) {
    const scopeKey = (parentKey) => `${chatId}::${parentKey}`;

    const childrenByParent = new Map();
    for (const turn of allTurns) {
        const parentKey = turn.parentTurnId || 'root';
        if (!childrenByParent.has(parentKey)) {
            childrenByParent.set(parentKey, []);
        }
        childrenByParent.get(parentKey).push(turn);
    }

    for (const children of childrenByParent.values()) {
        children.sort((a, b) => a.turnNumber - b.turnNumber);
    }

    const rendered = [];
    // `visited` guards against DB cycles (M3): a turn_id appears in at most
    // one position in the lineage path; a second visit means a cycle, so we
    // log and skip rather than recurse forever.
    const visited = new Set();
    const walk = (parentKey) => {
        if (visited.has(parentKey)) {
            console.warn(`[RENDER-CYCLE] Skipping parentKey="${parentKey}" — already visited. Likely a DB cycle.`);
            return;
        }
        visited.add(parentKey);

        const children = childrenByParent.get(parentKey) || [];
        if (children.length === 0) return;

        // Honor selectedSiblings for ALL parent keys, including 'root'.
        // Previously root siblings were hard-coded to ignore the selection,
        // which made the prev/next nav buttons on a root turn silently no-op
        // after a chat reload (H4).
        const selectedTurnId = selectedSiblings[scopeKey(parentKey)] ?? null;
        const matched = selectedTurnId
            ? children.find(child => child.turnId === selectedTurnId)
            : null;
        const chosen = matched ?? children[children.length - 1];
        selectedSiblings[scopeKey(parentKey)] = chosen.turnId;

        if (chosen) {
            rendered.push(chosen);
            if (chosen.turnId) walk(chosen.turnId);
        }
    };

    walk('root');

    return rendered;
}

// Resolve the turn_id of the deepest leaf on the currently selected
// branch (the "active terminal"). Used as the parent_turn_id for new
// user messages so a fresh send continues the active conversation
// instead of creating a root-level sibling. Returns null for an empty
// chat (first message in a new chat) or for a chat whose only turn is
// filtered out (e.g. system-only). The DOM is NOT consulted — this is
// pure data derived from the full history and selectedSiblings, so it
// can be called before any rendering happens (Phase 9 M11 fix).
async function getActiveTerminalTurnId(chatId) {
    if (!chatId) return null;
    const history = await getCompleteChatHistory(chatId);
    if (!history?.messages || !Array.isArray(history.messages)) return null;

    // System messages are meta-only (M9) and are filtered out of the
    // render walk in loadChatHistory. Do the same here so the active
    // terminal is always a real renderable turn.
    const renderableMessages = history.messages.filter(msg => msg.role !== 'system');
    if (renderableMessages.length === 0) return null;

    const allTurns = groupMessagesByTurn(renderableMessages);
    const active = walkActiveBranch(allTurns, chatId);
    if (active.length === 0) return null;
    return active[active.length - 1].turnId || null;
}

// Load chat history for a specific chat
async function loadChatHistory(chatId) {
    // Phase 8 Task 27 (L24): set the loading indicator before the guard
    // so a duplicate click during a load still gives the user visible
    // feedback (the spinner stays on). Previously the indicator was set
    // inside the try, so a duplicate click was silently dropped with only
    // a console.warn — the user saw nothing happen.
    setLoading(true);

    if (isLoadingHistory) {
        console.warn(`[LOAD-GUARD] Already loading history, ignoring duplicate call for chatId: ${chatId}`);
        return;
    }

    isLoadingHistory = true;

    try {

        const history = await getCompleteChatHistory(chatId);
        
        if (!history || !history.messages || !Array.isArray(history.messages)) {
            console.error('[LOAD-HISTORY] Invalid history data received:', history);
            throw new Error('Invalid chat history data received from server');
        }
        
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

        // System prompts are saved as root-level messages (parent_turn_id=null)
        // in processChatRequest, but they are meta-only — never rendered as
        // turns and never valid siblings of user/assistant turns. Including
        // them in the walk would either inflate the sibling count (Issue 1:
        // "1/3" for a 2-branch chat) or — worse — the root walk would land
        // on the system prompt as the "last root child" and stop there,
        // wiping every other turn from the renderer (Issue 2).
        const renderableMessages = validMessages.filter(msg => msg.role !== 'system');
        if (renderableMessages.length !== validMessages.length) {
            console.log(`[LOAD-HISTORY] Excluded ${validMessages.length - renderableMessages.length} system message(s) from rendering`);
        }
        history.messages = renderableMessages;

        // Load persisted branch navigation selections for this chat from
        // the DB and seed the in-memory map. Without this step, every
        // reload would lose the user's explicit prev/next picks (because
        // walk would default to "last sibling" again). The frontend map
        // is scoped per-chat (M2) — keys are `${chatId}::${parentKey}`.
        // loadBranchSelections returns the DB's `parent_key` column
        // verbatim, which is already in the full scoped form
        // (`<chatId>::root` or `<chatId>::<turnId>`) — do NOT add the
        // `${chatId}::` prefix again here, that would produce
        // `<chatId>::<chatId>::root` and the walk's scopeKey lookup
        // would never find the loaded pick. loadBranchSelections returns
        // {} for an unknown chat; we treat that as "no overrides" and let
        // the walk fall back. Errors throw — a broken DB read on a chat
        // load is loud, not silent.
        const persistedSelections = await loadBranchSelections(chatId);
        for (const [parentKey, selectedTurnId] of Object.entries(persistedSelections)) {
            selectedSiblings[parentKey] = selectedTurnId;
        }
        if (Object.keys(persistedSelections).length > 0) {
            console.log(`[LOAD-HISTORY] Restored ${Object.keys(persistedSelections).length} branch selection(s) for chat ${chatId}`);
        }

        await initializeTurnTrackingForChat(chatId);
        
        turnsContainer.innerHTML = '';
        isUserAtBottom = true;
        
        const chatItem = document.querySelector(`[data-chat-id="${chatId}"]`);
        const title = chatItem ? chatItem.querySelector('.chat-item-title').textContent : 'Chat';
        chatTitle.textContent = title;
        chatInfo.textContent = `Chat ID: ${chatId} | ${history.messages.length} messages`;
        
        logger.info('[UNIFIED-RENDERING] Loading chat history through Turn.renderable()');
        
        const allTurns = groupMessagesByTurn(history.messages);
        const renderedTurns = buildRenderedTurns(allTurns, chatId);
        
        renderedTurns.forEach(turn => {
            const rto = turn.renderable();
            chatRenderer.renderTurn(rto, false);
        });
        
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
