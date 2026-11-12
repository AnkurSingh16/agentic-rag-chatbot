import { describe, expect, it } from 'vitest';
import { ANSWER_RULES, answerSystem, fallbackText, routeSystem } from '../src/agent/prompts.js';
import { DEFAULT_STYLE_GUIDE } from '../src/config/schema.js';
import { instanceConfigSchema } from '../src/index.js';

function config(persona: Record<string, unknown> = {}) {
  return instanceConfigSchema.parse({
    id: 'help',
    displayName: 'Help',
    persona: {
      systemPrompt: 'You answer questions about the services.',
      answerStyle: 'Short, factual answers.',
      fallback: { message: 'I could not find that on this site.' },
      ...persona,
    },
    auth: { mode: 'public' },
    allowedOrigins: ['http://localhost:5180'],
    sources: [{ type: 'folder', path: 'data' }],
  });
}

describe('answerSystem', () => {
  it('uses the default voice and no examples when the persona sets neither', () => {
    const system = answerSystem(config());
    expect(system.startsWith('You answer questions about the services.')).toBe(true);
    expect(system).toContain('Style: Short, factual answers.');
    expect(system).toContain(`Voice: ${DEFAULT_STYLE_GUIDE}`);
    expect(system).not.toContain('Examples of the voice');
    expect(system.endsWith(ANSWER_RULES)).toBe(true);
  });

  it('includes a custom style guide and each example, in order', () => {
    const system = answerSystem(
      config({
        styleGuide: 'Warm and brief.',
        examples: [
          { question: 'What do you offer?', answer: 'Architecture reviews.' },
          { question: 'Do you mentor?', answer: 'Yes, in small groups.' },
        ],
      }),
    );
    expect(system).toContain('Voice: Warm and brief.');
    expect(system).not.toContain(DEFAULT_STYLE_GUIDE);
    const examplesAt = system.indexOf('Examples of the voice');
    expect(examplesAt).toBeGreaterThan(system.indexOf('Voice: Warm and brief.'));
    expect(system.indexOf('Question: What do you offer?')).toBeGreaterThan(examplesAt);
    expect(system.indexOf('Question: Do you mentor?')).toBeGreaterThan(
      system.indexOf('Answer: Architecture reviews.'),
    );
    expect(system.indexOf(ANSWER_RULES)).toBeGreaterThan(
      system.indexOf('Answer: Yes, in small groups.'),
    );
  });

  it('keeps the routing prompt free of answer style', () => {
    const route = routeSystem(config({ styleGuide: 'Warm and brief.' }));
    expect(route).not.toContain('Voice:');
    expect(route).toContain('route tool');
  });

  it('rejects more than three examples', () => {
    const example = { question: 'Q?', answer: 'A.' };
    expect(() => config({ examples: [example, example, example, example] })).toThrow();
  });
});

describe('fallbackText', () => {
  it('is the message alone when there are no topics or handoff', () => {
    expect(fallbackText({ message: 'Nothing here.', suggestedTopics: [] })).toBe('Nothing here.');
  });

  it('lists up to three topics in one sentence', () => {
    expect(fallbackText({ message: 'Nothing here.', suggestedTopics: ['pricing'] })).toBe(
      'Nothing here.\n\nYou could ask about pricing.',
    );
    expect(
      fallbackText({ message: 'Nothing here.', suggestedTopics: ['pricing', 'mentoring'] }),
    ).toBe('Nothing here.\n\nYou could ask about pricing or mentoring.');
    expect(
      fallbackText({
        message: 'Nothing here.',
        suggestedTopics: ['pricing', 'mentoring', 'writing'],
      }),
    ).toBe('Nothing here.\n\nYou could ask about pricing, mentoring or writing.');
  });

  it('ends with the handoff label and link when one is set', () => {
    expect(
      fallbackText({
        message: 'Nothing here.',
        suggestedTopics: ['pricing'],
        handoff: { url: 'https://example.com/contact', label: 'Get in touch' },
      }),
    ).toBe(
      'Nothing here.\n\nYou could ask about pricing.\n\nGet in touch: https://example.com/contact',
    );
  });
});

describe('fallback policy schema', () => {
  it('allows at most three suggested topics', () => {
    expect(() =>
      config({ fallback: { message: 'No.', suggestedTopics: ['a', 'b', 'c', 'd'] } }),
    ).toThrow();
  });

  it('requires an https handoff link', () => {
    expect(() =>
      config({
        fallback: { message: 'No.', handoff: { url: 'http://example.com', label: 'Contact' } },
      }),
    ).toThrow();
  });

  it('rejects the retired outOfScope field, so old instance files fail at boot', () => {
    expect(() => config({ fallback: undefined, outOfScope: 'No.' })).toThrow(/outOfScope/);
  });
});
