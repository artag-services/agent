import { Injectable } from '@nestjs/common'
import { RabbitMQService } from '../../rabbitmq/rabbitmq.service'
import { Tool } from '../tool.interface'

@Injectable()
export class IdentityTools {
  constructor(private readonly rabbitmq: RabbitMQService) {}

  getTools(): Tool[] {
    return [this.findUser(), this.listUsers(), this.getIdentityReport()]
  }

  private findUser(): Tool {
    return {
      definition: {
        name: 'find_or_create_user',
        description:
          'Find a user by their channel-specific ID (or create a new user if not found). Useful for resolving a WhatsApp/Instagram/Slack contact into a unified user.',
        inputSchema: {
          type: 'object',
          properties: {
            channel: { type: 'string', description: 'whatsapp / instagram / slack / etc' },
            channelUserId: { type: 'string' },
            displayName: { type: 'string' },
            phone: { type: 'string' },
            email: { type: 'string' },
          },
          required: ['channel', 'channelUserId'],
        },
      },
      execute: async (input) => {
        // Identity resolve is fire-and-forget per its API
        this.rabbitmq.publish('channels.identity.resolve', input as Record<string, unknown>)
        return { queued: true, message: 'Identity resolution queued (no immediate id returned)' }
      },
    }
  }

  private listUsers(): Tool {
    return {
      definition: {
        name: 'list_users',
        description: 'List unified users, optionally filtered by channel.',
        inputSchema: {
          type: 'object',
          properties: {
            channel: { type: 'string' },
            includeDeleted: { type: 'boolean' },
          },
        },
      },
      execute: async (input) => {
        const result = await this.rabbitmq.rpc<{ users?: unknown[] } & { correlationId: string }>(
          'channels.identity.get_all_users',
          'identity.responses',
          { filters: input },
        )
        return result.users ?? []
      },
    }
  }

  private getIdentityReport(): Tool {
    return {
      definition: {
        name: 'get_identity_report',
        description:
          'Get aggregate stats: total users, users by channel, deleted, average identities per user.',
        inputSchema: { type: 'object', properties: {} },
      },
      execute: async () => {
        const result = await this.rabbitmq.rpc<{ report?: unknown } & { correlationId: string }>(
          'channels.identity.get_report',
          'identity.responses',
          {},
        )
        return result.report ?? {}
      },
    }
  }
}
