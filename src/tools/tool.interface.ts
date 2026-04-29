import { ToolDefinition, ToolExecutionContext } from '../common/types'

/**
 * A single tool that the agent can call. Each tool is responsible for:
 *  - Declaring its public interface (`definition`)
 *  - Validating its input
 *  - Executing the underlying action (publish to RabbitMQ, query DB, etc.)
 *  - Returning a JSON-serializable result that the LLM can read
 *
 * Tools are registered with `ToolRegistry` at module init.
 */
export interface Tool {
  readonly definition: ToolDefinition
  execute(input: Record<string, unknown>, ctx: ToolExecutionContext): Promise<unknown>
}
