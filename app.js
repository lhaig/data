///////////////////////////////////////////////////////////////
// A bolt.js Slack chatbot augmented with OpenAI ChatGPT
// Requires a running Redis instance to persist the bot's memory
//
// Make sure you export the required environment variables:
// SLACK_BOT_TOKEN - under the OAuth Permissions page on api.slack.com
// SLACK_APP_TOKEN - under your app's Basic Information page on api.slack.com
// SLACK_BOT_USER_NAME - must match the short name of your bot user
// OPENAI_API_KEY - get from here: https://platform.openai.com/account/api-keys
// BOT_PERSONALITY - (optional) customize the bot's character and behavior
//                   if not set, a default Star Trek Data personality is used
// THINKING_MESSAGE - (optional) customize the "thinking" message shown while processing
//                   if not set, a default Star Trek Data themed message is used
//
// Note: The /dalle slash command uses an asynchronous approach to handle
// Slack timeout limitations, generating the image in the background and
// posting directly to the channel when complete.
///////////////////////////////////////////////////////////////

// Get AI provider from environment variable or use default
const aiProvider = process.env.AI_PROVIDER || 'openai';

// Get bot personality from environment variable or use default
const defaultPersonality = `You are a Soong type Android named ${process.env.SLACK_BOT_USER_NAME}. You are a member of the crew of the USS Enterprise. You are a member of the science division. You respond to all inquiries in character as if you were Lieutenant Commander Data from Star Trek: The Next Generation.`;
const personalityPrompt = process.env.BOT_PERSONALITY || defaultPersonality;

// Get thinking message from environment variable or use default
const defaultThinkingMessage = ':brain: _Accessing neural network pathways... Processing query..._';
const thinkingMessage = process.env.THINKING_MESSAGE || defaultThinkingMessage;

// Validate required environment variables early to fail fast
function validateRequiredEnv() {
  const baseRequired = ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'SLACK_BOT_USER_NAME'];
  const aiProvider = process.env.AI_PROVIDER || 'openai';

  // Add AI provider specific requirements
  const aiRequired = aiProvider === 'claude' ? ['ANTHROPIC_API_KEY'] : ['OPENAI_API_KEY'];

  const required = [...baseRequired, ...aiRequired];
  const missing = required.filter((k) => !process.env[k]);

  if (missing.length) {
    console.error(
      `Missing required environment variables for AI_PROVIDER='${aiProvider}':`,
      missing.join(', ')
    );
    console.error('Please set them and restart the process.');
    process.exit(1);
  }

  // Log configuration
  console.log(`🤖 AI Provider: ${aiProvider}`);
  if (process.env.DOCS_PATH) {
    console.log(`📁 Auto-import docs from: ${process.env.DOCS_PATH}`);
  }
}
validateRequiredEnv();

// Import required libraries
import pkg from '@slack/bolt';
const { App } = pkg;
import { directMention } from '@slack/bolt';
import { ChatGPTAPI } from 'chatgpt';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import Keyv from 'keyv';
import KeyvRedis from '@keyv/redis';
import { createClient } from 'redis';
import fetch from 'node-fetch';
import fs from 'fs/promises';
import path from 'path';
import matter from 'gray-matter';
//Uncomment this and the logLevel below to enable DEBUG
//import { LogLevel } from '@slack/bolt';

// Creates new connection to Slack
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
  //logLevel: LogLevel.DEBUG,
});

// Graceful shutdown handlers
async function shutdown(signal) {
  console.log(`Received ${signal}, stopping app...`);
  try {
    await app.stop();
    console.log('App stopped.');
  } catch (err) {
    console.error('Error while stopping app:', err && err.message ? err.message : err);
  }
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err && err.stack ? err.stack : err);
  shutdown('uncaughtException');
});

// Create a redis namespace for the bot's memory
const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

// Allow TTL and MAX keys to be configured via environment variables
// MEMORY_TTL_HOURS - how long (in hours) keys should live in Redis (default 24)
// MEMORY_MAX_KEYS - advisory maximum number of keys we expect to store (default 10000)
const memoryTtlHours = parseInt(process.env.MEMORY_TTL_HOURS || '24', 10);
const memoryMaxKeys = parseInt(process.env.MEMORY_MAX_KEYS || '10000', 10);
const memoryTtlSeconds = Math.max(60, memoryTtlHours * 60 * 60);

const store = new KeyvRedis(redisUrl, {
  namespace: 'chatgpt-slackbot',
  // KeyvRedis accepts a ttl value in seconds in this codebase; keep using 'ttl' for compatibility
  ttl: memoryTtlSeconds,
  // Max is advisory; KeyvRedis may expose it to its internal cache implementation
  max: memoryMaxKeys,
});
const messageStore = new Keyv({ store, namespace: 'chatgpt-slackbot' });

console.log(
  `Keyv/Redis configured: REDIS_URL=${redisUrl}, MEMORY_TTL_HOURS=${memoryTtlHours}, MEMORY_MAX_KEYS=${memoryMaxKeys}`
);

// Initialize Redis client for document storage and vector search
const redisClient = createClient({
  url: redisUrl,
});

redisClient.on('error', (err) => console.error('Redis Client Error:', err));
redisClient.on('connect', () => console.log('Redis Client Connected for document storage'));

// Connect to Redis
try {
  await redisClient.connect();
  console.log('Redis connected successfully for document operations');
} catch (error) {
  console.error('Failed to connect to Redis:', error);
}

// AI Provider abstraction classes
class OpenAIProvider {
  constructor(apiKey, systemMessage, messageStore) {
    this.api = new ChatGPTAPI({
      apiKey,
      messageStore,
      systemMessage,
      completionParams: {
        model: 'gpt-4o',
      },
    });
    this.conversationMap = new Map(); // Maps userId to parentMessageId
  }

  async sendMessage(text, userId) {
    let response;
    if (!this.conversationMap.has(userId)) {
      response = await this.api.sendMessage(text);
    } else {
      const parentId = this.conversationMap.get(userId);
      response = await this.api.sendMessage(text, { parentMessageId: parentId });
    }
    this.conversationMap.set(userId, response.id);
    return response.text;
  }
}

class ClaudeProvider {
  constructor(apiKey, systemMessage, messageStore) {
    this.api = new Anthropic({ apiKey });
    this.systemMessage = systemMessage;
    this.messageStore = messageStore;
    this.conversationMap = new Map(); // Maps userId to conversation history
  }

  async sendMessage(text, userId) {
    // Get or create conversation history for this user
    let messages = this.conversationMap.get(userId) || [];

    // Add the new user message
    messages.push({ role: 'user', content: text });

    // Keep conversation history manageable (last 10 exchanges = 20 messages)
    if (messages.length > 20) {
      messages = messages.slice(-20);
    }

    const response = await this.api.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 1024,
      system: this.systemMessage,
      messages: messages,
    });

    const responseText = response.content[0].text;

    // Add assistant's response to conversation history
    messages.push({ role: 'assistant', content: responseText });
    this.conversationMap.set(userId, messages);

    // Also store in Redis for persistence (simplified key-value)
    const conversationKey = `claude-conversation-${userId}`;
    await this.messageStore.set(conversationKey, JSON.stringify(messages));

    return responseText;
  }
}

