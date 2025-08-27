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
- **OpenAI Image Generation** - DALL-E integration for `/dalle` slash command (requires OPENAI_API_KEY)

### Message Flow Architecture
1. Messages arrive via Bolt.js socket mode
2. Three handler types process messages:
   - General messages (hubot-style pattern matching)
   - Direct Messages (DM/MPIM) → forwarded to ChatGPT
   - Direct mentions → help commands or ChatGPT
3. Async image generation for `/dalle` command with immediate ack/response pattern

### Key Architectural Patterns
- **Provider Abstraction**: OpenAIProvider and ClaudeProvider classes implement unified sendMessage(text, userId) interface
- **Async/Await Pattern**: Heavy operations (image generation) use setTimeout workers after immediate acknowledgment
- **Conversation Context**: Different strategies per provider - ChatGPT uses parentMessageId, Claude uses message arrays
- **Progressive UX**: "Thinking" messages posted while processing, then cleared
- **Graceful Degradation**: Multiple upload fallback methods (uploadV2 → upload → postMessage)

### Environment Configuration
- **Required Base**: SLACK_BOT_TOKEN, SLACK_APP_TOKEN, SLACK_BOT_USER_NAME
- **AI Provider**: AI_PROVIDER ("openai" or "claude", defaults to "openai")
- **Required AI Keys**: OPENAI_API_KEY (for ChatGPT) OR ANTHROPIC_API_KEY (for Claude)
- **Optional**: BOT_PERSONALITY, THINKING_MESSAGE, REDIS_URL, MEMORY_TTL_HOURS, MEMORY_MAX_KEYS
- Validates required env vars on startup with fail-fast behavior based on selected AI provider

### Extension Points
- **Message Handlers**: Add new `app.message()` patterns in the general handler
- **Slash Commands**: Add new `app.command()` handlers
- **AI Providers**: Add new provider classes implementing sendMessage(text, userId) interface
- **Conversation Logic**: Modify provider classes for different conversation handling strategies
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
- CI pipeline runs lint, test, and syntax check on pushes/PRs