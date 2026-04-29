/**
 * RabbitMQ contracts for the agent microservice.
 *
 * Pattern:
 *  - Inbound from gateway: chat (RPC with correlationId), CRUD reads on conversations/memories
 *  - Outbound: tool dispatches (publishes to whatever routing key the tool needs — no scoped to agent)
 *  - Outbound lifecycle events: per-message-step events for SSE streaming
 *  - Outbound RPC responses: channels.agent.response
 */

export const RABBITMQ_EXCHANGE = process.env.RABBITMQ_EXCHANGE ?? 'channels'

export const ROUTING_KEYS = {
  // Inbound: gateway → agent
  CHAT: 'channels.agent.chat',
  LIST_CONVERSATIONS: 'channels.agent.conversations.list',
  GET_CONVERSATION: 'channels.agent.conversations.get',
  DELETE_CONVERSATION: 'channels.agent.conversations.delete',
  LIST_MEMORIES: 'channels.agent.memories.list',
  DELETE_MEMORY: 'channels.agent.memories.delete',

  // Outbound: agent → gateway (RPC responses)
  RESPONSE: 'channels.agent.response',

  // Outbound broadcast lifecycle events (consumed by gateway SSE bus)
  EVENT_MESSAGE_STARTED: 'channels.agent.events.message-started',
  EVENT_TEXT_DELTA: 'channels.agent.events.text-delta',
  EVENT_TOOL_USE_START: 'channels.agent.events.tool-use-start',
  EVENT_TOOL_USE_END: 'channels.agent.events.tool-use-end',
  EVENT_MESSAGE_COMPLETED: 'channels.agent.events.message-completed',
  EVENT_ERROR: 'channels.agent.events.error',

  // Tool dispatches — the agent uses these (existing routing keys of other services)
  // These are NOT defined here as new contracts; the agent imports the exact routing
  // keys from each target service's contract documentation.
} as const

export const QUEUES = {
  CHAT: 'agent.chat',
  LIST_CONVERSATIONS: 'agent.conversations.list',
  GET_CONVERSATION: 'agent.conversations.get',
  DELETE_CONVERSATION: 'agent.conversations.delete',
  LIST_MEMORIES: 'agent.memories.list',
  DELETE_MEMORY: 'agent.memories.delete',
} as const
