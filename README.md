# SimpleChatJS

A lightweight, no-frills AI chat application built with pure JavaScript and Node.js. Designed for developers who appreciate simple architecture, and direct transparency with their chat interface.

![image](https://github.com/user-attachments/assets/da1e06d8-a8d1-4ec4-84de-fb105be1f13c)

## Philosophy

SimpleChatJS embraces a back-to-basics approach:

- **Pure JavaScript Frontend** - No React, Vue, or complex frameworks. Just vanilla JS, HTML, and CSS that any developer can understand and modify.
- **Clean Architecture** - Well-organized backend with clear separation of concerns. Easy to extend and maintain.
- **OpenAI Compatible** - Works with any OpenAI-compatible API including Ollama, providing flexibility in your AI provider choice.
- **MCP Integration** - Built-in support for Model Context Protocol, enabling powerful tool integrations.
- **1998-Style Simplicity** - Edit files, refresh browser. No build tools, no compilation step, no complex deployment pipeline.

## Features

### Core Chat Functionality
- Multiple persistent chat sessions with SQLite storage
- Real-time streaming responses
- Clean, dark-mode interface
- Message history and chat management

### Model Context Protocol (MCP) Support
- Connect to MCP servers for enhanced AI capabilities
- Tool execution with real-time feedback
- Configurable tool enabling/disabling
- Server-sent events for live tool status updates

### Developer-Friendly
- **No Build Tools** - Direct file editing with immediate browser refresh
- **Clear Code Organization** - Frontend and backend properly separated into logical modules
- **Comprehensive Logging** - Built-in debug panels and structured logging
- **Simple Deployment** - Single command startup with included scripts

### Advanced Features
- **Conductor Mode** - Multi-phase AI reasoning (experimental feature with ongoing improvements)
- **Debug Data Separation** - Technical debugging information separate from chat content
- **Flexible API Configuration** - Easy switching between different AI providers

## Quick Start

### Prerequisites

You'll need an AI API server running before starting SimpleChat JS. This could be:
- **Ollama** running locally (`ollama serve`)
- **OpenAI API** with your API key
- **Any OpenAI-compatible API** (LM Studio, vLLM, etc.)

### Requiremnets not currently installed/included

- Node.js

### Simple setup

Just run start.bat/start.sh.

- All node dependencies will be installed
- Server will start and you can connect to the localhost on port 50505 in a browser

### DIY Installation

1. Clone or download this repository
2. Install dependencies:
   ```bash
   npm install
   ```

3. Start the application:
   
   **Windows:**
   ```cmd
   start.bat
   ```
   
   **Mac/Linux:**
   ```bash
   ./start.sh
   ```
   
   **Or using npm:**
   ```bash
   npm start
   ```

4. Open your browser to `http://localhost:50505`

5. Configure your API settings in the Settings panel:
   - Set your API URL (e.g., `http://localhost:11434/v1` for Ollama)
   - Add your API key if required
   - Select your model

### MCP Setup (Optional)

To enable tool integrations:

1. Click the "MCP Config" button in the interface
2. Configure your MCP servers in the JSON editor
3. Click "Connect MCP Servers"
4. Enable specific tools in the Settings panel

Example MCP configuration:
```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "./"],
      "env": {}
    }
  }
}
```

## Architecture

### Frontend Structure
```
src/js/
├── app/          # Core application logic
├── chat/         # Chat functionality and conductor mode
├── tools/        # Tool handling and MCP integration
├── render/       # Message rendering and streaming
└── ui/           # User interface components
```

### Backend Structure
```
backend/
├── server.js           # Main entry point
├── config/             # Database and configuration
├── routes/             # API endpoints
├── services/           # Business logic
└── utils/              # Shared utilities
```

### Data Flow
1. **Frontend** sends requests to REST API endpoints
2. **Chat Service** processes requests and streams responses
3. **MCP Service** handles tool execution when needed
4. **Tool Events** provide real-time updates via Server-Sent Events
5. **Database** persists chat history and settings

## API Compatibility

SimpleChat JS works with any API that follows OpenAI's chat completions format:

- **Ollama** - Local AI models
- **OpenAI API** - GPT models with API key
- **LM Studio** - Local API server
- **vLLM** - High-performance inference server
- **Anthropic Claude** - Via compatible proxies
- **Custom APIs** - Any service implementing the OpenAI format

## Development

### Making Changes

1. **Frontend Changes** - Edit files in `src/js/`, refresh browser
2. **Backend Changes** - Edit files in `backend/`, restart server
3. **Styling** - Edit `src/css/style.css`, refresh browser

### Adding Features

- **New API Endpoints** - Add to appropriate route file in `backend/routes/`
- **New Services** - Create service files in `backend/services/`
- **Frontend Components** - Add to appropriate directory in `src/js/`

### Debugging

- Enable debug panels in Settings
- Check browser console for frontend logs
- Monitor server terminal for backend logs
- Use the debug data viewer for AI request/response analysis

## Known Limitations

- **Conductor Mode** is experimental and may have rough edges in complex scenarios
- **Tool Execution** timing can vary significantly based on tool complexity
- **Browser Compatibility** focused on modern browsers (Chrome, Firefox, Safari)

## Contributing

SimpleChat JS values clean, readable code over complex frameworks. When contributing:

- Keep the vanilla JavaScript approach
- Maintain clear separation between frontend and backend
- Add appropriate logging for debugging
- Test with multiple AI providers when possible

## License

MIT License - Feel free to use, modify, and distribute as needed.

## Why SimpleChat JS?

In a world of complex frameworks and build tools, SimpleChat JS proves that powerful AI applications can be built with fundamental web technologies. It's designed for developers who want:

- **Direct Control** - No black-box frameworks
- **Easy Customization** - Modify any aspect without fighting abstractions
- **Learning Clarity** - Understand exactly how AI chat applications work
- **Rapid Development** - Change code, refresh browser, see results

SimpleChat JS is a workhorse, not a show pony. It gets the job done efficiently and lets you focus on what matters: building great AI experiences.
