import {
  Controller,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  UseGuards,
} from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { RabbitMQService } from '../rabbitmq/rabbitmq.service'
import { AdminGuard } from './admin.guard'
import { ConversationStatus, MessageRole } from '@prisma/client'

const PAGE = 200 // smaller pages — agent messages have a heavier `content` Json column
const SLEEP_MS_EVERY_N = 100

interface ContentBlock {
  type: string
  text?: string
}

/**
 * One-shot CQRS backfill for the agent service. For each Conversation:
 *   - `data.agent.conversation.created` for the conversation itself
 *   - `data.agent.conversation.deleted` if status === DELETED (tombstone)
 *   - `data.agent.message.received` per USER message
 *   - `data.agent.message.sent` per FINAL ASSISTANT message
 *     ("final" = the last assistant turn before either a USER or end of
 *     conversation — i.e. NOT the assistant rounds that contain only
 *     tool_use blocks and were followed by tool/user turns)
 *
 * Auth: `X-Admin-Token: <ADMIN_BACKFILL_TOKEN>`.
 */
@Controller('admin')
@UseGuards(AdminGuard)
export class BackfillController {
  private readonly logger = new Logger(BackfillController.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly rabbitmq: RabbitMQService,
  ) {}

  @Post('backfill-events')
  @HttpCode(HttpStatus.OK)
  async backfill() {
    const started = Date.now()
    let convs = 0
    let userMsgs = 0
    let assistantMsgs = 0
    let published = 0

    for (let skip = 0; ; skip += PAGE) {
      const conversations = await this.prisma.conversation.findMany({
        skip,
        take: PAGE,
        orderBy: { createdAt: 'asc' },
      })
      if (conversations.length === 0) break
      convs += conversations.length

      for (const conv of conversations) {
        const channelUserId = conv.userId ?? conv.id

        // Conversation snapshot
        await this.rabbitmq.publish('data.agent.conversation.created', {
          conversationId: conv.id,
          userId: conv.userId,
          channel: 'agent',
          channelUserId,
          topic: conv.title ?? null,
          status: conv.status,
          aiEnabled: true,
          createdAt: conv.createdAt.toISOString(),
        })
        published++

        if (conv.status === ConversationStatus.DELETED) {
          await this.rabbitmq.publish('data.agent.conversation.deleted', {
            conversationId: conv.id,
            channel: 'agent',
            deletedAt: conv.updatedAt.toISOString(),
          })
          published++
        }

        // Messages: stream in order and only emit the user-visible surface.
        const messages = await this.prisma.message.findMany({
          where: { conversationId: conv.id },
          orderBy: { createdAt: 'asc' },
        })

        for (let i = 0; i < messages.length; i++) {
          const m = messages[i]
          const text = this.extractText(m.content)

          if (m.role === MessageRole.USER) {
            await this.rabbitmq.publish('data.agent.message.received', {
              messageId: m.id,
              conversationId: conv.id,
              userId: conv.userId,
              senderId: channelUserId,
              channelUserId,
              content: text,
              timestamp: m.createdAt.toISOString(),
            })
            userMsgs++
            published++
          } else if (m.role === MessageRole.ASSISTANT) {
            // "Final" assistant turn = the next message is either USER or
            // there's no next message. Intermediate assistant turns are the
            // ones followed by TOOL rows (the tool-use loop).
            const next = messages[i + 1]
            const isFinal = !next || next.role === MessageRole.USER
            if (isFinal && text.trim()) {
              await this.rabbitmq.publish('data.agent.message.sent', {
                messageId: m.id,
                conversationId: conv.id,
                userId: conv.userId,
                recipient: channelUserId,
                channelUserId,
                content: text,
                timestamp: m.createdAt.toISOString(),
              })
              assistantMsgs++
              published++
            }
          }
          // TOOL / SYSTEM rows are not projected.

          if (published % SLEEP_MS_EVERY_N === 0) await this.sleep(10)
        }
      }
    }

    const durationMs = Date.now() - started
    this.logger.log(
      `Backfill done: convs=${convs} userMsgs=${userMsgs} assistantMsgs=${assistantMsgs} published=${published} durationMs=${durationMs}`,
    )
    return { service: 'agent', conversations: convs, userMessages: userMsgs, assistantMessages: assistantMsgs, published, durationMs }
  }

  /**
   * Extract the rendered text from the agent's vendor-neutral content shape:
   *   { blocks: [{ type: 'text', text: '...' }, { type: 'tool_use', ... }] }
   * We only keep text blocks. For assistant rounds that contain ONLY tool_use,
   * this returns '' — caller treats those as non-final and skips them.
   */
  private extractText(content: unknown): string {
    if (!content || typeof content !== 'object') return ''
    const data = content as { blocks?: ContentBlock[] }
    if (!Array.isArray(data.blocks)) return ''
    return data.blocks
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n')
      .trim()
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms))
  }
}