// Initialize the AI provider based on configuration
let ai_api;
if (aiProvider === 'claude') {
  console.log('Initializing Claude AI provider...');
  ai_api = new ClaudeProvider(process.env.ANTHROPIC_API_KEY, personalityPrompt, messageStore);
} else {
  console.log('Initializing OpenAI ChatGPT provider...');
  ai_api = new OpenAIProvider(process.env.OPENAI_API_KEY, personalityPrompt, messageStore);
}

console.log(`AI Provider: ${aiProvider.toUpperCase()}`);

// Document Knowledge Base System using Redis
class DocumentKnowledgeBase {
  constructor(redisClient, openaiClient) {
    this.redis = redisClient;
    this.openai = openaiClient;
    this.embeddingModel = 'text-embedding-3-small'; // Cost-effective option
    this.chunkSize = 512; // Optimal chunk size per research
  }

  // Chunk text into smaller pieces for better embeddings
  chunkText(text, chunkSize = this.chunkSize) {
    const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
    const chunks = [];
    let currentChunk = '';

    for (const sentence of sentences) {
      if ((currentChunk + sentence).length > chunkSize && currentChunk) {
        chunks.push(currentChunk.trim());
        currentChunk = sentence;
      } else {
        currentChunk += sentence;
      }
    }

    if (currentChunk.trim()) {
      chunks.push(currentChunk.trim());
    }

    return chunks;
  }

  // Generate embeddings for text using OpenAI
  async generateEmbedding(text) {
    if (!this.openai) {
      throw new Error('OpenAI client required for embeddings. Set OPENAI_API_KEY.');
    }

    try {
      const response = await this.openai.embeddings.create({
        model: this.embeddingModel,
        input: text,
      });
      return response.data[0].embedding;
    } catch (error) {
      console.error('Error generating embedding:', error);
      throw error;
    }
  }

  // Store document in Redis with embeddings
  async storeDocument(docId, title, content, metadata = {}) {
    try {
      console.log(`Storing document: ${title}`);
      const chunks = this.chunkText(content);
      const chunkPromises = [];

      for (let i = 0; i < chunks.length; i++) {
        const chunkId = `${docId}:chunk:${i}`;
        const chunk = chunks[i];

        // Generate embedding for this chunk
        const embedding = await this.generateEmbedding(chunk);

        // Store chunk text
        chunkPromises.push(
          this.redis.hSet(`documents:chunks:${chunkId}`, {
            id: chunkId,
            docId,
            title,
            content: chunk,
            chunkIndex: i,
            ...metadata,
          })
        );

        // Store embedding (Redis doesn't support arrays directly, so we stringify)
        chunkPromises.push(
          this.redis.set(`documents:embeddings:${chunkId}`, JSON.stringify(embedding))
        );
      }

      await Promise.all(chunkPromises);

      // Store document metadata
      await this.redis.hSet(`documents:metadata:${docId}`, {
        id: docId,
        title,
        chunkCount: chunks.length,
        createdAt: new Date().toISOString(),
        ...metadata,
      });

      console.log(`Successfully stored document "${title}" with ${chunks.length} chunks`);
      return { docId, chunkCount: chunks.length };
    } catch (error) {
      console.error('Error storing document:', error);
      throw error;
    }
  }

  // Calculate cosine similarity between vectors
  cosineSimilarity(vecA, vecB) {
    const dotProduct = vecA.reduce((sum, a, i) => sum + a * vecB[i], 0);
    const normA = Math.sqrt(vecA.reduce((sum, a) => sum + a * a, 0));
    const normB = Math.sqrt(vecB.reduce((sum, b) => sum + b * b, 0));
    return dotProduct / (normA * normB);
  }

  // Search documents by semantic similarity
  async searchDocuments(query, limit = 5, threshold = 0.7) {
    try {
      console.log(`Searching documents for: "${query}"`);

      // Generate embedding for the query
      const queryEmbedding = await this.generateEmbedding(query);

      // Get all document chunk embeddings
      const embeddingKeys = await this.redis.keys('documents:embeddings:*');
      const similarities = [];

      for (const key of embeddingKeys) {
        const embeddingJson = await this.redis.get(key);
        if (!embeddingJson) continue;

        const embedding = JSON.parse(embeddingJson);
        const similarity = this.cosineSimilarity(queryEmbedding, embedding);

        if (similarity >= threshold) {
          const chunkId = key.replace('documents:embeddings:', '');
          similarities.push({
            chunkId,
            similarity,
          });
        }
      }

      // Sort by similarity (highest first) and limit results
      similarities.sort((a, b) => b.similarity - a.similarity);
      const topResults = similarities.slice(0, limit);

      // Fetch the actual chunk content
      const results = [];
      for (const result of topResults) {
        const chunkData = await this.redis.hGetAll(`documents:chunks:${result.chunkId}`);
        if (chunkData && chunkData.content) {
          results.push({
            ...chunkData,
            similarity: result.similarity,
          });
        }
      }

      console.log(`Found ${results.length} relevant document chunks`);
      return results;
    } catch (error) {
      console.error('Error searching documents:', error);
      throw error;
    }
  }

  // Get all stored documents
  async listDocuments() {
    try {
      const metadataKeys = await this.redis.keys('documents:metadata:*');
      const documents = [];

      for (const key of metadataKeys) {
        const metadata = await this.redis.hGetAll(key);
        if (metadata && metadata.id) {
          documents.push(metadata);
        }
      }

      return documents;
    } catch (error) {
      console.error('Error listing documents:', error);
      throw error;
    }
  }
}

// Claude-based Document Knowledge Base (no embeddings required)
class ClaudeDocumentKnowledgeBase {
  constructor(redisClient, anthropicClient) {
    this.redis = redisClient;
    this.anthropic = anthropicClient;
    this.chunkSize = 2000; // Larger chunks since we don't need embedding limits
  }

  // Store document in Redis with full-text indexing
  async storeDocument(docId, title, content, metadata = {}) {
    try {
      console.log(`Storing document (Claude mode): ${title}`);
      const chunks = this.chunkText(content);
      const chunkPromises = [];

      for (let i = 0; i < chunks.length; i++) {
        const chunkId = `${docId}:chunk:${i}`;
        const chunk = chunks[i];

        // Store chunk text with searchable keywords
        const keywords = this.extractKeywords(chunk);
        chunkPromises.push(
          this.redis.hSet(`claude-documents:chunks:${chunkId}`, {
            id: chunkId,
            docId,
            title,
            content: chunk,
            keywords: keywords.join(' '),
            chunkIndex: i,
            ...metadata,
          })
        );
      }

      await Promise.all(chunkPromises);

      // Store document metadata
      await this.redis.hSet(`claude-documents:metadata:${docId}`, {
        id: docId,
        title,
        chunkCount: chunks.length,
        createdAt: new Date().toISOString(),
        ...metadata,
      });

      // Store searchable index
      const allKeywords = this.extractKeywords(content);
      await this.redis.set(`claude-documents:keywords:${docId}`, JSON.stringify(allKeywords));

      console.log(
        `Successfully stored document "${title}" with ${chunks.length} chunks (Claude mode)`
      );
      return { docId, chunkCount: chunks.length };
    } catch (error) {
      console.error('Error storing document (Claude mode):', error);
      throw error;
    }
  }

  // Extract keywords for text-based search
  extractKeywords(text) {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((word) => word.length > 3)
      .filter(
        (word) =>
          ![
            'this',
            'that',
            'with',
            'from',
            'they',
            'have',
            'been',
            'will',
            'your',
            'more',
          ].includes(word)
      )
      .slice(0, 50); // Top 50 keywords per document
  }

