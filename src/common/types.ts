/**
 * Vendor-neutral types for the AI orchestrator.
 *
 * Adapters (Anthropic, OpenAI, Local) translate from the provider's native
 * format to these types and back. The orchestrator + tool registry never
 * touch provider SDKs directly.
 */

// ─────────────── Messages and content blocks ───────────────

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean }

export interface ChatMessage {
  role: 'user' | 'assistant' | 'tool'
  content: ContentBlock[]
}

// ─────────────── Tool definitions ───────────────

export interface ToolDefinition {
  /** Stable identifier — kebab_or_snake fine, but consistent across calls. */
  name: string
  /** Human-readable description for the LLM. The clearer this is, the better the LLM picks the right tool. */
  description: string
  /** JSON Schema for the input. */
  inputSchema: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
}

// ─────────────── Chat input/output ───────────────

export interface ChatInput {
  messages: ChatMessage[]
  systemPrompt: string
  tools: ToolDefinition[]
  /** Override the adapter's default model (e.g. switch to a faster/cheaper one). */
  model?: string
  maxTokens?: number
  /** Hint to the adapter to use prompt caching when supported (Anthropic 1h cache). */
  enableCache?: boolean
}

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'error'

export interface ChatResult {
  /** Final assistant message content (multiple blocks possible). */
  content: ContentBlock[]
  stopReason: StopReason
  usage: {
    inputTokens: number
    outputTokens: number
    cachedInputTokens?: number
  }
  /** Convenience getter — concatenates all `text` blocks. */
  text: string
  /** Convenience getter — extracts `tool_use` blocks. */
  toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>
}

// ─────────────── Streaming chunks ───────────────

export type StreamChunk =
  | { type: 'message_start' }
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_use_start'; id: string; name: string }
  | { type: 'tool_use_input_delta'; id: string; partialInput: string }
  | { type: 'tool_use_end'; id: string; input: Record<string, unknown> }
  | { type: 'message_end'; stopReason: StopReason }
  | { type: 'error'; error: string }

// ─────────────── Errors ───────────────

export class AiAdapterError extends Error {
  constructor(
    message: string,
    public readonly provider: string,
    public readonly retryable: boolean,
    public readonly cause?: unknown,
  ) {
    super(message)
    this.name = 'AiAdapterError'
  }
}

// ─────────────── Tool execution context (passed to each tool's `execute`) ───────────────

export interface ToolExecutionContext {
  /** UUID of the conversation this tool call belongs to. */
  conversationId: string
  /** Owner of the conversation (if known). */
  userId?: string
  /** ID assigned by the LLM for this specific tool call. Used to correlate the result. */
  toolUseId: string
}

export interface RpcEnvelope {
  correlationId?: string
  [k: string]: unknown
}
