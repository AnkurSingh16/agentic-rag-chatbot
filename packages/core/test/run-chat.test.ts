import { describe, expect, it } from 'vitest';
import {
  INSUFFICIENT_EVIDENCE_TEXT,
  checkParagraph,
  createMockChatModel,
  createMockEmbeddingProvider,
  guardInput,
  instanceConfigSchema,
  mergeResults,
  parseContext,
  runChat,
} from '../src/index.js';
import type {
  ChatEvent,
  ChatModel,
  ChatRequest,
  ModelCallRecord,
  RetrievalStore,
  RetrievedChunk,
  RunChatOptions,
  SearchQuery,
} from '../src/index.js';

const config = instanceConfigSchema.parse({
  id: 'help',
  displayName: 'Help',
  persona: {
    systemPrompt: 'You answer questions about the help articles.',
    answerStyle: 'Short.',
    outOfScope: 'I can only answer questions about the help articles.',
    forbiddenTopics: ['Legal Advice'],
  },
  auth: { mode: 'public' },
  allowedOrigins: ['http://localhost:5173'],
  sources: [{ type: 'folder', path: 'data' }],
  embedding: { provider: 'mock' },
});

function chunk(id: string, content: string, score = 0.03): RetrievedChunk {
  return {
    chunkId: id,
    sourceUri: `data/${id}.md`,
    title: `Title ${id}`,
    headingPath: ['Title', 'Section'],
    content: `Title > Section\n\n${content}`,
    score,
  };
}

const CHUNKS = [
  chunk('export', 'You can export notes to Markdown, PDF and HTML.'),
  chunk('sync', 'Notes sync within about thirty seconds.', 0.02),
];

function fakeRetrieval(chunks: RetrievedChunk[] = CHUNKS, active = true) {
  const searches: SearchQuery[][] = [];
  const store: RetrievalStore = {
    activeVersion: () =>
      Promise.resolve(
        active
          ? { id: 'version-1', embeddingProvider: 'mock', embeddingModel: 'mock-hash-v1' }
          : undefined,
      ),
    search: (_access, versionId, queries) => {
      expect(versionId).toBe('version-1');
      searches.push([...queries]);
      return Promise.resolve(queries.map((query) => chunks.slice(0, query.limit)));
    },
  };
  return { store, searches };
}

// A model whose answer for each call is computed from the request, for scripted failures.
function scripted(answers: ((request: ChatRequest) => string)[]): ChatModel {
  const mock = createMockChatModel();
  let call = 0;
  return {
    provider: 'mock',
    async *generate(request) {
      if (request.tools !== undefined) {
        yield* mock.generate(request);
        return;
      }
      const answer = answers[call++] ?? (() => '');
      yield { type: 'text', text: answer(request) };
      yield {
        type: 'done',
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 1 },
      };
    },
  };
}

function ids(request: ChatRequest): string[] {
  return parseContext(request.context).map((document) => document.citationId);
}

async function chat(overrides: Partial<RunChatOptions> = {}) {
  const events: ChatEvent[] = [];
  const calls: ModelCallRecord[] = [];
  const retrieval = fakeRetrieval();
  const outcome = await runChat({
    config,
    access: { instanceId: 'help', tenantKey: '_', accessTags: ['public'] },
    requestId: 'req-1',
    conversationId: 'conv-1',
    message: '  How do I export notes?  ',
    history: [],
    chatModel: createMockChatModel(),
    models: { chat: 'claude-sonnet-5-5', router: 'claude-haiku-5-5' },
    embeddings: createMockEmbeddingProvider(),
    retrieval: retrieval.store,
    signal: new AbortController().signal,
    emit: (event) => events.push(event),
    onModelCall: (call) => {
      calls.push(call);
    },
    ...overrides,
  });
  const tokens = events.flatMap((event) => (event.event === 'token' ? [event.data.text] : []));
  return { outcome, events, calls, tokens, searches: retrieval.searches };
}

