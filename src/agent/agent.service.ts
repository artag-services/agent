import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import {
  Conversation,
  ConversationStatus,
  Message,
  MessageRole,
  Prisma,
} from '@prisma/client'

import { PrismaService } from '../prisma/prisma.service'
import { RabbitMQService } from '../rabbitmq/rabbitmq.service'
import { ROUTING_KEYS } from '../rabbitmq/constants/queues'
import { AdapterFactory } from '../adapters/adapter.factory'
import { MemoryService } from '../memory/memory.service'
import { ToolRegistry } from '../tools/registry/tool.registry'
import {
  ChatMessage,
  ChatResult,
  ContentBlock,
  StreamChunk,
  ToolDefinition,
  ToolExecutionContext,
} from '../common/types'
import { buildSystemPrompt } from './system-prompt'

interface ChatRequest {
  message: string
  conversationId?: string
  userId?: string
  enableStreaming?: boolean
}

interface ChatResponse {
  conversationId: string
  finalText: string
  toolsUsed: Array<{ name: string; input: unknown; output: unknown; error?: string }>
  usage: { inputTokens: number; outputTokens: number; cachedTokens: number }
}

const MAX_TOOL_LOOP_ITERATIONS = 10

@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name)
  private readonly conversationTtlMs: number

  constructor(
    private readonly prisma: PrismaService,
    private readonly rabbitmq: RabbitMQService,
    private readonly adapters: AdapterFactory,
    private readonly memory: MemoryService,
    private readonly tools: ToolRegistry,
    private readonly config: ConfigService,
  ) {
    this.conversationTtlMs = Number(
      this.config.get('AGENT_CONVERSATION_TTL_MS', 30 * 24 * 60 * 60 * 1000), // 30 days
    )
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const conversation = await this.loadOrCreateConversation(req.conversationId, req.userId)
    const previousMessages = await this.loadMessages(conversation.id)

    // Build the message list for the LLM (vendor-neutral)
    const messages: ChatMessage[] = previousMessages.map((m) => ({
      role: m.role === MessageRole.USER ? 'user' : 'assistant',
      content: this.parseContent(m.content),
    }))
    messages.push({
      role: 'user',
      content: [{ type: 'text', text: req.message }],
    })

    // Inject memory into system prompt
    const memorySection = req.userId ? await this.memory.formatAsPromptContext(req.userId) : null
    const systemPrompt = buildSystemPrompt(memorySection, req.userId)

    // Persist the user message before calling the LLM
    await this.persistMessage(conversation.id, MessageRole.USER, [
      { type: 'text', text: req.message },
    ])

    this.publishEvent(ROUTING_KEYS.EVENT_MESSAGE_STARTED, {
      conversationId: conversation.id,
      userId: req.userId,
    })

    const adapter = this.adapters.get()
    const tools: ToolDefinition[] = this.tools.getAvailable(req.userId)
    const toolsUsed: ChatResponse['toolsUsed'] = []
    let totalInputTokens = 0
    let totalOutputTokens = 0
    let totalCachedTokens = 0

    // ─────────── Tool use loop ───────────
    for (let iter = 0; iter < MAX_TOOL_LOOP_ITERATIONS; iter++) {
      const result = req.enableStreaming
        ? await adapter.chatStream(
            { messages, systemPrompt, tools, enableCache: true },
            (chunk) => this.handleStreamChunk(chunk, conversation.id),
          )
        : await adapter.chat({ messages, systemPrompt, tools, enableCache: true })

      totalInputTokens += result.usage.inputTokens
      totalOutputTokens += result.usage.outputTokens
      totalCachedTokens += result.usage.cachedInputTokens ?? 0

      // Persist assistant message with all blocks (including tool_use)
      await this.persistMessage(
        conversation.id,
        MessageRole.ASSISTANT,
        result.content,
        result.usage.inputTokens,
        result.usage.outputTokens,
        result.usage.cachedInputTokens,
      )
      messages.push({ role: 'assistant', content: result.content })

      if (result.stopReason !== 'tool_use' || result.toolCalls.length === 0) {
        // Final answer
        this.publishEvent(ROUTING_KEYS.EVENT_MESSAGE_COMPLETED, {
          conversationId: conversation.id,
          userId: req.userId,
          finalText: result.text,
          toolsUsed: toolsUsed.length,
        })

        return {
          conversationId: conversation.id,
          finalText: result.text,
          toolsUsed,
          usage: {
            inputTokens: totalInputTokens,
            outputTokens: totalOutputTokens,
            cachedTokens: totalCachedTokens,
          },
        }
      }

      // Execute each tool call in parallel
      const toolResults: ContentBlock[] = await Promise.all(
        result.toolCalls.map(async (call) => {
          const ctx: ToolExecutionContext = {
            conversationId: conversation.id,
            userId: req.userId,
            toolUseId: call.id,
          }
          this.publishEvent(ROUTING_KEYS.EVENT_TOOL_USE_START, {
            conversationId: conversation.id,
            toolUseId: call.id,
            toolName: call.name,
            input: call.input,
          })

          const startedAt = Date.now()
          let output: unknown
          let isError = false
          let errorMessage: string | undefined
          try {
            output = await this.tools.execute(call.name, call.input, ctx)
          } catch (err) {
            isError = true
            errorMessage = (err as Error).message
            output = { error: errorMessage }
          }
          const durationMs = Date.now() - startedAt

          // Persist
          await this.prisma.toolExecution.create({
            data: {
              conversationId: conversation.id,
              toolUseId: call.id,
              toolName: call.name,
              input: call.input as Prisma.InputJsonValue,
              output: output as Prisma.InputJsonValue,
              error: errorMessage,
              durationMs,
            },
          })

          toolsUsed.push({ name: call.name, input: call.input, output, error: errorMessage })

          this.publishEvent(ROUTING_KEYS.EVENT_TOOL_USE_END, {
            conversationId: conversation.id,
            toolUseId: call.id,
            toolName: call.name,
            output,
            error: errorMessage,
            durationMs,
          })

          return {
            type: 'tool_result' as const,
            toolUseId: call.id,
            content: JSON.stringify(output),
            ...(isError ? { isError: true } : {}),
          }
        }),
      )

      // Persist tool results as a TOOL message and add to context
      await this.persistMessage(conversation.id, MessageRole.TOOL, toolResults)
      messages.push({ role: 'tool', content: toolResults })
    }

    // Loop exhausted — emit error and return a generic message
    const errorText = `Tool loop exceeded ${MAX_TOOL_LOOP_ITERATIONS} iterations. Aborting.`
    this.logger.error(errorText)
    this.publishEvent(ROUTING_KEYS.EVENT_ERROR, {
      conversationId: conversation.id,
      error: errorText,
    })
    return {
      conversationId: conversation.id,
      finalText: errorText,
      toolsUsed,
      usage: {
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        cachedTokens: totalCachedTokens,
      },
    }
  }

  // ─────────────── Streaming ───────────────

  private handleStreamChunk(chunk: StreamChunk, conversationId: string): void {
    if (chunk.type === 'text_delta') {
      this.publishEvent(ROUTING_KEYS.EVENT_TEXT_DELTA, {
        conversationId,
        delta: chunk.delta,
      })
    }
    // tool_use_start/end events are emitted explicitly during execution above;
    // we deliberately don't double-emit them from the SDK stream.
  }

  // ─────────────── DB helpers ───────────────

  private async loadOrCreateConversation(
    conversationId?: string,
    userId?: string,
  ): Promise<Conversation> {
    if (conversationId) {
      const existing = await this.prisma.conversation.findUnique({ where: { id: conversationId } })
      if (existing && existing.status === ConversationStatus.ACTIVE) return existing
    }

    const adapter = this.adapters.get()
    return this.prisma.conversation.create({
      data: {
        userId,
        provider: adapter.name,
        status: ConversationStatus.ACTIVE,
        expiresAt: new Date(Date.now() + this.conversationTtlMs),
      },
    })
  }

  private async loadMessages(conversationId: string): Promise<Message[]> {
    return this.prisma.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'asc' },
    })
  }

  private parseContent(content: unknown): ContentBlock[] {
    if (!content || typeof content !== 'object') return []
    const data = content as { blocks?: ContentBlock[] }
    return data.blocks ?? []
  }

  private async persistMessage(
    conversationId: string,
    role: MessageRole,
    blocks: ContentBlock[],
    tokensIn?: number,
    tokensOut?: number,
    cachedTokens?: number,
  ): Promise<void> {
    await this.prisma.message.create({
      data: {
        conversationId,
        role,
        content: { blocks } as unknown as Prisma.InputJsonValue,
        tokensIn,
        tokensOut,
        cachedTokens,
      },
    })
  }

  // ─────────────── Events ───────────────

  private publishEvent(routingKey: string, payload: Record<string, unknown>): void {
    try {
      this.rabbitmq.publish(routingKey, payload)
    } catch (err) {
      this.logger.warn(`Failed to publish event ${routingKey}: ${(err as Error).message}`)
    }
  }
}
