import { Global, Module } from '@nestjs/common'
import { AnthropicAdapter } from './anthropic.adapter'
import { OpenAiAdapter } from './openai.adapter'
import { LocalAdapter } from './local.adapter'
import { AdapterFactory } from './adapter.factory'

@Global()
@Module({
  providers: [AnthropicAdapter, OpenAiAdapter, LocalAdapter, AdapterFactory],
  exports: [AdapterFactory],
})
export class AdaptersModule {}
