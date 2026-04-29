import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'

import { AiAdapter } from './ai-adapter.interface'
import { AnthropicAdapter } from './anthropic.adapter'
import { OpenAiAdapter } from './openai.adapter'
import { LocalAdapter } from './local.adapter'

/**
 * Picks the active AI adapter based on `AI_PROVIDER` env (default: anthropic).
 *
 * Adding a new provider:
 *   1. Implement `AiAdapter` (see anthropic.adapter.ts as reference)
 *   2. Inject + register here
 *   3. Add to AdaptersModule providers
 */
@Injectable()
export class AdapterFactory {
  private readonly logger = new Logger(AdapterFactory.name)
  private readonly active: AiAdapter

  constructor(
    private readonly config: ConfigService,
    private readonly anthropic: AnthropicAdapter,
    private readonly openai: OpenAiAdapter,
    private readonly local: LocalAdapter,
  ) {
    const provider = (this.config.get<string>('AI_PROVIDER') ?? 'anthropic').toLowerCase()
    switch (provider) {
      case 'anthropic':
        this.active = this.anthropic
        break
      case 'openai':
        this.active = this.openai
        break
      case 'local':
      case 'ollama':
        this.active = this.local
        break
      default:
        this.logger.warn(`Unknown AI_PROVIDER="${provider}", falling back to anthropic`)
        this.active = this.anthropic
    }
    this.logger.log(`Active AI adapter: ${this.active.name}`)
  }

  get(): AiAdapter {
    return this.active
  }
}
