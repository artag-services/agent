import { Injectable, Logger } from '@nestjs/common'
import { Tool } from '../tool.interface'
import { ToolDefinition, ToolExecutionContext } from '../../common/types'

@Injectable()
export class ToolRegistry {
  private readonly logger = new Logger(ToolRegistry.name)
  private readonly tools = new Map<string, Tool>()

  register(tool: Tool): void {
    if (this.tools.has(tool.definition.name)) {
      this.logger.warn(`Tool "${tool.definition.name}" already registered — overwriting`)
    }
    this.tools.set(tool.definition.name, tool)
  }

  registerAll(tools: Tool[]): void {
    for (const t of tools) this.register(t)
    this.logger.log(`ToolRegistry: ${this.tools.size} tools registered`)
  }

  /**
   * List of tool definitions available to the user. In Fase 3 this can be
   * filtered by user permissions; for now all users see everything.
   */
  getAvailable(_userId?: string): ToolDefinition[] {
    return Array.from(this.tools.values()).map((t) => t.definition)
  }

  async execute(
    name: string,
    input: Record<string, unknown>,
    ctx: ToolExecutionContext,
  ): Promise<unknown> {
    const tool = this.tools.get(name)
    if (!tool) {
      throw new Error(`Unknown tool: ${name}`)
    }
    return tool.execute(input, ctx)
  }

  has(name: string): boolean {
    return this.tools.has(name)
  }

  count(): number {
    return this.tools.size
  }
}
