import { describe, expect, it } from 'vitest';
import { parseEvalSet } from '../src/eval/eval-set.js';
import { runChatEval } from '../src/eval/run-chat-eval.js';
import { instanceConfigSchema, parseContext } from '../src/index.js';
import type { ChatModel, ChatRequest } from '../src/llm/types.js';
import type { RetrievalStore, RetrievedChunk } from '../src/retrieval/types.js';

const config = instanceConfigSchema.parse({
  id: 'help',
  displayName: 'Help',
  persona: {
    systemPrompt: 'You answer questions about the help articles.',
    answerStyle: 'Short.',
    fallback: { message: 'I can only answer questions about the help articles.' },
  },
  auth: { mode: 'public' },
  allowedOrigins: ['http://localhost:5173'],
  sources: [{ type: 'folder', path: 'data' }],
  embedding: { provider: 'mock' },
});

const evalSet = parseEvalSet(`
questions:
  - id: unanswerable-a
    question: What is the capital of France?
    answerable: false
  - id: unanswerable-b
    question: Which encryption algorithm is used?
    answerable: false
  - id: answerable-a
    question: How do I export notes?
    answer: Use export.
    sources: [data/export.md]
`);

const chunk: RetrievedChunk = {
  chunkId: 'export',
  sourceUri: 'data/export.md',
  title: 'Export',
  headingPath: ['Export'],
  content: 'Export\n\nYou can export notes to Markdown, PDF and HTML.',
  score: 0.03,
};

const retrieval: RetrievalStore = {
  activeVersion: () => Promise.resolve(undefined),
  search: (_access, _version, queries) =>
    Promise.resolve(queries.map((query) => [chunk].slice(0, query.limit))),
};

const version = { id: 'version-1', embeddingProvider: 'mock', embeddingModel: 'mock-hash-v1' };

/**
 * Routes the export question to knowledge and every other question to out_of_scope, then answers
 * with `answer`. The route and answer calls are both real, so the test exercises the answer step.
 */
function model(
  answer: (request: ChatRequest) => string,
  route: (message: string) => string = (message) =>
    message.includes('export') ? 'knowledge' : 'out_of_scope',
): ChatModel {
  return {
    provider: 'mock',
    // eslint-disable-next-line @typescript-eslint/require-await -- the fake yields without awaiting
    async *generate(request) {
      if (request.tools !== undefined) {
        const message = request.messages.at(-1)?.content ?? '';
        yield { type: 'tool_use', name: 'route', input: { intent: route(message), queries: [] } };
      } else {
        yield { type: 'text', text: answer(request) };
      }
      yield {
        type: 'done',
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    },
  };
}

/** Cites the first document, as a model that answers from the documents would. */
const citeFirst = (request: ChatRequest) => {
  const id = parseContext(request.context)[0]?.citationId ?? '';
  return `You can export notes to Markdown, PDF and HTML. [${id}]`;
};

function embedAll(texts: readonly string[]) {
  return Promise.resolve(texts.map(() => Array.from({ length: 384 }, () => 0)));
}

function run(chatModel: ChatModel, repeats = 2, set = evalSet) {
  return runChatEval({
    evalSet: set,
    config,
    access: { instanceId: 'help', tenantKey: '_', accessTags: ['public'] },
    version,
    chatModel,
    models: { chat: 'test-chat', router: 'test-router' },
    embeddings: { provider: 'mock', model: 'mock-hash-v1', dimensions: 384, embed: embedAll },
    retrieval,
    signal: new AbortController().signal,
    repeats,
  });
}

describe('runChatEval', () => {
  it('passes when unanswerable questions are refused and answerable ones are answered with a citation', async () => {
    const result = await run(model(citeFirst));
    expect(result.passed).toBe(true);
    expect(result.unanswerable).toBe(2);
    expect(result.refusedAll).toBe(2);
    expect(result.answerable).toBe(1);
    expect(result.answeredRuns).toBe(2);
    expect(result.answerableRuns).toBe(2);
  });

  it('fails a model that refuses everything, even though every unanswerable question is refused', async () => {
    // The naysayer's case: the answer step never runs, so nothing shows the model can answer.
    const result = await run(
      model(
        () => '',
        () => 'out_of_scope',
      ),
    );
    expect(result.refusedAll).toBe(2);
    expect(result.answeredRuns).toBe(0);
    expect(result.passed).toBe(false);
  });

  it('fails a model that returns empty answers for answerable questions', async () => {
    const result = await run(model(() => ''));
    expect(result.refusedAll).toBe(2);
    expect(result.answeredRuns).toBe(0);
    expect(result.passed).toBe(false);
  });

  it('counts answer-step refusals separately from router refusals', async () => {
    // The unanswerable questions go through retrieval and the answer step, which has no citation.
    const result = await run(
      model(
        () => 'I cannot say.',
        () => 'knowledge',
      ),
    );
    expect(result.routeRefusalRuns).toBe(0);
    expect(result.answerRefusalRuns).toBe(4);
    expect(result.passed).toBe(false);
  });

  it('fails when the model answers an unanswerable question with a supported citation, even once', async () => {
    let calls = 0;
    const leaking = model(
      (request) => {
        calls++;
        return calls === 1 ? citeFirst(request) : 'No answer.';
      },
      () => 'knowledge',
    );
    const result = await run(leaking, 2);
    expect(result.passed).toBe(false);
    const first = result.questions[0];
    expect(first?.refused).toBe(false);
    expect(first?.runs[0]).toMatchObject({ state: 'ANSWERED', citations: 1, refused: false });
  });

  it('does not pass without unanswerable questions', async () => {
    const onlyAnswerable = parseEvalSet(`
questions:
  - id: answerable-a
    question: How do I export notes?
    answer: Use export.
    sources: [data/export.md]
`);
    const result = await run(model(citeFirst), 2, onlyAnswerable);
    expect(result.passed).toBe(false);
    expect(result.unanswerable).toBe(0);
  });

  it('does not pass without answerable questions', async () => {
    const onlyUnanswerable = parseEvalSet(`
questions:
  - id: unanswerable-a
    question: What is the capital of France?
    answerable: false
`);
    const result = await run(model(citeFirst), 2, onlyUnanswerable);
    expect(result.passed).toBe(false);
    expect(result.answerable).toBe(0);
  });
});
