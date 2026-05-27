# Agent Service

> Orquestador AI vendor-neutral con 21+ tools y memoria persistente. Maneja conversaciones que pueden ejecutar acciones en cualquier microservicio del sistema.

## Qué hace

Microservicio de **IA orquestadora**. Recibe un mensaje en lenguaje natural y:

1. Llama a un LLM (Claude/GPT/cualquier OpenAI-compatible) con tools definidas para cada microservicio
2. Si el LLM decide usar tools, las ejecuta (publica a RabbitMQ a los routing keys correspondientes)
3. Devuelve los resultados al LLM, que decide qué hacer después
4. Repite el loop hasta que el LLM da una respuesta final
5. Persiste la conversación completa + cada tool execution

Ejemplo: "Mandale un WhatsApp a Juan diciendo que llegamos tarde, y también programa un email recordatorio para mañana" → el agent:
- Usa `send_whatsapp` tool
- Usa `schedule_task` tool con cron de mañana → `channels.email.send`
- Responde "Listo, mensaje enviado a Juan y email programado para 09:00 de mañana"

## Stack

| Pieza | Valor |
|---|---|
| Framework | NestJS 10 |
| Lenguaje | TypeScript 5 |
| DB | PostgreSQL (`agent_db`) — `Conversation`, `Message`, `ToolExecution`, `Memory` |
| Cache | Redis |
| Mensajería | RabbitMQ — exchange `channels` |
| Providers AI soportados | Anthropic (Claude), OpenAI-compatible (OpenAI, Nvidia NIM, Groq, Together, OpenRouter, DeepSeek, xAI Grok, Mistral) |
| Puerto | `3011` |

## Adapter pattern — vendor-neutral

El servicio NO está atado a un provider. Implementa `AiAdapter` interface y tiene 3 implementaciones:

- **`AnthropicAdapter`** — Claude vía `@anthropic-ai/sdk`. Soporta prompt caching ephemeral (1h TTL, -90% costo en re-prompts), streaming nativo, tool use.
- **`OpenAiAdapter`** — Cualquier API compatible con OpenAI (incluye OpenAI, Nvidia NIM, Groq, Together AI, OpenRouter, DeepSeek, xAI Grok, Mistral). Configurable via `OPENAI_BASE_URL`.
- **`LocalAdapter`** — Stub para Ollama / LM Studio (Fase 2).

Switch entre providers: cambiás `AI_PROVIDER` en `.env` y rebooteás. Cero cambios de código.

### Multi-key support
Ambos providers soportan **round-robin con auto-rotación**: `ANTHROPIC_API_KEYS=key1,key2,key3` o `OPENAI_API_KEYS=key1,key2`. Si una key falla con 429 o 401, rota al siguiente automáticamente.

## Tools disponibles (21+)

| Área | Tools |
|---|---|
| **Mensajería (7)** | `send_whatsapp`, `send_slack_message`, `send_instagram_dm`, `send_facebook_message`, `send_email`, `create_notion_page`, `create_notion_task` |
| **Scheduler (6)** | `schedule_task`, `list_scheduled_tasks`, `pause_scheduled_task`, `resume_scheduled_task`, `delete_scheduled_task`, `trigger_scheduled_task_now` |
| **Scraping (3)** | `scrape_url`, `get_scraping_result`, `list_scraping_jobs` |
| **Identity (3)** | `find_or_create_user`, `list_users`, `get_identity_report` |
| **Memoria (4)** | `remember_fact`, `recall_fact`, `forget_fact`, `list_memories` |

Cada tool es un wrapper de ~10 líneas que publica al routing key del microservicio destino. Para agregar una nueva: implementás la interface `Tool` y la registrás en `ToolsModule.onModuleInit()`.

## Memoria persistente (Obsidian-like)

Tabla `Memory` con `(userId, key, value, type)`. El agente puede:
- `remember_fact("default_email_signature", "Saludos, Chris")` — guarda
- `recall_fact("default_email_signature")` — recupera

**Auto-injection en el system prompt**: al inicio de cada conversación, el orchestrator lee TODAS las memorias del `userId` y las inyecta al system prompt. Eso hace que el agente "recuerde" entre sesiones — si le dijiste "mi número de WhatsApp es X", en futuras conversaciones lo va a usar sin que se lo repitas.