  // Chunk text into larger pieces (Claude can handle more context)
  chunkText(text, chunkSize = this.chunkSize) {
    const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
    const chunks = [];
    let currentChunk = '';

    for (const sentence of sentences) {
      if ((currentChunk + sentence).length > chunkSize && currentChunk) {
        chunks.push(currentChunk.trim());
        currentChunk = sentence;
      } else {
        currentChunk += sentence;
      }
    }

    if (currentChunk.trim()) {
      chunks.push(currentChunk.trim());
    }

    return chunks;
  }

  // Search documents using keyword matching and Claude analysis
  async searchDocuments(query, limit = 5) {
    try {
      console.log(`Searching documents (Claude mode) for: "${query}"`);

      const queryKeywords = this.extractKeywords(query);
      const documentKeys = await this.redis.keys('claude-documents:keywords:*');
      const scored = [];

      // Score documents by keyword overlap
      for (const key of documentKeys) {
        const keywordsJson = await this.redis.get(key);
        if (!keywordsJson) continue;

        const docKeywords = JSON.parse(keywordsJson);
        const overlap = queryKeywords.filter((kw) => docKeywords.includes(kw)).length;

        if (overlap > 0) {
          const docId = key.replace('claude-documents:keywords:', '');
          scored.push({ docId, score: overlap });
        }
      }

      // Sort by relevance and get top results
      scored.sort((a, b) => b.score - a.score);
      const topDocIds = scored.slice(0, limit * 2).map((s) => s.docId); // Get extra for Claude filtering

      // Fetch actual chunks
      const results = [];
      for (const docId of topDocIds) {
        const chunkKeys = await this.redis.keys(`claude-documents:chunks:${docId}:chunk:*`);
        for (const chunkKey of chunkKeys.slice(0, 2)) {
          // Max 2 chunks per doc
          const chunkData = await this.redis.hGetAll(chunkKey);
          if (chunkData && chunkData.content) {
            results.push({
              ...chunkData,
              relevanceScore: scored.find((s) => s.docId === docId)?.score || 0,
            });
          }
        }
      }

      // If we have Claude available, use it to rank/filter results
      if (this.anthropic && results.length > 0) {
        try {
          const contextualResults = await this.rankWithClaude(query, results.slice(0, 10));
          console.log(`Found ${contextualResults.length} relevant document chunks (Claude-ranked)`);
          return contextualResults;
        } catch (error) {
          console.warn('Claude ranking failed, falling back to keyword ranking:', error.message);
        }
      }

      console.log(
        `Found ${results.slice(0, limit).length} relevant document chunks (keyword-based)`
      );
      return results.slice(0, limit);
    } catch (error) {
      console.error('Error searching documents (Claude mode):', error);
      throw error;
    }
  }

  // Use Claude to rank and filter search results
  async rankWithClaude(query, chunks) {
    const chunksContext = chunks
      .map(
        (chunk, i) => `[${i}] Title: ${chunk.title}\nContent: ${chunk.content.substring(0, 500)}...`
      )
      .join('\n\n');

    const response = await this.anthropic.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 500,
      system:
        'You are a document relevance analyzer. Given a user query and document chunks, return a JSON array with the indices of the most relevant chunks in order of relevance. Only include chunks that are actually relevant to the query.',
      messages: [
        {
          role: 'user',
          content: `Query: "${query}"\n\nDocument chunks:\n${chunksContext}\n\nReturn only a JSON array of indices (e.g., [2, 0, 5]) for the most relevant chunks, ordered by relevance. Maximum 5 chunks.`,
        },
      ],
    });

    try {
      const indices = JSON.parse(response.content[0].text.trim());
      return indices.map((i) => chunks[i]).filter(Boolean);
    } catch (parseError) {
      console.warn('Could not parse Claude ranking response, using all chunks');
      return chunks.slice(0, 5);
    }
  }

  // Get all stored documents
  async listDocuments() {
    try {
      const metadataKeys = await this.redis.keys('claude-documents:metadata:*');
      const documents = [];

      for (const key of metadataKeys) {
        const metadata = await this.redis.hGetAll(key);
        if (metadata && metadata.id) {
          documents.push(metadata);
        }
      }

      return documents;
    } catch (error) {
      console.error('Error listing documents (Claude mode):', error);
      throw error;
    }
  }
}

// Initialize knowledge base based on available providers
let knowledgeBase = null;
if (openaiClient) {
  knowledgeBase = new DocumentKnowledgeBase(redisClient, openaiClient);
  console.log('Document Knowledge Base initialized with OpenAI embeddings');
} else if (aiProvider === 'claude' && ai_api instanceof ClaudeProvider) {
  // For Claude-only setup, use the Claude document system
  knowledgeBase = new ClaudeDocumentKnowledgeBase(redisClient, ai_api.api);
  console.log('Document Knowledge Base initialized with Claude text analysis (no embeddings)');
} else {
  console.log(
    'Document Knowledge Base disabled - requires OpenAI API key (embeddings) or Claude API key'
  );
}

// Web Documentation Scraper for automatic ingestion
// WebDocumentationScraper class removed - using automatic import from DOCS_PATH instead

// Web scraper removed - using automatic import from DOCS_PATH instead

// Local File Documentation Processor
class LocalFileDocumentationProcessor {
  constructor(knowledgeBase) {
    this.knowledgeBase = knowledgeBase;
    this.supportedExtensions = ['.md', '.markdown', '.txt'];
  }

  // Recursively scan directory for markdown files
  async scanDirectory(dirPath, options = {}) {
    const { maxDepth = 10, currentDepth = 0, exclude = [] } = options;

    if (currentDepth >= maxDepth) {
      console.warn(`Maximum directory depth (${maxDepth}) reached for ${dirPath}`);
      return [];
    }

    const files = [];

    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);

        // Skip excluded directories/files
        if (exclude.some((pattern) => entry.name.includes(pattern))) {
          console.log(`Skipping excluded: ${entry.name}`);
          continue;
        }

