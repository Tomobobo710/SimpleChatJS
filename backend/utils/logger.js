// Logger utility - Simple logging with timestamps

function log(message, data = null) {
    const timestamp = new Date().toISOString().substr(11, 12);
    if (data) {
        console.log(`[${timestamp}] ${message}`, data);
    } else {
        console.log(`[${timestamp}] ${message}`);
    }
}

module.exports = { log };