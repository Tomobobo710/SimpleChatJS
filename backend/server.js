// Simple Chat JS Server - Slim main entry point
const express = require('express');
const path = require('path');

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

const app = express();
const PORT = process.env.PORT || 5500;

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

// Initialize and start server
async function startServer() {
    try {
        // Initialize database
        await initializeDatabase();
        log('[DATABASE] Initialized successfully');
        
        // Start server
        app.listen(PORT, async () => {
            log(`[SERVER] Simple Chat JS server running at http://localhost:${PORT}`);
            await loadSettingsOnStartup();
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