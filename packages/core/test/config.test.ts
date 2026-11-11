import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import {
  assertBootSafe,
  authModeOverrideVariable,
  loadInstanceConfig,
} from '../src/config/load.js';
import type { InstanceConfig } from '../src/config/schema.js';
import { ChatbotError } from '../src/errors.js';

type Raw = Record<string, unknown>;

function baseConfig(): Raw {
  return {
    id: 'portfolio',
    displayName: 'Portfolio assistant',
    persona: {
      systemPrompt: 'You answer questions about the published services.',
      answerStyle: 'Short and factual.',
      outOfScope: 'I can only answer questions about the published services.',
    },
    models: { chat: 'chat-model' },
    embedding: { provider: 'fake', model: 'fake-hash-v1' },
    auth: { mode: 'public' },
    allowedOrigins: ['https://example.com'],
    sources: [{ type: 'folder', path: 'docs' }],
  };
}

const rbacAuth = {
  mode: 'rbac',
  issuer: 'https://issuer.example.com/',
  audience: 'chatbot',
  roleClaim: 'roles',
  roles: { staff: ['chat:use', 'docs:read:internal'] },
};

const authenticatedAuth = {
  mode: 'authenticated',
  issuer: 'https://issuer.example.com/',
  audience: 'chatbot',
  defaultTags: ['members'],
};

function load(raw: Raw, env: Record<string, string | undefined> = {}) {
  return loadInstanceConfig(stringify(raw), env);
}

function rejection(run: () => unknown): ChatbotError {
  try {
    run();
  } catch (error) {
    if (error instanceof ChatbotError) return error;
    throw error;
  }
  throw new Error('expected a ChatbotError');
}

function expectRejected(raw: Raw, field: string, env: Record<string, string | undefined> = {}) {
  const error = rejection(() => load(raw, env));
  expect(error.code).toBe('invalid_config');
  expect(error.message).toContain(field);
  return error;
}

function withField(path: string[], value: unknown): Raw {
  const raw = baseConfig();
  let target: Raw = raw;
  for (const key of path.slice(0, -1)) {
    target[key] ??= {};
    target = target[key] as Raw;
  }
  const last = path.at(-1);
  if (last === undefined) throw new Error('empty path');
  if (value === undefined) {
    Reflect.deleteProperty(target, last);
  } else {
    target[last] = value;
  }
  return raw;
}

