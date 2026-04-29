import { Injectable } from '@nestjs/common'
import { MemoryType } from '@prisma/client'
import { MemoryService } from '../../memory/memory.service'
import { Tool } from '../tool.interface'

/**
 * Tools the agent uses to manage its own persistent memory about a user.
 * The orchestrator auto-injects all stored memories into every system
 * prompt, so anything the agent remembers here persists across sessions.
 */
@Injectable()
export class MemoryTools {
  constructor(private readonly memory: MemoryService) {}

  getTools(): Tool[] {
    return [this.remember(), this.recall(), this.forget(), this.listMemories()]
  }

  private remember(): Tool {
    return {
      definition: {
        name: 'remember_fact',
        description:
          'Store a fact, preference, or piece of context about the user. Use a stable, descriptive key (e.g. "default_email_signature", "preferred_whatsapp_number", "favorite_color"). Calling again with the same key updates the value.',
        inputSchema: {
          type: 'object',
          properties: {
            key: { type: 'string' },
            value: { type: 'string' },
            type: {
              type: 'string',
              enum: ['FACT', 'PREFERENCE', 'CONTACT', 'TASK', 'NOTE'],
              description: 'Default FACT',
            },
          },
          required: ['key', 'value'],
        },
      },
      execute: async (input, ctx) => {
        if (!ctx.userId) throw new Error('No userId in context — cannot remember per-user fact')
        const type = (input.type as MemoryType) ?? MemoryType.FACT
        const memory = await this.memory.remember(
          ctx.userId,
          input.key as string,
          input.value as string,
          type,
        )
        return { id: memory.id, key: memory.key, type: memory.type }
      },
    }
  }

  private recall(): Tool {
    return {
      definition: {
        name: 'recall_fact',
        description: 'Look up a specific memory by key. Returns null if not found.',
        inputSchema: {
          type: 'object',
          properties: { key: { type: 'string' } },
          required: ['key'],
        },
      },
      execute: async (input, ctx) => {
        if (!ctx.userId) throw new Error('No userId in context')
        const m = await this.memory.recall(ctx.userId, input.key as string)
        return m ? { key: m.key, value: m.value, type: m.type, updatedAt: m.updatedAt } : null
      },
    }
  }

  private forget(): Tool {
    return {
      definition: {
        name: 'forget_fact',
        description: 'Delete a memory by key.',
        inputSchema: {
          type: 'object',
          properties: { key: { type: 'string' } },
          required: ['key'],
        },
      },
      execute: async (input, ctx) => {
        if (!ctx.userId) throw new Error('No userId in context')
        await this.memory.forget(ctx.userId, input.key as string)
        return { key: input.key, forgotten: true }
      },
    }
  }

  private listMemories(): Tool {
    return {
      definition: {
        name: 'list_memories',
        description: 'List all stored memories about the user. Optional filter by type.',
        inputSchema: {
          type: 'object',
          properties: {
            type: {
              type: 'string',
              enum: ['FACT', 'PREFERENCE', 'CONTACT', 'TASK', 'NOTE'],
            },
          },
        },
      },
      execute: async (input, ctx) => {
        if (!ctx.userId) throw new Error('No userId in context')
        const list = await this.memory.list(ctx.userId, input.type as MemoryType | undefined)
        return list.map((m) => ({ key: m.key, value: m.value, type: m.type }))
      },
    }
  }
}
