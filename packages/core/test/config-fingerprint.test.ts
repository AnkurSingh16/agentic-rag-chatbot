import { describe, expect, it } from 'vitest';
import { chatConfigFingerprint, instanceConfigSchema } from '../src/index.js';

const base = {
  id: 'help',
  displayName: 'Help',
  persona: {
    systemPrompt: 'You answer questions about the help articles.',
    answerStyle: 'Short.',
    fallback: { message: 'I can only answer questions about the help articles.' },
    forbiddenTopics: ['salary'],
  },
  auth: { mode: 'public' },
  allowedOrigins: ['http://localhost:5173'],
  sources: [{ type: 'folder', path: 'data' }],
  embedding: { provider: 'mock' },
};
const models = { chat: 'qwen2.5:7b', router: 'qwen2.5:7b' };

describe('chatConfigFingerprint', () => {
  it('is stable for the same settings', () => {
    const a = chatConfigFingerprint(instanceConfigSchema.parse(base), models);
    const b = chatConfigFingerprint(instanceConfigSchema.parse({ ...base }), models);
    expect(a).toBe(b);
  });

  it('changes when the judge is turned off', () => {
    const on = instanceConfigSchema.parse({ ...base, verification: { judge: true } });
    const off = instanceConfigSchema.parse({ ...base, verification: { judge: false } });
    expect(chatConfigFingerprint(on, models)).not.toBe(chatConfigFingerprint(off, models));
  });

  it('changes when a forbidden topic, the persona or a model name changes', () => {
    const config = instanceConfigSchema.parse(base);
    const original = chatConfigFingerprint(config, models);
    const topics = instanceConfigSchema.parse({
      ...base,
      persona: { ...base.persona, forbiddenTopics: [] },
    });
    expect(chatConfigFingerprint(topics, models)).not.toBe(original);
    expect(chatConfigFingerprint(config, { ...models, chat: 'other' })).not.toBe(original);
  });
});
