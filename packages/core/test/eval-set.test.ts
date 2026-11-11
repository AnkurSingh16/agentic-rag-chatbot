import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { parseEvalSet } from '../src/index.js';

describe('parseEvalSet', () => {
  it('applies defaults to answerable and unanswerable questions', () => {
    expect(
      parseEvalSet(`questions:
  - id: q1
    question: How do I sync?
    answer: Open settings.
    sources: [data/sync.md]
  - id: q2
    question: What is the share price?
    answerable: false
`),
    ).toEqual({
      questions: [
        {
          id: 'q1',
          question: 'How do I sync?',
          answer: 'Open settings.',
          sources: ['data/sync.md'],
          answerable: true,
        },
        { id: 'q2', question: 'What is the share price?', answerable: false, sources: [] },
      ],
    });
  });

  it.each([
    ['questions: [', 'not valid YAML'],
    ['questions: []', 'questions:'],
    [
      'questions:\n  - id: q1\n    question: Q',
      'questions.0.answer: Answerable questions need one',
    ],
    [
      'questions:\n  - id: q1\n    question: Q\n    answerable: false\n    answer: A',
      'Unanswerable questions have no answer or sources',
    ],
    [
      'questions:\n  - {id: q1, question: Q, answer: A}\n  - {id: q1, question: R, answer: B}',
      'Duplicate id "q1"',
    ],
    ['other: 1', '(root)'],
  ])('rejects %j', (text, message) => {
    expect(() => parseEvalSet(text)).toThrow(message);
  });

  it('accepts the demo instance eval set', async () => {
    const text = await readFile(
      new URL('../../../instances/demo/evals.yaml', import.meta.url),
      'utf8',
    );
    const set = parseEvalSet(text);
    expect(set.questions.length).toBeGreaterThanOrEqual(10);
    expect(set.questions.filter((q) => !q.answerable)).toHaveLength(2);
  });
});
