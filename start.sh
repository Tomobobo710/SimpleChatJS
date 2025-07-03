#!/bin/bash

echo "[STARTING] SimpleChatJS"
echo "Chat will be available at: http://localhost:50505"
echo "Browser will open automatically."
echo ""

# Install dependencies if node_modules doesn't exist or is incomplete
if [ ! -d "node_modules" ]; then
    echo "Installing dependencies..."
    npm install
    if [ $? -ne 0 ]; then
        echo "Failed to install dependencies!"
        exit 1
    fi
    echo "Dependencies installed successfully!"
else
    echo "Checking if all dependencies are installed..."
    npm ls --depth=0 >/dev/null 2>&1
    if [ $? -ne 0 ]; then
        echo "Missing dependencies detected, installing..."
        npm install
        if [ $? -ne 0 ]; then
            echo "Failed to install dependencies!"
            exit 1
        fi
        echo "Dependencies installed successfully!"
    else
        echo "All dependencies are present."
    fi
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
