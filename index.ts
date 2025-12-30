import { htmlToMarkdown, isHtmlContentType } from "./src/content"
import { McpServer, z } from "./src/mcp"

const USER_AGENT =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

const server = new McpServer({
	name: "bun-fetch",
	version: "1.0.0",
})

server.tool("fetch", {
	description:
		"Fetch web content from a URL and process it with AI. Returns the AI's analysis based on the provided prompt.",
	schema: z.object({
		url: z.string().describe("URL to fetch"),
		prompt: z
			.string()
			.describe("What information to extract or analyze from the page"),
	}),
	handler: async (args) => {
		try {
			// 1. Fetch with browser-like headers
			const response = await fetch(args.url, {
				headers: {
					"User-Agent": USER_AGENT,
					Accept:
						"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
					"Accept-Language": "en-US,en;q=0.5",
				},
			})

			if (!response.ok) {
				return {
					content: [
						{
							type: "text",
							text: `Error: HTTP ${response.status} ${response.statusText}`,
						},
					],
					isError: true,
				}
			}

			// 2. Get content and convert HTML to Markdown
			const rawContent = await response.text()
			const contentType = response.headers.get("content-type")
			const content = isHtmlContentType(contentType)
				? htmlToMarkdown(rawContent)
				: rawContent

			// 3. Process with Claude CLI (using haiku for speed/cost)
			const fullPrompt = `<page_content>\n${content}\n</page_content>\n\n${args.prompt}`

			const proc = Bun.spawn(
				["claude", "-p", "--model", "haiku", "--tools", ""],
				{
					stdin: new Blob([fullPrompt]),
					stdout: "pipe",
					stderr: "pipe",
				},
			)

			const output = await new Response(proc.stdout).text()
			const exitCode = await proc.exited

			if (exitCode !== 0) {
				const stderr = await new Response(proc.stderr).text()
				return {
					content: [
						{ type: "text", text: `Error processing with Claude: ${stderr}` },
					],
					isError: true,
				}
			}

			return { content: [{ type: "text", text: output }] }
		} catch (e: unknown) {
			const message = e instanceof Error ? e.message : String(e)
			return {
				content: [{ type: "text", text: `Error: ${message}` }],
				isError: true,
			}
		}
	},
})

await server.start()
