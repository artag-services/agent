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

/**
 * CQRS routing keys consumed by sync-service. Producer-side rule: always
 * emit AFTER Postgres has committed. Final-reply emission only fires for
 * the user-visible response, NOT for intermediate tool-loop iterations.
 */
const DATA_EVENTS = {
  CONVERSATION_CREATED: 'data.agent.conversation.created',
  CONVERSATION_DELETED: 'data.agent.conversation.deleted',
  MESSAGE_RECEIVED: 'data.agent.message.received',
  MESSAGE_SENT: 'data.agent.message.sent',
} as const

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
    const { conversation, wasCreated } = await this.loadOrCreateConversation(
      req.conversationId,
      req.userId,
    )
    if (wasCreated) {
      this.publishDataEvent(DATA_EVENTS.CONVERSATION_CREATED, {
        conversationId: conversation.id,
        userId: conversation.userId,
        channel: 'agent',
        // The agent owner doubles as channelUserId — read model needs a value.
        channelUserId: conversation.userId ?? conversation.id,
        topic: conversation.title ?? null,
        status: conversation.status,
        aiEnabled: true,
        createdAt: conversation.createdAt.toISOString(),
      })
    }

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
    const userMessage = await this.persistMessage(conversation.id, MessageRole.USER, [
      { type: 'text', text: req.message },
    ])

    // CQRS: announce the user turn to the read model.
    this.publishDataEvent(DATA_EVENTS.MESSAGE_RECEIVED, {
      messageId: userMessage.id,
      conversationId: conversation.id,
      userId: req.userId ?? conversation.userId,
      senderId: req.userId ?? conversation.userId ?? conversation.id,
      channelUserId: req.userId ?? conversation.userId ?? conversation.id,
      content: req.message,
      timestamp: userMessage.createdAt.toISOString(),
    })

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
      const assistantMessage = await this.persistMessage(
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

        // CQRS: announce the user-visible reply to the read model. Only
        // fires for FINAL replies — intermediate tool-loop iterations are
        // not projected (they're agent-internal debug info).
        this.publishDataEvent(DATA_EVENTS.MESSAGE_SENT, {
          messageId: assistantMessage.id,
          conversationId: conversation.id,
          userId: req.userId ?? conversation.userId,
          recipient: req.userId ?? conversation.userId ?? conversation.id,
          channelUserId: req.userId ?? conversation.userId ?? conversation.id,
          content: result.text,
          timestamp: assistantMessage.createdAt.toISOString(),
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
  ): Promise<{ conversation: Conversation; wasCreated: boolean }> {
    if (conversationId) {
      const existing = await this.prisma.conversation.findUnique({ where: { id: conversationId } })
      if (existing && existing.status === ConversationStatus.ACTIVE) {
        return { conversation: existing, wasCreated: false }
      }
    }

    const adapter = this.adapters.get()
    const conversation = await this.prisma.conversation.create({
      data: {
        userId,
        provider: adapter.name,
        status: ConversationStatus.ACTIVE,
        expiresAt: new Date(Date.now() + this.conversationTtlMs),
      },
    })
    return { conversation, wasCreated: true }
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
  ): Promise<Message> {
    return this.prisma.message.create({
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

  /**
   * Same as publishEvent but specifically for `data.*` CQRS routing keys.
   * Kept separate for grep-ability and so we can log differently if needed.
   */
  private publishDataEvent(routingKey: string, payload: Record<string, unknown>): void {
    try {
      this.rabbitmq.publish(routingKey, payload)
    } catch (err) {
      this.logger.warn(
        `Failed to publish CQRS event ${routingKey}: ${(err as Error).message}`,
      )
    }
  }
}
