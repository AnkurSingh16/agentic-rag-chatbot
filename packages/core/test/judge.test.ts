import { describe, expect, it } from 'vitest';
import { runChat } from '../src/agent/run-chat.js';
import type { ChatEvent } from '../src/agent/events.js';
import { instanceConfigSchema, parseContext } from '../src/index.js';
import type { ChatModel, ChatRequest } from '../src/llm/types.js';
import type { RetrievalStore, RetrievedChunk } from '../src/retrieval/types.js';

const chunk: RetrievedChunk = {
  chunkId: 'services',
  sourceUri: 'data/services.md',
  title: 'Services',
  headingPath: ['Services'],
  content: 'Services\n\nFractional engineering leadership for small businesses.',
  score: 0.03,
};

const retrieval: RetrievalStore = {
  activeVersion: () =>
    Promise.resolve({ id: 'v1', embeddingProvider: 'mock', embeddingModel: 'mock-hash-v1' }),
  search: (_access, _version, queries) =>
    Promise.resolve(queries.map((query) => [chunk].slice(0, query.limit))),
};

function config(judge: boolean) {
  return instanceConfigSchema.parse({
    id: 'help',
    displayName: 'Help',
    persona: {
      systemPrompt: 'You answer questions about the services.',
      answerStyle: 'Short.',
      fallback: { message: 'I can only answer about the services.' },
    },
    auth: { mode: 'public' },
    allowedOrigins: ['http://localhost:5173'],
    sources: [{ type: 'folder', path: 'data' }],
    embedding: { provider: 'mock' },
    verification: { judge },
  });
}

const JUDGE = 'You check one paragraph';

/** Route to knowledge, answer with a supported paragraph, and answer the judge with `verdict`. */
function model(verdict: (request: ChatRequest) => string, answer: string): ChatModel {
  return {
    provider: 'mock',
    // eslint-disable-next-line @typescript-eslint/require-await -- the fake yields without awaiting
    async *generate(request) {
      if (request.tools !== undefined) {
        yield { type: 'tool_use', name: 'route', input: { intent: 'knowledge', queries: [] } };
      } else if (request.system.startsWith(JUDGE)) {
        yield { type: 'text', text: verdict(request) };
      } else {
        const id = parseContext(request.context)[0]?.citationId ?? '';
        yield { type: 'text', text: `${answer} [${id}]` };
      }
      yield {
        type: 'done',
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    },
  };
}

async function turn(judge: boolean, chatModel: ChatModel) {
  const events: ChatEvent[] = [];
  const outcome = await runChat({
    config: config(judge),
    access: { instanceId: 'help', tenantKey: '_', accessTags: ['public'] },
    requestId: 'r1',
    conversationId: 'c1',
    message: 'Do you offer fractional leadership?',
    history: [],
    chatModel,
    models: { chat: 'test-chat', router: 'test-router' },
    embeddings: {
      provider: 'mock',
      model: 'mock-hash-v1',
      dimensions: 384,
      embed: (texts) => Promise.resolve(texts.map(() => Array.from({ length: 384 }, () => 0))),
    },
    retrieval,
    signal: new AbortController().signal,
    emit: (event) => events.push(event),
  });
  return { outcome, events };
}

describe('verification judge', () => {
  it('releases a paragraph the judge confirms', async () => {
    const { outcome, events } = await turn(
      true,
      model(() => 'YES', 'Fractional engineering leadership is offered.'),
    );
    expect(outcome.state).toBe('ANSWERED');
    expect(events.some((event) => event.event === 'token')).toBe(true);
  });

  it('refuses a paragraph the judge rejects, and releases nothing', async () => {
    const { outcome, events } = await turn(
      true,
      model(() => 'NO', 'Fractional engineering leadership is offered.'),
    );
    expect(outcome.state).toBe('INSUFFICIENT_EVIDENCE');
    expect(outcome.text).not.toContain('Fractional engineering leadership is offered');
    expect(events.some((event) => event.event === 'citation')).toBe(false);
  });

  it('fails closed when the judge does not answer YES', async () => {
    const { outcome } = await turn(
      true,
      model(() => 'Maybe, it depends.', 'Fractional engineering leadership is offered.'),
    );
    expect(outcome.state).toBe('INSUFFICIENT_EVIDENCE');
  });

  it('is off by default, so the answer streams without a judge call', async () => {
    const judged: string[] = [];
    const { outcome } = await turn(
      false,
      model((request) => {
        judged.push(request.system);
        return 'NO';
      }, 'Fractional engineering leadership is offered.'),
    );
    expect(outcome.state).toBe('ANSWERED');
    expect(judged).toEqual([]);
  });

  it('gives the retry its own judge budget, so a second attempt can pass', async () => {
    // Attempt one judges paragraph one YES and paragraph two NO. Attempt two judges both YES.
    // A budget shared across attempts would run out on the fourth judge call.
    const verdicts = ['YES', 'NO', 'YES', 'YES'];
    let judged = 0;
    const chatModel: ChatModel = {
      provider: 'mock',
      // eslint-disable-next-line @typescript-eslint/require-await -- the fake yields without awaiting
      async *generate(request) {
        if (request.tools !== undefined) {
          yield { type: 'tool_use', name: 'route', input: { intent: 'knowledge', queries: [] } };
        } else if (request.system.startsWith(JUDGE)) {
          yield { type: 'text', text: verdicts[judged++] ?? 'NO' };
        } else {
          const id = parseContext(request.context)[0]?.citationId ?? '';
          yield {
            type: 'text',
            text: `Fractional engineering leadership is offered. [${id}]\n\nIt is for small businesses. [${id}]`,
          };
        }
        yield {
          type: 'done',
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        };
      },
    };
    const { outcome } = await turn(true, chatModel);
    expect(judged).toBe(4);
    expect(outcome.state).toBe('ANSWERED');
  });
});
