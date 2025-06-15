#!/bin/bash

echo "[STARTING] Simple Chat JS - PURE 1998 STYLE!"
echo ""
echo "Dark mode AOL-style chat with conductor mode!"
echo "- Multiple chats with persistent history"
echo "- PURE JAVASCRIPT (just script tags in HTML!)"
echo "- Simple MCP integration (server-side only)"
echo "- Professional logging system (check terminal for conductor phases)"
echo "- Configure your API settings in the web interface"
echo "- Toggle conductor mode for advanced workflows"
echo ""
echo "Chat will be available at: http://localhost:5500"
echo ""
echo "Quick setup:"
echo "1. Make sure you have Ollama running (ollama serve)"
echo "2. Or configure your API settings in the web interface"
echo "3. Edit mcp_config.json to add your MCP servers"
echo "4. Go to Settings and click 'Connect MCP Servers'"
echo "5. Enable conductor mode and ask questions!"
echo "6. NO BUILD TOOLS - just edit and refresh!"
echo ""

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
    echo "Installing dependencies (including MCP SDK)..."
    npm install
fi

# Start the server
echo "Starting server..."
node backend/server.js
