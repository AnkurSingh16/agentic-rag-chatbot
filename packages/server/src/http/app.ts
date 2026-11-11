import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import type { FastifyBaseLogger, FastifyInstance, FastifyRequest } from 'fastify';
import { pino } from 'pino';
import type { DestinationStream } from 'pino';
import { z } from 'zod';
import { ChatbotError, MAX_MESSAGE_CHARS, isChatbotError, runChat } from '@agentic-rag/core';
import type {
  ChatEvent,
  ChatModel,
  EmbeddingProvider,
  ErrorCode,
  InstanceConfig,
  RetrievalStore,
} from '@agentic-rag/core';
import type { ChatStore } from '../store/chat-store.js';
import { MinuteRateLimiter, ipKey } from './limits.js';
import { createSessionSigner } from './session.js';

/** Request body cap from ADR 0004. */
export const BODY_LIMIT_BYTES = 8 * 1024;
const PING_INTERVAL_MS = 15_000;

/**
 * Log fields removed by pino: message text, session tokens and credentials (ADR 0005). Usage log
 * lines carry only counts and names.
 */
// Error messages under `err` stay readable: ChatbotError messages are written to be safe to log.
export const LOG_REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-session-token"]',
  'body',
  'message',
  'text',
  'content',
  'token',
  'apiKey',
  '*.apiKey',
];

/** A pino logger with the platform's redaction rules. */
export function createLogger(
  options: { level?: string; destination?: DestinationStream } = {},
): FastifyBaseLogger {
  return pino(
    { level: options.level ?? 'info', redact: { paths: LOG_REDACT_PATHS, censor: '[redacted]' } },
    options.destination,
  );
}

export interface ChatServerOptions {
  instances: readonly InstanceConfig[];
  retrieval: RetrievalStore;
  chatStore: ChatStore;
  chatModel: ChatModel;
  /** The embedding provider of each instance, by instance ID. */
  embeddings: ReadonlyMap<string, EmbeddingProvider>;
  /** The answer and routing models of each instance, by instance ID. */
  models: ReadonlyMap<string, { chat: string; router: string }>;
  sessionSecret: string;
  /** Proxy addresses or CIDR ranges whose X-Forwarded-For header is trusted (ADR 0004). */
  trustedProxies?: readonly string[];
  logger?: FastifyBaseLogger;
  now?: () => number;
  pingIntervalMs?: number;
  deadlineMs?: number;
}

const STATUS: Readonly<Record<ErrorCode, number>> = {
  invalid_input: 400,
  invalid_config: 500,
  not_found: 404,
  unauthenticated: 401,
  forbidden: 403,
  rate_limited: 429,
  budget_exceeded: 429,
  provider_unavailable: 503,
  internal: 500,
};

const chatBodySchema = z.strictObject({
  message: z
    .string()
    .min(1)
    .max(MAX_MESSAGE_CHARS * 2),
  conversationId: z.uuid().optional(),
});

const ALLOWED_HEADERS = 'content-type, accept, x-session-token';

function errorBody(error: ChatbotError) {
  return { error: { code: error.code, retryable: error.retryable } };
}

