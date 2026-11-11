import { readMigrateCliConfig } from '@agentic-rag/server';
import type { CliContext } from '../context.js';

export async function migrateCommand(context: CliContext, args: readonly string[]): Promise<void> {
  const config = readMigrateCliConfig(context.env, args);
  const { applied } = await context.migrate(config);
  context.stdout(
    applied.length === 0
      ? 'Database schema is up to date.\n'
      : `Applied ${applied.length} migration${applied.length === 1 ? '' : 's'}:\n${applied.map((name) => `  ${name}`).join('\n')}\n`,
  );
}