## Streaming via SSE bus

El orchestrator publica eventos lifecycle a RabbitMQ que el SSE bus del gateway retransmite al frontend:

- `channels.agent.events.message-started`
- `channels.agent.events.text-delta` (cada chunk del LLM)
- `channels.agent.events.tool-use-start` (cuando decide usar una tool)
- `channels.agent.events.tool-use-end` (cuando la tool termina)
- `channels.agent.events.message-completed`
- `channels.agent.events.error`

Frontend: `new EventSource('/api/v1/events?topics=agent:<conversationId>')`.

## Routing keys

| Routing key | Tipo |
|---|---|
| `channels.agent.chat` | inbound RPC |
| `channels.agent.conversations.list` | inbound RPC |
| `channels.agent.conversations.get` | inbound RPC |
| `channels.agent.conversations.delete` | inbound RPC |
| `channels.agent.memories.list` | inbound RPC |
| `channels.agent.memories.delete` | inbound RPC |
| `channels.agent.response` | outbound (RPC responses) |
| `channels.agent.events.*` | outbound broadcast (para SSE) |

## Endpoints HTTP (vía gateway)

| Método | Path |
|---|---|
| POST | `/api/v1/agent/chat` |
| GET | `/api/v1/agent/conversations` |
| GET | `/api/v1/agent/conversations/:id` |
| DELETE | `/api/v1/agent/conversations/:id` |
| GET | `/api/v1/agent/memories?userId=...` |
| DELETE | `/api/v1/agent/memories/:userId/:key` |

## Configuración (`.env`)

```env
AGENT_PORT=3011
AGENT_DATABASE_URL=postgresql://postgres:postgres123@postgres:5432/agent_db
RABBITMQ_URL=...
REDIS_HOST=redis
REDIS_PORT=6379

# Provider selection
AI_PROVIDER=anthropic                # o "openai" para usar cualquier OpenAI-compatible

# Anthropic
ANTHROPIC_API_KEY=sk-ant-...         # o ANTHROPIC_API_KEYS=key1,key2 para round-robin
ANTHROPIC_MODEL=claude-haiku-4-5

# OpenAI-compatible (works for Nvidia/Groq/Together/etc. via OPENAI_BASE_URL)
OPENAI_API_KEY=sk-...                # o OPENAI_API_KEYS=...
OPENAI_MODEL=gpt-4o-mini
OPENAI_BASE_URL=                     # blank = OpenAI; o ej "https://integrate.api.nvidia.com/v1"

# Lifecycle
AGENT_CONVERSATION_TTL_MS=2592000000   # 30 días
```

## Cómo correrlo

```bash
docker-compose up -d agent
```

Dev local:
```bash
cd agent
pnpm install
pnpm prisma:generate
pnpm start:dev
```

## Ejemplo de uso desde el frontend

```javascript
// 1) Conectar al SSE para recibir streaming
const events = new EventSource('/api/v1/events?topics=agent:*')
events.addEventListener('agent:text-delta', e => console.log(JSON.parse(e.data).delta))
events.addEventListener('agent:tool-use-end', e => console.log('Tool used:', JSON.parse(e.data)))

// 2) Mandar el chat
const res = await fetch('/api/v1/agent/chat', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    message: 'Mandate un email a tu propia cuenta diciendo "hola test"',
    userId: 'scristxyz',
    enableStreaming: true
  })
}).then(r => r.json())

console.log(res.finalText)
console.log('Tools usadas:', res.toolsUsed)
```

## Seguridad — pendiente para producción

- ⚠️ **No hay tool whitelisting por usuario** — todo usuario tiene acceso a todas las tools. Pendiente: filtro por permisos en `ToolRegistry.getAvailable(userId)`.
- ⚠️ **No hay confirmation flow** para tools destructivas (delete, mass-send). Pendiente: marcar tools con `requiresConfirmation: true`.
- ⚠️ **No hay rate limiting** por usuario. Pendiente: contador en Redis por userId.

## Ver también

- **[../docs/api/](../docs/api/)** — API reference general
- **[../AGENTS.md](../AGENTS.md)** — patrón arquitectónico
- **[../scheduler/README.md](../scheduler/README.md)** — donde se programan tareas
- **[../email/README.md](../email/README.md)** — donde se envían emails
