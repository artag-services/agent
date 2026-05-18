import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'

import { PrismaModule } from './prisma/prisma.module'
import { RedisModule } from './redis/redis.module'
import { RabbitMQModule } from './rabbitmq/rabbitmq.module'
import { AdaptersModule } from './adapters/adapters.module'
import { MemoryModule } from './memory/memory.module'
import { AgentModule } from './agent/agent.module'
import { AdminModule } from './admin/admin.module'
// AUTH_TODO: import { JwtModule } from '@nestjs/jwt'
// AUTH_TODO: import { PassportModule } from '@nestjs/passport'

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: '.env' }),

    // Global infra
    PrismaModule,
    RedisModule,
    RabbitMQModule,

    // AI adapters (Anthropic / OpenAI / Local) — picked by AI_PROVIDER env
    AdaptersModule,

    // Persistent memory (Obsidian-like)
    MemoryModule,

    // Orchestrator + tool registry + RabbitMQ consumer
    AgentModule,

    // Admin (CQRS backfill etc.)
    AdminModule,

    // AUTH_TODO: enable when JWT is activated globally
    // PassportModule.register({ defaultStrategy: 'jwt' }),
    // JwtModule.register({
    //   secret: process.env.JWT_SECRET,
    //   signOptions: { expiresIn: process.env.JWT_EXPIRATION ?? '1h' },
    // }),
  ],
})
export class AppModule {}