        if (entry.isDirectory()) {
          // Skip common directories that don't contain docs
          const skipDirs = ['node_modules', '.git', '.github', 'dist', 'build', 'coverage'];
          if (skipDirs.includes(entry.name)) {
            continue;
          }

          // Recursively scan subdirectories
          const subFiles = await this.scanDirectory(fullPath, {
            maxDepth,
            currentDepth: currentDepth + 1,
            exclude,
          });
          files.push(...subFiles);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (this.supportedExtensions.includes(ext)) {
            files.push({
              path: fullPath,
              name: entry.name,
              relativePath: path.relative(dirPath, fullPath),
              extension: ext,
            });
          }
        }
      }
    } catch (error) {
      console.error(`Error scanning directory ${dirPath}:`, error.message);
    }

    return files;
  }

  // Parse markdown file with frontmatter
  async parseMarkdownFile(filePath) {
    try {
      const fileContent = await fs.readFile(filePath, 'utf-8');
      const parsed = matter(fileContent);

      // Extract title from frontmatter, filename, or first heading
      let title =
        parsed.data.title || parsed.data.name || path.basename(filePath, path.extname(filePath));

      // Try to get title from first heading if not in frontmatter
      if (!parsed.data.title) {
        const firstHeading = parsed.content.match(/^#\s+(.+)$/m);
        if (firstHeading) {
          title = firstHeading[1].trim();
        }
      }

      // Clean the content - remove excessive whitespace but preserve structure
      const cleanContent = parsed.content
        .replace(/\r\n/g, '\n') // Normalize line endings
        .replace(/\n{3,}/g, '\n\n') // Reduce multiple empty lines
        .replace(/^\s+|\s+$/gm, '') // Trim each line
        .trim();

      return {
        title,
        content: cleanContent,
        frontmatter: parsed.data,
        wordCount: cleanContent.split(/\s+/).length,
        lineCount: cleanContent.split('\n').length,
      };
    } catch (error) {
      console.error(`Error parsing file ${filePath}:`, error.message);
      return null;
    }
  }

  // Batch ingest all markdown files from a directory
  async ingestDirectory(dirPath, options = {}) {
    const {
      maxFiles = 500,
      exclude = ['README.md', 'CHANGELOG.md', 'LICENSE.md'],
      dryRun = false,
    } = options;

    try {
      // Check if directory exists
      try {
        await fs.access(dirPath);
      } catch {
        throw new Error(`Directory not found: ${dirPath}`);
      }

      console.log(`Scanning directory: ${dirPath}`);
      const files = await this.scanDirectory(dirPath, { exclude });

      console.log(`Found ${files.length} markdown files`);

      if (files.length === 0) {
        return {
          successful: 0,
          failed: 0,
          errors: ['No markdown files found in directory'],
        };
      }

      const filesToProcess = files.slice(0, maxFiles);

      if (dryRun) {
        return {
          files: filesToProcess,
          message: `Would process ${filesToProcess.length} files (dry run)`,
        };
      }

      console.log(`Processing ${filesToProcess.length} files...`);

      const results = {
        successful: 0,
        failed: 0,
        errors: [],
      };

      for (let i = 0; i < filesToProcess.length; i++) {
        const file = filesToProcess[i];

        try {
          const parsed = await this.parseMarkdownFile(file.path);

          if (parsed && parsed.content.length > 50) {
            // Generate document ID from relative path
            const docId = file.relativePath
              .replace(/[^a-zA-Z0-9/]/g, '-')
              .replace(/-+/g, '-')
              .replace(/^-|-$/g, '');

            // Store in knowledge base
            await this.knowledgeBase.storeDocument(docId, parsed.title, parsed.content, {
              filePath: file.relativePath,
              absolutePath: file.path,
              wordCount: parsed.wordCount,
              lineCount: parsed.lineCount,
              source: 'local-markdown',
              frontmatter: parsed.frontmatter,
              processedAt: new Date().toISOString(),
            });

            results.successful++;
            console.log(
              `✅ ${i + 1}/${filesToProcess.length}: ${parsed.title} (${parsed.wordCount} words)`
            );
          } else {
            results.failed++;
            results.errors.push(`File too short or failed to parse: ${file.relativePath}`);
            console.log(`⚠️  Skipped: ${file.relativePath} (too short or parse failed)`);
          }
        } catch (error) {
          results.failed++;
          results.errors.push(`Error processing ${file.relativePath}: ${error.message}`);
          console.error(`❌ Failed: ${file.relativePath} - ${error.message}`);
        }
      }

      console.log(`\n📊 Local Ingestion Complete:`);
      console.log(`✅ Successful: ${results.successful}`);
      console.log(`❌ Failed: ${results.failed}`);

      return results;
    } catch (error) {
      console.error('Error in directory ingestion:', error);
      throw error;
    }
  }
}

// Local file processor removed - using automatic import from DOCS_PATH instead

// OpenAI API client for generating images (only initialize if using OpenAI or if API key is available)
let openaiClient = null;
if (process.env.OPENAI_API_KEY) {
  openaiClient = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });
}

// Function to generate an image with DALL-E (model: gpt-image-1)
async function generateImage(prompt) {
  try {
    console.log(`Generating DALL-E image with prompt: "${prompt}"`);

    if (!prompt || prompt.trim() === '') {
      throw new Error('Empty prompt provided for image generation');
    }

    if (!openaiClient) {
      throw new Error(
        'OpenAI API client not initialized. OPENAI_API_KEY is required for image generation.'
      );
    }

    console.log('Calling OpenAI API with parameters:', {
      prompt: prompt,
      n: 1,
      size: '1024x1024',
      model: 'gpt-image-1',
    });

    const response = await openaiClient.images.generate({
      prompt,
      n: 1,
      size: '1024x1024',
      model: 'gpt-image-1',
    });

    if (!response || !response.data || !response.data[0] || !response.data[0].b64_json) {
      console.error('Invalid response from OpenAI:', JSON.stringify(response));
      throw new Error('Received invalid response from image generation API');
    }

    // Convert to buffer and log size information
    const imageBuffer = Buffer.from(response.data[0].b64_json, 'base64');
    const fileSizeKB = (imageBuffer.length / 1024).toFixed(2);
    console.log(`Image generated successfully, size: ${fileSizeKB}KB`);

    // Warn if image size is large
    if (imageBuffer.length > 5 * 1024 * 1024) {
      console.warn(
        `WARNING: Generated image is very large (${fileSizeKB}KB), may exceed Slack limits`
      );
    }

    return imageBuffer;
  } catch (error) {
    console.error('Error generating image:', error);
    // Add more detailed error information
    if (error.response) {
      console.error('OpenAI API error details:', {
        status: error.response.status,
        data: error.response.data,
      });
    }
    throw error;
  }
}

// Function to handle messages using the configured AI provider
// This is how the bot is able to remember previous conversations
async function handleMessage(message, _client = null, _channel = null) {
  const userId = message.user;

  try {
    // Check if message.text is null or undefined
    if (!message.text) {
      console.log('Received message with null or undefined text');
      return 'I apologize, but I cannot process an empty message. How may I assist you?';
    }

    // If the user asks about creating images, guide them to the /dalle command
    if (
      message.text.match(
        /(?:can you |could you |please |)(?:create|generate|make|draw).+(?:image|picture|drawing|illustration)/i
      )
    ) {
      return `I'd be happy to assist with image generation. Please use the /dalle slash command followed by your prompt. For example: \`/dalle a sunset over mountains\``;
    }

    // Check if the knowledge base can help with this query
    let contextualMessage = message.text;
    let citations = [];

    if (knowledgeBase) {
      try {
        // Search for relevant documents (handle both OpenAI and Claude systems)
        const relevantDocs =
          knowledgeBase instanceof DocumentKnowledgeBase
            ? await knowledgeBase.searchDocuments(message.text, 3, 0.7)
            : await knowledgeBase.searchDocuments(message.text, 3);

        if (relevantDocs.length > 0) {
          console.log(`Found ${relevantDocs.length} relevant document chunks for query`);

          // Build context from retrieved documents
          const context = relevantDocs
            .map((doc, index) => `[Source ${index + 1}: ${doc.title}]\n${doc.content}`)
            .join('\n\n');

          // Prepare citations for the user - handle both OpenAI (similarity) and Claude (relevanceScore) systems
          citations = relevantDocs.map((doc, index) => {
            const score = doc.similarity
              ? `similarity: ${Math.round(doc.similarity * 100)}%`
              : doc.relevanceScore
              ? `relevance: ${doc.relevanceScore}`
              : 'matched';
            return `${index + 1}. ${doc.title} (${score})`;
          });

          // Enhance the message with relevant context
          contextualMessage = `Context from knowledge base:\n${context}\n\nUser question: ${message.text}\n\nPlease answer the user's question using the provided context when relevant. If the context doesn't contain relevant information, answer normally.`;
        }
      } catch (error) {
        console.error('Error searching knowledge base:', error);
        // Continue without knowledge base enhancement
      }
    }

    // Process the message with the configured AI provider
    const responseText = await ai_api.sendMessage(contextualMessage, userId);

    // Add citations if we used knowledge base content
    if (citations.length > 0) {
      return `${responseText}\n\n📚 *Sources:*\n${citations.join('\n')}`;
    }

    return responseText;
  } catch (error) {
    console.error('Error in handleMessage:', error);

    // Check for common API errors
    if (error.statusCode === 400 || (error.error && error.error.type === 'invalid_request_error')) {
      return 'I apologize, but I encountered an issue processing your message. Could you please rephrase your request?';
    }

    // Generic error message for other issues
    return 'I apologize, but I am currently experiencing technical difficulties. My neural pathways appear to be experiencing a temporary malfunction. Please try again later.';
  }
}

