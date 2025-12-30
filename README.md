# mcp-fetch

An MCP server that fetches web content.

## Build

```bash
bun install
bun run build
```

This creates a bundled JS file at `dist/index.js`.

## Usage with Claude Desktop

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "fetch": {
      "command": "bun",
      "args": ["/path/to/mcp-fetch/dist/index.js"]
    }
  }
}
```

## Usage with Claude Code

Add to your Claude Code MCP settings:

```json
{
  "mcpServers": {
    "fetch": {
      "command": "bun",
      "args": ["/path/to/mcp-fetch/dist/index.js"]
    }
  }
}
```

## Development

Run directly without building:

```bash
bun run index.ts
```

## Tools

### fetch

Fetches content from a URL.

**Parameters:**
- `url` (required): URL to fetch
- `prompt` (optional): What to extract from the page
