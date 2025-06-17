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

# Start the server
echo "Starting server..."
node backend/server.js
