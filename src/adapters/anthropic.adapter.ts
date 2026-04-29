import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import Anthropic from '@anthropic-ai/sdk'

import { AiAdapter } from './ai-adapter.interface'
import {
  AiAdapterError,
  ChatInput,
  ChatMessage,
  ChatResult,
  ContentBlock,
  StopReason,
  StreamChunk,
  ToolDefinition,
} from '../common/types'

/**
 * Anthropic Claude adapter.
 *
 * Multi-key support: `ANTHROPIC_API_KEYS` (comma-separated) → round-robin
 * with auto-rotation on 429/401. Falls back to single `ANTHROPIC_API_KEY`.
 *
 * Default model: `ANTHROPIC_MODEL` (default: claude-haiku-4-5). Can be
 * overridden per-request via `ChatInput.model`.
 *
 * Prompt caching: when `enableCache` is true on the input, the system
 * prompt + tools are marked with `cache_control: ephemeral` (1h TTL).
 * Saves ~90% on repeated turns of the same conversation.
 */
@Injectable()
export class AnthropicAdapter implements AiAdapter {
  readonly name = 'anthropic'
  readonly supportsTools = true
  readonly supportsStreaming = true

  private readonly logger = new Logger(AnthropicAdapter.name)
  private readonly clients: Anthropic[]
  private readonly defaultModel: string
  private rrIndex = 0

  constructor(private readonly config: ConfigService) {
    const keys = this.parseKeys()
    this.clients = keys.map((apiKey) => new Anthropic({ apiKey }))
    this.defaultModel = this.config.get<string>('ANTHROPIC_MODEL') ?? 'claude-haiku-4-5'

    if (this.clients.length === 0) {
      this.logger.warn(
        'No ANTHROPIC_API_KEY(S) configured — AnthropicAdapter will throw on every call',
      )
    } else {
      this.logger.log(
        `AnthropicAdapter ready with ${this.clients.length} key(s), model=${this.defaultModel}`,
      )
    }
  }

  async chat(input: ChatInput): Promise<ChatResult> {
    return this.callWithRotation(async (client) => {
      const response = await client.messages.create({
        model: input.model ?? this.defaultModel,
        max_tokens: input.maxTokens ?? 4096,
        system: this.buildSystem(input.systemPrompt, input.enableCache),
        tools: this.translateTools(input.tools, input.enableCache),
        messages: this.translateMessages(input.messages),
      })
      return this.translateResponse(response)
    })
  }

  async chatStream(input: ChatInput, onChunk: (chunk: StreamChunk) => void): Promise<ChatResult> {
    return this.callWithRotation(async (client) => {
      onChunk({ type: 'message_start' })

      const stream = client.messages.stream({
        model: input.model ?? this.defaultModel,
        max_tokens: input.maxTokens ?? 4096,
        system: this.buildSystem(input.systemPrompt, input.enableCache),
        tools: this.translateTools(input.tools, input.enableCache),
        messages: this.translateMessages(input.messages),
      })

      // SDK v0.27+: stream.on() events
      stream.on('text', (delta: string) => {
        onChunk({ type: 'text_delta', delta })
      })
      stream.on('contentBlock', (block) => {
        if ((block as { type: string }).type === 'tool_use') {
          const tu = block as { id: string; name: string; input: Record<string, unknown> }
          onChunk({ type: 'tool_use_end', id: tu.id, input: tu.input })
        }
      })

      const finalMessage = await stream.finalMessage()
      const result = this.translateResponse(finalMessage)
      onChunk({ type: 'message_end', stopReason: result.stopReason })
      return result
    })
  }

  // ─────────────── Translation helpers ───────────────

  private buildSystem(prompt: string, enableCache?: boolean) {
    if (!enableCache) return prompt
    // Prompt caching: array form with cache_control
    return [
      {
        type: 'text' as const,
        text: prompt,
        cache_control: { type: 'ephemeral' as const },
      },
    ]
  }

