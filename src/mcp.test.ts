import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { z } from "zod"
import { McpServer } from "./mcp"

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

// Create a testable server that exposes handleMessage
class TestableServer extends McpServer {
  async processMessage(msg: object): Promise<void> {
    // @ts-expect-error - accessing private method for testing
    await this.handleMessage(msg)
  }

  sendResponse(msg: object): void {
    // @ts-expect-error - accessing private method for testing
    this.send(msg)
  }
}

describe("McpServer", () => {
  let server: TestableServer
  let output: { logs: string[]; restore: () => void }

  beforeEach(() => {
    server = new TestableServer({
      name: "test-server",
      version: "1.0.0",
    })
    output = captureOutput()
  })

  afterEach(() => {
    output.restore()
  })

  describe("initialize", () => {
    test("should respond with protocol version and capabilities", async () => {
      await server.processMessage({
        id: 1,
        method: "initialize",
        params: {},
      })

      expect(output.logs.length).toBe(1)
      const response = parseFirstLog(output.logs)

      expect(response).toEqual({
        jsonrpc: "2.0",
        id: 1,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "test-server", version: "1.0.0" },
        },
      })
    })

    test("should handle string id", async () => {
      await server.processMessage({
        id: "request-1",
        method: "initialize",
        params: {},
      })

      const response = parseFirstLog(output.logs) as { id: string }
      expect(response.id).toBe("request-1")
    })
  })

  describe("notifications", () => {
    test("should not respond to messages without id", async () => {
      await server.processMessage({
        method: "notifications/initialized",
        params: {},
      })

      expect(output.logs.length).toBe(0)
    })
  })

  describe("tools/list", () => {
    test("should return empty tools list when no tools registered", async () => {
      await server.processMessage({
        id: 1,
        method: "tools/list",
        params: {},
      })

      const response = parseFirstLog(output.logs) as { result: { tools: unknown[] } }
      expect(response.result.tools).toEqual([])
    })

    test("should return registered tools with schema", async () => {
      server.tool("test-tool", {
        description: "A test tool",
        schema: z.object({
          param1: z.string().describe("First parameter"),
          param2: z.number().optional().describe("Second parameter"),
        }),
        handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
      })

      await server.processMessage({
        id: 1,
        method: "tools/list",
        params: {},
      })

      const response = parseFirstLog(output.logs) as {
        result: {
          tools: Array<{
            name: string
            description: string
            inputSchema: {
              type: string
              properties: Record<string, { type: string }>
              required: string[]
            }
          }>
        }
      }
      expect(response.result.tools.length).toBe(1)

      const tool = response.result.tools[0]!
      expect(tool.name).toBe("test-tool")
      expect(tool.description).toBe("A test tool")
      expect(tool.inputSchema.type).toBe("object")
      expect(tool.inputSchema.properties.param1!.type).toBe("string")
      expect(tool.inputSchema.properties.param2!.type).toBe("number")
      expect(tool.inputSchema.required).toContain("param1")
    })

    test("should return multiple tools", async () => {
      server
        .tool("tool1", {
          description: "Tool 1",
          schema: z.object({ a: z.string() }),
          handler: async () => ({ content: [{ type: "text", text: "1" }] }),
        })
        .tool("tool2", {
          description: "Tool 2",
          schema: z.object({ b: z.number() }),
          handler: async () => ({ content: [{ type: "text", text: "2" }] }),
        })

      await server.processMessage({
        id: 1,
        method: "tools/list",
        params: {},
      })

      const response = parseFirstLog(output.logs) as { result: { tools: Array<{ name: string }> } }
      expect(response.result.tools.length).toBe(2)
      expect(response.result.tools.map((t) => t.name)).toEqual(["tool1", "tool2"])
    })
  })

  describe("tools/call", () => {
    test("should call tool handler with validated arguments", async () => {
      const handler = mock(async (args: Record<string, unknown>) => ({
        content: [{ type: "text" as const, text: `Received: ${args.message}` }],
      }))

      server.tool("echo", {
        description: "Echo tool",
        schema: z.object({ message: z.string() }),
        handler,
      })

      await server.processMessage({
        id: 1,
        method: "tools/call",
        params: {
          name: "echo",
          arguments: { message: "hello" },
        },
      })

      expect(handler).toHaveBeenCalledWith({ message: "hello" })

      const response = parseFirstLog(output.logs) as {
        result: { content: Array<{ text: string }> }
      }
      expect(response.result.content[0]!.text).toBe("Received: hello")
    })

    test("should return error for unknown tool", async () => {
      await server.processMessage({
        id: 1,
        method: "tools/call",
        params: {
          name: "nonexistent",
          arguments: {},
        },
      })

      const response = parseFirstLog(output.logs) as { error: { code: number; message: string } }
      expect(response.error.code).toBe(-32601) // METHOD_NOT_FOUND
      expect(response.error.message).toBe("Unknown tool: nonexistent")
    })

    test("should return error for invalid parameters", async () => {
      server.tool("strict", {
        description: "Strict tool",
        schema: z.object({ required: z.string() }),
        handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
      })

      await server.processMessage({
        id: 1,
        method: "tools/call",
        params: {
          name: "strict",
          arguments: {}, // missing required field
        },
      })

      const response = parseFirstLog(output.logs) as { error: { code: number } }
      expect(response.error.code).toBe(-32602) // INVALID_PARAMS
    })

    test("should return error when handler throws", async () => {
      server.tool("failing", {
        description: "Failing tool",
        schema: z.object({}),
        handler: async () => {
          throw new Error("Handler error")
        },
      })

      await server.processMessage({
        id: 1,
        method: "tools/call",
        params: {
          name: "failing",
          arguments: {},
        },
      })

      const response = parseFirstLog(output.logs) as { error: { code: number; message: string } }
      expect(response.error.code).toBe(-32603) // INTERNAL_ERROR
      expect(response.error.message).toBe("Handler error")
    })

    test("should handle synchronous handlers", async () => {
      server.tool("sync", {
        description: "Sync tool",
        schema: z.object({}),
        handler: () => ({ content: [{ type: "text", text: "sync result" }] }),
      })

      await server.processMessage({
        id: 1,
        method: "tools/call",
        params: {
          name: "sync",
          arguments: {},
        },
      })

      const response = parseFirstLog(output.logs) as {
        result: { content: Array<{ text: string }> }
      }
      expect(response.result.content[0]!.text).toBe("sync result")
    })

    test("should handle tool result with isError flag", async () => {
      server.tool("error-result", {
        description: "Error result tool",
        schema: z.object({}),
        handler: async () => ({
          content: [{ type: "text", text: "Something went wrong" }],
          isError: true,
        }),
      })

      await server.processMessage({
        id: 1,
        method: "tools/call",
        params: {
          name: "error-result",
          arguments: {},
        },
      })

      const response = parseFirstLog(output.logs) as {
        result: { content: Array<{ text: string }>; isError: boolean }
      }
      expect(response.result.content[0]!.text).toBe("Something went wrong")
      expect(response.result.isError).toBe(true)
    })

    test("should handle empty arguments", async () => {
      const handler = mock(async () => ({
        content: [{ type: "text" as const, text: "ok" }],
      }))

      server.tool("no-args", {
        description: "No args tool",
        schema: z.object({}),
        handler,
      })

      await server.processMessage({
        id: 1,
        method: "tools/call",
        params: {
          name: "no-args",
          // no arguments field
        },
      })

      expect(handler).toHaveBeenCalledWith({})
    })
  })

  describe("unknown methods", () => {
    test("should return error for unknown method", async () => {
      await server.processMessage({
        id: 1,
        method: "unknown/method",
        params: {},
      })

      const response = parseFirstLog(output.logs) as { error: { code: number; message: string } }
      expect(response.error.code).toBe(-32601) // METHOD_NOT_FOUND
      expect(response.error.message).toBe("Method not found: unknown/method")
    })
  })

  describe("JSON-RPC format", () => {
    test("should include jsonrpc version in all responses", async () => {
      await server.processMessage({
        id: 1,
        method: "initialize",
        params: {},
      })

      const response = parseFirstLog(output.logs) as { jsonrpc: string }
      expect(response.jsonrpc).toBe("2.0")
    })

    test("should include jsonrpc version in error responses", async () => {
      await server.processMessage({
        id: 1,
        method: "unknown",
        params: {},
      })

      const response = parseFirstLog(output.logs) as { jsonrpc: string }
      expect(response.jsonrpc).toBe("2.0")
    })
  })

  describe("tool chaining", () => {
    test("tool() should return server for chaining", () => {
      const result = server.tool("t1", {
        description: "T1",
        schema: z.object({}),
        handler: async () => ({ content: [] }),
      })

      expect(result).toBe(server)
    })
  })
})

