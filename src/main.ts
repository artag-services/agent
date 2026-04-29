import { NestFactory } from '@nestjs/core'
import { Logger, ValidationPipe } from '@nestjs/common'
import { AppModule } from './app.module'
import { HttpExceptionFilter } from './common/filters/http-exception.filter'

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule)

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  )
  app.useGlobalFilters(new HttpExceptionFilter())

  const port = process.env.PORT ?? 3011
  await app.listen(port)

  const logger = new Logger('Bootstrap')
  logger.log(`Agent service running on port ${port}`)
  logger.log(`Provider: ${process.env.AI_PROVIDER ?? 'anthropic'}`)
  // AUTH_TODO: when JWT auth is enabled globally, wire app.useGlobalGuards(new JwtAuthGuard()) here
}

bootstrap()
