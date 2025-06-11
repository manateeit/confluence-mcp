import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';
import { loadConfig } from './utils/config';
import { ConfluenceClient } from './services/confluence-client';
import { MarkdownConverter } from './services/markdown-converter';
import { MarkdownPageCache } from './utils/cache';
import { ProjectConfigManager } from './utils/project-config';
import crypto from 'crypto';

// Security configuration
const MCP_API_KEY = process.env.MCP_API_KEY;
const RATE_LIMIT_WINDOW = 15 * 60 * 1000; // 15 minutes
const RATE_LIMIT_MAX_REQUESTS = 100; // Max requests per window

// Rate limiting store (in production, use Redis or similar)
const rateLimitStore = new Map<string, { count: number; resetTime: number }>();

// Authentication middleware
function authenticateRequest(req: express.Request, res: express.Response, next: express.NextFunction) {
  const apiKey = req.headers['x-mcp-api-key'] || req.query.apiKey;

  if (!MCP_API_KEY) {
    console.error('MCP_API_KEY not configured on server');
    return res.status(500).json({ error: 'Server configuration error' });
  }

  if (!apiKey || apiKey !== MCP_API_KEY) {
    console.warn('Unauthorized access attempt:', {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      timestamp: new Date().toISOString()
    });
    return res.status(401).json({ error: 'Unauthorized: Invalid or missing API key' });
  }

  next();
}

