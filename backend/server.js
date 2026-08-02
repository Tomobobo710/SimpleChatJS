// SimpleChatJS Server - Main entry point
const express = require('express');
const path = require('path');

// Import utilities and services
const { log } = require('./utils/logger');
const { initializeDatabase, closeDatabase } = require('./config/database');
const { loadSettingsOnStartup } = require('./services/settingsService');
const { shutdownMcp } = require('./services/mcpService');

// Import routes
const chatRoutes = require('./routes/chat');
const projectRoutes = require('./routes/project');
const mcpRoutes = require('./routes/mcp');
const settingsRoutes = require('./routes/settings');
const debugRoutes = require('./routes/debug');
const documentRoutes = require('./routes/documents');
const shellConfigRoutes = require('./routes/shellConfig');
const jobRoutes = require('./routes/jobs');
const checkpointRoutes = require('./routes/checkpoints');

const app = express();
// PORT override: set PORT env var to change. Default 50505 for dev/local Electron.
const PORT = process.env.PORT || 50505;

// Express middleware - increase payload limit for large requests
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Serve static files from parent directory (where index.html lives)
app.use(express.static(path.join(__dirname, '..')));

// Mount API routes
app.use('/api', chatRoutes);
app.use('/api', projectRoutes);
app.use('/api', mcpRoutes);
app.use('/api', settingsRoutes);
app.use('/api', debugRoutes);
app.use('/api', documentRoutes);
app.use('/api', shellConfigRoutes);
app.use('/api', jobRoutes);
app.use('/api', checkpointRoutes);

// Bind a single port, resolving with the actual bound port.
function tryListen(port) {
    return new Promise((resolve, reject) => {
        const server = app.listen(port);
        server.once('listening', () => resolve({ server, port: server.address().port }));
        server.once('error', reject);
    });
}

// Bind the preferred port; if it's unavailable (Windows can dynamically
// reserve wide port ranges across reboots), fall back to port 0 and let the
// OS hand us any free port. The OS will never return a reserved port, so this
// fallback cannot hit EACCES.
async function listenWithFallback(preferredPort) {
    try {
        return await tryListen(preferredPort);
    } catch (err) {
        if (err.code === 'EACCES' || err.code === 'EADDRINUSE') {
            log(`[SERVER] Port ${preferredPort} unavailable (${err.code}), asking OS for any free port...`);
            return await tryListen(0);
        }
        throw err;
    }
}

// Initialize and start server. Resolves with the bound port.
async function startServer() {
    try {
        // Initialize database
        await initializeDatabase();
        log('[DATABASE] Initialized successfully');

        // Start server, falling forward if the preferred port is unavailable
        const { port } = await listenWithFallback(PORT);
        const url = `http://localhost:${port}`;
        log(`[SERVER] SimpleChatJS server running at ${url}`);
        await loadSettingsOnStartup();
        return port;
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

// Start the server. Export the promise so an embedding process (Electron main)
// can await the actual bound port instead of guessing.
module.exports = startServer();