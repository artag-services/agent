import { ChatInput, ChatResult, StreamChunk } from '../common/types'

/**
 * Vendor-neutral AI provider abstraction.
 *
 * Each implementation translates the orchestrator's `ChatInput` (using our
 * own `ContentBlock[]` representation) to the provider's native format,
 * makes the API call, and translates the response back.
 *
 * Why this abstraction exists:
 *  - Anthropic encodes tool use as `{ type: "tool_use", ... }` blocks inside
 *    the assistant message's `content` array; tool results are `{ type:
 *    "tool_result", ... }` blocks in the next user message.
 *  - OpenAI uses a separate `tool_calls` field on the assistant message and
 *    a `role: "tool"` message with `tool_call_id` for the result.
 *  - Local (Ollama) varies by model — some use OpenAI-compatible API, some
 *    don't support tools at all.
 *
 * Each adapter handles its own quirks; the orchestrator stays clean.
 */
export interface AiAdapter {
  /** Stable identifier matching `AI_PROVIDER` env values. */
  readonly name: string

  /** Whether tool use is supported by the active model. */
  readonly supportsTools: boolean

  /** Whether streaming is supported. */
  readonly supportsStreaming: boolean

  /**
   * Buffered chat — sends messages, waits for full response, returns once.
   */
  chat(input: ChatInput): Promise<ChatResult>

  /**
   * Streaming chat — sends messages, calls `onChunk` for each event from
   * the provider, resolves with the final aggregated result. Falls back to
   * buffered chat if the adapter doesn't support streaming.
   */
  chatStream(input: ChatInput, onChunk: (chunk: StreamChunk) => void): Promise<ChatResult>
}