// Rate limiting middleware
function rateLimitMiddleware(req: express.Request, res: express.Response, next: express.NextFunction) {
  const clientId = req.ip || 'unknown';
  const now = Date.now();

  // Clean up expired entries
  for (const [key, value] of rateLimitStore.entries()) {
    if (now > value.resetTime) {
      rateLimitStore.delete(key);
    }
  }

  const clientData = rateLimitStore.get(clientId);

  if (!clientData) {
    rateLimitStore.set(clientId, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
    return next();
  }

  if (now > clientData.resetTime) {
    rateLimitStore.set(clientId, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
    return next();
  }

  if (clientData.count >= RATE_LIMIT_MAX_REQUESTS) {
    return res.status(429).json({
      error: 'Rate limit exceeded',
      retryAfter: Math.ceil((clientData.resetTime - now) / 1000)
    });
  }

  clientData.count++;
  next();
}

// Security headers middleware
function securityHeaders(req: express.Request, res: express.Response, next: express.NextFunction) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'");
  next();
}

// Generate a secure session ID
function generateSecureSessionId(): string {
  return crypto.randomBytes(32).toString('hex');
}

// Create an MCP server instance with Confluence tools
const getServer = () => {
  const server = new McpServer({
    name: 'confluence-mcp',
    version: '0.1.0',
  }, {
    capabilities: {
      tools: {},
      logging: {}
    }
  });

  // Load configuration on startup
  loadConfig();

  // Register Confluence tools
  server.tool('confluence_list_spaces', 'List all available Confluence spaces', {}, async () => {
    try {
      const client = new ConfluenceClient();
      const spaces = await client.listSpaces();

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              spaces: spaces.map(space => ({
                key: space.key,
                name: space.name
              }))
            }, null, 2)
          }
        ]
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: error.message || 'Failed to list Confluence spaces'
            }, null, 2)
          }
        ],
        isError: true
      };
    }
  });

  server.tool('confluence_list_pages', 'List all pages in a Confluence space', {
    spaceKey: z.string().describe('The key of the Confluence space to list pages from')
  }, async ({ spaceKey }) => {
    try {
      const client = new ConfluenceClient();
      const pages = await client.listPages(spaceKey);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              pages: pages.map(page => ({
                id: page.id,
                title: page.title,
                spaceKey: page.spaceKey,
                version: page.version.number
              }))
            }, null, 2)
          }
        ]
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: error.message || 'Failed to list Confluence pages'
            }, null, 2)
          }
        ],
        isError: true
      };
    }
  });

  server.tool('confluence_create_page', 'Create a new Confluence page from Markdown content', {
    title: z.string().describe('The title of the new page'),
    markdownContent: z.string().describe('The Markdown content to be converted and used for the page'),
    markdownPath: z.string().optional().describe('Optional: The path to the Markdown file in the local codebase for caching'),
    spaceKey: z.string().optional().describe('Optional: Override the default space key from project config'),
    parentPageId: z.string().optional().describe('Optional: Override the default parent page from project config')
  }, async ({ title, markdownContent, markdownPath, spaceKey, parentPageId }) => {
    try {
      const projectConfig = new ProjectConfigManager();
      const config = projectConfig.getConfig();

      // Use project config defaults if not provided
      const finalSpaceKey = spaceKey || config?.spaceKey;
      const finalParentPageId = parentPageId || config?.parentPageId;

      if (!finalSpaceKey) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: 'No space key provided. Either pass spaceKey parameter or set up project config with confluence_setup_project'
              }, null, 2)
            }
          ],
          isError: true
        };
      }

      const client = new ConfluenceClient();
      const converter = new MarkdownConverter();
      const cache = new MarkdownPageCache();

      // Convert markdown to Confluence format
      const confluenceContent = await converter.convertToConfluence(markdownContent);

      // Create the page (with parent if specified)
      const page = await client.createPage(finalSpaceKey, title, confluenceContent, finalParentPageId);

      // Cache the mapping if markdownPath is provided
      if (markdownPath) {
        cache.setPageMapping(markdownPath, {
          markdownPath,
          pageId: page.id,
          spaceKey: page.spaceKey,
          title: page.title,
          lastUpdated: new Date().toISOString()
        });
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              message: `✅ Page '${title}' created successfully!`,
              page: {
                id: page.id,
                title: page.title,
                spaceKey: page.spaceKey,
                version: page.version,
                parentPageId: finalParentPageId
              }
            }, null, 2)
          }
        ]
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: error.message || 'Failed to create Confluence page'
            }, null, 2)
          }
        ],
        isError: true
      };
    }
  });

  server.tool('confluence_update_page', 'Update an existing Confluence page from Markdown content', {
    pageId: z.string().describe('The ID of the Confluence page to update'),
    title: z.string().describe('The new title for the page'),
    markdownContent: z.string().describe('The Markdown content to be converted and used for the page'),
    markdownPath: z.string().optional().describe('Optional: The path to the Markdown file in the local codebase for caching'),
    version: z.number().describe('The current version number of the page (required for updates)'),
    parentPageId: z.string().optional().describe('Optional: Override the default parent page from project config')
  }, async ({ pageId, title, markdownContent, markdownPath, version, parentPageId }) => {
    try {
      const projectConfig = new ProjectConfigManager();
      const config = projectConfig.getConfig();

      // Use project config default parent if not provided
      const finalParentPageId = parentPageId || config?.parentPageId;

      const client = new ConfluenceClient();
      const converter = new MarkdownConverter();
      const cache = new MarkdownPageCache();

      // Convert markdown to Confluence format
      const confluenceContent = await converter.convertToConfluence(markdownContent);

      // Update the page (with parent if specified)
      const page = await client.updatePage(pageId, title, confluenceContent, version, finalParentPageId);

      // Update cache mapping if markdownPath is provided
      if (markdownPath) {
        cache.setPageMapping(markdownPath, {
          markdownPath,
          pageId: page.id,
          spaceKey: page.spaceKey,
          title: page.title,
          lastUpdated: new Date().toISOString()
        });
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              message: `✅ Page '${title}' updated successfully!`,
              page: {
                id: page.id,
                title: page.title,
                spaceKey: page.spaceKey,
                version: page.version,
                parentPageId: finalParentPageId
              }
            }, null, 2)
          }
        ]
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: error.message || 'Failed to update Confluence page'
            }, null, 2)
          }
        ],
        isError: true
      };
    }
  });

  server.tool('confluence_delete_page', 'Delete a Confluence page and remove it from cache', {
    pageId: z.string().describe('The ID of the Confluence page to delete'),
    markdownPath: z.string().optional().describe('Optional: The path to the Markdown file in the local codebase to remove from cache')
  }, async ({ pageId, markdownPath }) => {
    try {
      const client = new ConfluenceClient();
      const cache = new MarkdownPageCache();

      // Delete the page from Confluence
      await client.deletePage(pageId);

      // Remove from cache if markdownPath is provided
      if (markdownPath) {
        cache.removePageMapping(markdownPath);
      } else {
        // If no markdownPath provided, try to find and remove by pageId
        const allMappings = cache.getAllMappings();
        for (const [path, mapping] of Object.entries(allMappings)) {
          if (mapping.pageId === pageId) {
            cache.removePageMapping(path);
            break;
          }
        }
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              message: `Page ${pageId} deleted successfully`
            }, null, 2)
          }
        ]
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: error.message || 'Failed to delete Confluence page'
            }, null, 2)
          }
        ],
        isError: true
      };
    }
  });

  // Add project configuration management tools
  server.tool('confluence_setup_project', 'Set up Confluence project configuration with your specific settings', {
    confluenceUrl: z.string().describe('Confluence base URL (e.g., https://realestatenexus.atlassian.net/)'),
    username: z.string().describe('Confluence username/email'),
    apiToken: z.string().describe('Confluence API token'),
    spaceKey: z.string().describe('Default space key (e.g., ~712020b38176381dd2400481d381324bb1fb50)'),
    parentPageTitle: z.string().optional().describe('Parent page title in hierarchy (e.g., REN360 Microservices Ecosystem)'),
    baseDir: z.string().optional().describe('Local file path mapping (optional)')
  }, async ({ confluenceUrl, username, apiToken, spaceKey, parentPageTitle, baseDir }) => {
    try {
      const projectConfig = new ProjectConfigManager();

      // Update environment variables for immediate use
      process.env.CONFLUENCE_BASE_URL = confluenceUrl;
      process.env.CONFLUENCE_USERNAME = username;
      process.env.CONFLUENCE_API_TOKEN = apiToken;

      // Reload configuration
      loadConfig();

      // Test the connection first
      const client = new ConfluenceClient();

      // Validate space exists
      try {
        const spaces = await client.listSpaces();
        const spaceExists = spaces.some(space => space.key === spaceKey);
        if (!spaceExists) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: `Space with key '${spaceKey}' not found`,
                  availableSpaces: spaces.map(s => ({ key: s.key, name: s.name }))
                }, null, 2)
              }
            ],
            isError: true
          };
        }
      } catch (error: any) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: `Failed to connect to Confluence: ${error.message}`,
                troubleshooting: [
                  'Check your Confluence URL format',
                  'Verify your username/email is correct',
                  'Ensure your API token is valid',
                  'Make sure you have access to the Confluence instance'
                ]
              }, null, 2)
            }
          ],
          isError: true
        };
      }

      // Find parent page if specified
      let parentPageId: string | undefined;
      if (parentPageTitle) {
        try {
          const pages = await client.listPages(spaceKey);
          const parentPage = pages.find(page => page.title === parentPageTitle);
          if (parentPage) {
            parentPageId = parentPage.id;
          } else {
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    error: `Parent page '${parentPageTitle}' not found in space '${spaceKey}'`,
                    availablePages: pages.map(p => ({ id: p.id, title: p.title })).slice(0, 10)
                  }, null, 2)
                }
              ],
              isError: true
            };
          }
        } catch (error: any) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: `Failed to find parent page: ${error.message}`
                }, null, 2)
              }
            ],
            isError: true
          };
        }
      }

      // Save project configuration
      projectConfig.saveConfig({
        confluenceUrl,
        username,
        apiToken,
        spaceKey,
        parentPageTitle,
        parentPageId,
        baseDir
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              message: '✅ Confluence project configuration saved successfully!',
              config: {
                confluenceUrl,
                username: username.replace(/(.{3}).*(@.*)/, '$1***$2'), // Mask email
                spaceKey,
                parentPageTitle,
                parentPageId,
                baseDir
              }
            }, null, 2)
          }
        ]
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: error.message || 'Failed to set up Confluence project configuration'
            }, null, 2)
          }
        ],
        isError: true
      };
    }
  });

  server.tool('confluence_show_config', 'Show current project configuration', {}, async () => {
    try {
      const projectConfig = new ProjectConfigManager();
      const config = projectConfig.getConfig();

      if (!config) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                message: 'No project configuration found. Use confluence_setup_project to configure.',
                configured: false
              }, null, 2)
            }
          ]
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              configured: true,
              config: {
                confluenceUrl: config.confluenceUrl,
                username: config.username.replace(/(.{3}).*(@.*)/, '$1***$2'), // Mask email
                spaceKey: config.spaceKey,
                parentPageTitle: config.parentPageTitle,
                parentPageId: config.parentPageId,
                baseDir: config.baseDir,
                lastUpdated: config.lastUpdated
              }
            }, null, 2)
          }
        ]
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: error.message || 'Failed to show project configuration'
            }, null, 2)
          }
        ],
        isError: true
      };
    }
  });

  server.tool('confluence_test_connection', 'Test Confluence connection', {}, async () => {
    try {
      const client = new ConfluenceClient();
      const spaces = await client.listSpaces();

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              message: `✅ Connection successful! Found ${spaces.length} spaces.`,
              spacesCount: spaces.length
            }, null, 2)
          }
        ]
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: false,
              error: `❌ Connection failed: ${error.message}`,
              troubleshooting: [
                'Check your Confluence base URL',
                'Verify your username/email is correct',
                'Ensure your API token is valid',
                'Make sure you have access to the Confluence instance'
              ]
            }, null, 2)
          }
        ],
        isError: true
      };
    }
  });

  return server;
};

