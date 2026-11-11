// Helpers shared by the dev and ingest scripts. Plain Node, no dependencies.
import { spawn } from 'node:child_process';

export const RAGCTL = 'packages/cli/bin/ragctl.mjs';

export function fail(message) {
  process.stderr.write(`\n${message}\n`);
  process.exit(1);
}

/** Runs a command with inherited output; resolves with its exit code. */
export function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: options.capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
      env: options.env ?? process.env,
    });
    let stdout = '';
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code: code ?? 1, stdout });
    });
  });
}

/** Runs a command and exits the script when it fails. */
export async function step(label, command, args, options) {
  process.stdout.write(`\n> ${label}\n`);
  const result = await run(command, args, options);
  if (result.code !== 0) fail(`${label} failed with exit code ${result.code}.`);
  return result;
}

export function ragctl(args, options) {
  return run(process.execPath, [RAGCTL, ...args], options);
}

/** The newest index version of an instance, from `ragctl versions --json`. */
export async function newestVersion(instance, env) {
  const result = await ragctl(['versions', instance, '--json'], { capture: true, env });
  if (result.code !== 0) fail(`Could not list the versions of ${instance}.`);
  return JSON.parse(result.stdout);
}

export function requireEnv(names) {
  const missing = names.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    fail(
      `Missing ${missing.join(', ')}. Copy .env.example to .env and fill them in (docs/local-setup.md).`,
    );
  }
}

/** Trains an instance, evaluates the new version and activates it when the eval passes. */
export async function trainEvalActivate(instance, env, extraTrainArgs = []) {
  await step(
    `ragctl train ${instance}`,
    process.execPath,
    [RAGCTL, 'train', instance, ...extraTrainArgs],
    { env },
  );
  const [version] = await newestVersion(instance, env);
  if (version === undefined) fail(`Training ${instance} produced no version.`);
  process.stdout.write(`\n> ragctl eval ${instance} ${version.id}\n`);
  const evaluated = await ragctl(['eval', instance, version.id], { env });
  if (evaluated.code !== 0) {
    fail(
      `Version ${version.id} did not pass the eval, so it was not activated. ` +
        'Check the documents and evals.yaml, or activate it with "ragctl activate --force --reason".',
    );
  }
  await step(
    `ragctl activate ${instance} ${version.id}`,
    process.execPath,
    [RAGCTL, 'activate', instance, version.id],
    { env },
  );
  return version;
}
