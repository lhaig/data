# Data - a Bolt-JS Slack Chatbot

![Lt. Commander Data and his cat, Spot](data_and_spot.png)

## Overview

This is an AI-powered Slack chatbot built on the Bolt JS framework with **intelligent document knowledge capabilities**. The bot supports both **OpenAI ChatGPT** (default) and **Anthropic Claude** as AI providers, plus a **Redis-based document storage system** that can instantly ingest your local markdown documentation. The bot automatically enhances conversations with relevant context from your documentation, making it perfect for teams with extensive technical docs.

## Prerequisites

You will need a local Redis installation to persist the bot's conversation memory. You can install Redis server on Ubuntu like this:

```zsh
sudo apt -y install redis-server
```

## Installation

### 0. Create a new Slack App

- Go to https://api.slack.com/apps
- Click **Create App**
- Choose a workspace
- **Choose the appropriate manifest file:**
  - `manifest.yaml` or `manifest-openai.yaml` - If using OpenAI ChatGPT (includes /dalle command)
  - `manifest-claude.yaml` - If using Claude AI (no image generation)
- Copy the manifest contents into the input box
- Update the name and display name settings
- Click **Create**

Once the app is created click **Install to Workspace**
Then scroll down in Basic Info and click **Generate Token and Scopes** with all three scopes enabled.

### 1. Setup environment variables

**🎯 Primary Feature**: The bot automatically imports your local markdown documentation on startup and provides contextual assistance in all conversations.

**Two Knowledge Base Modes:**
- **OpenAI Mode**: Vector embeddings for semantic search (most accurate)
- **Claude Mode**: Text analysis + AI ranking (no embeddings needed, Claude API only)

**🚀 Automatic Document Import**: Set `DOCS_PATH` to your documentation directory and documents are automatically loaded on bot startup - no manual commands needed!

#### For Linux/Mac

```zsh
# Replace with your bot and tokens
export SLACK_BOT_TOKEN=<your-bot-token> # from the OAuth section
export SLACK_APP_TOKEN=<your-app-level-token> # from the Basic Info App Token Section
export SLACK_BOT_USER_NAME=<your-bot-username> # must match the short name of your bot user

# AI Provider Configuration (choose one)
export AI_PROVIDER="openai" # Use "openai" for ChatGPT or "claude" for Claude

# For OpenAI ChatGPT (default)
export OPENAI_API_KEY=<your-openai-api-key> # get from here: https://platform.openai.com/account/api-keys

# For Claude AI (alternative)
export ANTHROPIC_API_KEY=<your-anthropic-api-key> # get from here: https://console.anthropic.com/

# Document auto-import (RECOMMENDED)
export DOCS_PATH="/path/to/your/docs" # Auto-import documents on startup
export DOCS_MAX_FILES="500" # Optional: Limit number of files to import (default: 500)

# Optional customization
export BOT_PERSONALITY="Your custom bot personality prompt here" # Optional: Set a custom personality for your bot
export THINKING_MESSAGE=":gear: _Processing your request..._" # Optional: Customize the thinking indicator message
```

#### For Windows PowerShell

```powershell
# Replace with your bot and tokens
$env:SLACK_BOT_TOKEN = "xoxb-your-bot-token"
$env:SLACK_APP_TOKEN = "xapp-your-app-token"
$env:SLACK_BOT_USER_NAME = "Data" # Change to match your bot's name

# AI Provider Configuration (choose one)
$env:AI_PROVIDER = "openai" # Use "openai" for ChatGPT or "claude" for Claude

# For OpenAI ChatGPT (default)
$env:OPENAI_API_KEY = "your-openai-api-key"

# For Claude AI (alternative)
$env:ANTHROPIC_API_KEY = "your-anthropic-api-key"

# Document auto-import (RECOMMENDED)
$env:DOCS_PATH = "C:\path\to\your\docs" # Auto-import documents on startup
$env:DOCS_MAX_FILES = "500" # Optional: Limit number of files to import (default: 500)

# Optional customization
$env:BOT_PERSONALITY = "Your custom bot personality prompt here" # Optional: Set a custom personality for your bot
$env:THINKING_MESSAGE = ":gear: _Processing your request..._" # Optional: Customize the thinking indicator message

# Optional: Set Redis URL if you're using a custom Redis instance
# $env:REDIS_URL = "redis://localhost:6379"

# Start the bot
npm start
```

### 2. Setup your local project

```zsh
# Clone this project onto your machine
git clone https://github.com/scarolan/data.git
```

The bot's personality is now configurable via the BOT_PERSONALITY environment variable. You can set this in your script or directly in your environment:

```zsh
# Example of customizing the bot's personality
export BOT_PERSONALITY="You are a helpful assistant with a cheerful disposition. You love to tell jokes and answer questions clearly and concisely."
```

If you don't set the BOT_PERSONALITY variable, the bot will use a default Star Trek "Data" personality.

