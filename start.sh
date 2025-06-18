#!/bin/bash

echo "[STARTING] SimpleChatJS"
echo "Chat will be available at: http://localhost:50505"
echo "Browser will open automatically."
echo ""

# Install dependencies if needed
if [ ! -d "node_modules" ] || [ ! -d "node_modules/open" ] || [ ! -d "node_modules/better-sqlite3" ]; then
    echo "Installing dependencies..."
    npm install
fi

# Kill any existing server on port 50505
echo "Checking for existing server on port 50505..."
PID=$(lsof -ti:50505 2>/dev/null)
if [ ! -z "$PID" ]; then
    echo "Found process $PID using port 50505, killing it..."
    kill -9 $PID 2>/dev/null
    sleep 1
fi

# Start the server
echo "Starting server..."
node backend/server.js
