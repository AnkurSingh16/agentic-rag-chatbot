import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadInstances, readAppConfig } from '../src/config.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const BASE = { DATABASE_URL: 'postgres://rag_runtime:pw@127.0.0.1/rag' };

function yaml(id: string, auth = 'auth:\n  mode: public'): string {
  return `id: ${id}
displayName: ${id}
persona:
  systemPrompt: Answer.
  answerStyle: Short.
  outOfScope: No.
${auth}
allowedOrigins:
  - http://localhost:5173
sources:
  - type: folder
    path: data
`;
}

async function instancesDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'app-server-'));
  directories.push(dir);
  for (const [id, text] of Object.entries(files)) {
    await mkdir(join(dir, id));
    await writeFile(join(dir, id, 'instance.yaml'), text);
  }
  return dir;
}

const RBAC = `auth:
  mode: rbac
  issuer: https://issuer.example
  audience: api
  roleClaim: roles
  roles:
    reader: ['chat:use']`;

describe('readAppConfig', () => {
  it('applies defaults and generates a session secret outside production', () => {
    const config = readAppConfig(BASE, '/srv');
    expect(config).toMatchObject({
      instancesDir: '/srv/instances',
      instanceId: undefined,
      host: '127.0.0.1',
      port: 4000,
      sessionSecretGenerated: true,
      trustedProxies: [],
    });
    expect(config.sessionSecret.length).toBeGreaterThanOrEqual(32);
    expect(
      readAppConfig(
        {
          ...BASE,
          PORT: '8080',
          SESSION_SECRET: 'x'.repeat(32),
          TRUSTED_PROXIES: '10.0.0.1, 10.1.0.0/16',
        },
        '/srv',
      ),
    ).toMatchObject({
      port: 8080,
      sessionSecretGenerated: false,
      trustedProxies: ['10.0.0.1', '10.1.0.0/16'],
    });
  });

  it.each([
    [{}, 'DATABASE_URL is not set'],
    [{ ...BASE, PORT: 'eighty' }, 'PORT must be an integer'],
    [{ ...BASE, AUTH_MODE: 'rbac' }, 'AUTH_MODE applies to INSTANCE_ID'],
    [{ ...BASE, NODE_ENV: 'production' }, 'SESSION_SECRET is required'],
    [{ ...BASE, SESSION_SECRET: 'short' }, 'at least 32 characters'],
  ])('rejects %j', (env, message) => {
    expect(() => readAppConfig(env, '/srv')).toThrow(message);
  });
});

describe('loadInstances', () => {
  it('loads every instance folder, or only INSTANCE_ID', async () => {
    const dir = await instancesDir({ alpha: yaml('alpha'), beta: yaml('beta') });
    const all = await loadInstances(readAppConfig({ ...BASE, INSTANCES_DIR: dir }, '/'), {});
    expect(all.map((config) => config.id)).toEqual(['alpha', 'beta']);
    const env = { ...BASE, INSTANCES_DIR: dir, INSTANCE_ID: 'beta' };
    const one = await loadInstances(readAppConfig(env, '/'), env);
    expect(one.map((config) => config.id)).toEqual(['beta']);
  });

  it('refuses to start with authenticated or rbac instances, including through AUTH_MODE', async () => {
    const dir = await instancesDir({ alpha: yaml('alpha'), gated: yaml('gated', RBAC) });
    await expect(
      loadInstances(readAppConfig({ ...BASE, INSTANCES_DIR: dir }, '/'), {}),
    ).rejects.toThrow('uses auth.mode rbac, which the server does not implement until phase 5');
    const env = { ...BASE, INSTANCES_DIR: dir, INSTANCE_ID: 'alpha', AUTH_MODE: 'authenticated' };
    await expect(loadInstances(readAppConfig(env, '/'), env)).rejects.toThrow(/auth/);
    const loosen = { ...BASE, INSTANCES_DIR: dir, INSTANCE_ID: 'gated', AUTH_MODE: 'public' };
    await expect(loadInstances(readAppConfig(loosen, '/'), loosen)).rejects.toThrow(
      'cannot loosen',
    );
  });

  it('fails on a missing folder, an empty folder or a mismatched id', async () => {
    const missing = { ...BASE, INSTANCES_DIR: '/does/not/exist' };
    await expect(loadInstances(readAppConfig(missing, '/'), {})).rejects.toThrow(
      'Cannot read INSTANCES_DIR',
    );
    const empty = await instancesDir({});
    await expect(
      loadInstances(readAppConfig({ ...BASE, INSTANCES_DIR: empty }, '/'), {}),
    ).rejects.toThrow('No instances found');
    const renamed = await instancesDir({ alpha: yaml('other') });
    await expect(
      loadInstances(readAppConfig({ ...BASE, INSTANCES_DIR: renamed }, '/'), {}),
    ).rejects.toThrow('expected "alpha"');
    const env = { ...BASE, INSTANCES_DIR: renamed, INSTANCE_ID: 'nope' };
    await expect(loadInstances(readAppConfig(env, '/'), env)).rejects.toThrow('Cannot read');
  });
});
