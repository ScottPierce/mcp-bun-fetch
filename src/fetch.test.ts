import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { McpServer, z } from "./mcp"
import { htmlToMarkdown, isHtmlContentType } from "./content"

const USER_AGENT =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

// Create a testable server that exposes handleMessage
class TestableServer extends McpServer {
	async processMessage(msg: object): Promise<void> {
		// @ts-expect-error - accessing private method for testing
		await this.handleMessage(msg)
	}
}

// Helper to capture console.log output
function captureOutput(): { logs: string[]; restore: () => void } {
	const logs: string[] = []
	const originalLog = console.log
	console.log = (...args: unknown[]) => {
		logs.push(args.map(String).join(" "))
	}
	return {
		logs,
		restore: () => {
			console.log = originalLog
		},
	}
}

// Helper to parse the first log entry safely
function parseFirstLog(logs: string[]): Record<string, unknown> {
	const first = logs[0]
	if (!first) throw new Error("No log output captured")
	return JSON.parse(first) as Record<string, unknown>
}

// Helper to create a mock fetch that satisfies Bun's fetch type
function mockFetch(
	impl: (url: string, options?: RequestInit) => Promise<Response>,
): typeof fetch {
	const mockFn = mock(impl) as unknown as typeof fetch
	return mockFn
}

// Mock Bun.spawn for Claude CLI
function mockBunSpawn(output: string, exitCode = 0) {
	const originalSpawn = Bun.spawn
	const mockSpawn = mock(
		(
			_cmd: string[],
			_options?: { stdin?: Blob; stdout?: string; stderr?: string },
		) => ({
			stdout: new ReadableStream({
				start(controller) {
					controller.enqueue(new TextEncoder().encode(output))
					controller.close()
				},
			}),
			stderr: new ReadableStream({
				start(controller) {
					controller.close()
				},
			}),
			exited: Promise.resolve(exitCode),
		}),
	)
	// @ts-expect-error - mocking Bun.spawn
	Bun.spawn = mockSpawn
	return {
		mockSpawn,
		restore: () => {
			// @ts-expect-error - restoring Bun.spawn
			Bun.spawn = originalSpawn
		},
	}
}

