# Confluence MCP Deployment Guide

This guide covers deploying the Confluence MCP server to Fly.io for production use.

## Prerequisites

- [Fly.io account](https://fly.io/app/sign-up)
- [Fly CLI installed](https://fly.io/docs/getting-started/installing-flyctl/)
- Confluence Cloud instance with API access
- Confluence API token

## Local Development Setup

### 1. Clone and Install

```bash
git clone <repository-url>
cd confluence-mcp
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` with your Confluence credentials:

```env
CONFLUENCE_BASE_URL=https://your-domain.atlassian.net
CONFLUENCE_USERNAME=your-email@domain.com
CONFLUENCE_API_TOKEN=your-api-token
MCP_API_KEY=your-secure-mcp-key
PORT=3001
```

### 3. Get Confluence API Token

1. Go to [Atlassian Account Settings](https://id.atlassian.com/manage-profile/security/api-tokens)
2. Click "Create API token"
3. Give it a label (e.g., "MCP Server")
4. Copy the token immediately (you won't see it again)

### 4. Test Locally

```bash
npm run dev
```

Test the server:

```bash
node simple-test.js
```

## Production Deployment on Fly.io

### 1. Login to Fly.io

```bash
fly auth login
```

### 2. Initialize Fly App

```bash
fly launch
```

This will:
- Create a `fly.toml` configuration file (already provided)
- Set up your app on Fly.io
- Ask if you want to deploy immediately (say "no" for now)

### 3. Set Production Secrets

```bash
# Set Confluence credentials
fly secrets set CONFLUENCE_BASE_URL=https://your-domain.atlassian.net
fly secrets set CONFLUENCE_USERNAME=your-email@domain.com
fly secrets set CONFLUENCE_API_TOKEN=your-api-token

# Set MCP API key for security
fly secrets set MCP_API_KEY=your-secure-random-key

# Optional: Set custom port (default is 3000)
fly secrets set PORT=3000
```

### 4. Create Volume for Cache

```bash
fly volumes create confluence_mcp_data --region iad --size 1
```

### 5. Deploy

```bash
fly deploy
```

### 6. Verify Deployment

```bash
# Check app status
fly status

# View logs
fly logs

# Test health endpoint
curl https://your-app-name.fly.dev/health
```

## Configuration

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `CONFLUENCE_BASE_URL` | Yes | Your Confluence instance URL |
| `CONFLUENCE_USERNAME` | Yes | Your Confluence username/email |
| `CONFLUENCE_API_TOKEN` | Yes | Your Confluence API token |
| `MCP_API_KEY` | Recommended | API key for MCP access |
| `PORT` | No | Server port (default: 3000) |
| `CACHE_FILE_PATH` | No | Cache file location (default: ./markdown-page-mapping.json) |

### Fly.io Configuration

The `fly.toml` file includes:

- **Memory**: 1GB RAM for Puppeteer/Chrome
- **CPU**: 1 shared CPU
- **Health checks**: Automatic health monitoring
- **Auto-scaling**: Scales to 0 when not in use
- **Volume**: Persistent storage for cache

### Security Considerations

1. **API Keys**: Always use `fly secrets set` for sensitive data
2. **HTTPS**: Fly.io provides automatic HTTPS
3. **Access Control**: Consider implementing IP restrictions if needed
4. **Token Rotation**: Regularly rotate your Confluence API tokens

## Usage with AI Assistants

### Claude Desktop Configuration

Add to your Claude Desktop MCP configuration:

```json
{
  "mcpServers": {
    "confluence": {
      "command": "node",
      "args": ["/path/to/confluence-mcp/dist/index.js"],
      "env": {
        "CONFLUENCE_BASE_URL": "https://your-domain.atlassian.net",
        "CONFLUENCE_USERNAME": "your-email@domain.com",
        "CONFLUENCE_API_TOKEN": "your-api-token"
      }
    }
  }
}
```

### SSE Client Configuration

For SSE-based clients, connect to:

```
GET https://your-app-name.fly.dev/mcp
POST https://your-app-name.fly.dev/messages?sessionId=<session-id>
```

## Monitoring and Maintenance

### View Logs

```bash
# Real-time logs
fly logs

# Historical logs
fly logs --app your-app-name
```

### Scale Resources

```bash
# Scale memory
fly scale memory 2048

# Scale CPU
fly scale count 2
```

### Update Deployment

```bash
# Deploy latest changes
fly deploy

# Deploy specific version
fly deploy --image your-app-name:v1.2.3
```

### Backup Cache Data

```bash
# SSH into the app
fly ssh console

# Copy cache file
fly sftp get /data/markdown-page-mapping.json ./backup/
```

## Troubleshooting

### Common Issues

1. **Puppeteer/Chrome Issues**
   - Ensure sufficient memory (1GB+)
   - Check Chrome flags in `fly.toml`

2. **Confluence API Errors**
   - Verify API token is valid
   - Check base URL format
   - Ensure user has proper permissions

3. **Memory Issues**
   - Monitor with `fly logs`
   - Scale memory if needed
   - Optimize Mermaid rendering

### Debug Commands

```bash
# Check app status
fly status

# View resource usage
fly metrics

# SSH into app
fly ssh console

# Check environment variables
fly ssh console -C "env | grep CONFLUENCE"
```

## Performance Optimization

### Mermaid Rendering

- Diagrams are cached after first render
- Consider pre-rendering common diagrams
- Monitor memory usage during rendering

### Confluence API

- Implement rate limiting if needed
- Cache space/page listings
- Use batch operations when possible

### Fly.io Optimization

- Use regions close to your Confluence instance
- Enable auto-scaling for cost efficiency
- Monitor and adjust resource allocation

## Support

For issues:

1. Check the logs: `fly logs`
2. Verify configuration: Environment variables and secrets
3. Test locally first: `npm run dev`
4. Check Confluence API access independently

## Next Steps

After deployment:

1. Test all MCP tools with your AI assistant
2. Create sample pages to verify formatting
3. Set up monitoring and alerts
4. Document your team's usage patterns
5. Consider implementing additional security measures
