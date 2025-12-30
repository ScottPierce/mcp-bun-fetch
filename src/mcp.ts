import { toJSONSchema, type ZodObject, type ZodRawShape, z } from "zod"

export { z }

const JsonRpcError = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const

export interface McpServerOptions {
  name: string
  version: string
}

export interface ToolContent {
  type: "text" | "image" | "resource"
  text?: string
  data?: string
  mimeType?: string
}

export interface ToolResult {
  content: ToolContent[]
  isError?: boolean
}

interface StoredTool {
  description: string
  schema: ZodObject<ZodRawShape>
  handler: (args: Record<string, unknown>) => Promise<ToolResult> | ToolResult
}

interface JsonRpcMessage {
  id?: number | string
  method?: string
  params?: Record<string, unknown>
}

export class McpServer {
  private name: string
  private version: string
  private tools: Map<string, StoredTool> = new Map()

  constructor(options: McpServerOptions) {
    this.name = options.name
    this.version = options.version
  }

  tool<T extends ZodRawShape>(
    name: string,
    options: {
      description: string
      schema: ZodObject<T>
      handler: (args: z.infer<ZodObject<T>>) => Promise<ToolResult> | ToolResult
    },
  ): this {
    this.tools.set(name, {
      description: options.description,
      schema: options.schema as ZodObject<ZodRawShape>,
      handler: options.handler as (
        args: Record<string, unknown>,
      ) => Promise<ToolResult> | ToolResult,
    })
    return this
  }

  async start(): Promise<void> {
    const decoder = new TextDecoder()
    let buffer = ""

    for await (const chunk of Bun.stdin.stream()) {
      buffer += decoder.decode(chunk, { stream: true })

      let index: number
      while ((index = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, index).replace(/\r$/, "")
        buffer = buffer.slice(index + 1)

        if (line) {
          try {
            await this.handleMessage(JSON.parse(line))
          } catch {
            this.respondError(null, JsonRpcError.PARSE_ERROR, "Parse error")
          }
        }
      }
    }
  }

  private send(msg: object): void {
    console.log(JSON.stringify(msg))
  }

  private respond(id: number | string, result: unknown): void {
    this.send({ jsonrpc: "2.0", id, result })
  }

  private respondError(id: number | string | null, code: number, message: string): void {
    this.send({ jsonrpc: "2.0", id, error: { code, message } })
  }

  private async handleMessage(msg: JsonRpcMessage): Promise<void> {
    const { id, method, params } = msg

    // Notifications (no id) don't need responses
    if (id === undefined) return

    switch (method) {
      case "initialize":
        this.respond(id, {
          protocolVersion: "2024-11-05",
          // Advertise supported capabilities (tools: {} means "tools enabled with default settings")
          // Actual tool list is returned by tools/list
          capabilities: { tools: {} },
          serverInfo: { name: this.name, version: this.version },
        })
        break

      case "tools/list":
        this.respond(id, {
          tools: Array.from(this.tools.entries()).map(([name, tool]) => ({
            name,
            description: tool.description,
            inputSchema: toJSONSchema(tool.schema),
          })),
        })
        break

      case "tools/call":
        await this.handleToolCall(id, params)
        break

      default:
        this.respondError(id, JsonRpcError.METHOD_NOT_FOUND, `Method not found: ${method}`)
    }
  }

  private async handleToolCall(
    id: number | string,
    params?: Record<string, unknown>,
  ): Promise<void> {
    const toolName = params?.name as string
    const rawArgs = (params?.arguments as Record<string, unknown>) ?? {}

    const tool = this.tools.get(toolName)
    if (!tool) {
      this.respondError(id, JsonRpcError.METHOD_NOT_FOUND, `Unknown tool: ${toolName}`)
      return
    }

    // Validate and parse args with Zod
    const parseResult = tool.schema.safeParse(rawArgs)
    if (!parseResult.success) {
      this.respondError(id, JsonRpcError.INVALID_PARAMS, parseResult.error.message)
      return
    }

    try {
      const result = await tool.handler(parseResult.data)
      this.respond(id, result)
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e)
      this.respondError(id, JsonRpcError.INTERNAL_ERROR, message)
    }
  }
}
