import { Injectable } from '@nestjs/common'
import { v4 as uuid } from 'uuid'
import { RabbitMQService } from '../../rabbitmq/rabbitmq.service'
import { Tool } from '../tool.interface'

/**
 * Messaging tools: sending messages through any of the supported channels.
 * Each tool publishes to the channel-specific routing key on RabbitMQ.
 * Per project pattern: the agent does NOT call the gateway — it speaks
 * RabbitMQ directly, like any other internal service.
 */
@Injectable()
export class MessagingTools {
  constructor(private readonly rabbitmq: RabbitMQService) {}

  getTools(): Tool[] {
    return [
      this.sendWhatsapp(),
      this.sendSlack(),
      this.sendInstagramDm(),
      this.sendFacebookMessage(),
      this.sendEmail(),
      this.createNotionPage(),
      this.createNotionTask(),
    ]
  }

  // ─────────────── WhatsApp ───────────────
  private sendWhatsapp(): Tool {
    return {
      definition: {
        name: 'send_whatsapp',
        description:
          'Send a WhatsApp message to one or more recipients. Recipients must be phone numbers with country code, no plus sign (e.g. "573205711428"). Optionally attach an image/video by URL.',
        inputSchema: {
          type: 'object',
          properties: {
            recipients: { type: 'array', items: { type: 'string' }, description: 'Phone numbers' },
            message: { type: 'string' },
            mediaUrl: { type: 'string', description: 'Optional public URL of media to attach' },
          },
          required: ['recipients', 'message'],
        },
      },
      execute: async (input) => {
        const messageId = uuid()
        this.rabbitmq.publish('channels.whatsapp.send', {
          messageId,
          recipients: input.recipients,
          message: input.message,
          mediaUrl: input.mediaUrl,
        })
        return { messageId, queued: true }
      },
    }
  }

  // ─────────────── Slack ───────────────
  private sendSlack(): Tool {
    return {
      definition: {
        name: 'send_slack_message',
        description:
          'Send a Slack message to a channel (id starts with C) or user (id starts with U). Supports Slack markdown (*bold*, _italic_, `code`, :emoji:).',
        inputSchema: {
          type: 'object',
          properties: {
            recipients: { type: 'array', items: { type: 'string' } },
            message: { type: 'string' },
            mediaUrl: { type: 'string' },
          },
          required: ['recipients', 'message'],
        },
      },
      execute: async (input) => {
        const messageId = uuid()
        this.rabbitmq.publish('channels.slack.send', {
          messageId,
          recipients: input.recipients,
          message: input.message,
          mediaUrl: input.mediaUrl,
        })
        return { messageId, queued: true }
      },
    }
  }

  // ─────────────── Instagram ───────────────
  private sendInstagramDm(): Tool {
    return {
      definition: {
        name: 'send_instagram_dm',
        description:
          'Send a direct message on Instagram. Recipients must be IGSIDs (Instagram Scoped User IDs, numeric strings). Note: you can only message users who have messaged your IG Business account first.',
        inputSchema: {
          type: 'object',
          properties: {
            recipients: { type: 'array', items: { type: 'string' } },
            message: { type: 'string' },
            mediaUrl: { type: 'string' },
          },
          required: ['recipients', 'message'],
        },
      },
      execute: async (input) => {
        const messageId = uuid()
        this.rabbitmq.publish('channels.instagram.send', {
          messageId,
          recipients: input.recipients,
          message: input.message,
          mediaUrl: input.mediaUrl,
        })
        return { messageId, queued: true }
      },
    }
  }

