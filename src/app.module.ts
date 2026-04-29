import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'

import { PrismaModule } from './prisma/prisma.module'
import { RedisModule } from './redis/redis.module'
import { RabbitMQModule } from './rabbitmq/rabbitmq.module'
import { AdaptersModule } from './adapters/adapters.module'
// AUTH_TODO: import { JwtModule } from '@nestjs/jwt'
// AUTH_TODO: import { PassportModule } from '@nestjs/passport'

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: '.env' }),

    PrismaModule,
    RedisModule,
    RabbitMQModule,
    AdaptersModule,

    // AUTH_TODO: enable when JWT is activated globally
    // PassportModule.register({ defaultStrategy: 'jwt' }),
    // JwtModule.register({
    //   secret: process.env.JWT_SECRET,
    //   signOptions: { expiresIn: process.env.JWT_EXPIRATION ?? '1h' },
    // }),

    // OrchestratorModule, ToolsModule, MemoryModule, ConversationsModule
    // ↑ wired in next iteration
  ],
})
export class AppModule {}
