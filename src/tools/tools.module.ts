import { Module, OnModuleInit } from '@nestjs/common'
import { ToolRegistry } from './registry/tool.registry'
import { MessagingTools } from './messaging/messaging.tools'
import { SchedulerTools } from './scheduler/scheduler.tools'
import { ScrapingTools } from './scraping/scraping.tools'
import { IdentityTools } from './identity/identity.tools'
import { MemoryTools } from './memory-tools/memory.tools'

@Module({
  providers: [
    ToolRegistry,
    MessagingTools,
    SchedulerTools,
    ScrapingTools,
    IdentityTools,
    MemoryTools,
  ],
  exports: [ToolRegistry],
})
export class ToolsModule implements OnModuleInit {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly messaging: MessagingTools,
    private readonly scheduler: SchedulerTools,
    private readonly scraping: ScrapingTools,
    private readonly identity: IdentityTools,
    private readonly memoryTools: MemoryTools,
  ) {}

  onModuleInit(): void {
    this.registry.registerAll([
      ...this.messaging.getTools(),
      ...this.scheduler.getTools(),
      ...this.scraping.getTools(),
      ...this.identity.getTools(),
      ...this.memoryTools.getTools(),
    ])
  }
}