describe("Zod schema validation", () => {
  let server: TestableServer
  let output: { logs: string[]; restore: () => void }

  beforeEach(() => {
    server = new TestableServer({
      name: "test-server",
      version: "1.0.0",
    })
    output = captureOutput()
  })

  afterEach(() => {
    output.restore()
  })

  test("should validate string enum", async () => {
    server.tool("enum-tool", {
      description: "Enum tool",
      schema: z.object({
        status: z.enum(["active", "inactive"]),
      }),
      handler: async (args) => ({
        content: [{ type: "text", text: String(args.status) }],
      }),
    })

    await server.processMessage({
      id: 1,
      method: "tools/call",
      params: {
        name: "enum-tool",
        arguments: { status: "invalid" },
      },
    })

    const response = parseFirstLog(output.logs) as { error: { code: number } }
    expect(response.error.code).toBe(-32602)
  })

  test("should validate number ranges", async () => {
    server.tool("number-tool", {
      description: "Number tool",
      schema: z.object({
        count: z.number().min(1).max(100),
      }),
      handler: async (args) => ({
        content: [{ type: "text", text: String(args.count) }],
      }),
    })

    await server.processMessage({
      id: 1,
      method: "tools/call",
      params: {
        name: "number-tool",
        arguments: { count: 150 },
      },
    })

    const response = parseFirstLog(output.logs) as { error: { code: number } }
    expect(response.error.code).toBe(-32602)
  })

  test("should validate URL format", async () => {
    server.tool("url-tool", {
      description: "URL tool",
      schema: z.object({
        url: z.url(),
      }),
      handler: async (args) => ({
        content: [{ type: "text", text: String(args.url) }],
      }),
    })

    await server.processMessage({
      id: 1,
      method: "tools/call",
      params: {
        name: "url-tool",
        arguments: { url: "not-a-url" },
      },
    })

    const response = parseFirstLog(output.logs) as { error: { code: number } }
    expect(response.error.code).toBe(-32602)
  })

  test("should accept valid URL", async () => {
    server.tool("url-tool", {
      description: "URL tool",
      schema: z.object({
        url: z.url(),
      }),
      handler: async (args) => ({
        content: [{ type: "text", text: String(args.url) }],
      }),
    })

    await server.processMessage({
      id: 1,
      method: "tools/call",
      params: {
        name: "url-tool",
        arguments: { url: "https://example.com" },
      },
    })

    const response = parseFirstLog(output.logs) as { result: { content: Array<{ text: string }> } }
    expect(response.result.content[0]!.text).toBe("https://example.com")
  })
})
