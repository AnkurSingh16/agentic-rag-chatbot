import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';
import { loadInstanceConfig } from '../src/config/load.js';

const reference = readFileSync(
  new URL('../../../docs/reference/instance-config.md', import.meta.url),
  'utf8',
);
const examples = [...reference.matchAll(/```yaml\n([\s\S]*?)```/g)].map((match) => match[1] ?? '');

describe('instance.yaml reference examples', () => {
  it('contains a full example and an rbac example', () => {
    expect(examples).toHaveLength(2);
  });

  it('documents a full example that loads', () => {
    const { config } = loadInstanceConfig(examples[0] ?? '', {});
    expect(config.id).toBe('portfolio');
  });

  it('documents an rbac auth block that loads in place of the public one', () => {
    const full = parse(examples[0] ?? '') as Record<string, unknown>;
    const rbac = parse(examples[1] ?? '') as Record<string, unknown>;
    const { config } = loadInstanceConfig(stringify({ ...full, ...rbac }), {});
    expect(config.auth.mode).toBe('rbac');
  });
});
