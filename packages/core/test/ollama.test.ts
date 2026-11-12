import { describe, expect, it } from 'vitest';
import {
  ChatbotError,
  createChatModel,
  createMockEmbeddingProvider,
  createOllamaChatModel,
  instanceConfigSchema,
  ollamaBaseUrl,
  ollamaModelName,
  recommendedOllamaModel,
  resolveChatModels,
  runChat,
} from '../src/index.js';
import type {
  ChatEvent,
  ChatRequest,
  ChatStreamEvent,
  OllamaFetch,
  RetrievalStore,
  RetrievedChunk,
  SearchQuery,
} from '../src/index.js';

const BASE = 'http://127.0.0.1:11434';
const GIB = 1024 ** 3;

function bodyText(init: RequestInit): string {
  return typeof init.body === 'string' ? init.body : '';
}

function lines(objects: unknown[]): Response {
  const body = objects.map((object) => `${JSON.stringify(object)}\n`).join('');
  return new Response(body, { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
}

function request(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return {
    model: 'qwen2.5:7b',
    system: 'Answer from the documents.',
    context: '<documents>\n</documents>',
    messages: [{ role: 'user', content: 'How do I export notes?' }],
    maxOutputTokens: 300,
    signal: new AbortController().signal,
    ...overrides,
  };
}

async function collect(stream: AsyncIterable<ChatStreamEvent>): Promise<ChatStreamEvent[]> {
  const events: ChatStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function recordingFetch(response: () => Response | Promise<Response>) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const fetch: OllamaFetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(bodyText(init)) as Record<string, unknown> });
    return response();
  };
  return { fetch, calls };
}