  private translateTools(tools: ToolDefinition[], enableCache?: boolean) {
    if (tools.length === 0) return undefined
    const mapped = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
    }))
    if (enableCache && mapped.length > 0) {
      // Mark the last tool with cache_control to cache the whole tools array
      mapped[mapped.length - 1] = {
        ...mapped[mapped.length - 1],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        cache_control: { type: 'ephemeral' as const },
      } as never
    }
    return mapped as never
  }

  private translateMessages(messages: ChatMessage[]) {
    return messages.map((m) => ({
      role: m.role === 'tool' ? 'user' : m.role, // Anthropic: tool results live in a user message
      content: m.content.map((b) => this.translateBlock(b)),
    })) as never
  }

  private translateBlock(block: ContentBlock) {
    if (block.type === 'text') {
      return { type: 'text', text: block.text }
    }
    if (block.type === 'tool_use') {
      return { type: 'tool_use', id: block.id, name: block.name, input: block.input }
    }
    return {
      type: 'tool_result',
      tool_use_id: block.toolUseId,
      content: block.content,
      ...(block.isError ? { is_error: true } : {}),
    }
  }

  private translateResponse(response: Anthropic.Messages.Message): ChatResult {
    const content: ContentBlock[] = response.content
      .map((b): ContentBlock | null => {
        if (b.type === 'text') return { type: 'text', text: b.text }
        if (b.type === 'tool_use') {
          return {
            type: 'tool_use',
            id: b.id,
            name: b.name,
            input: b.input as Record<string, unknown>,
          }
        }
        return null
      })
      .filter((b): b is ContentBlock => b !== null)

    const text = content
      .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('')

    const toolCalls = content
      .filter((b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use')
      .map((b) => ({ id: b.id, name: b.name, input: b.input }))

    const stopReason: StopReason = (() => {
      switch (response.stop_reason) {
        case 'end_turn': return 'end_turn'
        case 'tool_use': return 'tool_use'
        case 'max_tokens': return 'max_tokens'
        case 'stop_sequence': return 'stop_sequence'
        default: return 'end_turn'
      }
    })()

    const usage = response.usage as unknown as {
      input_tokens: number
      output_tokens: number
      cache_read_input_tokens?: number
    }
    return {
      content,
      stopReason,
      usage: {
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        cachedInputTokens: usage.cache_read_input_tokens,
      },
      text,
      toolCalls,
    }
  }

  // ─────────────── Multi-key rotation ───────────────

  private parseKeys(): string[] {
    const multi = this.config.get<string>('ANTHROPIC_API_KEYS')
    if (multi) {
      return multi.split(',').map((s) => s.trim()).filter(Boolean)
    }
    const single = this.config.get<string>('ANTHROPIC_API_KEY')
    return single ? [single] : []
  }

  private async callWithRotation<T>(fn: (client: Anthropic) => Promise<T>): Promise<T> {
    if (this.clients.length === 0) {
      throw new AiAdapterError('No Anthropic API keys configured', 'anthropic', false)
    }

    let lastError: unknown
    for (let attempt = 0; attempt < this.clients.length; attempt++) {
      const idx = (this.rrIndex + attempt) % this.clients.length
      try {
        const result = await fn(this.clients[idx])
        this.rrIndex = (idx + 1) % this.clients.length
        return result
      } catch (err) {
        lastError = err
        const status = (err as { status?: number }).status
        if (status === 401 || status === 429) {
          this.logger.warn(`Key ${idx} rejected (status=${status}), rotating...`)
          continue
        }
        // Non-retryable error
        throw new AiAdapterError(
          (err as Error).message,
          'anthropic',
          false,
          err,
        )
      }
    }

    throw new AiAdapterError(
      `All ${this.clients.length} Anthropic keys failed: ${(lastError as Error)?.message}`,
      'anthropic',
      true,
      lastError,
    )
  }
}
