import { ChatbotError } from '@agentic-rag/core';
import type { IndexVersionSummary } from '@agentic-rag/core';
import type { CliContext } from '../context.js';
import { checkInstanceId, withIngestStore } from '../context.js';

function evalColumn(version: IndexVersionSummary): string {
  const run = version.latestEval;
  if (run === null) return 'none';
  return run.passed ? 'passed' : 'failed';
}

function timestamp(date: Date | null): string {
  return date === null ? '-' : date.toISOString().slice(0, 19).replace('T', ' ');
}

export function formatTable(rows: readonly (readonly string[])[]): string {
  const widths = rows[0]?.map((_, column) =>
    Math.max(...rows.map((row) => row[column]?.length ?? 0)),
  );
  return rows
    .map((row) =>
      row
        .map((cell, column) => cell.padEnd(widths?.[column] ?? 0))
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}

export async function versionsCommand(
  context: CliContext,
  positionals: readonly string[],
  json: boolean,
): Promise<void> {
  if (positionals.length > 1) {
    throw new ChatbotError('invalid_input', 'Usage: ragctl versions <id> [--json]');
  }
  const id = checkInstanceId(positionals[0]);
  const versions = await withIngestStore(context, ({ store }) => store.listVersions(id));

  if (json) {
    context.stdout(`${JSON.stringify(versions, null, 2)}\n`);
    return;
  }
  if (versions.length === 0) {
    context.stdout(`No index versions for ${id}. Run "ragctl train ${id}" first.\n`);
    return;
  }
  const rows = [
    [
      'VERSION',
      'STATUS',
      'EMBEDDING',
      'DOCS',
      'CHUNKS',
      'EVAL',
      'CREATED (UTC)',
      'ACTIVATED (UTC)',
    ],
    ...versions.map((version) => [
      version.id,
      version.status,
      `${version.embeddingProvider}/${version.embeddingModel}`,
      String(version.documentCount),
      String(version.chunkCount),
      evalColumn(version),
      timestamp(version.createdAt),
      timestamp(version.activatedAt),
    ]),
  ];
  context.stdout(`${formatTable(rows)}\n`);
}
