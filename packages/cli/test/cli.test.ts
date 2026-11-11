import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadInstanceConfig, parseEvalSet } from '@agentic-rag/core';
import type { MigrateCliConfig } from '@agentic-rag/server';
import { USAGE, run } from '../src/cli.js';
import type { CliContext } from '../src/context.js';
import { formatTable } from '../src/commands/versions.js';
import { MemoryStore, memoryRetrieval } from '../../core/test/memory-store.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface Harness {
  context: CliContext;
  store: MemoryStore;
  out: () => string;
  err: () => string;
  opened: string[];
  closed: number;
  migrations: MigrateCliConfig[];
}

async function harness(
  env: Record<string, string> = {},
  overrides: Partial<CliContext> = {},
): Promise<Harness> {
  const cwd = await mkdtemp(join(tmpdir(), 'ragctl-'));
  directories.push(cwd);
  const stdout: string[] = [];
  const stderr: string[] = [];
  const store = new MemoryStore();
  const state: Harness = {
    store,
    out: () => stdout.join(''),
    err: () => stderr.join(''),
    opened: [],
    closed: 0,
    migrations: [],
    context: {
      env: {
        DATABASE_INGEST_URL: 'postgres://rag_ingest:pw@127.0.0.1/rag',
        EMBEDDING_PROVIDER: 'mock',
        ...env,
      },
      cwd,
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
      openIngestStore: (url) => {
        state.opened.push(url);
        return {
          store,
          retrieval: memoryRetrieval(store),
          close: () => {
            state.closed++;
            return Promise.resolve();
          },
        };
      },
      migrate: (config) => {
        state.migrations.push(config);
        return Promise.resolve({ applied: ['0006_cap_usage_increments.sql'] });
      },
      fetch: () => Promise.reject(new Error('no network')),
      operator: 'tester',
      signal: new AbortController().signal,
      ...overrides,
    },
  };
  return state;
}

async function readyVersion(store: MemoryStore, instanceId = 'help'): Promise<string> {
  await store.ensureInstance(instanceId);
  const id = await store.createIndexVersion(instanceId, {
    embeddingProvider: 'mock',
    embeddingModel: 'mock-hash-v1',
    embeddingDimensions: 384,
    chunkerHash: 'a'.repeat(64),
    configHash: 'b'.repeat(64),
  });
  await store.markReady(instanceId, id, { documents: 2, chunks: 5 });
  return id;
}

describe('ragctl arguments', () => {
  it('prints help with exit code 0', async () => {
    for (const args of [['--help'], ['-h'], ['help'], ['train', '--help'], ['migrate', '-h']]) {
      const h = await harness();
      expect(await run(args, h.context)).toBe(0);
      expect(h.out()).toBe(USAGE);
    }
  });

  it('prints usage to stderr with exit code 1 when no command is given', async () => {
    const h = await harness();
    expect(await run([], h.context)).toBe(1);
    expect(h.err()).toBe(USAGE);
  });

  it('rejects unknown commands, unknown options and missing values with exit code 1', async () => {
    const cases: [string[], string][] = [
      [['deploy'], 'Unknown command "deploy"'],
      [['train', 'help', '--fast'], "Unknown option '--fast'"],
      [['activate', 'help', 'v1', '--force', '--reason'], "Option '--reason <value>'"],
      [['train'], 'Missing instance ID'],
      [['train', 'Bad_ID'], 'Instance ID "Bad_ID" must match'],
      [['train', 'a', 'b'], 'Usage: ragctl train <id>'],
      [['init', 'a', 'b'], 'Usage: ragctl init <id>'],
      [['versions', 'a', 'b'], 'Usage: ragctl versions <id>'],
      [['activate', 'help'], 'Usage: ragctl activate'],
    ];
    for (const [args, message] of cases) {
      const h = await harness();
      expect(await run(args, h.context), args.join(' ')).toBe(1);
      expect(h.err()).toContain(message);
    }
  });

  it('returns exit code 2 for unexpected failures', async () => {
    const h = await harness();
    h.store.listVersions = () => Promise.reject(new Error('connection reset'));
    expect(await run(['versions', 'help'], h.context)).toBe(2);
    expect(h.err()).toBe('Unexpected error: connection reset\n');
    expect(h.closed).toBe(1);
  });

  it('reports a non-error throw as unexpected', async () => {
    const h = await harness(
      {},
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- third-party code can reject with anything
      { migrate: () => Promise.reject('boom') },
    );
    const env = {
      DATABASE_ADMIN_URL: 'postgres://admin:pw@localhost/rag',
      RAG_RUNTIME_PASSWORD: 'r'.repeat(16),
      RAG_INGEST_PASSWORD: 'i'.repeat(16),
    };
    expect(await run(['migrate'], { ...h.context, env })).toBe(2);
    expect(h.err()).toBe('Unexpected error: boom\n');
  });
});

