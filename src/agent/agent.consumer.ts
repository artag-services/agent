import { Injectable, Logger, OnModuleInit } from '@nestjs/common'
import { RabbitMQService } from '../rabbitmq/rabbitmq.service'
import { QUEUES, ROUTING_KEYS } from '../rabbitmq/constants/queues'
import { AgentService } from './agent.service'
import { PrismaService } from '../prisma/prisma.service'
import { MemoryService } from '../memory/memory.service'
import { ConversationStatus, MemoryType } from '@prisma/client'

interface RpcEnvelope {
  correlationId?: string
  [k: string]: unknown
}

/**
 * Bridges RabbitMQ messages from the gateway into AgentService + admin
 * operations on conversations/memories.
 *
 * RPC pattern: every inbound carries a `correlationId`; we publish the
 * response on `ROUTING_KEYS.RESPONSE` echoing the same id.
 */
@Injectable()
export class AgentConsumer implements OnModuleInit {
  private readonly logger = new Logger(AgentConsumer.name)

  constructor(
    private readonly rabbitmq: RabbitMQService,
    private readonly agent: AgentService,
    private readonly prisma: PrismaService,
    private readonly memory: MemoryService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.rabbitmq.subscribe(QUEUES.CHAT, ROUTING_KEYS.CHAT, (p) => this.handle(p, 'chat'))
    await this.rabbitmq.subscribe(QUEUES.LIST_CONVERSATIONS, ROUTING_KEYS.LIST_CONVERSATIONS, (p) =>
      this.handle(p, 'list_conversations'),
    )
    await this.rabbitmq.subscribe(QUEUES.GET_CONVERSATION, ROUTING_KEYS.GET_CONVERSATION, (p) =>
      this.handle(p, 'get_conversation'),
    )
    await this.rabbitmq.subscribe(
      QUEUES.DELETE_CONVERSATION,
      ROUTING_KEYS.DELETE_CONVERSATION,
      (p) => this.handle(p, 'delete_conversation'),
    )
    await this.rabbitmq.subscribe(QUEUES.LIST_MEMORIES, ROUTING_KEYS.LIST_MEMORIES, (p) =>
      this.handle(p, 'list_memories'),
    )
    await this.rabbitmq.subscribe(QUEUES.DELETE_MEMORY, ROUTING_KEYS.DELETE_MEMORY, (p) =>
      this.handle(p, 'delete_memory'),
    )
  }

  private async handle(payload: Record<string, unknown>, op: string): Promise<void> {
    const env = payload as RpcEnvelope
    this.logger.log(`[${op}] correlationId=${env.correlationId ?? 'none'}`)

    try {
      const data = await this.dispatch(op, env)
      if (env.correlationId) this.respond(env.correlationId, true, data)
    } catch (err) {
      const message = (err as Error).message
      this.logger.error(`[${op}] failed: ${message}`)
      if (env.correlationId) this.respond(env.correlationId, false, { error: message })
    }
  }

  private async dispatch(op: string, env: RpcEnvelope): Promise<unknown> {
    switch (op) {
      case 'chat': {
        const { correlationId: _c, ...args } = env
        return this.agent.chat(args as never)
      }
      case 'list_conversations': {
        const { userId, limit = 50 } = env as { userId?: string; limit?: number }
        return {
          conversations: await this.prisma.conversation.findMany({
            where: { ...(userId ? { userId } : {}), status: ConversationStatus.ACTIVE },
            orderBy: { updatedAt: 'desc' },
            take: limit,
          }),
        }
      }
      case 'get_conversation': {
        const { id } = env as { id: string }
        if (!id) throw new Error('id is required')
        const conversation = await this.prisma.conversation.findUnique({
          where: { id },
          include: {
            messages: { orderBy: { createdAt: 'asc' } },
            toolExecutions: { orderBy: { createdAt: 'asc' } },
          },
        })
        return { conversation }
      }
      case 'delete_conversation': {
        const { id } = env as { id: string }
        if (!id) throw new Error('id is required')
        await this.prisma.conversation.update({
          where: { id },
          data: { status: ConversationStatus.DELETED },
        })
        return { id, deleted: true }
      }
      case 'list_memories': {
        const { userId, type } = env as { userId: string; type?: MemoryType }
        if (!userId) throw new Error('userId is required')
        return { memories: await this.memory.list(userId, type) }
      }
      case 'delete_memory': {
        const { userId, key } = env as { userId: string; key: string }
        if (!userId || !key) throw new Error('userId and key are required')
        await this.memory.forget(userId, key)
        return { userId, key, deleted: true }
      }
      default:
        throw new Error(`Unknown op: ${op}`)
    }
  }

  private respond(correlationId: string, success: boolean, data: unknown): void {
    this.rabbitmq.publish(ROUTING_KEYS.RESPONSE, {
      correlationId,
      success,
      ...(typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : { data }),
    })
  }
}