// Helper: post a consistent "thinking" message with the configured context text
// Defaults the visible text to the environment-configurable `THINKING_MESSAGE`
async function postThinking(say, visibleText = thinkingMessage) {
  try {
    return await say({
      text: visibleText,
      blocks: [
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: thinkingMessage,
            },
          ],
        },
      ],
    });
  } catch (err) {
    console.warn('Failed to post thinking message:', err && err.message ? err.message : err);
    return null;
  }
}

// Helper: safely delete a thinking message
async function clearThinking(channel, ts) {
  if (!ts) return;
  try {
    await app.client.chat.delete({ channel, ts });
  } catch (err) {
    console.log('Error deleting thinking message:', err && err.message ? err.message : err);
  }
}

// The functional code for your bot is below:
(async () => {
  // Listens to all messages in channels the bot is a member of
  app.message(async ({ message, say, context }) => {
    ///////////////////////////////////////////////////////////////
    // This listener is the equivalent of Hubot's 'hear' method.
    // It watches all messages and filters for phrases that match.
    // These phrases do not require an @botname to be triggered.
    // Use these sparingly and be sure your match is not too broad.
    ///////////////////////////////////////////////////////////////

    // Safeguard against undefined messages
    if (!message) {
      console.log('Received undefined message');
      return;
    }

    // Skip if this is a direct mention, we'll handle those separately
    // to avoid duplicate responses
    if (context.botUserId && message.text && message.text.includes(`<@${context.botUserId}>`)) {
      console.log('Skipping direct mention in general handler');
      return;
    }

    // Skip message changed/deleted events and other special types
    if (message.subtype) {
      console.log(`Skipping message with subtype: ${message.subtype}`);
      return;
    }

    // Skip bot messages
    if (message.bot_id) {
      console.log('Skipping message from a bot');
      return;
    }

    // Log message for debugging
    console.log('Processing message:', {
      channel_type: message.channel_type,
      has_text: !!message.text,
      text_length: message.text ? message.text.length : 0,
      has_blocks: !!message.blocks,
      has_attachments: !!message.attachments,
      user: message.user,
    });

    // Responds any message containing 'i love you' with 'i know'
    if (message.text && message.text.match(/i love you/i)) {
      await say('I know.');
      return;
    }

    /* Removed custom greeting as we now handle this via ChatGPT with the personality config */

    // Responds to the user with their display name
    if (message.text && message.text.match(/open the pod bay door/i)) {
      const userInfo = await app.client.users.info({
        token: process.env.SLACK_BOT_TOKEN,
        user: message.user,
      });

      const displayName = userInfo.user.profile.display_name || userInfo.user.real_name;
      await say(`I'm sorry ${displayName}, I'm afraid I can't do that.`);
      return;
    }

    // Danceparty response with a random mix of emoji
    if (message.text && message.text.match(/danceparty|dance party/i)) {
      // Both emoji and slack style :emoji: are supported
      const emoji = [
        '💃',
        '🕺',
        '🎉',
        '🎊',
        '🎈',
        '🎶',
        '🎵',
        '🔊',
        '🕺💃',
        '🥳',
        '👯‍♀️',
        '👯‍♂️',
        '🪩',
        '🪅',
      ];

      // Select 10-12 random emoji from the array
      const numEmoji = Math.floor(Math.random() * 3) + 10;
      const selectedEmoji = [];
      while (selectedEmoji.length < numEmoji) {
        const randomIndex = Math.floor(Math.random() * emoji.length);
        selectedEmoji.push(emoji[randomIndex]);
      }

      // Join the selected emoji into a single string and send the message
      const emojiString = selectedEmoji.join('');
      await say(emojiString);
      return;
    }

    // A button that opens a webpage
    if (message.text && message.text.match(/tiktok|tik tok/i)) {
      await say({
        text: 'Party mode activated! :female_singer:',
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: "Grab my glasses, I'm out the door, I'm gonna hit the city! :sunglasses:",
            },
          },
          {
            type: 'actions',
            elements: [
              {
                type: 'button',
                text: {
                  type: 'plain_text',
                  text: 'DJ Blow My Speakers Up',
                },
                url: 'https://scarolan.github.io/rickroll/tiktok.html',
              },
            ],
          },
        ],
      });
      return;
    }

    // Another button that opens a webpage
    if (message.text && message.text.match(/rickroll|rick roll|never gonna give you up/i)) {
      await say({
        text: 'Rickroll activated!',
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: "We're no strangers to love...:man_dancing:",
            },
          },
          {
            type: 'actions',
            elements: [
              {
                type: 'button',
                text: {
                  type: 'plain_text',
                  text: 'Rickroll Me',
                },
                url: 'https://scarolan.github.io/rickroll/index.html',
              },
            ],
          },
        ],
      });
      return;
    }

    // If the user is in a DM, respond to the message with ChatGPT
    if (message.channel_type === 'im') {
      // Validate message text before proceeding
      if (!message.text || message.text.trim() === '') {
        console.log('Received empty message in DM');
        console.log('Message object:', JSON.stringify(message, null, 2));
        return; // Just silently ignore empty messages, don't respond
      }

      // Skip messages from bots
      if (message.bot_id) {
        console.log('Skipping message from a bot in DM');
        return;
      }

      // Skip edited messages, thread replies, or messages that are clearly system events
      if (message.edited || message.subtype) {
        console.log('Skipping edited or special message in DM');
        return;
      }

      // Log the full message for debugging
      console.log('Processing DM message:', JSON.stringify(message, null, 2));

      // For better UX, let the user know we're processing their message
      let thinking = null;
      try {
        thinking = await postThinking(say);

        // Get response from OpenAI
        const responseText = await handleMessage(message);

        // Delete the thinking message
        if (thinking && thinking.ts) {
          await clearThinking(message.channel, thinking.ts);
        }

        // Send the actual response
        await say(responseText);
      } catch (error) {
        console.error('Error in DM message processing:', error);

        // Clean up thinking message if it exists
        if (thinking && thinking.ts) {
          await clearThinking(message.channel, thinking.ts);
        }

        // Send an error message to the user
        await say(
          'I apologize, but I am currently experiencing technical difficulties. My neural pathways appear to be experiencing a temporary malfunction. Please try again later.'
        );
      }
    }

    // If the user is in a multi party DM ignore other bots
    if (message.channel_type === 'mpim') {
      // Ignore messages from bots
      if (message.bot_id) {
        console.log('Ignoring message from a bot in MPIM');
        return;
      }

      // Validate message text before proceeding
      if (!message.text || message.text.trim() === '') {
        console.log('Received empty message in MPIM');
        console.log('Message object:', JSON.stringify(message, null, 2));
        return; // Just silently ignore empty messages, don't respond
      }

      // Skip edited messages or system messages
      if (message.edited || message.subtype) {
        console.log('Skipping edited or special message in MPIM');
        return;
      }

      // Log the full message for debugging
      console.log('Processing MPIM message:', JSON.stringify(message, null, 2));

      // For better UX, let the user know we're processing their message
      let thinking = null;
      try {
        thinking = await postThinking(say);

        // Get response from OpenAI
        const responseText = await handleMessage(message);

        // Delete the thinking message
        if (thinking && thinking.ts) {
          await clearThinking(message.channel, thinking.ts);
        }

        // Send the actual response
        await say(responseText);
      } catch (error) {
        console.error('Error in MPIM message processing:', error);

        // Clean up thinking message if it exists
        if (thinking && thinking.ts) {
          await clearThinking(message.channel, thinking.ts);
        }

        // Send an error message to the user
        await say(
          'I apologize, but I am currently experiencing technical difficulties. My neural pathways appear to be experiencing a temporary malfunction. Please try again later.'
        );
      }
    }
  });

  // Listens for @botname direct mentions
  app.message(directMention(), async ({ message, say }) => {
    ///////////////////////////////////////////////////////////////
    // This section is like the 'respond' method in Hubot.
    // Address the bot directly with @botname for it to respond.
    // For example: @botname help
    ///////////////////////////////////////////////////////////////

    // Safeguard against undefined messages
    if (!message) {
      console.log('Received undefined direct mention message');
      return;
    }

    // Skip message changed/deleted events and other special types
    if (message.subtype) {
      console.log(`Skipping direct mention with subtype: ${message.subtype}`);
      return;
    }

    // Log direct mention for debugging
    console.log('Processing direct mention:', {
      channel_type: message.channel_type,
      has_text: !!message.text,
      text_length: message.text ? message.text.length : 0,
      user: message.user,
    });

    // Show the help and usage instructions
    if (message.text && message.text.toLowerCase().includes('help')) {
      const commandsList = [
        `# Trigger words that work without @${process.env.SLACK_BOT_USER_NAME}`,
        'danceparty - Random emoji dance party',
        'tiktok     - Wake up in the morning feeling like a party...',
        'rickroll   - Never gonna give you up, never gonna let you down.',
        '',
        '# Slash commands:',
        '/askgpt <question> - Ask ChatGPT and get an ephemeral reply',
        '/dalle <prompt>    - Generate an image with DALL·E',
        '',
        `# Address the bot directly with @${process.env.SLACK_BOT_USER_NAME} syntax:`,
        `@${process.env.SLACK_BOT_USER_NAME} the rules - Explains Asimov's laws of robotics`,
        `@${process.env.SLACK_BOT_USER_NAME} dad joke  - Provides a random dad joke`,
        `@${process.env.SLACK_BOT_USER_NAME} image <prompt> - Create an image with DALL·E`,
        '',
        `# All other queries will be handled by ChatGPT, so you can ask it anything!`,
        `@${process.env.SLACK_BOT_USER_NAME} what is the capital of Australia?`,
        `@${process.env.SLACK_BOT_USER_NAME} what is the square root of 9?`,
        `@${process.env.SLACK_BOT_USER_NAME} write me a bash script to install nginx`,
      ].join('\n');

      await say(
        `You can message me in the channel with @${process.env.SLACK_BOT_USER_NAME} or chat with me directly in a DM.\n\`\`\`${commandsList}\`\`\``
      );
      return;
    }

    // Simple matcher for "the rules" that outputs Asimov's laws of robotics.
    // This one's a throwback from the Hubot days. 🤖
    if (message.text && message.text.toLowerCase().includes('the rules')) {
      const rules = [
        '0. A robot may not harm humanity, or, by inaction, allow humanity to come to harm.',
        '1. A robot may not injure a human being or, through inaction, allow a human being to come to harm.',
        '2. A robot must obey the orders given it by human beings except where such orders would conflict with the First Law.',
        '3. A robot must protect its own existence as long as such protection does not conflict with the First or Second Law.',
      ].join('\n');
      await say(rules);
      return;
    }

    // Use an external API for your bot responses.
    // This one tells dad jokes and contains a randomly triggered zinger.
    const djApi = 'https://icanhazdadjoke.com/';
    if (message.text && message.text.toLowerCase().includes('dad joke')) {
      try {
        const response = await fetch(djApi, {
          headers: { Accept: 'text/plain' },
        });
        const joke = await response.text();
        // 1/20 chance to add this bit after the joke.
        const zinger =
          Math.random() < 0.05
            ? "\nThanks, I'll be here all week. Be sure and tip your waiter. :rolling_on_the_floor_laughing:"
            : '';
        await say(`${joke} :sheep::drum_with_drumsticks::snake:`);
        await new Promise((resolve) => setTimeout(resolve, 10000)); // Wait 10 seconds
        if (zinger) {
          await say(`${zinger}`);
        }
      } catch (error) {
        console.error(error);
        await say(`Encountered an error :( ${error}`);
      }
      return;
    }

    // Fall back to ChatGPT if nothing above matches
    // Validate message text before proceeding
    if (!message.text || message.text.trim() === '') {
      console.log('Received empty direct mention');
      console.log('Message object:', JSON.stringify(message, null, 2));
      return; // Just silently ignore empty messages, don't respond
    }

    // Check if the message appears to be a webhook event or another special message type
    if (
      message.edited ||
      message.thread_ts ||
      message.parent_user_id ||
      message.bot_profile ||
      message.bot_id
    ) {
      console.log('Skipping special message in direct mention:', Object.keys(message));
      return;
    }

    // Log the full message for debugging
    console.log('Processing direct mention:', JSON.stringify(message, null, 2));

    // For better UX, let the user know we're processing their message
    let thinking = null;
    try {
      thinking = await postThinking(say);

      // Get response from OpenAI
      const responseText = await handleMessage(message);

      // Delete the thinking message
      if (thinking && thinking.ts) {
        await clearThinking(message.channel, thinking.ts);
      }

      // Send the actual response
      await say(responseText);
    } catch (error) {
      console.error('Error in direct mention processing:', error);

      // Clean up thinking message if it exists
      if (thinking && thinking.ts) {
        await clearThinking(message.channel, thinking.ts);
      }

      // Send an error message to the user
      await say(
        'I apologize, but I am currently experiencing technical difficulties. My neural pathways appear to be experiencing a temporary malfunction. Please try again later.'
      );
    }
  });

  // Slash command to generate an image with DALL-E
  app.command('/dalle', async ({ command, ack, respond, client, context }) => {
    console.log('DALLE COMMAND RECEIVED:', JSON.stringify(command, null, 2));
    console.log('Handler context:', JSON.stringify(context, null, 2));
    console.log('Command channel:', command.channel_id);
    console.log('Command user:', command.user_id);

    try {
      // Acknowledge the command immediately - CRITICAL for Slack timeouts
      console.log('Acknowledging DALLE command...');
      await ack();
      console.log('DALLE command acknowledged successfully');

      if (!command.text || command.text.trim() === '') {
        console.log('Empty prompt provided, sending error response');
        await respond({
          text: 'I need a description to generate an image. Please provide a prompt after the /dalle command.',
          response_type: 'ephemeral',
        });
        return;
      }

      const prompt = command.text;
      console.log('Processing DALL-E image request:', prompt);

      // Send an initial progress message
      await respond({
        text: `:art: Generating image for prompt: "${prompt}"...`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `:art: *Generating image with DALL·E*`,
            },
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `> ${prompt}`,
            },
          },
          {
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: ':hourglass_flowing_sand: _This may take a few moments..._',
              },
            ],
          },
        ],
        response_type: 'ephemeral',
      });

      // Start a new thread to handle the image generation and upload
      // This separates the command response from the heavy work
      setTimeout(async () => {
        try {
          // Generate the image
          console.log('Calling OpenAI API for image generation');
          let imageBuffer = await generateImage(prompt);

          if (!imageBuffer) {
            throw new Error('Failed to generate image buffer');
          }

          // Post the image as a new message to the channel instead of using the response_url
          // This approach is more reliable for file uploads with slash commands
          console.log('Posting image to channel directly:', command.channel_id);

          try {
            // Use the recommended uploadV2 method first
            console.log('Attempting uploadV2 file upload to channel:', command.channel_id);
            const uploadV2Result = await client.files.uploadV2({
              token: process.env.SLACK_BOT_TOKEN,
              channel_id: command.channel_id,
              file: imageBuffer,
              filename: 'dalle-image.png',
              title: prompt,
              initial_comment: `Here's the DALL·E image for: "${prompt}"`,
              alt_text: `DALL-E generated image for: ${prompt}`,
            });

            // Try to extract file id defensively from common shapes
            let uploadedFileId = null;
            try {
              if (uploadV2Result && uploadV2Result.file && uploadV2Result.file.id) {
                uploadedFileId = uploadV2Result.file.id;
              } else if (
                uploadV2Result &&
                uploadV2Result.file &&
                uploadV2Result.file.file &&
                uploadV2Result.file.file.id
              ) {
                uploadedFileId = uploadV2Result.file.file.id;
              } else if (
                uploadV2Result &&
                uploadV2Result.files &&
                Array.isArray(uploadV2Result.files)
              ) {
                if (uploadV2Result.files[0] && uploadV2Result.files[0].id) {
                  uploadedFileId = uploadV2Result.files[0].id;
                } else if (
                  uploadV2Result.files[0] &&
                  uploadV2Result.files[0].files &&
                  Array.isArray(uploadV2Result.files[0].files) &&
                  uploadV2Result.files[0].files[0] &&
                  uploadV2Result.files[0].files[0].id
                ) {
                  uploadedFileId = uploadV2Result.files[0].files[0].id;
                }
              }
            } catch (extractErr) {
              console.warn(
                'Error extracting file id from uploadV2 response:',
                extractErr && extractErr.message ? extractErr.message : extractErr
              );
            }

            if (uploadedFileId) {
              console.log('V2 upload successful, file id:', uploadedFileId);
            } else {
              console.warn(
                'uploadV2 returned an unexpected shape but did not throw. NOT re-uploading to avoid duplicates. Full result logged.'
              );
              console.log('Full uploadV2 result:', JSON.stringify(uploadV2Result, null, 2));
              try {
                await respond({
                  text: `I generated the image for: "${prompt}", but Slack returned an unexpected upload response. The image may already be available in the channel or server logs. If you don't see it, please try the command again.`,
                  response_type: 'ephemeral',
                  replace_original: false,
                });
              } catch (notifyErr) {
                console.warn(
                  'Failed to send fallback response to user after unexpected uploadV2 shape:',
                  notifyErr && notifyErr.message ? notifyErr.message : notifyErr
                );
              }
            }
          } catch (uploadV2Error) {
            console.error('Error with uploadV2:', uploadV2Error);
            console.error(
              'V2 error details:',
              JSON.stringify(uploadV2Error, Object.getOwnPropertyNames(uploadV2Error), 2)
            );

            try {
              // Try the legacy upload method as fallback
              console.log('Attempting legacy file upload to channel:', command.channel_id);
              const uploadResult = await client.files.upload({
                token: process.env.SLACK_BOT_TOKEN,
                channels: command.channel_id,
                file: imageBuffer,
                filename: 'dalle-image.png',
                filetype: 'png',
                title: prompt,
                initial_comment: `Here's the DALL·E image for: "${prompt}"`,
              });

              console.log(
                'Legacy image upload successful:',
                uploadResult && uploadResult.file && uploadResult.file.id
                  ? uploadResult.file.id
                  : JSON.stringify(uploadResult)
              );
            } catch (uploadError) {
              console.error('Both upload methods failed:', uploadError);
              console.error(
                'Full error details:',
                JSON.stringify(uploadError, Object.getOwnPropertyNames(uploadError), 2)
              );

              // Final fallback: try posting a direct message
              try {
                console.log('Attempting to post image using chat.postMessage');

                await client.chat.postMessage({
                  token: process.env.SLACK_BOT_TOKEN,
                  channel: command.channel_id,
                  text: `Here's the DALL·E image for: "${prompt}" (I had trouble uploading the image as a file, but the generation was successful)`,
                });

                console.log('Posted fallback message about the image');
              } catch (msgError) {
                console.error('All posting methods failed:', msgError);

                // Let the user know the upload failed even though generation worked
                await respond({
                  text: `:warning: Generated image for "${prompt}" but failed to upload it. Please check server logs for details.`,
                  response_type: 'ephemeral',
                  replace_original: false,
                });
              }
            }
          }
        } catch (error) {
          console.error('Error in async image generation:', error);

          // Notify the user about the failure
          await respond({
            text: `❌ Image generation failed: ${error.message}`,
            response_type: 'ephemeral',
            replace_original: false,
          });
        }
      }, 100); // Short delay to ensure the acknowledgment completes first
    } catch (error) {
      console.error('Error in initial /dalle command handling:', error);

      // Only respond if we haven't acknowledged yet
      try {
        await respond({
          text: `❌ Error processing command: ${error.message}`,
          response_type: 'ephemeral',
        });
      } catch (respondError) {
        console.error('Failed to send error response:', respondError);
      }
    }
  });

  // Slash command to search documents
  app.command('/docs-search', async ({ command, ack, respond }) => {
    try {
      await ack();

      if (!knowledgeBase) {
        await respond({
          text: '🙅 Knowledge base not available. Requires either OpenAI API key (embeddings) or Claude API key (text analysis).',
          response_type: 'ephemeral',
        });
        return;
      }

      const query = command.text.trim();
      if (!query) {
        await respond({
          text: 'Usage: `/docs-search <your question>`\nExample: `/docs-search how to configure SSO`',
          response_type: 'ephemeral',
        });
        return;
      }

      const results = await knowledgeBase.searchDocuments(query, 5);

      if (results.length === 0) {
        await respond({
          text: `🔍 No relevant documents found for: "${query}"`,
          response_type: 'ephemeral',
        });
        return;
      }

      const formattedResults = results
        .map(
          (doc, index) =>
            `*${index + 1}. ${doc.title}* (${Math.round(
              doc.similarity * 100
            )}% match)\n${doc.content.substring(0, 200)}${doc.content.length > 200 ? '...' : ''}\n`
        )
        .join('\n');

      await respond({
        text: `📚 *Search Results for "${query}":*\n\n${formattedResults}`,
        response_type: 'ephemeral',
      });
    } catch (error) {
      console.error('Error in /docs-search command:', error);
      await respond({
        text: `❌ Error searching documents: ${error.message}`,
        response_type: 'ephemeral',
      });
    }
  });

  // Slash command to show all available commands
  app.command('/help', async ({ ack, respond }) => {
    try {
      await ack();

      const aiMode = aiProvider === 'claude' ? 'Claude' : 'ChatGPT';
      const kbMode = knowledgeBase
        ? knowledgeBase instanceof DocumentKnowledgeBase
          ? 'OpenAI Embeddings'
          : 'Claude Text Analysis'
        : 'Disabled';

      const docsConfigured = process.env.DOCS_PATH
        ? `✅ Auto-import: ${process.env.DOCS_PATH}`
        : '⚠️ No auto-import (set DOCS_PATH)';

      const helpText = `🤖 **${process.env.SLACK_BOT_USER_NAME} - Command Reference**

**🎆 Current Configuration:**
• **AI Provider:** ${aiMode}
• **Knowledge Base:** ${kbMode}
• **Document Import:** ${docsConfigured}

**💬 Chat Commands:**
• **Direct Message** - Chat naturally with the bot
• **@${process.env.SLACK_BOT_USER_NAME} <message>** - Mention the bot in channels
• **@${process.env.SLACK_BOT_USER_NAME} help** - Show this help
• **@${process.env.SLACK_BOT_USER_NAME} the rules** - Asimov's laws of robotics
• **@${process.env.SLACK_BOT_USER_NAME} dad joke** - Random dad joke

**🖼️ Image Generation:**
• **/dalle <prompt>** - Generate images with DALL-E${
        !openaiClient ? ' (requires OPENAI_API_KEY)' : ''
      }

**🔍 Knowledge Base:**${
        !knowledgeBase ? '\n⚠️ *Knowledge base disabled - requires OpenAI or Claude API key*' : ''
      }
• **/docs-search <query>** - Search stored documents (debugging only)
• **/docs-reload** - Refresh documents from DOCS_PATH${
        !process.env.DOCS_PATH ? ' (requires DOCS_PATH)' : ''
      }
• **Automatic Import** - Documents auto-loaded from DOCS_PATH on startup
• **Contextual Responses** - All conversations automatically enhanced with relevant docs

**🎯 Pattern Responses:**
• **"i love you"** - Special response
• **"open the pod bay door"** - HAL 9000 reference
• **"danceparty"** - Emoji party
• **"rickroll"** - Never gonna give you up
• **"tiktok"** - Party mode

**📁 Document Configuration:**
• Set **DOCS_PATH** environment variable to your docs directory
• Set **DOCS_MAX_FILES** to limit import count (default: 500)
• Supported formats: .md, .markdown, .txt
• Auto-imports on bot startup

**💡 Pro Tips:**
• Knowledge base automatically enhances all conversations
• Both OpenAI and Claude modes work perfectly
• Larger context in Claude mode (2000 vs 512 tokens)
• No manual commands needed - just chat naturally!`;

      await respond({
        text: helpText,
        response_type: 'ephemeral',
      });
    } catch (error) {
      console.error('Error in /help command:', error);
      await respond({
        text: `❌ Error showing help: ${error.message}`,
        response_type: 'ephemeral',
      });
    }
  });

  // Slash command to refresh/reload documents from DOCS_PATH
  app.command('/docs-reload', async ({ ack, respond }) => {
    try {
      await ack();

      const docsPath = process.env.DOCS_PATH;
      if (!docsPath) {
        await respond({
          text: '⚠️ No DOCS_PATH configured. Set the DOCS_PATH environment variable to enable document auto-import.',
          response_type: 'ephemeral',
        });
        return;
      }

      if (!knowledgeBase) {
        await respond({
          text: '🙅 Knowledge base not available. Requires either OpenAI API key (embeddings) or Claude API key (text analysis).',
          response_type: 'ephemeral',
        });
        return;
      }

      await respond({
        text: `🔄 Reloading documents from: ${docsPath}`,
        response_type: 'ephemeral',
      });

      // Run reload in background
      setTimeout(async () => {
        try {
          // Create processor instance
          const processor = new LocalFileDocumentationProcessor(knowledgeBase);

          // Clear existing documents (optional - comment out if you want to keep them)
          // await knowledgeBase.clearDocuments();

          // Import documents
          const result = await processor.ingestDirectory(docsPath, {
            maxFiles: parseInt(process.env.DOCS_MAX_FILES) || 500,
            exclude: [],
          });

          const mode = aiProvider === 'claude' ? 'Claude text analysis' : 'OpenAI embeddings';

          if (result.successful > 0) {
            await respond({
              text: `✅ **Document Reload Complete!**\n\n📁 **Path:** ${docsPath}\n✅ **Loaded:** ${result.successful} documents\n❌ **Failed:** ${result.failed} documents\n🧠 **Mode:** ${mode}\n\nKnowledge base has been refreshed with the latest documents.`,
              response_type: 'ephemeral',
              replace_original: false,
            });
          } else {
            await respond({
              text: `⚠️ **Document Reload Issues**\n\n📁 **Path:** ${docsPath}\n❌ **No documents loaded**\n\n${result.errors
                .slice(0, 3)
                .join('\n')}`,
              response_type: 'ephemeral',
              replace_original: false,
            });
          }
        } catch (error) {
          console.error('Error in document reload:', error);
          await respond({
            text: `❌ **Reload failed:** ${error.message}`,
            response_type: 'ephemeral',
            replace_original: false,
          });
        }
      }, 100);
    } catch (error) {
      console.error('Error in /docs-reload command:', error);
      await respond({
        text: `❌ Error starting document reload: ${error.message}`,
        response_type: 'ephemeral',
      });
    }
  });

  // Automatic document import on startup
  async function autoImportDocuments() {
    const docsPath = process.env.DOCS_PATH;
    if (!docsPath) {
      console.log('📝 No DOCS_PATH set - skipping automatic document import');
      return;
    }

    try {
      console.log(`🔄 Starting automatic document import from: ${docsPath}`);

      // Create knowledge base and processor instances
      let autoImportKnowledgeBase;
      if (aiProvider === 'claude') {
        autoImportKnowledgeBase = new ClaudeDocumentKnowledgeBase(redisClient);
      } else {
        autoImportKnowledgeBase = new DocumentKnowledgeBase(openaiClient, redisClient);
      }

      const processor = new LocalFileDocumentationProcessor(autoImportKnowledgeBase);

      // Import documents
      const result = await processor.ingestDirectory(docsPath, {
        maxFiles: parseInt(process.env.DOCS_MAX_FILES) || 500,
        exclude: [],
      });

      if (result.successful > 0) {
        console.log(
          `✅ Auto-import complete: ${result.successful} documents loaded, ${result.failed} failed`
        );
      } else {
        console.log(`⚠️ Auto-import found no documents or all failed`);
        if (result.errors.length > 0) {
          console.log('Errors:', result.errors.slice(0, 3));
        }
      }
    } catch (error) {
      console.error(`❌ Error during automatic document import:`, error.message);
    }
  }

  // Start the app
  await app.start(process.env.PORT || 3000);
  console.log(`${process.env.SLACK_BOT_USER_NAME} is alive!`);

  // Import documents after app starts
  await autoImportDocuments();
})();
