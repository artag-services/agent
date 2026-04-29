import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import OpenAI from 'openai'

import { AiAdapter } from './ai-adapter.interface'
import {
  AiAdapterError,
  ChatInput,
  ChatMessage,
  ChatResult,
  ContentBlock,
  StopReason,
  StreamChunk,
} from '../common/types'

/**
 * OpenAI adapter — translates our `ContentBlock[]` representation into
 * OpenAI's `tool_calls` / `role: "tool"` format and back.
 *
 * Multi-key support via `OPENAI_API_KEYS` (comma-separated). Default model:
 * `OPENAI_MODEL` (default: gpt-4o-mini).
 */
@Injectable()
export class OpenAiAdapter implements AiAdapter {
  readonly name = 'openai'
  readonly supportsTools = true
  readonly supportsStreaming = true

  private readonly logger = new Logger(OpenAiAdapter.name)
  private readonly clients: OpenAI[]
  private readonly defaultModel: string
  private rrIndex = 0

  constructor(private readonly config: ConfigService) {
    const keys = this.parseKeys()
    this.clients = keys.map((apiKey) => new OpenAI({ apiKey }))
    this.defaultModel = this.config.get<string>('OPENAI_MODEL') ?? 'gpt-4o-mini'

    if (this.clients.length === 0) {
      this.logger.warn(
        'No OPENAI_API_KEY(S) configured — OpenAiAdapter will throw on every call',
      )
    } else {
      this.logger.log(
        `OpenAiAdapter ready with ${this.clients.length} key(s), model=${this.defaultModel}`,
      )
    }
  }

  async chat(input: ChatInput): Promise<ChatResult> {
    return this.callWithRotation(async (client) => {
      const response = await client.chat.completions.create({
        model: input.model ?? this.defaultModel,
        max_tokens: input.maxTokens ?? 4096,
        messages: this.translateMessages(input.systemPrompt, input.messages),
        tools: input.tools.length
          ? input.tools.map((t) => ({
              type: 'function' as const,
              function: {
                name: t.name,
                description: t.description,
                parameters: t.inputSchema,
              },
            }))
          : undefined,
      })
      return this.translateResponse(response)
    })
  }

  async chatStream(input: ChatInput, onChunk: (chunk: StreamChunk) => void): Promise<ChatResult> {
    // OpenAI streaming with tool_calls is more complex (tool_call args arrive
    // as deltas that must be reassembled). Implementing properly later;
    // for now delegate to buffered chat and emit synthetic chunks.
    onChunk({ type: 'message_start' })
    const result = await this.chat(input)
    for (const block of result.content) {
      if (block.type === 'text') {
        onChunk({ type: 'text_delta', delta: block.text })
      } else if (block.type === 'tool_use') {
        onChunk({ type: 'tool_use_end', id: block.id, input: block.input })
      }
    }
    onChunk({ type: 'message_end', stopReason: result.stopReason })
    return result
  }

  // ─────────────── Translation helpers ───────────────

  private translateMessages(systemPrompt: string, messages: ChatMessage[]) {
    const result: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
    ]

    for (const msg of messages) {
      if (msg.role === 'tool') {
        // Tool result blocks → one OpenAI tool message per block
        for (const block of msg.content) {
          if (block.type === 'tool_result') {
            result.push({
              role: 'tool',
              tool_call_id: block.toolUseId,
              content: block.content,
            })
          }
        }
        continue
      }

      if (msg.role === 'user') {
        const text = msg.content
          .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
          .map((b) => b.text)
          .join('')
        result.push({ role: 'user', content: text })
        continue
      }

      // assistant: text + optional tool_calls
      const textParts = msg.content
        .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
        .map((b) => b.text)
        .join('')
      const toolCalls = msg.content
        .filter((b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use')
        .map((b) => ({
          id: b.id,
          type: 'function' as const,
          function: { name: b.name, arguments: JSON.stringify(b.input) },
        }))
      result.push({
        role: 'assistant',
        content: textParts || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      })
    }

    return result
  }

  private translateResponse(response: OpenAI.Chat.ChatCompletion): ChatResult {
    const choice = response.choices[0]
    const msg = choice.message

    const content: ContentBlock[] = []
    if (msg.content) content.push({ type: 'text', text: msg.content })
    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        if (tc.type !== 'function') continue
        let parsed: Record<string, unknown> = {}
        try {
          parsed = JSON.parse(tc.function.arguments) as Record<string, unknown>
        } catch {
          // leave as empty
        }
        content.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input: parsed,
        })
      }
    }

    const text = msg.content ?? ''
    const toolCalls = content
      .filter((b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use')
      .map((b) => ({ id: b.id, name: b.name, input: b.input }))

    const stopReason: StopReason = (() => {
      switch (choice.finish_reason) {
        case 'stop': return 'end_turn'
        case 'tool_calls': return 'tool_use'
        case 'length': return 'max_tokens'
        default: return 'end_turn'
      }
    })()

    return {
      content,
      stopReason,
      usage: {
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
      },
      text,
      toolCalls,
    }
  }

  // ─────────────── Multi-key rotation ───────────────

  private parseKeys(): string[] {
    const multi = this.config.get<string>('OPENAI_API_KEYS')
    if (multi) return multi.split(',').map((s) => s.trim()).filter(Boolean)
    const single = this.config.get<string>('OPENAI_API_KEY')
    return single ? [single] : []
  }

  private async callWithRotation<T>(fn: (client: OpenAI) => Promise<T>): Promise<T> {
    if (this.clients.length === 0) {
      throw new AiAdapterError('No OpenAI API keys configured', 'openai', false)
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
        throw new AiAdapterError((err as Error).message, 'openai', false, err)
      }
    }

    throw new AiAdapterError(
      `All ${this.clients.length} OpenAI keys failed: ${(lastError as Error)?.message}`,
      'openai',
      true,
      lastError,
    )
  }
}
