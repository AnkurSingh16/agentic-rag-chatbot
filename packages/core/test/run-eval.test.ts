import { describe, expect, it } from 'vitest';
import { createMockEmbeddingProvider, parseEvalSet, runRetrievalEval } from '../src/index.js';
import type { RetrievalStore, RetrievedChunk } from '../src/index.js';

function retrieving(sources: string[][]): RetrievalStore {
  return {
    activeVersion: () => Promise.resolve(undefined),
    search: (_access, _version, queries) =>
      Promise.resolve(
        queries.map((_query, i) =>
          (sources[i] ?? []).map((sourceUri): RetrievedChunk => ({
            chunkId: sourceUri,
            sourceUri,
            title: '',
            headingPath: [],
            content: '',
            score: 0.02,
          })),
        ),
      ),
  };
}

const options = {
  access: { instanceId: 'help', tenantKey: '_', accessTags: ['public'] },
  versionId: 'v1',
  embeddings: createMockEmbeddingProvider(),
  signal: new AbortController().signal,
};

describe('runRetrievalEval', () => {
  it('averages recall over questions with sources and reports unanswerable ones', async () => {
    const evalSet = parseEvalSet(`questions:
  - { id: a, question: A?, answer: A., sources: [a.md, b.md] }
  - { id: b, question: B?, answer: B. }
  - { id: c, question: C?, answerable: false }
  - { id: d, question: D?, answerable: false }
`);
    const result = await runRetrievalEval({
      ...options,
      evalSet,
      retrieval: retrieving([['a.md', 'a.md', 'x.md'], ['b.md'], [], ['x.md']]),
      minRecall: 0.5,
    });
    expect(result).toMatchObject({
      passed: true,
      recallAt8: 0.5,
      unanswerableEmpty: 1,
      unanswerable: 2,
    });
    expect(result.questions.map((question) => [question.id, question.recall, question.ok])).toEqual(
      [
        ['a', 0.5, false],
        ['b', undefined, true],
        ['c', undefined, true],
        ['d', undefined, false],
      ],
    );
    expect(result.questions[0]?.retrievedSources).toEqual(['a.md', 'x.md']);
  });

  it('fails an eval set with no scored questions', async () => {
    const evalSet = parseEvalSet('questions:\n  - { id: c, question: C?, answerable: false }\n');
    const result = await runRetrievalEval({ ...options, evalSet, retrieval: retrieving([]) });
    expect(result).toMatchObject({ passed: false, recallAt8: 0, minRecall: 0.6 });
  });
});
