# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

### Essential Commands
- `npm install` - Install dependencies
- `npm start` - Start the bot application (requires environment variables)
- `npm test` - Run tests using Node.js built-in test runner
- `npm run lint` - Run ESLint with max warnings set to 0
- `npm run lint:fix` - Run ESLint with automatic fixes
- `npm run format` - Format code with Prettier
- `node --check ./app.js` - Syntax validation (used in CI)

### Testing
- Tests are minimal and located in `test/package.test.js`
- Uses Node.js built-in test runner (`node:test`)
- Run individual test files with: `node --test test/package.test.js`

## High-Level Architecture

### Core Components
- **app.js** - Single entrypoint containing all application logic
- **Slack Integration** - Uses Bolt.js framework in socket mode
- **AI Provider Abstraction** - Configurable AI backend (OpenAI ChatGPT or Anthropic Claude)
- **Redis Persistence** - Stores conversation state via Keyv + KeyvRedis
- **Document Knowledge Base** - Redis-based RAG system with automatic import and dual modes:
  - Automatic import from DOCS_PATH on startup (LocalFileDocumentationProcessor)
  - OpenAI embeddings for semantic search (high accuracy)
  - Claude text analysis with keyword matching (no embeddings required)
- **OpenAI Image Generation** - DALL-E integration for `/dalle` slash command (requires OPENAI_API_KEY)

### Startup Flow Architecture
1. Environment validation and configuration logging
2. AI provider initialization (OpenAI/Claude)
3. Redis connection and knowledge base setup
4. Slack app initialization and event handlers
5. **Automatic document import**: If DOCS_PATH is set, LocalFileDocumentationProcessor scans directory and imports all markdown files
6. App starts listening for Slack events

### Message Flow Architecture
1. Messages arrive via Bolt.js socket mode
2. Three handler types process messages:
   - General messages (hubot-style pattern matching)
   - Direct Messages (DM/MPIM) → forwarded to AI provider with automatic context enhancement
   - Direct mentions → help commands or AI provider with context
3. Async image generation for `/dalle` command with immediate ack/response pattern

### Key Architectural Patterns
- **Provider Abstraction**: OpenAIProvider and ClaudeProvider classes implement unified sendMessage(text, userId) interface
- **RAG Integration**: DocumentKnowledgeBase class handles chunking, embedding, storage, and semantic search
- **Automatic Document Import**: LocalFileDocumentationProcessor scans DOCS_PATH and imports on startup
- **Automatic Context Enhancement**: handleMessage function searches knowledge base and injects relevant context
- **Async/Await Pattern**: Heavy operations (image generation, embeddings, document import) use setTimeout workers after immediate acknowledgment
- **Conversation Context**: Different strategies per provider - ChatGPT uses parentMessageId, Claude uses message arrays
- **Progressive UX**: "Thinking" messages posted while processing, then cleared
- **Graceful Degradation**: Multiple upload fallback methods (uploadV2 → upload → postMessage)

### Environment Configuration
- **Required Base**: SLACK_BOT_TOKEN, SLACK_APP_TOKEN, SLACK_BOT_USER_NAME
- **AI Provider**: AI_PROVIDER ("openai" or "claude", defaults to "openai")
- **Required AI Keys**: OPENAI_API_KEY (for ChatGPT) OR ANTHROPIC_API_KEY (for Claude)
- **Document Import**: DOCS_PATH (path to documentation directory for auto-import)
- **Optional**: DOCS_MAX_FILES (default: 500), BOT_PERSONALITY, THINKING_MESSAGE, REDIS_URL, MEMORY_TTL_HOURS, MEMORY_MAX_KEYS
- Validates required env vars on startup with fail-fast behavior based on selected AI provider
- Logs configuration including AI provider and document auto-import path

### Slack App Configuration
- **manifest.yaml** / **manifest-openai.yaml** - For OpenAI ChatGPT setup (includes /dalle command)
- **manifest-claude.yaml** - For Claude AI setup (no image generation commands)
- Choose the appropriate manifest when creating your Slack app based on your AI_PROVIDER setting

### Extension Points
- **Message Handlers**: Add new `app.message()` patterns in the general handler
- **Slash Commands**: Add new `app.command()` handlers 
  - OpenAI: /dalle, /docs-search, /docs-reload, /help
  - Claude: /docs-search, /docs-reload, /help
- **AI Providers**: Add new provider classes implementing sendMessage(text, userId) interface
- **Knowledge Base**: Modify DocumentKnowledgeBase class for different embedding models or vector stores
- **Document Processing**: Extend LocalFileDocumentationProcessor class for new file formats or processing logic
- **Search Algorithm**: Customize similarity thresholds or ranking algorithms
- **Image Processing**: Extend `generateImage()` function for different providers
- **Persistence**: Configure Keyv store options and TTL settings

### Error Handling Strategy
- Console-based logging throughout (consider structured logging for production)
- Graceful shutdown handlers for SIGINT/SIGTERM
- User-friendly error messages with Star Trek theming
- Multiple fallback mechanisms for file uploads

### Development Notes
- Single-file architecture keeps complexity low
- Socket mode eliminates need for webhook endpoints
- Redis connection managed by KeyvRedis with configurable TTL
- Document embeddings use OpenAI's `text-embedding-3-small` model (cost-effective)
- Vector similarity search uses cosine similarity with 0.7 threshold
- OpenAI mode: Documents chunked to 512 tokens for optimal embedding performance
- Claude mode: Documents chunked to 2000 tokens to leverage Claude's larger context window
- Knowledge base supports two modes:
  - OpenAI mode: Requires OPENAI_API_KEY for embeddings (most accurate)
  - Claude mode: Requires only ANTHROPIC_API_KEY, uses keyword + Claude ranking
- Automatic local file import from DOCS_PATH environment variable
- Supports processing hundreds of local markdown files on startup
- No manual commands needed - documents auto-imported and contextually enhanced
- CI pipeline runs lint, test, and syntax check on pushes/PRs