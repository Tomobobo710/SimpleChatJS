# SimpleChatJS

An Electron desktop AI chat application with MCP (Model Context Protocol) support.

![image](https://github.com/user-attachments/assets/da1e06d8-a8d1-4ec4-84de-fb105be1f13c)

## Tech Stack

- **Frontend:** Vanilla JS, HTML, CSS (no frameworks)
- **Backend:** Node.js + Express
- **Desktop:** Electron
- **Database:** SQLite (better-sqlite3)
- **MCP:** @modelcontextprotocol/sdk

## Features

- Multiple persistent chat sessions with SQLite storage
- Real-time streaming responses from AI providers
- Model Context Protocol (MCP) integration for tool execution
- Chat branching and turn-based history
- Multimodal messages (images, documents)
- Debug panels with API request/response inspection
- Settings profiles for different AI providers
- Anthropic thinking mode and Google Gemini thinking support

## Quick Start

### Prerequisites

- Node.js
- An AI API (Ollama, OpenAI, or any OpenAI-compatible endpoint)

### Installation

```bash
npm install
npm run dev
```

### Build

```bash
npm run build
```

## Architecture

```
src/js/
├── app/          # Core logic (message sending, API calls, settings)
├── chat/         # Chat modes and history management
├── tools/        # MCP server management and tool handling
├── render/       # Message rendering and streaming
└── ui/           # Settings, debug panels, context menus

backend/
├── server.js           # Express server (runs inside Electron)
├── config/             # Database initialization
├── routes/             # API endpoints
├── services/           # Chat, MCP, settings, tool events
└── utils/              # Logging
```

## API Compatibility

Works with any OpenAI-compatible API:

- **Ollama** - Local AI models
- **OpenAI API** - GPT models
- **Anthropic** - Claude (via proxy or direct)
- **Google Gemini** - Gemini models
- **LM Studio / vLLM** - Local inference servers

## Development

- Edit files in `src/js/` or `backend/`
- Reload the app (Ctrl+R) for frontend changes
- Restart the app for backend changes