```zsh
# Change into the project
cd data

# Install the dependencies
npm install
```

### 3. Start the chatbot application

```zsh
npm run start
```

### 4. Test

Go to the installed workspace and type **help** in a DM to your new bot.
Use the slash commands for various functionality:

Direct mention example (in a channel or DM):

```text
@Data help
```

Slash command examples:

```text
# Image generation
/dalle An image of Lt. Commander Data and his cat

# Knowledge base management
/docs-search how do I configure SSO
/docs-reload

# That's it! Documents are automatically imported from DOCS_PATH on startup
# No manual ingestion needed - just chat naturally and get contextual responses
```

### 5. Deploy to production

You'll need a Linux server, container, or application platform that supports nodejs to keep the bot running. Slack has a tutorial for getting an app running on the Glitch platform: https://api.slack.com/tutorials/hello-world-bolt

## Image Generation and Troubleshooting

The bot supports generating images with DALL-E through the `/dalle` slash command.

Note: The older direct `@Data image ...` handler was removed to simplify the codebase. Please use `/dalle` for image generation.

### How Image Generation Works

When using the `/dalle` slash command:

1. The bot acknowledges your request and shows a "generating" message
2. Image generation happens asynchronously in the background
3. When complete, the image is posted directly to the channel

## Environment Variables

| Variable            | Required | Description                                        |
| ------------------- | -------- | -------------------------------------------------- |
| SLACK_BOT_TOKEN     | Yes      | Your Slack bot token from OAuth section            |
| SLACK_APP_TOKEN     | Yes      | Your Slack app-level token                         |
| SLACK_BOT_USER_NAME | Yes      | Must match the short name of your bot user         |
| AI_PROVIDER         | No       | AI provider to use: "openai" (default) or "claude" |
| OPENAI_API_KEY      | *        | Your OpenAI API key (required if AI_PROVIDER=openai) |
| ANTHROPIC_API_KEY   | *        | Your Anthropic API key (required if AI_PROVIDER=claude) |
| DOCS_PATH           | No       | Path to your documentation directory for auto-import |
| DOCS_MAX_FILES      | No       | Maximum files to import (default: 500)            |
| BOT_PERSONALITY     | No       | Custom personality prompt for your bot             |
| THINKING_MESSAGE    | No       | Custom thinking indicator message                  |
| REDIS_URL           | No       | Custom Redis URL (default: redis://localhost:6379) |

**Notes:**
- Either OPENAI_API_KEY or ANTHROPIC_API_KEY is required depending on your AI_PROVIDER setting
- **Knowledge Base Modes:**
  - **OpenAI Mode**: Vector embeddings + semantic search (most accurate, requires OPENAI_API_KEY)
  - **Claude Mode**: Keyword matching + Claude AI ranking (no embeddings, requires ANTHROPIC_API_KEY only)
  - **Both work perfectly with local markdown files**

## 📁 Automatic Document Import (Primary Feature)

The bot's **main strength** is automatically importing your local markdown documentation on startup:

### 🚀 Quick Start
```bash
# Set environment variable
export DOCS_PATH="/path/to/your/docs"

# Start the bot - documents are automatically imported!
npm start

# Reload documents if you update them
/docs-reload
```

### ✨ Why Automatic Import Is Better
- **Zero Manual Work** - Set DOCS_PATH once, documents always stay current
- **Instant Processing** - No rate limiting, process hundreds of files in minutes
- **Perfect Content** - Clean markdown without HTML parsing issues  
- **Complete Control** - Use your exact documentation version
- **Works Offline** - No network dependencies
- **Better Structure** - Preserves headings, code blocks, frontmatter
- **Supports Both AI Modes** - OpenAI embeddings OR Claude text analysis
- **Always Current** - Use `/docs-reload` to refresh when docs change

### 📂 Supported File Types
- `.md` (Markdown) 
- `.markdown` (Markdown)
- `.txt` (Plain text)

### 🔄 Document Management
- **DOCS_PATH** - Set this environment variable to your documentation directory
- **DOCS_MAX_FILES** - Optionally limit the number of files imported (default: 500)
- **Auto-import** - Documents loaded automatically on bot startup
- **Manual refresh** - Use `/docs-reload` command to refresh when docs change

### Automatic Context Enhancement
When you ask questions in regular chat, the bot automatically:
1. Searches the knowledge base for relevant information
2. Includes context in the AI response
3. Provides source citations

**Examples:**

*With OpenAI (embeddings):*
```
User: "How do I set up SSO?"
Bot: "To configure SAML authentication, navigate to Settings > Identity Providers...

📚 Sources:
1. Authentication Guide (similarity: 94%)
2. SAML Configuration Tutorial (similarity: 87%)
```

*With Claude (text analysis):*
```
User: "How do I configure database access?"
Bot: "To configure database access, you'll need to create a gateway...

📚 Sources:
1. Database Connection Guide (relevance: 8)
2. Gateway Configuration (relevance: 6)
```
