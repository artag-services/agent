import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'

import { AiAdapter } from './ai-adapter.interface'
import { AiAdapterError, ChatInput, ChatResult, StreamChunk } from '../common/types'

/**
 * Stub for a local LLM adapter (Ollama, LM Studio, vLLM, etc.).
 *
 * Most local engines expose an OpenAI-compatible REST API, so the
 * implementation can largely mirror OpenAiAdapter pointing at a different
 * `baseURL`. Filling this out is a Fase 2/3 task — gated by:
 *  - Which engine the user picks (Ollama vs LM Studio vs custom)
 *  - Whether tool use is supported by the chosen model
 *
 * Activates when `AI_PROVIDER=local` in env.
 */
@Injectable()
export class LocalAdapter implements AiAdapter {
  readonly name = 'local'
  readonly supportsTools = false   // model-dependent — default conservative
  readonly supportsStreaming = false
  private readonly logger = new Logger(LocalAdapter.name)

  constructor(private readonly config: ConfigService) {
    const baseURL = this.config.get<string>('LOCAL_LLM_BASE_URL')
    if (!baseURL) {
      this.logger.warn('LOCAL_LLM_BASE_URL not set — LocalAdapter will throw on every call')
    } else {
      this.logger.log(`LocalAdapter configured for ${baseURL} (NOT IMPLEMENTED yet)`)
    }
  }

  async chat(_input: ChatInput): Promise<ChatResult> {
    throw new AiAdapterError(
      'LocalAdapter not implemented — set AI_PROVIDER=anthropic or openai',
      'local',
      false,
    )
  }

  async chatStream(_input: ChatInput, _onChunk: (chunk: StreamChunk) => void): Promise<ChatResult> {
    return this.chat(_input)
  }
}