describe('runChat', () => {
  it('answers a question with verified, cited paragraphs', async () => {
    const { outcome, events, calls, tokens, searches } = await chat();
    expect(events[0]).toEqual({
      event: 'meta',
      data: { requestId: 'req-1', conversationId: 'conv-1', indexVersion: 'version-1' },
    });
    expect(searches[0]).toMatchObject([{ text: 'How do I export notes?', limit: 8 }]);
    expect(tokens).toHaveLength(2);
    expect(tokens[0]).toMatch(
      /^You can export notes to Markdown, PDF and HTML\. \[c[0-9a-f]{6}\]$/,
    );
    expect(tokens[1]).toMatch(/^\n\nNotes sync/);
    const citations = events.flatMap((event) => (event.event === 'citation' ? [event.data] : []));
    expect(citations[0]).toMatchObject({
      title: 'Title export',
      excerpt: 'You can export notes to Markdown, PDF and HTML.',
      sourceUri: 'data/export.md',
    });
    expect(outcome.state).toBe('ANSWERED');
    expect(outcome.citationIds).toEqual(citations.map((citation) => citation.citationId));
    expect(outcome.text).toBe(tokens.join(''));
    expect(calls.map((call) => [call.node, call.model])).toEqual([
      ['route', 'claude-haiku-5-5'],
      ['answer', 'claude-sonnet-5-5'],
    ]);
    expect(events.at(-1)).toEqual({
      event: 'final',
      data: {
        state: 'ANSWERED',
        citationIds: outcome.citationIds,
        usage: {
          inputTokens: (calls[0]?.usage.inputTokens ?? 0) + (calls[1]?.usage.inputTokens ?? 0),
          outputTokens: (calls[0]?.usage.outputTokens ?? 0) + (calls[1]?.usage.outputTokens ?? 0),
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      },
    });
  });

  it('answers small talk without retrieval', async () => {
    const { outcome, calls, searches, tokens } = await chat({ message: 'hi' });
    expect(outcome).toMatchObject({ state: 'ANSWERED', citationIds: [] });
    expect(tokens).toEqual(['Happy to help. Ask me anything about Help.']);
    expect(calls).toHaveLength(1);
    expect(searches).toEqual([]);
  });

  it.each([
    ['out_of_scope', 'OUT_OF_SCOPE'],
    ['unsafe', 'REFUSED'],
  ])('replies with the out-of-scope text for intent %s', async (intent, state) => {
    const model: ChatModel = {
      provider: 'mock',
      async *generate() {
        await Promise.resolve();
        yield { type: 'tool_use', name: 'route', input: { intent, queries: [] } };
        yield {
          type: 'done',
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        };
      },
    };
    const { outcome, tokens } = await chat({ chatModel: model });
    expect(outcome.state).toBe(state);
    expect(tokens).toEqual([config.persona.outOfScope]);
  });

  it('treats an unusable routing answer as a question', async () => {
    const mock = createMockChatModel();
    const model: ChatModel = {
      provider: 'mock',
      async *generate(request) {
        if (request.tools !== undefined) {
          yield { type: 'tool_use', name: 'route', input: { intent: 'chat' } };
          yield {
            type: 'done',
            usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
          };
          return;
        }
        yield* mock.generate(request);
      },
    };
    const { outcome, searches } = await chat({ chatModel: model });
    expect(outcome.state).toBe('ANSWERED');
    expect(searches[0]?.[0]?.text).toBe('How do I export notes?');
  });

  it('returns insufficient evidence without an answer call when nothing is retrieved', async () => {
    const { outcome, calls, tokens } = await chat({ retrieval: fakeRetrieval([]).store });
    expect(outcome.state).toBe('INSUFFICIENT_EVIDENCE');
    expect(tokens).toEqual([INSUFFICIENT_EVIDENCE_TEXT]);
    expect(calls.map((call) => call.node)).toEqual(['route']);
  });

  it('retries once with broader retrieval, then gives up without releasing bad text', async () => {
    const model = scripted([() => 'Made up. [c000000]', () => 'No citation at all.']);
    const { outcome, calls, tokens, searches, events } = await chat({ chatModel: model });
    expect(searches.map((queries) => queries[0]?.limit)).toEqual([8, 16]);
    expect(calls).toHaveLength(3);
    expect(tokens).toEqual([INSUFFICIENT_EVIDENCE_TEXT]);
    expect(events.some((event) => event.event === 'reset')).toBe(false);
    expect(outcome.state).toBe('INSUFFICIENT_EVIDENCE');
    expect(outcome.usage).toMatchObject({ cacheReadTokens: 4, cacheWriteTokens: 2 });
  });

  it('resets released paragraphs when a later one fails, and answers on the retry', async () => {
    const model = scripted([
      (request) => `Good. [${ids(request)[0] ?? ''}]\n\nUnsupported claim.`,
      (request) => `Better. [${ids(request)[1] ?? ''}]`,
    ]);
    const { outcome, events } = await chat({ chatModel: model });
    const kinds = events.map((event) => event.event);
    expect(kinds.indexOf('reset')).toBeGreaterThan(kinds.indexOf('token'));
    expect(events.find((event) => event.event === 'reset')).toEqual({
      event: 'reset',
      data: { reason: 'verification_failed' },
    });
    expect(outcome.state).toBe('ANSWERED');
    expect(outcome.text).toMatch(/^Better\. \[c[0-9a-f]{6}\]$/);
  });

  it('refuses instead of releasing a paragraph that mentions a forbidden topic', async () => {
    const retrieval = fakeRetrieval([chunk('legal', 'We do not give legal advice here.')]);
    const { outcome, tokens, events } = await chat({ retrieval: retrieval.store });
    expect(outcome.state).toBe('REFUSED');
    expect(tokens).toEqual([config.persona.outOfScope]);
    expect(events.some((event) => event.event === 'citation')).toBe(false);

    const late = scripted([
      (request) =>
        `Fine. [${ids(request)[0] ?? ''}]\n\nSome legal advice. [${ids(request)[0] ?? ''}]`,
    ]);
    const reset = await chat({ chatModel: late });
    expect(reset.events.find((event) => event.event === 'reset')).toEqual({
      event: 'reset',
      data: { reason: 'guard_out' },
    });
    expect(reset.outcome.state).toBe('REFUSED');
  });

  it('fails without an active version or with another embedding model', async () => {
    await expect(chat({ retrieval: fakeRetrieval(CHUNKS, false).store })).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(
      chat({ embeddings: createMockEmbeddingProvider({ model: 'other' }) }),
    ).rejects.toMatchObject({ code: 'invalid_config' });
  });

  it('turns a passed deadline into provider_unavailable and keeps client aborts as they are', async () => {
    const hanging: ChatModel = {
      provider: 'mock',
      async *generate(request) {
        await new Promise((_resolve, reject) => {
          request.signal.addEventListener('abort', () => {
            reject(new Error('aborted'));
          });
        });
        yield { type: 'text', text: '' };
      },
    };
    await expect(chat({ chatModel: hanging, deadlineMs: 20 })).rejects.toMatchObject({
      code: 'provider_unavailable',
    });
    const controller = new AbortController();
    setTimeout(() => {
      controller.abort();
    }, 10);
    await expect(chat({ chatModel: hanging, signal: controller.signal })).rejects.toThrow(
      'aborted',
    );
  });
});

describe('guards', () => {
  it('rejects empty, long and control-character messages', () => {
    expect(guardInput('  hi  ')).toBe('hi');
    expect(() => guardInput('   ')).toThrow('Message is empty');
    expect(() => guardInput('a'.repeat(2001))).toThrow('longer than 2000');
    expect(() => guardInput('a\u0000b')).toThrow('control characters');
    expect(guardInput('line\nline\tend')).toBe('line\nline\tend');
  });

  it('checks citations and forbidden topics per paragraph', () => {
    const known = new Set(['c00000a']);
    expect(checkParagraph('Fact. [c00000a] [c00000a]', known, [])).toEqual({
      ok: true,
      citationIds: ['c00000a'],
    });
    expect(checkParagraph('Fact. [c00000b]', known, [])).toEqual({
      ok: false,
      reason: 'unknown_citation',
    });
    expect(checkParagraph('Fact.', known, [])).toEqual({ ok: false, reason: 'unsupported' });
    expect(checkParagraph('TAX tips [c00000a]', known, ['tax'])).toEqual({
      ok: false,
      reason: 'forbidden_topic',
    });
  });

  it('merges ranked lists by best score', () => {
    const merged = mergeResults(
      [[chunk('a', 'x', 0.01), chunk('b', 'y', 0.03)], [chunk('a', 'x', 0.05)]],
      1,
    );
    expect(merged.map((item) => [item.chunkId, item.score])).toEqual([['a', 0.05]]);
  });
});
