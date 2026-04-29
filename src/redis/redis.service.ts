import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import Redis from 'ioredis'

/**
 * Thin wrapper used by:
 *  - Conversation cache (warm convos held in memory for fast multi-turn)
 *  - Rate limiting per userId (chat budget)
 *  - Future: prompt fragment cache (template warming)
 */
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name)
  private client: Redis | null = null

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    const host = this.config.get<string>('REDIS_HOST') ?? 'redis'
    const port = Number(this.config.get<string>('REDIS_PORT') ?? 6379)
    this.client = new Redis({ host, port, lazyConnect: true })
    this.client
      .connect()
      .then(() => this.logger.log(`Redis connected → ${host}:${port}`))
      .catch((err) => this.logger.error(`Redis connect failed: ${(err as Error).message}`))
  }

  async onModuleDestroy(): Promise<void> {
    await this.client?.quit()
  }

  get raw(): Redis {
    if (!this.client) throw new Error('Redis not initialized')
    return this.client
  }

  async setJson(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    const json = JSON.stringify(value)
    if (ttlSeconds) {
      await this.raw.set(key, json, 'EX', ttlSeconds)
    } else {
      await this.raw.set(key, json)
    }
  }

  async getJson<T>(key: string): Promise<T | null> {
    const raw = await this.raw.get(key)
    if (!raw) return null
    try {
      return JSON.parse(raw) as T
    } catch {
      return null
    }
  }

  async incr(key: string, ttlSeconds?: number): Promise<number> {
    const value = await this.raw.incr(key)
    if (value === 1 && ttlSeconds) {
      await this.raw.expire(key, ttlSeconds)
    }
    return value
  }

  async del(key: string): Promise<void> {
    await this.raw.del(key)
  }
}
