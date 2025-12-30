import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { McpServer, z } from "./mcp"

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
function mockFetch(impl: (url: string, options?: RequestInit) => Promise<Response>): typeof fetch {
  const mockFn = mock(impl) as unknown as typeof fetch
  return mockFn
}

describe("fetch tool", () => {
  let server: TestableServer
  let output: { logs: string[]; restore: () => void }
  let originalFetch: typeof fetch

  beforeEach(() => {
    server = new TestableServer({
      name: "bun-fetch",
      version: "1.0.0",
    })

    // Register the fetch tool (same as in index.ts)
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

    output = captureOutput()
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    output.restore()
    globalThis.fetch = originalFetch
  })

  test("should fetch content from URL successfully", async () => {
    const mockResponse = new Response("<html><body>Hello World</body></html>", {
      status: 200,
      headers: { "Content-Type": "text/html" },
    })

    globalThis.fetch = mockFetch(() => Promise.resolve(mockResponse))

    await server.processMessage({
      id: 1,
      method: "tools/call",
      params: {
        name: "fetch",
        arguments: { url: "https://example.com" },
      },
    })

    const response = parseFirstLog(output.logs) as {
      result: { content: { text: string }[]; isError?: boolean }
    }
    expect(response.result.content[0]!.text).toBe("<html><body>Hello World</body></html>")
    expect(response.result.isError).toBeUndefined()
  })

  test("should pass correct User-Agent header", async () => {
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
        arguments: { url: "https://example.com" },
      },
    })

    expect(capturedHeaders).toEqual({
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    })
  })

  test("should truncate response to 50000 characters", async () => {
    const largeContent = "x".repeat(60000)
    globalThis.fetch = mockFetch(() => Promise.resolve(new Response(largeContent)))

    await server.processMessage({
      id: 1,
      method: "tools/call",
      params: {
        name: "fetch",
        arguments: { url: "https://example.com/large" },
      },
    })

    const response = parseFirstLog(output.logs) as { result: { content: { text: string }[] } }
    expect(response.result.content[0]!.text.length).toBe(50000)
    expect(response.result.content[0]!.text).toBe("x".repeat(50000))
  })

  test("should return content under 50000 characters without truncation", async () => {
    const content = "x".repeat(30000)
    globalThis.fetch = mockFetch(() => Promise.resolve(new Response(content)))

    await server.processMessage({
      id: 1,
      method: "tools/call",
      params: {
        name: "fetch",
        arguments: { url: "https://example.com" },
      },
    })

    const response = parseFirstLog(output.logs) as { result: { content: { text: string }[] } }
    expect(response.result.content[0]!.text.length).toBe(30000)
  })

  test("should handle fetch error gracefully", async () => {
    globalThis.fetch = mockFetch(() => Promise.reject(new Error("Network error")))

    await server.processMessage({
      id: 1,
      method: "tools/call",
      params: {
        name: "fetch",
        arguments: { url: "https://example.com" },
      },
    })

    const response = parseFirstLog(output.logs) as {
      result: { content: { text: string }[]; isError: boolean }
    }
    expect(response.result.content[0]!.text).toBe("Error: Network error")
    expect(response.result.isError).toBe(true)
  })

  test("should handle non-Error exceptions", async () => {
    globalThis.fetch = mockFetch(() => Promise.reject("string error"))

    await server.processMessage({
      id: 1,
      method: "tools/call",
      params: {
        name: "fetch",
        arguments: { url: "https://example.com" },
      },
    })

    const response = parseFirstLog(output.logs) as {
      result: { content: { text: string }[]; isError: boolean }
    }
    expect(response.result.content[0]!.text).toBe("Error: string error")
    expect(response.result.isError).toBe(true)
  })

  test("should handle HTTP error status codes", async () => {
    const errorResponse = new Response("Not Found", { status: 404 })
    globalThis.fetch = mockFetch(() => Promise.resolve(errorResponse))

    await server.processMessage({
      id: 1,
      method: "tools/call",
      params: {
        name: "fetch",
        arguments: { url: "https://example.com/notfound" },
      },
    })

    // The current implementation returns the response body even for error status codes
    const response = parseFirstLog(output.logs) as {
      result: { content: { text: string }[]; isError?: boolean }
    }
    expect(response.result.content[0]!.text).toBe("Not Found")
    expect(response.result.isError).toBeUndefined()
  })

  test("should handle empty response", async () => {
    globalThis.fetch = mockFetch(() => Promise.resolve(new Response("")))

    await server.processMessage({
      id: 1,
      method: "tools/call",
      params: {
        name: "fetch",
        arguments: { url: "https://example.com/empty" },
      },
    })

    const response = parseFirstLog(output.logs) as { result: { content: { text: string }[] } }
    expect(response.result.content[0]!.text).toBe("")
  })

  test("should fetch with different URL schemes", async () => {
    let capturedUrl: string | undefined

    globalThis.fetch = mockFetch((url: string) => {
      capturedUrl = url
      return Promise.resolve(new Response("ok"))
    })

    await server.processMessage({
      id: 1,
      method: "tools/call",
      params: {
        name: "fetch",
        arguments: { url: "http://insecure.example.com" },
      },
    })

    expect(capturedUrl).toBe("http://insecure.example.com")
  })

  test("should handle JSON response as text", async () => {
    const jsonContent = JSON.stringify({ key: "value", number: 42 })
    globalThis.fetch = mockFetch(() =>
      Promise.resolve(
        new Response(jsonContent, {
          headers: { "Content-Type": "application/json" },
        }),
      ),
    )

    await server.processMessage({
      id: 1,
      method: "tools/call",
      params: {
        name: "fetch",
        arguments: { url: "https://api.example.com/data" },
      },
    })

    const response = parseFirstLog(output.logs) as { result: { content: { text: string }[] } }
    expect(response.result.content[0]!.text).toBe(jsonContent)
  })

  test("should handle special characters in response", async () => {
    const specialContent = "<html>Special chars: &lt; &gt; &amp; 'quotes' \"double\" \n\t</html>"
    globalThis.fetch = mockFetch(() => Promise.resolve(new Response(specialContent)))

    await server.processMessage({
      id: 1,
      method: "tools/call",
      params: {
        name: "fetch",
        arguments: { url: "https://example.com" },
      },
    })

    const response = parseFirstLog(output.logs) as { result: { content: { text: string }[] } }
    expect(response.result.content[0]!.text).toBe(specialContent)
  })

  test("should handle unicode content", async () => {
    const unicodeContent = "Hello 世界 🌍 Привет"
    globalThis.fetch = mockFetch(() => Promise.resolve(new Response(unicodeContent)))

    await server.processMessage({
      id: 1,
      method: "tools/call",
      params: {
        name: "fetch",
        arguments: { url: "https://example.com/unicode" },
      },
    })

    const response = parseFirstLog(output.logs) as { result: { content: { text: string }[] } }
    expect(response.result.content[0]!.text).toBe(unicodeContent)
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

  test("should be listed in tools/list", async () => {
    const server = new TestableServer({
      name: "bun-fetch",
      version: "1.0.0",
    })

    server.tool("fetch", {
      description: "Fetch web content from a URL",
      schema: z.object({
        url: z.string().describe("URL to fetch"),
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
          inputSchema: { properties: { url: { type: string } } }
        }[]
      }
    }
    const fetchTool = response.result.tools.find((t) => t.name === "fetch")

    expect(fetchTool).toBeDefined()
    expect(fetchTool!.name).toBe("fetch")
    expect(fetchTool!.description).toBe("Fetch web content from a URL")
    expect(fetchTool!.inputSchema.properties.url.type).toBe("string")
  })

  test("should require url parameter", async () => {
    const server = new TestableServer({
      name: "bun-fetch",
      version: "1.0.0",
    })

    server.tool("fetch", {
      description: "Fetch web content from a URL",
      schema: z.object({
        url: z.string().describe("URL to fetch"),
      }),
      handler: async () => ({ content: [{ type: "text", text: "" }] }),
    })

    await server.processMessage({
      id: 1,
      method: "tools/call",
      params: {
        name: "fetch",
        arguments: {}, // missing url
      },
    })

    const response = parseFirstLog(output.logs) as { error: { code: number } }
    expect(response.error.code).toBe(-32602) // INVALID_PARAMS
  })
})