export function startServer(port: number): void {
  const app = express();

  // Trust proxy for accurate IP addresses (important for Fly.io)
  app.set('trust proxy', true);

  // Apply security middleware
  app.use(securityHeaders);
  app.use(express.json({ limit: '10mb' })); // Limit payload size
  app.use(rateLimitMiddleware);

  // Store transports by session ID
  const transports: Record<string, SSEServerTransport> = {};

  // SSE endpoint for establishing the stream (requires authentication)
  app.get('/mcp', authenticateRequest, async (req, res) => {
    console.log('Received authenticated GET request to /mcp (establishing SSE stream)');
    try {
      // Generate a secure session ID
      const secureSessionId = generateSecureSessionId();

      // Create a new SSE transport for the client
      const transport = new SSEServerTransport('/messages', res);

      // Override the session ID with our secure one
      (transport as any).sessionId = secureSessionId;

      // Store the transport by session ID
      transports[secureSessionId] = transport;

      // Set up onclose handler to clean up transport when closed
      transport.onclose = () => {
        console.log(`SSE transport closed for session ${secureSessionId}`);
        delete transports[secureSessionId];
      };

      // Connect the transport to the MCP server
      const server = getServer();
      await server.connect(transport);
      console.log(`Established SSE stream with session ID: ${secureSessionId}`);
    } catch (error) {
      console.error('Error establishing SSE stream:', error);
      if (!res.headersSent) {
        res.status(500).send('Error establishing SSE stream');
      }
    }
  });

  // Messages endpoint for receiving client JSON-RPC requests (requires authentication)
  app.post('/messages', authenticateRequest, async (req, res) => {
    console.log('Received authenticated POST request to /messages');

    const sessionId = req.query.sessionId as string;
    if (!sessionId) {
      console.error('No session ID provided in request URL');
      res.status(400).send('Missing sessionId parameter');
      return;
    }

    const transport = transports[sessionId];
    if (!transport) {
      console.error(`No active transport found for session ID: ${sessionId}`);
      res.status(404).send('Session not found');
      return;
    }

    try {
      await transport.handlePostMessage(req, res, req.body);
    } catch (error) {
      console.error('Error handling request:', error);
      if (!res.headersSent) {
        res.status(500).send('Error handling request');
      }
    }
  });

  // Health check endpoint
  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  // Start the server
  app.listen(port, () => {
    console.log(`Confluence MCP SSE server running on port ${port}`);
  });

  // Handle server shutdown
  process.on('SIGINT', async () => {
    console.log('Shutting down server...');
    for (const sessionId in transports) {
      try {
        console.log(`Closing transport for session ${sessionId}`);
        await transports[sessionId].close();
        delete transports[sessionId];
      } catch (error) {
        console.error(`Error closing transport for session ${sessionId}:`, error);
      }
    }
    console.log('Server shutdown complete');
    process.exit(0);
  });
}