describe('ragctl init', () => {
  it('scaffolds a config that validates, a sample document and a valid eval set', async () => {
    const h = await harness();
    expect(await run(['init', 'support-bot'], h.context)).toBe(0);
    const dir = join(h.context.cwd, 'instances', 'support-bot');
    const loaded = loadInstanceConfig(await readFile(join(dir, 'instance.yaml'), 'utf8'), {});
    expect(loaded.config).toMatchObject({
      id: 'support-bot',
      auth: { mode: 'public' },
      embedding: { provider: 'local', model: 'Xenova/all-MiniLM-L6-v2', dimensions: 384 },
      sources: [{ type: 'folder', path: 'data' }],
      evalSet: 'evals.yaml',
    });
    expect(await readFile(join(dir, 'data', 'welcome.md'), 'utf8')).toMatch(/^# Welcome/);
    const evals = parseEvalSet(await readFile(join(dir, 'evals.yaml'), 'utf8'));
    expect(evals.questions).toHaveLength(3);
    expect(evals.questions.filter((q) => !q.answerable)).toHaveLength(1);
    expect(h.out()).toContain('ragctl train support-bot');
  });

  it('writes under --instances and refuses to overwrite an existing instance', async () => {
    const h = await harness();
    expect(await run(['init', 'site', '--instances', 'config/bots'], h.context)).toBe(0);
    const path = join(h.context.cwd, 'config', 'bots', 'site', 'instance.yaml');
    await writeFile(path, 'edited');
    expect(await run(['init', 'site', '--instances', 'config/bots'], h.context)).toBe(1);
    expect(h.err()).toContain('already exists; nothing was changed');
    expect(await readFile(path, 'utf8')).toBe('edited');
  });
});

describe('ragctl train', () => {
  it('trains a scaffolded instance and prints a summary', async () => {
    const h = await harness();
    await run(['init', 'help'], h.context);
    expect(await run(['train', 'help'], h.context)).toBe(0);
    expect(h.opened).toEqual(['postgres://rag_ingest:pw@127.0.0.1/rag']);
    expect(h.closed).toBe(1);
    const versionId = h.store.versions[0]?.id ?? '';
    expect(h.out()).toContain(`version ${versionId} is ready`);
    expect(h.out()).toContain('documents 1, chunks 3 (3 embedded, 0 reused from cache)');
    expect(h.err()).toContain('Loaded 1 documents, 3 chunks');

    expect(await run(['train', 'help'], h.context)).toBe(0);
    expect(h.out()).toContain('(0 embedded, 3 reused from cache)');
  });

  it('lists deleted versions after keeping three', async () => {
    const h = await harness();
    await run(['init', 'help'], h.context);
    const doc = join(h.context.cwd, 'instances', 'help', 'data', 'welcome.md');
    for (let i = 0; i < 4; i++) {
      await writeFile(doc, `# Welcome\n\nRun ${i}.`);
      await run(['train', 'help'], h.context);
    }
    expect(h.out()).toContain('Deleted old versions: ');
    expect(h.store.versions).toHaveLength(3);
  });

  it('applies EMBEDDING_PROVIDER over the instance config and rejects unknown providers', async () => {
    const ok = await harness();
    await run(['init', 'help'], ok.context);
    expect(await run(['train', 'help'], ok.context)).toBe(0);
    expect(ok.out()).toContain('embeddings mock/mock-hash-v1');
    expect(ok.store.versions[0]).toMatchObject({
      embeddingProvider: 'mock',
      embeddingModel: 'mock-hash-v1',
    });

    const unknown = await harness({ EMBEDDING_PROVIDER: 'voyage' });
    await run(['init', 'help'], unknown.context);
    expect(await run(['train', 'help'], unknown.context)).toBe(1);
    expect(unknown.err()).toContain('EMBEDDING_PROVIDER must be one of local, mock');
    expect(unknown.opened).toEqual([]);
  });

  it('trains from --source instead of the configured sources', async () => {
    const h = await harness();
    await run(['init', 'help'], h.context);
    const other = join(h.context.cwd, 'elsewhere', 'data');
    await mkdir(other, { recursive: true });
    await writeFile(join(other, 'faq.md'), '# FAQ\n\nThe office opens at nine.');
    expect(await run(['train', 'help', '--source', 'elsewhere/data'], h.context)).toBe(0);
    const uris = h.store.versions[0]?.documents.map((entry) => entry.document.sourceUri);
    expect(uris).toEqual(['data/faq.md']);
  });

  it('fails clearly without an instance, a matching id or a database URL', async () => {
    const missing = await harness();
    expect(await run(['train', 'nothing'], missing.context)).toBe(1);
    expect(missing.err()).toContain('create the instance with "ragctl init nothing"');

    const renamed = await harness();
    await run(['init', 'help'], renamed.context);
    const path = join(renamed.context.cwd, 'instances', 'help', 'instance.yaml');
    await writeFile(path, (await readFile(path, 'utf8')).replace('id: help', 'id: other'));
    expect(await run(['train', 'help'], renamed.context)).toBe(1);
    expect(renamed.err()).toContain('has id "other"; it must match the directory name "help"');

    const noUrl = await harness({ DATABASE_INGEST_URL: '' });
    await run(['init', 'help'], noUrl.context);
    expect(await run(['train', 'help'], noUrl.context)).toBe(1);
    expect(noUrl.err()).toBe('Error: DATABASE_INGEST_URL is not set; see .env.example\n');
  });
});

describe('ragctl versions', () => {
  it('prints a table with eval state, newest first', async () => {
    const h = await harness();
    const older = await readyVersion(h.store);
    const newer = await readyVersion(h.store);
    await h.store.recordEvalRun('help', newer, {
      embeddingProvider: 'mock',
      embeddingModel: 'mock-hash-v1',
      passed: false,
      metrics: {},
    });
    expect(await run(['versions', 'help'], h.context)).toBe(0);
    const lines = h.out().trimEnd().split('\n');
    expect(lines[0]).toMatch(/^VERSION +STATUS +EMBEDDING +DOCS +CHUNKS +EVAL +CREATED \(UTC\)/);
    expect(lines[1]).toMatch(new RegExp(`^${newer} +ready +mock/mock-hash-v1 +2 +5 +failed `));
    expect(lines[2]).toMatch(new RegExp(`^${older} .* none +2026-01-01 00:00:\\d\\d +-$`));
  });

  it('prints JSON with --json and a hint when there are no versions', async () => {
    const h = await harness();
    const id = await readyVersion(h.store);
    expect(await run(['versions', 'help', '--json'], h.context)).toBe(0);
    const parsed = JSON.parse(h.out()) as { id: string; status: string; createdAt: string }[];
    expect(parsed).toEqual([expect.objectContaining({ id, status: 'ready' })]);
    expect(parsed[0]?.createdAt).toMatch(/^2026-01-01T/);

    const empty = await harness();
    expect(await run(['versions', 'help'], empty.context)).toBe(0);
    expect(empty.out()).toBe('No index versions for help. Run "ragctl train help" first.\n');
  });

  it('aligns table columns', () => {
    expect(
      formatTable([
        ['A', 'BB'],
        ['CCC', 'D'],
      ]),
    ).toBe('A    BB\nCCC  D');
  });
});

describe('ragctl eval', () => {
  async function trained(env: Record<string, string> = {}) {
    const h = await harness(env);
    await run(['init', 'help'], h.context);
    await run(['train', 'help'], h.context);
    return h;
  }

  it('scores the newest version, records a passing run and unlocks activation', async () => {
    const h = await trained();
    expect(await run(['eval', 'help'], h.context)).toBe(0);
    const version = h.store.versions[0];
    expect(version?.evals).toHaveLength(1);
    expect(version?.evals[0]).toMatchObject({
      embeddingProvider: 'mock',
      embeddingModel: 'mock-hash-v1',
      passed: true,
      metrics: { harness: 'retrieval', recallAt8: 1, minRecall: 0.6, questions: 3 },
    });
    expect(h.out()).toMatch(/opening-hours +answer +1\.00 +yes +data\/welcome\.md/);
    expect(h.out()).toContain('recall@8 1.00 (minimum 0.60)');
    expect(h.out()).toContain('Eval passed.');
    expect(await run(['activate', 'help', version?.id ?? ''], h.context)).toBe(0);
  });

  it('records a failing run and exits with 1 when recall is below the minimum', async () => {
    const h = await trained();
    const path = join(h.context.cwd, 'instances', 'help', 'evals.yaml');
    await writeFile(
      path,
      (await readFile(path, 'utf8')).replaceAll('data/welcome.md', 'data/x.md'),
    );
    const versionId = h.store.versions[0]?.id ?? '';
    expect(await run(['eval', 'help', versionId, '--min-recall', '0.5'], h.context)).toBe(1);
    expect(h.store.versions[0]?.evals[0]).toMatchObject({ passed: false });
    expect(h.out()).toContain('recall@8 0.00 (minimum 0.50)');
    expect(h.err()).toContain(`Eval failed for ${versionId}`);
  });

  it('refuses bad options, missing versions, other embedding models and missing eval sets', async () => {
    const h = await trained();
    expect(await run(['eval', 'help', '--min-recall', '1.5'], h.context)).toBe(1);
    expect(h.err()).toContain('--min-recall must be a number from 0 to 1');
    expect(await run(['eval', 'help', 'nope'], h.context)).toBe(1);
    expect(h.err()).toContain('Index version nope does not exist');
    expect(await run(['eval'], h.context)).toBe(1);
    expect(h.err()).toContain('Usage: ragctl eval');

    const local = await trained();
    local.context.env = { ...local.context.env, EMBEDDING_PROVIDER: 'local' };
    expect(await run(['eval', 'help'], local.context)).toBe(1);
    expect(local.err()).toContain('but EMBEDDING_PROVIDER selects local/Xenova/all-MiniLM-L6-v2');

    const empty = await harness();
    await run(['init', 'help'], empty.context);
    expect(await run(['eval', 'help'], empty.context)).toBe(1);
    expect(empty.err()).toContain('has no trained version');

    const path = join(empty.context.cwd, 'instances', 'help', 'instance.yaml');
    await writeFile(path, (await readFile(path, 'utf8')).replace('evalSet: evals.yaml\n', ''));
    expect(await run(['eval', 'help'], empty.context)).toBe(1);
    expect(empty.err()).toContain('has no evalSet');
  });
});

describe('ragctl activate', () => {
  it('refuses a version without a passing eval run and leaves it unchanged', async () => {
    const h = await harness();
    const id = await readyVersion(h.store);
    expect(await run(['activate', 'help', id], h.context)).toBe(1);
    expect(h.err()).toContain('cannot be activated: it has no eval run');
    expect(h.store.versions[0]?.status).toBe('ready');
  });

  it('activates a version that passed its eval with the same embedding model', async () => {
    const h = await harness();
    const id = await readyVersion(h.store);
    await h.store.recordEvalRun('help', id, {
      embeddingProvider: 'mock',
      embeddingModel: 'mock-hash-v1',
      passed: true,
      metrics: {},
    });
    expect(await run(['activate', 'help', id], h.context)).toBe(0);
    expect(h.out()).toContain(`Activated ${id} for help. Previous: none.`);
    expect(h.store.versions[0]?.status).toBe('active');
  });

  it('activates with --force and --reason and logs the operator and reason', async () => {
    const h = await harness();
    const first = await readyVersion(h.store);
    const second = await readyVersion(h.store);
    const force = ['--force', '--reason', 'demo data'];
    expect(await run(['activate', 'help', first, ...force], h.context)).toBe(0);
    expect(await run(['activate', 'help', second, ...force], h.context)).toBe(0);
    expect(h.out()).toContain(`Previous: ${first} (now retired).`);
    const events = h
      .err()
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events[0]).toEqual({
      event: 'index.activation_forced',
      instanceId: 'help',
      versionId: first,
      operator: 'tester',
      reason: 'demo data',
      gate: 'it has no eval run',
    });
    expect(h.store.activations.map((a) => [a.force, a.reason, a.operator])).toEqual([
      [true, 'demo data', 'tester'],
      [true, 'demo data', 'tester'],
    ]);
  });

  it('records the operator from --operator instead of the default', async () => {
    const h = await harness();
    const id = await readyVersion(h.store);
    const args = ['--force', '--reason', 'r', '--operator', 'release-bot'];
    expect(await run(['activate', 'help', id, ...args], h.context)).toBe(0);
    expect(h.store.activations[0]?.operator).toBe('release-bot');
    expect(h.err()).toContain('"operator":"release-bot"');
  });

  it('refuses an empty operator name', async () => {
    const h = await harness({}, { operator: '' });
    const id = await readyVersion(h.store);
    expect(await run(['activate', 'help', id, '--force', '--reason', 'r'], h.context)).toBe(1);
    expect(h.err()).toContain('pass --operator <name>');
    expect(h.store.versions[0]?.status).toBe('ready');
  });

  it('requires --reason with --force and --force with --reason', async () => {
    const h = await harness();
    const id = await readyVersion(h.store);
    expect(await run(['activate', 'help', id, '--force'], h.context)).toBe(1);
    expect(h.err()).toContain('--force needs --reason');
    expect(await run(['activate', 'help', id, '--reason', 'x'], h.context)).toBe(1);
    expect(h.err()).toContain('--reason is only used together with --force');
    expect(h.store.versions[0]?.status).toBe('ready');
  });

  it('reports an unknown version as a user error', async () => {
    const h = await harness();
    expect(await run(['activate', 'help', 'not-a-version'], h.context)).toBe(1);
    expect(h.err()).toContain('does not exist for "help"');
  });
});

