import { Injectable, Logger } from '@nestjs/common'
import { Memory, MemoryType, Prisma } from '@prisma/client'
import { PrismaService } from '../prisma/prisma.service'

/**
 * Per-user persistent memory. Acts like a lightweight Obsidian: each entry
 * is `(key, value, type)` scoped to a userId. The orchestrator auto-loads
 * preferences/facts into the system prompt so the agent "remembers"
 * between sessions without re-asking.
 */
@Injectable()
export class MemoryService {
  private readonly logger = new Logger(MemoryService.name)

  constructor(private readonly prisma: PrismaService) {}

  async remember(
    userId: string,
    key: string,
    value: string,
    type: MemoryType = MemoryType.FACT,
    metadata?: Record<string, unknown>,
  ): Promise<Memory> {
    const result = await this.prisma.memory.upsert({
      where: { userId_key: { userId, key } },
      update: { value, type, metadata: metadata as Prisma.InputJsonValue | undefined },
      create: { userId, key, value, type, metadata: metadata as Prisma.InputJsonValue | undefined },
    })
    this.logger.log(`📝 Remembered "${key}" for user ${userId} (type=${type})`)
    return result
  }

  async recall(userId: string, key: string): Promise<Memory | null> {
    return this.prisma.memory.findUnique({ where: { userId_key: { userId, key } } })
  }

  async forget(userId: string, key: string): Promise<void> {
    await this.prisma.memory.deleteMany({ where: { userId, key } })
    this.logger.log(`🗑️ Forgot "${key}" for user ${userId}`)
  }

  async list(userId: string, type?: MemoryType): Promise<Memory[]> {
    return this.prisma.memory.findMany({
      where: { userId, ...(type ? { type } : {}) },
      orderBy: { updatedAt: 'desc' },
    })
  }

  /**
   * Format all memories for a user as a markdown block to inject into the
   * system prompt. Returns null if user has no memories.
   */
  async formatAsPromptContext(userId: string): Promise<string | null> {
    const memories = await this.list(userId)
    if (memories.length === 0) return null

    const byType = memories.reduce<Record<string, Memory[]>>((acc, m) => {
      acc[m.type] = acc[m.type] ?? []
      acc[m.type].push(m)
      return acc
    }, {})

    const sections: string[] = []
    for (const [type, items] of Object.entries(byType)) {
      sections.push(`### ${type}`)
      for (const m of items) {
        sections.push(`- **${m.key}**: ${m.value}`)
      }
    }

    return [
      '## What I remember about this user',
      '',
      ...sections,
      '',
      'Use this context to personalize responses. Update it via the `remember_fact` tool when the user shares new info.',
    ].join('\n')
  }
}
