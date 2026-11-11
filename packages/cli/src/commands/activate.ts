import { ChatbotError, activateVersion } from '@agentic-rag/core';
import type { CliContext } from '../context.js';
import { checkInstanceId, withIngestStore } from '../context.js';

export async function activateCommand(
  context: CliContext,
  positionals: readonly string[],
  options: { force: boolean; reason: string | undefined; operator: string | undefined },
): Promise<void> {
  if (positionals.length !== 2) {
    throw new ChatbotError(
      'invalid_input',
      'Usage: ragctl activate <id> <versionId> [--force --reason <text>] [--operator <name>]',
    );
  }
  const id = checkInstanceId(positionals[0]);
  const versionId = positionals[1] ?? '';
  if (options.reason !== undefined && !options.force) {
    throw new ChatbotError('invalid_input', '--reason is only used together with --force');
  }

  const result = await withIngestStore(context, (store) =>
    activateVersion({
      store,
      instanceId: id,
      versionId,
      force: options.force,
      ...(options.reason === undefined ? {} : { reason: options.reason }),
      operator: options.operator ?? context.operator,
      // Structured events go to stderr so they can be collected as an audit log.
      log: (event) => {
        context.stderr(`${JSON.stringify(event)}\n`);
      },
    }),
  );
  const previous =
    result.previousVersionId === null ? 'none' : `${result.previousVersionId} (now retired)`;
  context.stdout(
    `Activated ${result.versionId} for ${id}${result.forced ? ' without the eval gate' : ''}. Previous: ${previous}.\n`,
  );
}