// Create the fetch handler matching index.ts implementation
function createFetchHandler() {
	return async (args: { url: string; prompt: string }) => {
		try {
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

			const rawContent = await response.text()
			const contentType = response.headers.get("content-type")
			const content = isHtmlContentType(contentType)
				? htmlToMarkdown(rawContent)
				: rawContent

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
	}
}

describe("fetch tool", () => {
	let server: TestableServer
	let output: { logs: string[]; restore: () => void }
	let originalFetch: typeof fetch
	let spawnMock: { mockSpawn: ReturnType<typeof mock>; restore: () => void }

	beforeEach(() => {
		server = new TestableServer({
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
			handler: createFetchHandler(),
		})

		output = captureOutput()
		originalFetch = globalThis.fetch
		spawnMock = mockBunSpawn("AI analysis of the page content")
	})

	afterEach(() => {
		output.restore()
		globalThis.fetch = originalFetch
		spawnMock.restore()
	})

	test("should fetch and process content successfully", async () => {
		const mockResponse = new Response(
			"<html><body><h1>Hello World</h1></body></html>",
			{
				status: 200,
				headers: { "Content-Type": "text/html" },
			},
		)

		globalThis.fetch = mockFetch(() => Promise.resolve(mockResponse))

		await server.processMessage({
			id: 1,
			method: "tools/call",
			params: {
				name: "fetch",
				arguments: {
					url: "https://example.com",
					prompt: "What is the main heading?",
				},
			},
		})

		const response = parseFirstLog(output.logs) as {
			result: { content: { text: string }[]; isError?: boolean }
		}
		expect(response.result.content[0]!.text).toBe(
			"AI analysis of the page content",
		)
		expect(response.result.isError).toBeUndefined()
	})

	test("should pass correct browser-like headers", async () => {
		let capturedHeaders: Record<string, string> | undefined

		globalThis.fetch = mockFetch((_url: string, options?: RequestInit) => {
			capturedHeaders = options?.headers as Record<string, string>
			return Promise.resolve(new Response("ok"))
		})

		await server.processMessage({
			id: 1,
			method: "tools/call",
			params: {
				name: "fetch",
				arguments: { url: "https://example.com", prompt: "Summarize" },
			},
		})

		expect(capturedHeaders).toEqual({
			"User-Agent": USER_AGENT,
			Accept:
				"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
			"Accept-Language": "en-US,en;q=0.5",
		})
	})

	test("should convert HTML to Markdown before processing", async () => {
		const htmlContent = "<html><body><h1>Title</h1><p>Content</p></body></html>"
		globalThis.fetch = mockFetch(() =>
			Promise.resolve(
				new Response(htmlContent, {
					headers: { "Content-Type": "text/html" },
				}),
			),
		)

		let capturedStdin: string | undefined
		spawnMock.restore()
		const originalSpawn = Bun.spawn
		// @ts-expect-error - mocking Bun.spawn
		Bun.spawn = mock(
			(
				_cmd: string[],
				options?: { stdin?: Blob; stdout?: string; stderr?: string },
			) => {
				// Capture stdin content
				if (options?.stdin instanceof Blob) {
					options.stdin.text().then((t) => {
						capturedStdin = t
					})
				}
				return {
					stdout: new ReadableStream({
						start(controller) {
							controller.enqueue(new TextEncoder().encode("result"))
							controller.close()
						},
					}),
					stderr: new ReadableStream({
						start(controller) {
							controller.close()
						},
					}),
					exited: Promise.resolve(0),
				}
			},
		)

		await server.processMessage({
			id: 1,
			method: "tools/call",
			params: {
				name: "fetch",
				arguments: { url: "https://example.com", prompt: "Summarize" },
			},
		})

		// Wait for async stdin capture
		await new Promise((resolve) => setTimeout(resolve, 10))

		// Verify markdown conversion happened (should contain # Title, not <h1>)
		expect(capturedStdin).toContain("# Title")
		expect(capturedStdin).not.toContain("<h1>")

		// @ts-expect-error - restoring Bun.spawn
		Bun.spawn = originalSpawn
	})

	test("should not convert non-HTML content", async () => {
		const jsonContent = '{"key": "value"}'
		globalThis.fetch = mockFetch(() =>
			Promise.resolve(
				new Response(jsonContent, {
					headers: { "Content-Type": "application/json" },
				}),
			),
		)

		let capturedStdin: string | undefined
		spawnMock.restore()
		const originalSpawn = Bun.spawn
		// @ts-expect-error - mocking Bun.spawn
		Bun.spawn = mock(
			(
				_cmd: string[],
				options?: { stdin?: Blob; stdout?: string; stderr?: string },
			) => {
				if (options?.stdin instanceof Blob) {
					options.stdin.text().then((t) => {
						capturedStdin = t
					})
				}
				return {
					stdout: new ReadableStream({
						start(controller) {
							controller.enqueue(new TextEncoder().encode("result"))
							controller.close()
						},
					}),
					stderr: new ReadableStream({
						start(controller) {
							controller.close()
						},
					}),
					exited: Promise.resolve(0),
				}
			},
		)

		await server.processMessage({
			id: 1,
			method: "tools/call",
			params: {
				name: "fetch",
				arguments: { url: "https://api.example.com/data", prompt: "Analyze" },
			},
		})

		await new Promise((resolve) => setTimeout(resolve, 10))

		// JSON should be passed through as-is
		expect(capturedStdin).toContain('{"key": "value"}')

		// @ts-expect-error - restoring Bun.spawn
		Bun.spawn = originalSpawn
	})

	test("should handle HTTP error status codes", async () => {
		globalThis.fetch = mockFetch(() =>
			Promise.resolve(
				new Response("Not Found", { status: 404, statusText: "Not Found" }),
			),
		)

		await server.processMessage({
			id: 1,
			method: "tools/call",
			params: {
				name: "fetch",
				arguments: { url: "https://example.com/notfound", prompt: "Read" },
			},
		})

		const response = parseFirstLog(output.logs) as {
			result: { content: { text: string }[]; isError?: boolean }
		}
		expect(response.result.content[0]!.text).toBe("Error: HTTP 404 Not Found")
		expect(response.result.isError).toBe(true)
	})

	test("should handle fetch error gracefully", async () => {
		globalThis.fetch = mockFetch(() =>
			Promise.reject(new Error("Network error")),
		)

		await server.processMessage({
			id: 1,
			method: "tools/call",
			params: {
				name: "fetch",
				arguments: { url: "https://example.com", prompt: "Read" },
			},
		})

		const response = parseFirstLog(output.logs) as {
			result: { content: { text: string }[]; isError: boolean }
		}
		expect(response.result.content[0]!.text).toBe("Error: Network error")
		expect(response.result.isError).toBe(true)
	})

	test("should handle Claude CLI error", async () => {
		globalThis.fetch = mockFetch(() => Promise.resolve(new Response("ok")))

		spawnMock.restore()
		const errorSpawnMock = mockBunSpawn("", 1)

		await server.processMessage({
			id: 1,
			method: "tools/call",
			params: {
				name: "fetch",
				arguments: { url: "https://example.com", prompt: "Read" },
			},
		})

		const response = parseFirstLog(output.logs) as {
			result: { content: { text: string }[]; isError: boolean }
		}
		expect(response.result.content[0]!.text).toContain(
			"Error processing with Claude",
		)
		expect(response.result.isError).toBe(true)

		errorSpawnMock.restore()
	})
})

describe("fetch tool registration", () => {
	let output: { logs: string[]; restore: () => void }

	beforeEach(() => {
		output = captureOutput()
	})

	afterEach(() => {
		output.restore()
	})

	test("should be listed in tools/list with both url and prompt parameters", async () => {
		const server = new TestableServer({
			name: "bun-fetch",
			version: "1.0.0",
		})

		server.tool("fetch", {
			description: "Fetch web content from a URL and process it with AI",
			schema: z.object({
				url: z.string().describe("URL to fetch"),
				prompt: z.string().describe("What to extract from the page"),
			}),
			handler: async () => ({ content: [{ type: "text", text: "" }] }),
		})

		await server.processMessage({
			id: 1,
			method: "tools/list",
			params: {},
		})

		const response = parseFirstLog(output.logs) as {
			result: {
				tools: {
					name: string
					description: string
					inputSchema: {
						properties: { url: { type: string }; prompt: { type: string } }
					}
				}[]
			}
		}
		const fetchTool = response.result.tools.find((t) => t.name === "fetch")

		expect(fetchTool).toBeDefined()
		expect(fetchTool!.name).toBe("fetch")
		expect(fetchTool!.inputSchema.properties.url.type).toBe("string")
		expect(fetchTool!.inputSchema.properties.prompt.type).toBe("string")
	})

	test("should require both url and prompt parameters", async () => {
		const server = new TestableServer({
			name: "bun-fetch",
			version: "1.0.0",
		})

		server.tool("fetch", {
			description: "Fetch web content",
			schema: z.object({
				url: z.string().describe("URL to fetch"),
				prompt: z.string().describe("What to extract"),
			}),
			handler: async () => ({ content: [{ type: "text", text: "" }] }),
		})

		await server.processMessage({
			id: 1,
			method: "tools/call",
			params: {
				name: "fetch",
				arguments: { url: "https://example.com" }, // missing prompt
			},
		})

		const response = parseFirstLog(output.logs) as { error: { code: number } }
		expect(response.error.code).toBe(-32602) // INVALID_PARAMS
	})
})