describe('ragctl migrate', () => {
  const env = {
    DATABASE_ADMIN_URL: 'postgres://admin:pw@127.0.0.1/rag',
    RAG_RUNTIME_PASSWORD: 'runtime-password-16',
    RAG_INGEST_PASSWORD: 'ingest-password-16',
  };

  it('runs the migration runner with the environment settings', async () => {
    const h = await harness(env);
    expect(await run(['migrate'], h.context)).toBe(0);
    expect(h.migrations).toEqual([
      {
        adminUrl: env.DATABASE_ADMIN_URL,
        runtimePassword: env.RAG_RUNTIME_PASSWORD,
        ingestPassword: env.RAG_INGEST_PASSWORD,
      },
    ]);
    expect(h.out()).toBe('Applied 1 migration:\n  0006_cap_usage_increments.sql\n');
  });

  it('reports an up-to-date schema and several migrations', async () => {
    const none = await harness(env, { migrate: () => Promise.resolve({ applied: [] }) });
    expect(await run(['migrate'], none.context)).toBe(0);
    expect(none.out()).toBe('Database schema is up to date.\n');

    const two = await harness(env, {
      migrate: () => Promise.resolve({ applied: ['0001_a.sql', '0002_b.sql'] }),
    });
    expect(await run(['migrate'], two.context)).toBe(0);
    expect(two.out()).toBe('Applied 2 migrations:\n  0001_a.sql\n  0002_b.sql\n');
  });

  it('refuses a remote host without --allow-remote, and missing settings', async () => {
    const remote = await harness({
      ...env,
      DATABASE_ADMIN_URL: 'postgres://a:b@db.example.com/rag',
    });
    expect(await run(['migrate'], remote.context)).toBe(1);
    expect(remote.err()).toContain('--allow-remote');
    expect(await run(['migrate', '--allow-remote'], remote.context)).toBe(0);

    const missing = await harness();
    expect(await run(['migrate'], missing.context)).toBe(1);
    expect(missing.err()).toBe('Error: DATABASE_ADMIN_URL is not set\n');
    expect(missing.migrations).toEqual([]);
  });
});