describe('ollama chat model', () => {
  it('posts a streamed chat request and maps text and usage', async () => {
    const { fetch, calls } = recordingFetch(() =>
      lines([
        { message: { role: 'assistant', content: 'Use ' }, done: false },
        { message: { role: 'assistant', content: 'File > Export.' }, done: false },
        {
          message: { role: 'assistant', content: '' },
          done: true,
          prompt_eval_count: 812,
          eval_count: 17,
        },
      ]),
    );
    const model = createOllamaChatModel({ baseUrl: BASE, model: 'qwen2.5:7b', fetch });
    const events = await collect(
      model.generate(request({ context: '<documents>doc</documents>', maxOutputTokens: 300 })),
    );

    expect(events).toEqual([
      { type: 'text', text: 'Use ' },
      { type: 'text', text: 'File > Export.' },
      {
        type: 'done',
        usage: { inputTokens: 812, outputTokens: 17, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${BASE}/api/chat`);
    expect(calls[0]?.body).toMatchObject({
      model: 'qwen2.5:7b',
      stream: true,
      options: { num_predict: 300 },
    });
    const messages = calls[0]?.body.messages as { role: string; content: string }[];
    expect(messages[0]).toEqual({
      role: 'system',
      content: 'Answer from the documents.\n\n<documents>doc</documents>',
    });
    expect(messages[1]).toEqual({ role: 'user', content: 'How do I export notes?' });
    expect(calls[0]?.body).not.toHaveProperty('tools');
  });

  it('reads a response split across chunks and a final line without a newline', async () => {
    const encoder = new TextEncoder();
    const parts = [
      '{"message":{"content":"Hel',
      'lo"},"done":false}\n{"message":{"content":"!"},"done":false}\n',
      '{"done":true,"prompt_eval_count":5,"eval_count":2}',
    ];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const part of parts) controller.enqueue(encoder.encode(part));
        controller.close();
      },
    });
    const model = createOllamaChatModel({
      baseUrl: BASE,
      model: 'm',
      fetch: () => Promise.resolve(new Response(body, { status: 200 })),
    });
    const events = await collect(model.generate(request()));
    expect(events.filter((event) => event.type === 'text').map((event) => event.text)).toEqual([
      'Hello',
      '!',
    ]);
    expect(events.at(-1)).toMatchObject({
      type: 'done',
      usage: { inputTokens: 5, outputTokens: 2 },
    });
  });

  it('maps tool calls with object or string arguments', async () => {
    const { fetch, calls } = recordingFetch(() =>
      lines([
        {
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                function: {
                  name: 'route',
                  arguments: { intent: 'knowledge', queries: ['export'] },
                },
              },
            ],
          },
          done: false,
        },
        { done: true, prompt_eval_count: 40, eval_count: 9 },
      ]),
    );
    const model = createOllamaChatModel({ baseUrl: BASE, model: 'm', fetch });
    const tool = {
      name: 'route',
      description: 'Route.',
      inputSchema: { properties: { intent: { type: 'string' } }, required: ['intent'] },
    };
    const events = await collect(model.generate(request({ tools: [tool], toolChoice: 'route' })));
    expect(events[0]).toEqual({
      type: 'tool_use',
      name: 'route',
      input: { intent: 'knowledge', queries: ['export'] },
    });
    expect(calls[0]?.body.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'route',
          description: 'Route.',
          parameters: {
            type: 'object',
            properties: { intent: { type: 'string' } },
            required: ['intent'],
          },
        },
      },
    ]);
    expect(calls[0]?.body).not.toHaveProperty('tool_choice');

    const stringArguments = createOllamaChatModel({
      baseUrl: BASE,
      model: 'm',
      fetch: () =>
        Promise.resolve(
          lines([
            {
              message: {
                tool_calls: [{ function: { name: 'route', arguments: '{"intent":"small_talk"}' } }],
              },
              done: false,
            },
            { done: true, prompt_eval_count: 1, eval_count: 1 },
          ]),
        ),
    });
    const parsed = await collect(stringArguments.generate(request({ tools: [tool] })));
    expect(parsed[0]).toEqual({ type: 'tool_use', name: 'route', input: { intent: 'small_talk' } });
  });

  it('rejects malformed tool arguments', async () => {
    const model = createOllamaChatModel({
      baseUrl: BASE,
      model: 'm',
      fetch: () =>
        Promise.resolve(
          lines([
            { message: { tool_calls: [{ function: { name: 'route', arguments: '{oops' } }] } },
          ]),
        ),
    });
    await expect(collect(model.generate(request()))).rejects.toMatchObject({
      code: 'provider_unavailable',
    });
  });

  it('explains how to start Ollama when it is not running', async () => {
    const model = createOllamaChatModel({
      baseUrl: BASE,
      model: 'qwen2.5:7b',
      fetch: () => Promise.reject(new TypeError('fetch failed')),
    });
    const error = await collect(model.generate(request())).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ChatbotError);
    expect((error as ChatbotError).code).toBe('provider_unavailable');
    expect((error as ChatbotError).message).toContain('not reachable at http://127.0.0.1:11434');
    expect((error as ChatbotError).message).toContain('brew services start ollama');
    expect((error as ChatbotError).message).toContain('ollama serve');
  });

  it('says which model to pull when the model is missing', async () => {
    const model = createOllamaChatModel({
      baseUrl: BASE,
      model: 'qwen2.5:7b',
      fetch: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({ error: 'model "qwen2.5:7b" not found, try pulling it first' }),
            {
              status: 404,
            },
          ),
        ),
    });
    const error = (await collect(model.generate(request())).catch(
      (caught: unknown) => caught,
    )) as ChatbotError;
    expect(error.code).toBe('invalid_config');
    expect(error.message).toBe(
      'Ollama does not have the model "qwen2.5:7b". Run: ollama pull qwen2.5:7b',
    );
  });

  it('maps server failures to provider_unavailable and other statuses to internal', async () => {
    const serverError = createOllamaChatModel({
      baseUrl: BASE,
      model: 'm',
      fetch: () =>
        Promise.resolve(new Response(JSON.stringify({ error: 'out of memory' }), { status: 500 })),
    });
    await expect(collect(serverError.generate(request()))).rejects.toMatchObject({
      code: 'provider_unavailable',
      message: 'Ollama failed (500): out of memory',
    });

    const badRequest = createOllamaChatModel({
      baseUrl: BASE,
      model: 'm',
      fetch: () =>
        Promise.resolve(new Response('not json', { status: 400, statusText: 'Bad Request' })),
    });
    await expect(collect(badRequest.generate(request()))).rejects.toMatchObject({
      code: 'internal',
    });
  });

  it('turns an error line in the stream into provider_unavailable', async () => {
    const model = createOllamaChatModel({
      baseUrl: BASE,
      model: 'm',
      fetch: () =>
        Promise.resolve(lines([{ message: { content: 'Part' } }, { error: 'runner crashed' }])),
    });
    await expect(collect(model.generate(request()))).rejects.toMatchObject({
      code: 'provider_unavailable',
      message: 'Ollama error: runner crashed',
    });
  });

  it('fails when the stream ends before the done line', async () => {
    const model = createOllamaChatModel({
      baseUrl: BASE,
      model: 'm',
      fetch: () => Promise.resolve(lines([{ message: { content: 'Cut' }, done: false }])),
    });
    await expect(collect(model.generate(request()))).rejects.toMatchObject({
      code: 'provider_unavailable',
      message: 'Ollama ended the response early',
    });
  });

  it('stops reading when the caller aborts and rethrows the abort reason', async () => {
    const encoder = new TextEncoder();
    const caller = new AbortController();
    const model = createOllamaChatModel({
      baseUrl: BASE,
      model: 'm',
      fetch: (_url, init) =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(
                  encoder.encode('{"message":{"content":"Start"},"done":false}\n'),
                );
                init.signal?.addEventListener('abort', () => {
                  controller.error(init.signal?.reason);
                });
              },
            }),
            { status: 200 },
          ),
        ),
    });
    const reason = new Error('client disconnected');
    const events: ChatStreamEvent[] = [];
    const consume = (async () => {
      for await (const event of model.generate(request({ signal: caller.signal }))) {
        events.push(event);
        caller.abort(reason);
      }
    })();
    await expect(consume).rejects.toBe(reason);
    expect(events).toEqual([{ type: 'text', text: 'Start' }]);
  });

  it('gives up when Ollama stays silent longer than the idle timeout', async () => {
    const model = createOllamaChatModel({
      baseUrl: BASE,
      model: 'm',
      idleTimeoutMs: 20,
      fetch: (_url, init) =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                init.signal?.addEventListener('abort', () => {
                  controller.error(init.signal?.reason);
                });
              },
            }),
            { status: 200 },
          ),
        ),
    });
    await expect(collect(model.generate(request()))).rejects.toMatchObject({
      code: 'provider_unavailable',
      message: 'Ollama sent nothing for 0.02 seconds',
    });
  });

  it('refuses to start when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('deadline'));
    const model = createOllamaChatModel({
      baseUrl: BASE,
      model: 'm',
      fetch: () => Promise.reject(new Error('unused')),
    });
    await expect(collect(model.generate(request({ signal: controller.signal })))).rejects.toThrow(
      'deadline',
    );
  });
});

describe('OLLAMA_BASE_URL and model settings', () => {
  it('accepts loopback addresses and strips a trailing slash', () => {
    expect(ollamaBaseUrl('http://127.0.0.1:11434/', false)).toBe('http://127.0.0.1:11434');
    expect(ollamaBaseUrl('http://localhost:11434', false)).toBe('http://localhost:11434');
    expect(ollamaBaseUrl('http://[::1]:11434', false)).toBe('http://[::1]:11434');
  });

  it('refuses a remote host unless OLLAMA_ALLOW_REMOTE is set', () => {
    expect(() => ollamaBaseUrl('http://192.168.1.20:11434', false)).toThrow(
      /points to 192.168.1.20, which is not a loopback address.*OLLAMA_ALLOW_REMOTE=true/,
    );
    expect(ollamaBaseUrl('http://192.168.1.20:11434', true)).toBe('http://192.168.1.20:11434');
  });

  it('rejects values that are not http URLs', () => {
    expect(() => ollamaBaseUrl('not a url', false)).toThrow(/OLLAMA_BASE_URL is not a URL/);
    expect(() => ollamaBaseUrl('ftp://127.0.0.1:11434', false)).toThrow(/must start with http/);
  });

  it('recommends qwen2.5:7b with 16 GB of memory or more, and llama3.2:3b below that', () => {
    expect(recommendedOllamaModel(16 * GIB)).toBe('qwen2.5:7b');
    expect(recommendedOllamaModel(32 * GIB)).toBe('qwen2.5:7b');
    expect(recommendedOllamaModel(8 * GIB)).toBe('llama3.2:3b');
  });

  it('uses OLLAMA_MODEL when set and the recommendation otherwise', () => {
    expect(ollamaModelName({ OLLAMA_MODEL: ' llama3.2:3b ' })).toBe('llama3.2:3b');
    expect(['qwen2.5:7b', 'llama3.2:3b']).toContain(ollamaModelName({ OLLAMA_MODEL: ' ' }));
  });

  it('creates the provider from the environment and forces the Ollama model for every call', () => {
    const fetch: OllamaFetch = () => Promise.reject(new Error('unused'));
    const model = createChatModel(
      { LLM_PROVIDER: 'ollama', OLLAMA_MODEL: 'qwen2.5:7b' },
      { ollamaFetch: fetch },
    );
    expect(model.provider).toBe('ollama');
    expect(() =>
      createChatModel({ LLM_PROVIDER: 'ollama', OLLAMA_BASE_URL: 'http://10.0.0.5:11434' }),
    ).toThrow(/OLLAMA_ALLOW_REMOTE/);
    expect(
      createChatModel({
        LLM_PROVIDER: 'ollama',
        OLLAMA_BASE_URL: 'http://10.0.0.5:11434',
        OLLAMA_ALLOW_REMOTE: 'true',
      }).provider,
    ).toBe('ollama');

    const config = instanceConfigSchema.parse({
      id: 'help',
      displayName: 'Help',
      persona: { systemPrompt: 'Answer.', answerStyle: 'Short.', fallback: { message: 'No.' } },
      models: { chat: 'claude-sonnet-5-5', router: 'claude-haiku-5-5' },
      auth: { mode: 'public' },
      allowedOrigins: ['http://localhost:5180'],
      sources: [{ type: 'folder', path: 'data' }],
    });
    expect(
      resolveChatModels(config, { LLM_PROVIDER: 'ollama', OLLAMA_MODEL: 'llama3.2:3b' }),
    ).toEqual({
      chat: 'llama3.2:3b',
      router: 'llama3.2:3b',
    });
    expect(resolveChatModels(config, { LLM_PROVIDER: 'mock' })).toEqual({
      chat: 'claude-sonnet-5-5',
      router: 'claude-haiku-5-5',
    });
  });
});

describe('ollama in the agent graph', () => {
  const config = instanceConfigSchema.parse({
    id: 'help',
    displayName: 'Help',
    persona: {
      systemPrompt: 'You answer questions about the help articles.',
      answerStyle: 'Short.',
      fallback: { message: 'I can only answer questions about the help articles.' },
    },
    auth: { mode: 'public' },
    allowedOrigins: ['http://localhost:5180'],
    sources: [{ type: 'folder', path: 'data' }],
    embedding: { provider: 'mock' },
  });

  function retrievalFor(chunks: RetrievedChunk[]) {
    const searches: SearchQuery[][] = [];
    const store: RetrievalStore = {
      activeVersion: () =>
        Promise.resolve({ id: 'v1', embeddingProvider: 'mock', embeddingModel: 'mock-hash-v1' }),
      search: (_access, _version, queries) => {
        searches.push([...queries]);
        return Promise.resolve(queries.map(() => chunks));
      },
    };
    return { store, searches };
  }

  const exportChunk: RetrievedChunk = {
    chunkId: 'export',
    sourceUri: 'data/export.md',
    title: 'Export',
    headingPath: ['Export'],
    content: 'Export\n\nYou can export notes to Markdown, PDF and HTML.',
    score: 0.03,
  };

  // Answers the route call with text instead of a tool call, as small models sometimes do.
  function routeAsText(): OllamaFetch {
    return (_url, init) => {
      const body = JSON.parse(bodyText(init)) as {
        tools?: unknown;
        messages: { content: string }[];
      };
      if (body.tools !== undefined) {
        return Promise.resolve(
          lines([
            { message: { role: 'assistant', content: 'Let me look that up.' }, done: false },
            { done: true, prompt_eval_count: 30, eval_count: 6 },
          ]),
        );
      }
      const citation = /citation="(c[0-9a-f]{6})"/.exec(body.messages[0]?.content ?? '')?.[1];
      return Promise.resolve(
        lines([
          {
            message: {
              role: 'assistant',
              content: `You can export notes to Markdown, PDF and HTML [`,
            },
            done: false,
          },
          { message: { role: 'assistant', content: `${citation ?? 'missing'}].` }, done: false },
          { done: true, prompt_eval_count: 300, eval_count: 20 },
        ]),
      );
    };
  }

  it('falls back to a knowledge question when the route call returns no tool call', async () => {
    const retrieval = retrievalFor([exportChunk]);
    const events: ChatEvent[] = [];
    const outcome = await runChat({
      config,
      access: { instanceId: 'help', tenantKey: '_', accessTags: ['public'] },
      requestId: 'req-1',
      conversationId: 'conv-1',
      message: 'How do I export notes?',
      history: [],
      chatModel: createOllamaChatModel({
        baseUrl: BASE,
        model: 'qwen2.5:7b',
        fetch: routeAsText(),
      }),
      models: { chat: 'qwen2.5:7b', router: 'qwen2.5:7b' },
      embeddings: createMockEmbeddingProvider(),
      retrieval: retrieval.store,
      signal: new AbortController().signal,
      emit: (event) => events.push(event),
    });

    expect(retrieval.searches).toEqual([
      [expect.objectContaining({ text: 'How do I export notes?', limit: 8 })],
    ]);
    expect(outcome.state).toBe('ANSWERED');
    expect(outcome.citationIds).toHaveLength(1);
    expect(events.find((event) => event.event === 'final')).toMatchObject({
      data: { state: 'ANSWERED', usage: { inputTokens: 330, outputTokens: 26 } },
    });
  });
});
