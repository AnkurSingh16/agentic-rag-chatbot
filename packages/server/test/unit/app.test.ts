import { describe, expect, it } from 'vitest';
import {
  ChatbotError,
  createMockChatModel,
  createMockEmbeddingProvider,
  instanceConfigSchema,
} from '@agentic-rag/core';
import type { InstanceConfig, RetrievalStore, RetrievedChunk } from '@agentic-rag/core';
import { createChatServer, createLogger } from '../../src/http/app.js';
import type { ChatServerOptions } from '../../src/http/app.js';
import type { ChatStore, OwnerAccess } from '../../src/store/chat-store.js';

const ORIGIN = 'http://localhost:5173';
const CONVERSATION = '11111111-2222-4333-8444-555555555555';

function instance(limits: Record<string, number> = {}): InstanceConfig {
  return instanceConfigSchema.parse({
    id: 'help',
    displayName: 'Help desk',
    persona: { systemPrompt: 'Answer.', answerStyle: 'Short.', outOfScope: 'Out of scope.' },
    auth: { mode: 'public' },
    allowedOrigins: [ORIGIN],
    sources: [{ type: 'folder', path: 'data' }],
    embedding: { provider: 'mock' },
    theme: { primaryColor: '#123456' },
    limits,
  });
}

const CHUNK: RetrievedChunk = {
  chunkId: 'chunk-1',
  sourceUri: 'data/export.md',
  title: 'Export',
  headingPath: [],
  content: 'Notes export to Markdown and PDF.',
  score: 0.03,
};

function retrieval(active = true): RetrievalStore {
  return {
    activeVersion: () =>
      Promise.resolve(
        active
          ? { id: 'v1', embeddingProvider: 'mock', embeddingModel: 'mock-hash-v1' }
          : undefined,
      ),
    search: (_access, _version, queries) => Promise.resolve(queries.map(() => [CHUNK])),
  };
}

class MemoryChatStore implements ChatStore {
  turns = 0;
  totals = { ip: 0, instance: 0 };
  readonly usage: { scopes: readonly string[]; tokens: number; requests: number }[] = [];
  readonly appended: { owner: OwnerAccess; user: string; assistant: string }[] = [];

  openConversation(_access: OwnerAccess, conversationId?: string) {
    if (conversationId !== undefined && conversationId !== CONVERSATION) {
      return Promise.reject(new ChatbotError('not_found', 'Conversation not found'));
    }
    return Promise.resolve({ conversationId: CONVERSATION, history: [], turns: this.turns });
  }

  appendTurn(owner: OwnerAccess, _id: string, user: string, assistant: string) {
    this.appended.push({ owner, user, assistant });
    return Promise.resolve();
  }

  consumeUsage(
    _instanceId: string,
    scopes: readonly string[],
    delta: { tokens: number; requests: number },
  ) {
    this.usage.push({ scopes, ...delta });
    this.totals.ip += delta.requests;
    this.totals.instance += delta.requests;
    return Promise.resolve([
      { scope: scopes[0] ?? '', tokens: 0, requests: this.totals.ip },
      { scope: 'instance', tokens: 0, requests: this.totals.instance },
      { scope: null, tokens: 0, requests: this.totals.instance },
    ]);
  }
}

function server(overrides: Partial<ChatServerOptions> = {}, config = instance()) {
  const logs: string[] = [];
  const store = new MemoryChatStore();
  const app = createChatServer({
    instances: [config],
    retrieval: retrieval(),
    chatStore: store,
    chatModel: createMockChatModel(),
    embeddings: new Map([['help', createMockEmbeddingProvider()]]),
    models: new Map([['help', { chat: 'claude-haiku-5-5', router: 'claude-haiku-5-5' }]]),
    sessionSecret: 's'.repeat(32),
    logger: createLogger({ destination: { write: (line: string) => void logs.push(line) } }),
    ...overrides,
  });
  return { app, store, logs };
}

async function sessionToken(app: ReturnType<typeof server>['app']): Promise<string> {
  const response = await app.inject({ method: 'POST', url: '/v1/instances/help/session' });
  return response.json<{ token: string }>().token;
}

function frames(body: string) {
  return body
    .split('\n\n')
    .filter((frame) => frame.startsWith('event: '))
    .map((frame) => {
      const [eventLine = '', dataLine = ''] = frame.split('\n');
      return {
        event: eventLine.slice(7),
        data: JSON.parse(dataLine.slice(6)) as Record<string, unknown>,
      };
    });
}

