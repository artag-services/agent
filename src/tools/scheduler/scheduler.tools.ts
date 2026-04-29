import { Injectable } from '@nestjs/common'
import { RabbitMQService } from '../../rabbitmq/rabbitmq.service'
import { Tool } from '../tool.interface'

/**
 * Tools that operate on the scheduler microservice. The agent can program
 * recurring or one-shot tasks that fire any other tool's underlying routing
 * key when their schedule hits.
 */
@Injectable()
export class SchedulerTools {
  constructor(private readonly rabbitmq: RabbitMQService) {}

  getTools(): Tool[] {
    return [
      this.scheduleTask(),
      this.listTasks(),
      this.pauseTask(),
      this.resumeTask(),
      this.deleteTask(),
      this.triggerTaskNow(),
    ]
  }

  private scheduleTask(): Tool {
    return {
      definition: {
        name: 'schedule_task',
        description:
          'Create a scheduled task. The task publishes its `payload` to the given `targetRoutingKey` when fired. Use targetRoutingKey="channels.email.send" to schedule emails, "channels.whatsapp.send" for WhatsApp, etc.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            description: { type: 'string' },
            scheduleType: { type: 'string', enum: ['CRON', 'INTERVAL', 'ONCE'] },
            cronExpression: { type: 'string', description: '5-field cron, required if CRON' },
            intervalMs: { type: 'number', description: 'required if INTERVAL, min 1000' },
            runAt: { type: 'string', description: 'ISO datetime, required if ONCE' },
            timezone: { type: 'string', description: 'default America/Bogota' },
            targetRoutingKey: { type: 'string' },
            payload: { type: 'object' },
          },
          required: ['name', 'scheduleType', 'targetRoutingKey', 'payload'],
        },
      },
      execute: async (input) => {
        const result = await this.rabbitmq.rpc<{
          correlationId: string
          success: boolean
          [k: string]: unknown
        }>(
          'channels.scheduler.create',
          'channels.scheduler.response',
          input as Record<string, unknown>,
        )
        if (!result.success) throw new Error((result.error as string) ?? 'Schedule create failed')
        return result
      },
    }
  }

  private listTasks(): Tool {
    return {
      definition: {
        name: 'list_scheduled_tasks',
        description: 'List all scheduled tasks (active and paused).',
        inputSchema: { type: 'object', properties: {} },
      },
      execute: async () => {
        const result = await this.rabbitmq.rpc<{ tasks?: unknown[]; success: boolean }>(
          'channels.scheduler.list',
          'channels.scheduler.response',
          {},
        )
        return result.tasks ?? []
      },
    }
  }

  private pauseTask(): Tool {
    return {
      definition: {
        name: 'pause_scheduled_task',
        description: 'Pause a scheduled task by id (stops firing but keeps history).',
        inputSchema: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
      },
      execute: async (input) => {
        return this.rabbitmq.rpc(
          'channels.scheduler.pause',
          'channels.scheduler.response',
          input as Record<string, unknown>,
        )
      },
    }
  }

  private resumeTask(): Tool {
    return {
      definition: {
        name: 'resume_scheduled_task',
        description: 'Resume a paused scheduled task by id.',
        inputSchema: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
      },
      execute: async (input) => {
        return this.rabbitmq.rpc(
          'channels.scheduler.resume',
          'channels.scheduler.response',
          input as Record<string, unknown>,
        )
      },
    }
  }

  private deleteTask(): Tool {
    return {
      definition: {
        name: 'delete_scheduled_task',
        description: 'Delete a scheduled task by id permanently.',
        inputSchema: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
      },
      execute: async (input) => {
        this.rabbitmq.publish('channels.scheduler.delete', input as Record<string, unknown>)
        return { id: input.id, deleted: true }
      },
    }
  }

  private triggerTaskNow(): Tool {
    return {
      definition: {
        name: 'trigger_scheduled_task_now',
        description: 'Trigger a scheduled task immediately, ignoring its schedule.',
        inputSchema: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
      },
      execute: async (input) => {
        this.rabbitmq.publish('channels.scheduler.trigger-now', input as Record<string, unknown>)
        return { id: input.id, triggered: true }
      },
    }
  }
}
