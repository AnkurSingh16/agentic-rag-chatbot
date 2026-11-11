// npm run dev / npm run dev:live: start PostgreSQL, migrate, train the demo instance if needed,
// then run apps/server and apps/web-demo together. Run through `node --env-file-if-exists=.env`.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { fail, newestVersion, requireEnv, step, trainEvalActivate } from './lib.mjs';

const live = process.argv.includes('--live');
const DEMO = 'demo';

// The key must come from this project's .env, never from a shell profile, so it is read from the
// file itself rather than from the inherited environment.
function keyFromDotEnv() {
  try {
    return parseEnv(readFileSync('.env', 'utf8')).ANTHROPIC_API_KEY?.trim() || undefined;
  } catch {
    return undefined;
  }
}

const apiKey = live ? keyFromDotEnv() : undefined;
if (live && apiKey === undefined) {
  fail(
    "npm run dev:live needs ANTHROPIC_API_KEY in this project's .env file. Create a key in the " +
      'Anthropic Console, set a spend limit there, and add the key to .env (docs/local-setup.md).',
  );
}

const env = {
  ...process.env,
  LLM_PROVIDER: live ? 'anthropic' : 'mock',
  EMBEDDING_PROVIDER: process.env.EMBEDDING_PROVIDER || 'local',
};
if (live) env.ANTHROPIC_API_KEY = apiKey;
else delete env.ANTHROPIC_API_KEY;

requireEnv([
  'POSTGRES_PASSWORD',
  'DATABASE_ADMIN_URL',
  'DATABASE_URL',
  'DATABASE_INGEST_URL',
  'RAG_RUNTIME_PASSWORD',
  'RAG_INGEST_PASSWORD',
]);

if (process.env.DEV_SKIP_DOCKER === '1') {
  process.stdout.write('\nDEV_SKIP_DOCKER=1: using the PostgreSQL at DATABASE_ADMIN_URL\n');
} else {
  await step('docker compose up -d --wait', 'docker', ['compose', 'up', '-d', '--wait'], { env });
}
await step('npm run build', 'npm', ['run', 'build'], { env });
await step('ragctl migrate', process.execPath, ['packages/cli/bin/ragctl.mjs', 'migrate'], { env });

// Retrain when the demo has no active version or was built with other embeddings, for example
// after switching EMBEDDING_PROVIDER.
const versions = await newestVersion(DEMO, env);
const active = versions.find((version) => version.status === 'active');
const expectedProvider = env.EMBEDDING_PROVIDER;
if (active === undefined || active.embeddingProvider !== expectedProvider) {
  process.stdout.write(
    active === undefined
      ? `\nThe ${DEMO} instance has no active version; training it.\n`
      : `\nThe active ${DEMO} version uses ${active.embeddingProvider} embeddings; retraining with ${expectedProvider}.\n`,
  );
  await trainEvalActivate(DEMO, env);
} else {
  process.stdout.write(`\nServing ${DEMO} version ${active.id} (${active.embeddingProvider}).\n`);
}

process.stdout.write(
  `\nStarting the API (LLM_PROVIDER=${env.LLM_PROVIDER}, EMBEDDING_PROVIDER=${env.EMBEDDING_PROVIDER}) and the web demo.\n` +
    'Open http://127.0.0.1:5173 and press Ctrl+C to stop.\n\n',
);
const children = [
  spawn(process.execPath, ['apps/server/dist/main.js'], { stdio: 'inherit', env }),
  // Vite directly rather than through npm, so stopping it does not leave an orphaned process.
  spawn(process.execPath, [resolve('node_modules/vite/bin/vite.js')], {
    cwd: 'apps/web-demo',
    stdio: 'inherit',
    env,
  }),
];
let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  process.exitCode = code;
}
for (const child of children) {
  child.on('exit', (code) => {
    stop(code ?? 0);
  });
}
process.on('SIGINT', () => {
  stop(0);
});
process.on('SIGTERM', () => {
  stop(0);
});
