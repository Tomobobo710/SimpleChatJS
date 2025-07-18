// SimpleChatJS Server - Main entry point
const express = require('express');
const path = require('path');
const open = require('open');

// Import utilities and services
const { log } = require('./utils/logger');
const { initializeDatabase, closeDatabase } = require('./config/database');
const { loadSettingsOnStartup } = require('./services/settingsService');
const { shutdownMcp } = require('./services/mcpService');

// Import routes
const chatRoutes = require('./routes/chat');
const mcpRoutes = require('./routes/mcp');
const settingsRoutes = require('./routes/settings');
const debugRoutes = require('./routes/debug');
const documentRoutes = require('./routes/documents');

const app = express();
const PORT = process.env.PORT || 50505;

// Express middleware - increase payload limit for long conductor conversations
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Serve static files from parent directory (where index.html lives)
app.use(express.static(path.join(__dirname, '..')));

// Mount API routes
app.use('/api', chatRoutes);
app.use('/api', mcpRoutes);
app.use('/api', settingsRoutes);
app.use('/api', debugRoutes);
app.use('/api', documentRoutes);

// Initialize and start server
async function startServer() {
    try {
        // Initialize database
        await initializeDatabase();
        log('[DATABASE] Initialized successfully');
        
        // Start server
        app.listen(PORT, async () => {
            const url = `http://localhost:${PORT}`;
            log(`[SERVER] SimpleChatJS server running at ${url}`);
            await loadSettingsOnStartup();
            
            // Skip opening browser when running in Electron
            if (!process.env.PORTABLE_USERDATA_PATH) {
                try {
                    await open(url);
                    log('[BROWSER] Opened browser automatically');
                } catch (error) {
                    log('[BROWSER] Failed to open browser:', error);
                }
            } else {
                log('[BROWSER] Running in Electron, skipping browser launch');
            }
        });
    } catch (error) {
        log('[STARTUP] Failed to start server:', error);
        process.exit(1);
    }
}

// Graceful shutdown
process.on('SIGINT', async () => {
    log('[SHUTDOWN] Shutting down gracefully...');
    
    try {
        // Shutdown MCP connections
        await shutdownMcp();
        
        // Close database
        await closeDatabase();
        
        process.exit(0);
    } catch (error) {
        log('[SHUTDOWN] Error during shutdown:', error);
        process.exit(1);
    }
});

// Start the server
startServer();