function sseFrame(event: ChatEvent): string {
  return `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
}

/**
 * Builds the chat API for public-mode instances: health, instance config, session issuance and
 * chat with SSE or JSON responses. Limits are checked in the order of ADR 0004: body size,
 * message length, requests per minute per IP, daily requests per IP and per instance, then turns
 * per session.
 */
export function createChatServer(options: ChatServerOptions): FastifyInstance {
  const instances = new Map(options.instances.map((config) => [config.id, config]));
  const sessions = createSessionSigner(options.sessionSecret, options.now);
  const minuteLimiter = new MinuteRateLimiter(options.now);
  const trusted = options.trustedProxies ?? [];
  let warnedForwardedFor = false;

  const app = Fastify({
    loggerInstance: options.logger ?? createLogger(),
    bodyLimit: BODY_LIMIT_BYTES,
    trustProxy: trusted.length > 0 ? [...trusted] : false,
    genReqId: () => randomUUID(),
  });

  app.setErrorHandler((error, request, reply) => {
    if (isChatbotError(error)) {
      if (STATUS[error.code] >= 500) request.log.error({ err: error }, 'request failed');
      return reply.code(STATUS[error.code]).send(errorBody(error));
    }
    const status =
      typeof error === 'object' && error !== null && 'statusCode' in error
        ? Number(error.statusCode)
        : 500;
    if (status >= 400 && status < 500) {
      return reply.code(status).send({ error: { code: 'invalid_input', retryable: false } });
    }
    request.log.error({ err: error }, 'request failed');
    return reply.code(500).send({ error: { code: 'internal', retryable: false } });
  });
  app.setNotFoundHandler((_request, reply) =>
    reply.code(404).send({ error: { code: 'not_found', retryable: false } }),
  );

  function instanceOf(request: FastifyRequest): InstanceConfig {
    const { id } = request.params as { id: string };
    const config = instances.get(id);
    if (config === undefined) throw new ChatbotError('not_found', `Unknown instance "${id}"`);
    return config;
  }

  function clientKey(request: FastifyRequest): string {
    if (!warnedForwardedFor && trusted.length === 0 && request.headers['x-forwarded-for']) {
      warnedForwardedFor = true;
      request.log.warn(
        'X-Forwarded-For received but TRUSTED_PROXIES is empty; using the socket address, so every client behind that proxy shares one limit',
      );
    }
    return ipKey(request.ip);
  }

  // CORS from each instance's allowedOrigins. A browser request from any other origin is refused
  // outright rather than only hidden from the page, so it cannot spend tokens.
  app.addHook('onRequest', async (request, reply) => {
    const { id } = (request.params ?? {}) as { id?: string };
    const origin = request.headers.origin;
    if (id === undefined || origin === undefined) return;
    const config = instances.get(id);
    if (config === undefined) return;
    if (!config.allowedOrigins.includes(origin)) {
      throw new ChatbotError('forbidden', `Origin ${origin} is not allowed for "${id}"`);
    }
    reply.header('access-control-allow-origin', origin);
    reply.header('vary', 'Origin');
  });

  app.options('/v1/instances/:id/:action', async (request, reply) => {
    instanceOf(request);
    return reply
      .code(204)
      .header('access-control-allow-methods', 'GET, POST, OPTIONS')
      .header('access-control-allow-headers', ALLOWED_HEADERS)
      .header('access-control-max-age', '600')
      .send();
  });

  app.get('/health', () => ({ status: 'ok' }));

  app.get('/v1/instances/:id/config', (request) => {
    const config = instanceOf(request);
    return {
      id: config.id,
      displayName: config.displayName,
      mode: config.auth.mode,
      theme: config.theme ?? {},
    };
  });

  app.post('/v1/instances/:id/session', (request) => {
    const config = instanceOf(request);
    // Issuance shares the per-IP minute budget, so new sessions cannot be minted faster than
    // requests are allowed (ADR 0004).
    if (
      !minuteLimiter.take(
        `${config.id}:${clientKey(request)}`,
        config.limits.requestsPerMinutePerIp,
      )
    ) {
      throw new ChatbotError('rate_limited', 'Too many requests from this address');
    }
    const session = sessions.issue(config.id);
    return { token: session.token, expiresAt: session.expiresAt.toISOString() };
  });

  app.post('/v1/instances/:id/chat', async (request, reply) => {
    const config = instanceOf(request);
    const header = request.headers['x-session-token'];
    const session = typeof header === 'string' ? sessions.verify(header, config.id) : undefined;
    if (session === undefined) {
      throw new ChatbotError('unauthenticated', 'Missing, invalid or expired session token');
    }
    const body = chatBodySchema.safeParse(request.body);
    if (!body.success) throw new ChatbotError('invalid_input', 'Invalid chat request body');
    if (body.data.message.trim().length > MAX_MESSAGE_CHARS) {
      throw new ChatbotError(
        'invalid_input',
        `Message is longer than ${MAX_MESSAGE_CHARS} characters`,
      );
    }

    const ip = clientKey(request);
    const { limits } = config;
    if (!minuteLimiter.take(`${config.id}:${ip}`, limits.requestsPerMinutePerIp)) {
      throw new ChatbotError('rate_limited', 'Too many requests from this address');
    }
    const ipScope = `ip:${ip}`;
    const totals = await options.chatStore.consumeUsage(config.id, [ipScope, 'instance'], {
      tokens: 0,
      requests: 1,
    });
    const requestsFor = (scope: string) =>
      totals.find((total) => total.scope === scope)?.requests ?? 0;
    if (requestsFor(ipScope) > limits.dailyRequestsPerIp) {
      throw new ChatbotError('budget_exceeded', 'Daily request limit for this address reached');
    }
    if (requestsFor('instance') > limits.dailyRequests) {
      throw new ChatbotError('budget_exceeded', `Daily request limit for "${config.id}" reached`);
    }

    const owner = { instanceId: config.id, ownerKey: session.ownerKey };
    const conversation = await options.chatStore.openConversation(owner, body.data.conversationId);
    if (conversation.turns >= limits.maxTurnsPerSession) {
      throw new ChatbotError('rate_limited', 'Turn limit for this session reached');
    }

    const embeddings = options.embeddings.get(config.id);
    const models = options.models.get(config.id);
    if (embeddings === undefined || models === undefined) {
      throw new ChatbotError('invalid_config', `Instance "${config.id}" is not fully configured`);
    }

    const wantsJson = (request.headers.accept ?? '').includes('application/json');
    const controller = new AbortController();
    const events: ChatEvent[] = [];
    let streaming = false;
    let ping: NodeJS.Timeout | undefined;

    const emit = (event: ChatEvent) => {
      if (streaming) reply.raw.write(sseFrame(event));
      else events.push(event);
    };

    if (!wantsJson) {
      reply.hijack();
      reply.raw.writeHead(200, {
        ...(reply.getHeaders() as Record<string, string>),
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      streaming = true;
      ping = setInterval(
        () => reply.raw.write(': ping\n\n'),
        options.pingIntervalMs ?? PING_INTERVAL_MS,
      );
    }
    let finished = false;
    reply.raw.on('close', () => {
      if (!finished) controller.abort();
    });

    try {
      const outcome = await runChat({
        config,
        access: { instanceId: config.id, tenantKey: '_', accessTags: ['public'] },
        requestId: request.id,
        conversationId: conversation.conversationId,
        message: body.data.message,
        history: conversation.history,
        chatModel: options.chatModel,
        models,
        embeddings,
        retrieval: options.retrieval,
        signal: controller.signal,
        emit,
        ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
        onModelCall: async (call) => {
          request.log.info(
            {
              event: 'model_call',
              instance: config.id,
              node: call.node,
              provider: call.provider,
              model: call.model,
              inputTokens: call.usage.inputTokens,
              outputTokens: call.usage.outputTokens,
              cacheReadTokens: call.usage.cacheReadTokens,
              cacheWriteTokens: call.usage.cacheWriteTokens,
            },
            'model call',
          );
          const tokens =
            call.usage.inputTokens +
            call.usage.outputTokens +
            call.usage.cacheReadTokens +
            call.usage.cacheWriteTokens;
          // The answer is already being paid for; a failed counter update is logged rather than
          // ending the turn, and the log line above still records the spend.
          await options.chatStore
            .consumeUsage(config.id, [ipScope, 'instance'], { tokens, requests: 0 })
            .catch((error: unknown) => {
              request.log.error({ err: error }, 'could not record token usage');
            });
        },
      });
      finished = true;
      await options.chatStore
        .appendTurn(owner, conversation.conversationId, body.data.message.trim(), outcome.text)
        .catch((error: unknown) => {
          request.log.error({ err: error }, 'could not store the conversation turn');
        });
      if (!streaming) {
        const citations = events.flatMap((event) =>
          event.event === 'citation' ? [event.data] : [],
        );
        return await reply.send({
          requestId: request.id,
          conversationId: conversation.conversationId,
          indexVersion: outcome.indexVersion,
          state: outcome.state,
          text: outcome.text,
          citationIds: outcome.citationIds,
          citations,
          usage: outcome.usage,
        });
      }
    } catch (error) {
      finished = true;
      if (!streaming) throw error;
      const failure = isChatbotError(error)
        ? error
        : new ChatbotError('internal', 'Chat turn failed', { cause: error });
      if (STATUS[failure.code] >= 500) request.log.error({ err: failure }, 'chat turn failed');
      if (!controller.signal.aborted) {
        reply.raw.write(
          sseFrame({ event: 'error', data: { code: failure.code, retryable: failure.retryable } }),
        );
      }
    } finally {
      if (ping !== undefined) clearInterval(ping);
      if (streaming) reply.raw.end();
    }
    return reply;
  });

  return app;
}
