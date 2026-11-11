// npm run ingest -- --instance <id> --source <folder>: train an instance from a folder instead
// of its configured sources, evaluate the new version and activate it if the eval passes.
import { parseArgs } from 'node:util';
import { fail, requireEnv, step, trainEvalActivate } from './lib.mjs';

let values;
try {
  ({ values } = parseArgs({
    options: { instance: { type: 'string' }, source: { type: 'string' } },
    strict: true,
  }));
} catch (error) {
  fail(`${error.message}\nUsage: npm run ingest -- --instance <id> --source <folder>`);
}
if (!values.instance || !values.source) {
  fail('Usage: npm run ingest -- --instance <id> --source <folder>');
}

const env = { ...process.env, EMBEDDING_PROVIDER: process.env.EMBEDDING_PROVIDER || 'local' };
requireEnv(['DATABASE_INGEST_URL']);
await step('npm run build', 'npm', ['run', 'build'], { env });
const version = await trainEvalActivate(values.instance, env, ['--source', values.source]);
process.stdout.write(
  `\nIngested ${values.source} into ${values.instance}: version ${version.id} is active ` +
    `(${version.documentCount} documents, ${version.chunkCount} chunks, ${version.embeddingProvider}/${version.embeddingModel}).\n`,
);
