// Professional logging system with levels

class Logger {
    constructor(component = 'CLIENT') {
        this.component = component;
        this.levels = {
            DEBUG: 0,
            INFO: 1,
            WARN: 2,
            ERROR: 3
        };
        
        // Set default log level (can be overridden)
        this.currentLevel = this.levels.DEBUG;
        
        // Color mappings for browser console
        this.colors = {
            DEBUG: '#888888',
            INFO: '#4a9eff',
            WARN: '#ff9900',
            ERROR: '#ff4444'
        };
    }
    
    // Set the minimum log level
    setLevel(level) {
        if (typeof level === 'string') {
            this.currentLevel = this.levels[level.toUpperCase()] || this.levels.INFO;
        } else {
            this.currentLevel = level;
        }
    }
    
    // Internal logging method
    _log(level, message, data = null, sendToServer = false) {
        if (this.levels[level] < this.currentLevel) {
            return; // Skip logs below current level
        }
        
        const timestamp = new Date().toISOString();
        const shortTime = timestamp.substr(11, 12);
        const logMessage = `[${shortTime}] [${level}] [${this.component}] ${message}`;
        
        // Browser console with colors
        const color = this.colors[level];
        if (data) {
            console.log(`%c${logMessage}`, `color: ${color}; font-weight: bold`, data);
        } else {
            console.log(`%c${logMessage}`, `color: ${color}; font-weight: bold`);
        }
        
        // Send to server if requested
        if (sendToServer) {
            this._sendToServer(level, message, data);
        }
    }
    
    // Send logs to server for terminal display
    async _sendToServer(level, message, data) {
        try {
            await fetch('/api/log', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    level,
                    component: this.component,
                    message,
                    data: data ? JSON.stringify(data) : null,
                    timestamp: new Date().toISOString()
                })
            });
        } catch (error) {
            // Don't log this error to avoid infinite loops
            console.warn('Failed to send log to server:', error.message);
        }
    }
    
    // Public logging methods
    debug(message, data = null, sendToServer = false) {
        this._log('DEBUG', message, data, sendToServer);
    }
    
    info(message, data = null, sendToServer = false) {
        this._log('INFO', message, data, sendToServer);
    }
    
    warn(message, data = null, sendToServer = true) { // Warnings go to server by default
        this._log('WARN', message, data, sendToServer);
    }
    
    error(message, data = null, sendToServer = true) { // Errors go to server by default
        this._log('ERROR', message, data, sendToServer);
    }
    
    // Special method for conductor phases (always goes to server)
    phase(phaseNumber, action, details = '') {
        const message = `PHASE ${phaseNumber}: ${action}${details ? ' - ' + details : ''}`;
        this._log('INFO', message, null, true);
    }
}

// Create global logger instance
const logger = new Logger('CHAT');

// Set default log level
logger.setLevel('INFO');

// Helper to change log level at runtime
function setLogLevel(level) {
    logger.setLevel(level);
    
    // Save via settings system
    const currentSettings = loadSettings();
    currentSettings.logLevel = level.toUpperCase();
    saveSettings(currentSettings);
    
    logger.info(`Log level set to ${level.toUpperCase()}`, null, true);
    showNotification(`Log level set to ${level.toUpperCase()}`, 'success');
}

// Expose to global scope for easy debugging
window.logger = logger;
window.setLogLevel = setLogLevel;


function log(message, data = null) {
    logger.info(message, data);
}
