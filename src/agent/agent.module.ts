import { Module } from '@nestjs/common'
import { AgentService } from './agent.service'
import { AgentConsumer } from './agent.consumer'
import { ToolsModule } from '../tools/tools.module'

@Module({
  imports: [ToolsModule],
  providers: [AgentService, AgentConsumer],
  exports: [AgentService],
})
export class AgentModule {}