describe('chat server', () => {
  it('serves health, instance config and 404s', async () => {
    const { app } = server();
    expect((await app.inject('/health')).json()).toEqual({ status: 'ok' });
    expect((await app.inject('/v1/instances/help/config')).json()).toEqual({
      id: 'help',
      displayName: 'Help desk',
      mode: 'public',
      theme: { primaryColor: '#123456' },
    });
    const missing = await app.inject('/v1/instances/nope/config');
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: { code: 'not_found', retryable: false } });
    expect((await app.inject('/nothing')).statusCode).toBe(404);
  });

  it('applies CORS from allowedOrigins and refuses other origins', async () => {
    const { app } = server();
    const allowed = await app.inject({
      url: '/v1/instances/help/config',
      headers: { origin: ORIGIN },
    });
    expect(allowed.headers['access-control-allow-origin']).toBe(ORIGIN);
    const preflight = await app.inject({
      method: 'OPTIONS',
      url: '/v1/instances/help/chat',
      headers: { origin: ORIGIN, 'access-control-request-method': 'POST' },
    });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers['access-control-allow-headers']).toContain('x-session-token');
    const refused = await app.inject({
      url: '/v1/instances/help/config',
      headers: { origin: 'https://evil.example' },
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('streams a cited answer over SSE, stores the turn and logs usage without message text', async () => {
    const { app, store, logs } = server();
    const token = await sessionToken(app);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/instances/help/chat',
      headers: { 'x-session-token': token, origin: ORIGIN },
      payload: { message: 'Which export formats exist?' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.headers['access-control-allow-origin']).toBe(ORIGIN);
    const events = frames(response.body);
    expect(events[0]).toMatchObject({
      event: 'meta',
      data: { conversationId: CONVERSATION, indexVersion: 'v1' },
    });
    const token0 = events.find((event) => event.event === 'token');
    expect(token0?.data.text).toMatch(/^Notes export to Markdown and PDF\. \[c[0-9a-f]{6}\]$/);
    expect(events.find((event) => event.event === 'citation')?.data).toMatchObject({
      title: 'Export',
      sourceUri: 'data/export.md',
    });
    expect(events.at(-1)).toMatchObject({ event: 'final', data: { state: 'ANSWERED' } });

    expect(store.appended[0]?.user).toBe('Which export formats exist?');
    expect(store.appended[0]?.owner.ownerKey).toMatch(/^[0-9a-f]{64}$/);
    expect(store.usage[0]).toEqual({
      scopes: ['ip:127.0.0.1', 'instance'],
      tokens: 0,
      requests: 1,
    });
    expect(store.usage.slice(1).every((entry) => entry.requests === 0 && entry.tokens > 0)).toBe(
      true,
    );

    const modelCalls = logs
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((l) => l.event === 'model_call');
    expect(modelCalls).toHaveLength(2);
    expect(modelCalls[0]).toMatchObject({
      instance: 'help',
      provider: 'mock',
      model: 'claude-haiku-5-5',
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(modelCalls[0]?.inputTokens).toBeGreaterThan(0);
    expect(logs.join('\n')).not.toContain('Which export formats exist?');
    expect(logs.join('\n')).not.toContain(token);
  });

  it('answers in JSON when asked and continues an owned conversation', async () => {
    const { app } = server();
    const token = await sessionToken(app);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/instances/help/chat',
      headers: { 'x-session-token': token, accept: 'application/json' },
      payload: { message: 'Export?', conversationId: CONVERSATION },
    });
    expect(response.json()).toMatchObject({
      conversationId: CONVERSATION,
      indexVersion: 'v1',
      state: 'ANSWERED',
      citations: [{ title: 'Export', sourceUri: 'data/export.md' }],
    });
    const other = await app.inject({
      method: 'POST',
      url: '/v1/instances/help/chat',
      headers: { 'x-session-token': token, accept: 'application/json' },
      payload: { message: 'Export?', conversationId: '99999999-2222-4333-8444-555555555555' },
    });
    expect(other.statusCode).toBe(404);
  });

  it('rejects missing sessions and invalid bodies', async () => {
    const { app } = server();
    const unauthenticated = await app.inject({
      method: 'POST',
      url: '/v1/instances/help/chat',
      payload: { message: 'hi' },
    });
    expect(unauthenticated.statusCode).toBe(401);
    expect(unauthenticated.json()).toEqual({
      error: { code: 'unauthenticated', retryable: false },
    });
    const token = await sessionToken(app);
    const post = (payload: unknown) =>
      app.inject({
        method: 'POST',
        url: '/v1/instances/help/chat',
        headers: { 'x-session-token': token, 'content-type': 'application/json' },
        payload: JSON.stringify(payload),
      });
    expect((await post({ message: 'a'.repeat(2001) })).statusCode).toBe(400);
    expect((await post({ message: 'hi', extra: 1 })).statusCode).toBe(400);
    expect((await post({ message: 'x'.repeat(9000) })).statusCode).toBe(413);
    const malformed = await app.inject({
      method: 'POST',
      url: '/v1/instances/help/chat',
      headers: { 'x-session-token': token, 'content-type': 'application/json' },
      payload: '{',
    });
    expect(malformed.json()).toEqual({ error: { code: 'invalid_input', retryable: false } });
  });

  it('enforces the per-IP minute limit, daily caps and the turn limit', async () => {
    const chatWith = async (setup: ReturnType<typeof server>, token: string) =>
      setup.app.inject({
        method: 'POST',
        url: '/v1/instances/help/chat',
        headers: { 'x-session-token': token, accept: 'application/json' },
        payload: { message: 'hi' },
      });

    const minute = server({}, instance({ requestsPerMinutePerIp: 2 }));
    const token = await sessionToken(minute.app);
    expect((await chatWith(minute, token)).statusCode).toBe(200);
    const limited = await chatWith(minute, token);
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toEqual({ error: { code: 'rate_limited', retryable: true } });
    expect(
      (await minute.app.inject({ method: 'POST', url: '/v1/instances/help/session' })).statusCode,
    ).toBe(429);

    const daily = server({}, instance({ dailyRequests: 1 }));
    const dailyToken = await sessionToken(daily.app);
    expect((await chatWith(daily, dailyToken)).statusCode).toBe(200);
    const exhausted = await chatWith(daily, dailyToken);
    expect(exhausted.statusCode).toBe(429);
    expect(exhausted.json()).toMatchObject({ error: { code: 'budget_exceeded' } });

    const perIp = server({}, instance({ dailyRequestsPerIp: 1 }));
    const perIpToken = await sessionToken(perIp.app);
    await chatWith(perIp, perIpToken);
    expect((await chatWith(perIp, perIpToken)).json()).toMatchObject({
      error: { code: 'budget_exceeded' },
    });

    const turns = server({}, instance({ maxTurnsPerSession: 2 }));
    turns.store.turns = 2;
    const turnsResponse = await chatWith(turns, await sessionToken(turns.app));
    expect(turnsResponse.statusCode).toBe(429);
    expect(turnsResponse.json()).toMatchObject({ error: { code: 'rate_limited' } });
  });

  it('reports failures after the stream started as an error event', async () => {
    const { app, logs } = server({ retrieval: retrieval(false) });
    const token = await sessionToken(app);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/instances/help/chat',
      headers: { 'x-session-token': token },
      payload: { message: 'Export?' },
    });
    expect(frames(response.body)).toEqual([
      { event: 'error', data: { code: 'not_found', retryable: false } },
    ]);
    const json = await app.inject({
      method: 'POST',
      url: '/v1/instances/help/chat',
      headers: { 'x-session-token': token, accept: 'application/json' },
      payload: { message: 'Export?' },
    });
    expect(json.statusCode).toBe(404);

    const broken: RetrievalStore = {
      activeVersion: () => Promise.reject(new Error('database down')),
      search: () => Promise.resolve([]),
    };
    const failing = server({ retrieval: broken });
    const failed = await failing.app.inject({
      method: 'POST',
      url: '/v1/instances/help/chat',
      headers: { 'x-session-token': await sessionToken(failing.app) },
      payload: { message: 'Export?' },
    });
    expect(frames(failed.body)).toEqual([
      { event: 'error', data: { code: 'internal', retryable: false } },
    ]);
    expect(failing.logs.some((line) => line.includes('chat turn failed'))).toBe(true);
    expect(logs).toBeDefined();
  });

  it('uses X-Forwarded-For only from trusted proxies and warns once otherwise', async () => {
    const untrusted = server();
    const token = await sessionToken(untrusted.app);
    for (let i = 0; i < 2; i++) {
      await untrusted.app.inject({
        method: 'POST',
        url: '/v1/instances/help/chat',
        headers: {
          'x-session-token': token,
          'x-forwarded-for': '203.0.113.9',
          accept: 'application/json',
        },
        payload: { message: 'hi' },
      });
    }
    expect(untrusted.store.usage[0]?.scopes[0]).toBe('ip:127.0.0.1');
    expect(untrusted.logs.filter((line) => line.includes('TRUSTED_PROXIES is empty'))).toHaveLength(
      1,
    );

    const trusted = server({ trustedProxies: ['127.0.0.1'] });
    await trusted.app.inject({
      method: 'POST',
      url: '/v1/instances/help/chat',
      headers: {
        'x-session-token': await sessionToken(trusted.app),
        'x-forwarded-for': '2001:db8:1:2::5',
        accept: 'application/json',
      },
      payload: { message: 'hi' },
    });
    expect(trusted.store.usage[0]?.scopes[0]).toBe('ip:2001:db8:1:2::/64');
  });

  it('keeps the answer when usage or turn storage fails', async () => {
    const { app, store, logs } = server();
    store.appendTurn = () => Promise.reject(new Error('insert failed'));
    const consume = store.consumeUsage.bind(store);
    store.consumeUsage = (id, scopes, delta) =>
      delta.requests === 0
        ? Promise.reject(new Error('counter failed'))
        : consume(id, scopes, delta);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/instances/help/chat',
      headers: { 'x-session-token': await sessionToken(app), accept: 'application/json' },
      payload: { message: 'Export?' },
    });
    expect(response.json()).toMatchObject({ state: 'ANSWERED' });
    expect(logs.some((line) => line.includes('could not record token usage'))).toBe(true);
    expect(logs.some((line) => line.includes('could not store the conversation turn'))).toBe(true);
  });
});
