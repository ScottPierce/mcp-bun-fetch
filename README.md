# mcp-bun-fetch

MCP server that fetches web content, converts HTML to Markdown, and processes it with Claude AI. This is meant to be
a replacement for Claude's default WebFetch, that seems to get regularly blocked from servers. This works around that by
not identifying itself as Claude.

## Requirements

- [Bun](https://bun.sh/)
- [Claude CLI](https://docs.anthropic.com/en/docs/claude-code) (authenticated)

## Configuration

No installation required. The MCP configurations below use `bunx` to run the package directly from GitHub.

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

```json
{
  "mcpServers": {
    "fetch": {
      "command": "bunx",
      "args": ["github:scottpierce/mcp-bun-fetch#v1"]
    }
  }
}
```

### Claude Code

Run the following command:

```bash
claude mcp add fetch -- bunx github:scottpierce/mcp-bun-fetch#v1
```

## Local Development

Run without building:

```bash
bun run index.ts
```

Run tests:

```bash
bun test
```

Build:

```bash
bun run build
```

### Local Installation

To use a local build instead of a published package:

```json
{
  "mcpServers": {
    "fetch": {
      "command": "bun",
      "args": ["/absolute/path/to/mcp-fetch/dist/index.js"]
    }
  }
}
```

## Tool

### fetch

Fetches a URL, converts HTML to Markdown, and processes with Claude.

Parameters:
- `url` (required): URL to fetch
- `prompt` (required): What to extract or analyze from the page