describe('loadInstanceConfig', () => {
  it('applies defaults to a minimal public config', () => {
    const { config } = load(baseConfig());
    expect(config.embedding.dimensions).toBe(1024);
    expect(config.persona.forbiddenTopics).toEqual([]);
    expect(config.features).toEqual({ adminApi: false });
    expect(config.limits).toEqual({
      requestsPerMinutePerIp: 20,
      requestsPerMinutePerSession: 10,
      dailyTokensPerIp: 50_000,
      dailyTokensPerInstance: 1_000_000,
    });
    expect(config.chunking).toEqual({
      targetTokens: 450,
      overlapTokens: 60,
      minTokens: 50,
      maxTokens: 800,
    });
    expect(config.theme).toBeUndefined();
    expect(config.requiredPolicies).toBeUndefined();
  });

  it('accepts every source type and keeps explicit values', () => {
    const raw = baseConfig();
    raw.sources = [
      { type: 'folder', path: 'docs' },
      { type: 'urls', urls: ['https://example.com/a', 'http://localhost:3000/b'] },
      { type: 'sitemap', url: 'https://example.com/sitemap.xml' },
      { type: 'github', repo: 'owner/repo.docs', path: 'docs' },
      { type: 'github', repo: 'owner/repo', path: 'guides', ref: 'v1' },
    ];
    raw.theme = { primaryColor: '#0af', backgroundColor: '#ffffff', borderRadius: '0.5rem' };
    raw.evalSet = 'eval/questions.yaml';
    raw.requiredPolicies = ['aegis_tenant_restrict'];
    raw.models = { chat: 'chat-model', router: 'router-model' };
    const { config } = load(raw);
    expect(config.sources[3]).toEqual({
      type: 'github',
      repo: 'owner/repo.docs',
      path: 'docs',
      ref: 'main',
    });
    expect(config.sources[4]).toMatchObject({ ref: 'v1' });
    expect(config.theme?.borderRadius).toBe('0.5rem');
    expect(config.models.router).toBe('router-model');
  });

  it('accepts authenticated and rbac auth blocks', () => {
    expect(load({ ...baseConfig(), auth: authenticatedAuth }).config.auth.mode).toBe(
      'authenticated',
    );
    const { config } = load({ ...baseConfig(), auth: rbacAuth });
    expect(config.auth).toEqual(rbacAuth);
  });

  it('computes the same hash regardless of key order and a different hash on any change', () => {
    const raw = baseConfig();
    const reordered = Object.fromEntries(Object.entries(raw).reverse());
    const first = load(raw).configHash;
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(load(reordered).configHash).toBe(first);
    expect(load(withField(['displayName'], 'Other')).configHash).not.toBe(first);
  });

  it('hashes the config after defaults so an explicit default does not change the hash', () => {
    const explicit = withField(['features'], { adminApi: false });
    expect(load(explicit).configHash).toBe(load(baseConfig()).configHash);
  });

  it('rejects text that is not YAML', () => {
    const error = rejection(() => loadInstanceConfig('id: [unclosed', {}));
    expect(error.code).toBe('invalid_config');
    expect(error.message).toContain('not valid YAML');
  });

  it('rejects a document that is not a mapping', () => {
    expect(rejection(() => loadInstanceConfig('- a\n- b\n', {})).message).toContain('(root)');
  });

  it.each([
    ['too short', 'a'],
    ['upper case', 'Portfolio'],
    ['leading digit', '1bot'],
    ['underscore', 'my_bot'],
    ['too long', `a${'b'.repeat(40)}`],
  ])('rejects an id that is %s', (_label, id) => {
    expectRejected(withField(['id'], id), 'id:');
  });

  it('rejects unknown keys, so a misplaced secret cannot be stored', () => {
    expectRejected(withField(['apiKey'], 'sk-123'), 'apiKey');
    expectRejected(withField(['embedding', 'apiKey'], 'sk-123'), 'embedding');
  });

  it.each([
    [['displayName'], '   '],
    [['persona', 'systemPrompt'], undefined],
    [['persona', 'outOfScope'], ''],
    [['models', 'chat'], undefined],
    [['embedding', 'model'], ''],
  ])('rejects a missing or blank %j', (path, value) => {
    expectRejected(withField(path, value), path.join('.'));
  });

  it('rejects an unsupported embedding provider', () => {
    expectRejected(withField(['embedding', 'provider'], 'openai'), 'embedding.provider');
  });

  it('rejects any embedding dimension other than 1024', () => {
    expectRejected(withField(['embedding', 'dimensions'], 768), 'embedding.dimensions');
  });

  it.each([
    ['a bare wildcard', ['*'], 'Wildcards'],
    ['a wildcard subdomain', ['https://*.example.com'], 'Wildcards'],
    ['an empty list', [], 'allowedOrigins'],
    ['a path', ['https://example.com/app'], 'no path'],
    ['a trailing slash', ['https://example.com/'], 'no path'],
    ['a non-http scheme', ['ftp://example.com'], 'must use https'],
    ['http on a public host', ['http://example.com'], 'must use https'],
    ['http on a host that only starts with localhost', ['http://localhost.example.com'], 'https'],
    ['a non-URL', ['example.com'], 'not a URL origin'],
  ])('rejects allowedOrigins with %s', (_label, origins, message) => {
    const error = expectRejected(withField(['allowedOrigins'], origins), 'allowedOrigins');
    expect(error.message).toContain(message);
  });

  it('accepts http only for loopback origins', () => {
    const origins = ['http://localhost:5173', 'http://127.0.0.1:3000', 'http://[::1]:8080'];
    expect(load(withField(['allowedOrigins'], origins)).config.allowedOrigins).toEqual(origins);
  });

  it('rejects an unknown auth mode', () => {
    expectRejected(withField(['auth'], { mode: 'open' }), 'auth.mode');
  });

  it.each([
    ['issuer', 'auth.issuer'],
    ['audience', 'auth.audience'],
    ['defaultTags', 'auth.defaultTags'],
  ])('rejects authenticated mode without %s', (key, field) => {
    const auth: Raw = { ...authenticatedAuth };
    Reflect.deleteProperty(auth, key);
    expectRejected(withField(['auth'], auth), field);
  });

  it.each([
    ['issuer', 'auth.issuer'],
    ['audience', 'auth.audience'],
    ['roleClaim', 'auth.roleClaim'],
    ['roles', 'auth.roles'],
  ])('rejects rbac mode without %s', (key, field) => {
    const auth: Raw = { ...rbacAuth };
    Reflect.deleteProperty(auth, key);
    expectRejected(withField(['auth'], auth), field);
  });

  it('rejects an issuer that is not https', () => {
    expectRejected(
      withField(['auth'], { ...authenticatedAuth, issuer: 'http://issuer.example.com/' }),
      'auth.issuer',
    );
  });

  it('rejects authenticated mode with no default tags or an invalid tag', () => {
    expectRejected(withField(['auth'], { ...authenticatedAuth, defaultTags: [] }), 'defaultTags');
    expectRejected(
      withField(['auth'], { ...authenticatedAuth, defaultTags: ['Has Space'] }),
      'defaultTags',
    );
  });

  it('rejects unknown permissions and empty docs:read tags in a role map', () => {
    for (const permission of ['docs:write:x', 'docs:read:', 'admin']) {
      expectRejected(
        withField(['auth'], { ...rbacAuth, roles: { staff: [permission] } }),
        'auth.roles.staff',
      );
    }
  });

  it('rejects role names that start with an underscore', () => {
    expectRejected(
      withField(['auth'], { ...rbacAuth, roles: { _hidden: ['chat:use'] } }),
      '_hidden',
    );
  });

  it.each([['__proto__'], ['constructor'], ['prototype']])(
    'rejects the reserved role name %s instead of dropping it',
    (name) => {
      const yaml = stringify({ ...baseConfig(), auth: { ...rbacAuth, roles: {} } }).replace(
        'roles: {}',
        `roles:\n    staff: [chat:use]\n    ${name}: [instance:admin]`,
      );
      const error = rejection(() => loadInstanceConfig(yaml, {}));
      expect(error.code).toBe('invalid_config');
      expect(error.message).toContain(`auth.roles.${name}: Reserved role name`);
    },
  );

  it.each([
    ['requestsPerMinutePerIp', 0],
    ['requestsPerMinutePerSession', -1],
    ['dailyTokensPerIp', 1.5],
    ['dailyTokensPerInstance', 'many'],
  ])('rejects limits.%s = %j', (key, value) => {
    expectRejected(withField(['limits', key], value), `limits.${key}`);
  });

  it.each([
    ['primaryColor', 'red'],
    ['textColor', '#12345'],
    ['backgroundColor', 'url(x)'],
    ['borderRadius', '4px; color: red'],
  ])('rejects theme.%s values that are not plain colours or lengths', (key, value) => {
    expectRejected(withField(['theme', key], value), `theme.${key}`);
  });

  it.each([
    [[], 'sources'],
    [[{ type: 'ftp', path: 'x' }], 'sources.0.type'],
    [[{ type: 'folder' }], 'sources.0.path'],
    [[{ type: 'urls', urls: [] }], 'sources.0.urls'],
    [[{ type: 'urls', urls: ['file:///etc/passwd'] }], 'sources.0.urls.0'],
    [[{ type: 'sitemap', url: 'not a url' }], 'sources.0.url'],
    [[{ type: 'github', repo: 'no-slash', path: 'docs' }], 'sources.0.repo'],
  ])('rejects sources %j', (sources, field) => {
    expectRejected(withField(['sources'], sources), field);
  });

  it.each([
    [{ targetTokens: 900 }, 'chunking.targetTokens'],
    [{ minTokens: 450 }, 'chunking.minTokens'],
    [{ overlapTokens: 450 }, 'chunking.overlapTokens'],
    [{ maxTokens: 9000 }, 'chunking.maxTokens'],
    [{ targetTokens: 0 }, 'chunking.targetTokens'],
  ])('rejects inconsistent chunking %j', (chunking, field) => {
    expectRejected(withField(['chunking'], chunking), field);
  });

  it('rejects policy names that are not SQL identifiers', () => {
    expectRejected(withField(['requiredPolicies'], ['drop table;']), 'requiredPolicies.0');
  });

  it('reports every failing field in one error', () => {
    const raw = withField(['id'], 'X');
    raw.allowedOrigins = ['*'];
    const error = expectRejected(raw, 'id:');
    expect(error.message).toContain('allowedOrigins.0');
  });
});

