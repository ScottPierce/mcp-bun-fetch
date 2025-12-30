import { McpServer, z } from "./mcp"

const server = new McpServer({
  name: "bun-fetch",
  version: "1.0.0",
})

server.tool("fetch", {
  description: "Fetch web content from a URL",
  schema: z.object({
    url: z.string().describe("URL to fetch"),
  }),
  handler: async (args) => {
    try {
      const response = await fetch(args.url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        },
      })
      const text = await response.text()
      return { content: [{ type: "text", text: text.slice(0, 50000) }] }
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e)
      return { content: [{ type: "text", text: `Error: ${message}` }], isError: true }
    }
  },
})

await server.start()