  // ─────────────── Facebook ───────────────
  private sendFacebookMessage(): Tool {
    return {
      definition: {
        name: 'send_facebook_message',
        description:
          'Send a Facebook Messenger message via the Page. Recipients must be PSIDs (Page-Scoped User IDs). Inside the 24h window use messaging_type=RESPONSE; outside use MESSAGE_TAG with a valid tag.',
        inputSchema: {
          type: 'object',
          properties: {
            recipients: { type: 'array', items: { type: 'string' } },
            message: { type: 'string' },
            mediaUrl: { type: 'string' },
            messaging_type: {
              type: 'string',
              enum: ['RESPONSE', 'UPDATE', 'MESSAGE_TAG'],
            },
            tag: { type: 'string' },
          },
          required: ['recipients', 'message'],
        },
      },
      execute: async (input) => {
        const messageId = uuid()
        this.rabbitmq.publish('channels.facebook.send', {
          messageId,
          recipients: input.recipients,
          message: input.message,
          mediaUrl: input.mediaUrl,
          metadata: {
            messaging_type: input.messaging_type ?? 'RESPONSE',
            tag: input.tag,
          },
        })
        return { messageId, queued: true }
      },
    }
  }

  // ─────────────── Email ───────────────
  private sendEmail(): Tool {
    return {
      definition: {
        name: 'send_email',
        description:
          'Send a transactional email via the email service (Resend by default). Provide either html, text, or both. Optional idempotencyKey prevents duplicate sends.',
        inputSchema: {
          type: 'object',
          properties: {
            to: { type: 'array', items: { type: 'string' }, description: 'Recipient emails' },
            cc: { type: 'array', items: { type: 'string' } },
            bcc: { type: 'array', items: { type: 'string' } },
            from: { type: 'string', description: 'Override default From address' },
            replyTo: { type: 'string' },
            subject: { type: 'string' },
            html: { type: 'string' },
            text: { type: 'string' },
            idempotencyKey: { type: 'string' },
          },
          required: ['to', 'subject'],
        },
      },
      execute: async (input) => {
        const result = await this.rabbitmq.rpc<{
          correlationId: string
          success: boolean
          email?: { id: string; status: string }
          error?: string
        }>(
          'channels.email.send',
          'channels.email.response',
          input as Record<string, unknown>,
          30_000,
        )
        if (!result.success) throw new Error(result.error ?? 'Email send failed')
        return result.email
      },
    }
  }

  // ─────────────── Notion ───────────────
  private createNotionPage(): Tool {
    return {
      definition: {
        name: 'create_notion_page',
        description:
          'Create a new page in Notion under a parent page. Use this when the user asks to save notes, meeting summaries, or general docs in Notion.',
        inputSchema: {
          type: 'object',
          properties: {
            parent_page_id: { type: 'string', description: 'UUID of the parent page in Notion' },
            title: { type: 'string' },
            content: { type: 'string', description: 'Body content (text or JSON)' },
            icon: { type: 'string', description: 'Optional emoji icon' },
          },
          required: ['parent_page_id', 'title', 'content'],
        },
      },
      execute: async (input) => {
        const messageId = uuid()
        this.rabbitmq.publish('channels.notion.send', {
          messageId,
          operation: 'create_page',
          message: input.content,
          metadata: {
            parent_page_id: input.parent_page_id,
            title: input.title,
            icon: input.icon ?? '📝',
          },
        })
        return { messageId, queued: true }
      },
    }
  }

  private createNotionTask(): Tool {
    return {
      definition: {
        name: 'create_notion_task',
        description:
          'Create a task entry in a Notion database. Use when the user wants to track a TODO, task, or item with due date and assignee.',
        inputSchema: {
          type: 'object',
          properties: {
            database_id: { type: 'string', description: 'UUID of the Notion database' },
            title: { type: 'string' },
            due_date: { type: 'string', description: 'ISO datetime' },
            assignee_ids: { type: 'array', items: { type: 'string' } },
            priority: { type: 'string', enum: ['High', 'Medium', 'Low'] },
          },
          required: ['database_id', 'title'],
        },
      },
      execute: async (input) => {
        const messageId = uuid()
        this.rabbitmq.publish('channels.notion.send', {
          messageId,
          operation: 'create_task',
          message: input.title,
          metadata: {
            database_id: input.database_id,
            title_property: 'Name',
            due_date: input.due_date,
            assignee_ids: input.assignee_ids,
            priority: input.priority,
          },
        })
        return { messageId, queued: true }
      },
    }
  }
}