describe('auth mode environment override', () => {
  const rbacReadyAuthenticated = {
    ...authenticatedAuth,
    roleClaim: 'roles',
    roles: rbacAuth.roles,
  };

  it('derives the variable name from the instance id', () => {
    expect(authModeOverrideVariable('aegis-ai')).toBe('RAG_AUTH_MODE__AEGIS_AI');
  });

  it('tightens public to authenticated when the auth block has the fields', () => {
    const raw = withField(['auth'], { ...authenticatedAuth, mode: 'public' });
    const { config } = load(raw, { RAG_AUTH_MODE__PORTFOLIO: 'authenticated' });
    expect(config.auth).toEqual(authenticatedAuth);
  });

  it('tightens authenticated to rbac and drops fields rbac does not use', () => {
    const raw = withField(['auth'], rbacReadyAuthenticated);
    const { config } = load(raw, { RAG_AUTH_MODE__PORTFOLIO: 'rbac' });
    expect(config.auth).toEqual({ ...rbacAuth });
  });

  it('changes the config hash when the effective mode changes', () => {
    const raw = withField(['auth'], rbacReadyAuthenticated);
    expect(load(raw, { RAG_AUTH_MODE__PORTFOLIO: 'rbac' }).configHash).not.toBe(
      load(raw).configHash,
    );
  });

  it.each([
    ['rbac', 'authenticated'],
    ['rbac', 'public'],
    ['authenticated', 'public'],
  ])('rejects loosening %s to %s', (configured, override) => {
    const auth = { ...rbacReadyAuthenticated, mode: configured };
    const error = expectRejected(withField(['auth'], auth), 'RAG_AUTH_MODE__PORTFOLIO', {
      RAG_AUTH_MODE__PORTFOLIO: override,
    });
    expect(error.message).toContain(`from ${configured} to ${override}`);
  });

  it('rejects an override value that is not a mode', () => {
    expectRejected(baseConfig(), 'RAG_AUTH_MODE__PORTFOLIO', { RAG_AUTH_MODE__PORTFOLIO: 'open' });
  });

  it('fails validation when the override needs fields the auth block lacks', () => {
    expectRejected(baseConfig(), 'auth.issuer', { RAG_AUTH_MODE__PORTFOLIO: 'rbac' });
  });

  it('does not let an override replace an invalid configured mode', () => {
    const error = expectRejected(withField(['auth'], { ...rbacAuth, mode: 'RBAC' }), 'auth.mode', {
      RAG_AUTH_MODE__PORTFOLIO: 'rbac',
    });
    expect(error.message).not.toContain('RAG_AUTH_MODE__PORTFOLIO');
  });

  it('does not let an override supply a missing mode', () => {
    expectRejected(withField(['auth'], { issuer: 'https://issuer.example.com/' }), 'auth.mode', {
      RAG_AUTH_MODE__PORTFOLIO: 'public',
    });
  });

  it('ignores empty overrides and variables for other instances', () => {
    const raw = withField(['auth'], rbacAuth);
    expect(load(raw, { RAG_AUTH_MODE__PORTFOLIO: '' }).config.auth.mode).toBe('rbac');
    expect(load(raw, { RAG_AUTH_MODE__OTHER: 'public' }).config.auth.mode).toBe('rbac');
  });

  it('allows an override equal to the configured mode', () => {
    expect(load(baseConfig(), { RAG_AUTH_MODE__PORTFOLIO: 'public' }).config.auth.mode).toBe(
      'public',
    );
    const raw = withField(['auth'], rbacAuth);
    expect(load(raw, { RAG_AUTH_MODE__PORTFOLIO: 'rbac' }).config.auth.mode).toBe('rbac');
  });
});

describe('assertBootSafe', () => {
  it('rejects the admin API on a public instance', () => {
    expectRejected(withField(['features'], { adminApi: true }), 'features.adminApi');
  });

  it('allows the admin API on authenticated and rbac instances', () => {
    const raw = withField(['features'], { adminApi: true });
    raw.auth = rbacAuth;
    expect(load(raw).config.features.adminApi).toBe(true);
    raw.auth = authenticatedAuth;
    expect(load(raw).config.features.adminApi).toBe(true);
  });

  it('rejects an rbac instance with an empty role map', () => {
    expectRejected(withField(['auth'], { ...rbacAuth, roles: {} }), 'auth.roles');
  });

  it('can be called directly on a config built in code', () => {
    const { config } = load(baseConfig());
    const unsafe: InstanceConfig = { ...config, features: { adminApi: true } };
    expect(() => {
      assertBootSafe(config);
    }).not.toThrow();
    expect(
      rejection(() => {
        assertBootSafe(unsafe);
      }).message,
    ).toContain('features.adminApi');
  });
});
