import { Injectable } from '@nestjs/common'
import { v4 as uuid } from 'uuid'
import { RabbitMQService } from '../../rabbitmq/rabbitmq.service'
import { Tool } from '../tool.interface'

@Injectable()
export class ScrapingTools {
  constructor(private readonly rabbitmq: RabbitMQService) {}

  getTools(): Tool[] {
    return [this.scrapeUrl(), this.getScrapingResult(), this.listScrapingJobs()]
  }

  private scrapeUrl(): Tool {
    return {
      definition: {
        name: 'scrape_url',
        description:
          'Start a web scraping job. Strategy "auto" extracts title/sections/links/text without selectors (good for unknown sites). "extract" requires CSS selectors. Returns a jobId — listen for events on SSE topic scraping:<jobId> for the result.',
        inputSchema: {
          type: 'object',
          properties: {
            url: { type: 'string' },
            strategy: {
              type: 'string',
              enum: ['auto', 'extract', 'search', 'login_then_extract', 'login_then_search', 'custom_flow'],
            },
            selectors: {
              type: 'object',
              description: 'Map of name → CSS selector (or {css, attr} object)',
            },
          },
          required: ['url', 'strategy'],
        },
      },
      execute: async (input) => {
        const jobId = uuid()
        this.rabbitmq.publish('channels.scraping.task', { jobId, ...input })
        return {
          jobId,
          subscribeTo: `scraping:${jobId}`,
          message: 'Job queued — listen on SSE topic for completion',
        }
      },
    }
  }

  private getScrapingResult(): Tool {
    return {
      definition: {
        name: 'get_scraping_result',
        description: 'Get the current status and (if completed) result of a scraping job by id.',
        inputSchema: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
      },
      execute: async (input) => {
        const result = await this.rabbitmq.rpc<{ job?: unknown; success: boolean; error?: string }>(
          'channels.scraping.get',
          'channels.scraping.response',
          input as Record<string, unknown>,
        )
        if (!result.success) throw new Error(result.error ?? 'Scraping get failed')
        return result.job
      },
    }
  }

  private listScrapingJobs(): Tool {
    return {
      definition: {
        name: 'list_scraping_jobs',
        description: 'List recent scraping jobs (most recent first). Optional filter by userId.',
        inputSchema: {
          type: 'object',
          properties: {
            limit: { type: 'number' },
            userId: { type: 'string' },
          },
        },
      },
      execute: async (input) => {
        const result = await this.rabbitmq.rpc<{ jobs?: unknown[]; success: boolean }>(
          'channels.scraping.list',
          'channels.scraping.response',
          input as Record<string, unknown>,
        )
        return result.jobs ?? []
      },
    }
  }
}
