import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import * as amqp from 'amqplib'
import { RABBITMQ_EXCHANGE } from './constants/queues'

@Injectable()
export class RabbitMQService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RabbitMQService.name)
  private connection: Awaited<ReturnType<typeof amqp.connect>> | null = null
  private channel: amqp.Channel | null = null

  constructor(private readonly config: ConfigService) {}

  async onModuleInit(): Promise<void> {
    await this.connect()
  }

  async onModuleDestroy(): Promise<void> {
    await this.disconnect()
  }

  private async connect(retries = 10, delayMs = 3000): Promise<void> {
    const url = this.config.get<string>('RABBITMQ_URL')
    if (!url) throw new Error('RABBITMQ_URL is not defined')

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        this.connection = await amqp.connect(url)
        this.channel = await this.connection.createChannel()
        await this.channel.assertExchange(RABBITMQ_EXCHANGE, 'topic', { durable: true })
        this.logger.log(`Connected to RabbitMQ — exchange [${RABBITMQ_EXCHANGE}]`)
        return
      } catch (err) {
        this.logger.warn(`RabbitMQ attempt ${attempt}/${retries} failed`)
        if (attempt === retries) throw err
        await new Promise((r) => setTimeout(r, delayMs))
      }
    }
  }

  private async disconnect(): Promise<void> {
    try {
      await this.channel?.close()
      await this.connection?.close()
    } catch {
      // ignore
    }
  }

  publish(routingKey: string, payload: Record<string, unknown>): void {
    if (!this.channel) throw new Error('RabbitMQ channel not available')
    const content = Buffer.from(JSON.stringify(payload))
    this.channel.publish(RABBITMQ_EXCHANGE, routingKey, content, {
      persistent: true,
      contentType: 'application/json',
    })
  }

  async subscribe(
    queue: string,
    routingKey: string,
    handler: (payload: Record<string, unknown>) => Promise<void>,
  ): Promise<void> {
    if (!this.channel) throw new Error('RabbitMQ channel not available')

    await this.channel.assertQueue(queue, { durable: true })
    await this.channel.bindQueue(queue, RABBITMQ_EXCHANGE, routingKey)
    this.channel.prefetch(1)

    await this.channel.consume(queue, async (msg) => {
      if (!msg) return
      try {
        const payload = JSON.parse(msg.content.toString()) as Record<string, unknown>
        await handler(payload)
        this.channel!.ack(msg)
      } catch (err) {
        this.logger.error(`Error processing [${queue}]`, err as Error)
        this.channel!.nack(msg, false, false)
      }
    })

    this.logger.log(`Subscribed → queue [${queue}] | routing key [${routingKey}]`)
  }

  /**
   * RPC client: publishes a request with a correlationId and waits on a
   * temporary response queue. Used by tools that need to query other
   * services synchronously.
   */
  async rpc<T = unknown>(
    routingKey: string,
    responseRoutingKey: string,
    payload: Record<string, unknown>,
    timeoutMs = 30_000,
  ): Promise<T> {
    if (!this.channel) throw new Error('RabbitMQ channel not available')

    const correlationId = `rpc-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const replyQueue = await this.channel.assertQueue('', { exclusive: true, autoDelete: true })
    await this.channel.bindQueue(replyQueue.queue, RABBITMQ_EXCHANGE, responseRoutingKey)

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error(`RPC timeout after ${timeoutMs}ms (rk=${routingKey})`))
      }, timeoutMs)

      let consumerTag: string | undefined
      const cleanup = () => {
        clearTimeout(timer)
        if (consumerTag) this.channel?.cancel(consumerTag).catch(() => {})
      }

      this.channel!.consume(
        replyQueue.queue,
        (msg) => {
          if (!msg) return
          const parsed = JSON.parse(msg.content.toString()) as { correlationId?: string } & T
          if (parsed.correlationId !== correlationId) return
          cleanup()
          resolve(parsed)
        },
        { noAck: true },
      ).then((res) => {
        consumerTag = res.consumerTag
      })

      this.channel!.publish(
        RABBITMQ_EXCHANGE,
        routingKey,
        Buffer.from(JSON.stringify({ correlationId, ...payload })),
        { persistent: true, contentType: 'application/json' },
      )
    })
  }
}
