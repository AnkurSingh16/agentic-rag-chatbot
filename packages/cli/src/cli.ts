import { parseArgs } from 'node:util';
import type { ParseArgsConfig } from 'node:util';
import { isChatbotError } from '@agentic-rag/core';
import type { ErrorCode } from '@agentic-rag/core';
import { activateCommand } from './commands/activate.js';
import { evalCommand } from './commands/eval.js';
import { initCommand } from './commands/init.js';
import { migrateCommand } from './commands/migrate.js';
import { trainCommand } from './commands/train.js';
import { versionsCommand } from './commands/versions.js';
import type { CliContext } from './context.js';

export const USAGE = `Usage: ragctl <command> [options]

Commands:
  migrate [--allow-remote]                       Apply database migrations (DATABASE_ADMIN_URL)
  init <id>                                      Create instances/<id> with a sample config, document and eval set
  train <id> [--source <folder>]                 Build a new index version from the instance's sources,
                                                 or from one folder instead of them
  eval <id> [versionId] [--min-recall <0..1>]    Score retrieval on the eval set (default: newest version,
                                                 minimum recall@8 0.6) and record the eval run
  versions <id> [--json]                         List index versions
  activate <id> <versionId> [--force --reason <text>] [--operator <name>]
                                                 Serve a version; requires a passing eval run unless forced.
                                                 Every activation is logged with the operator (default: $USER)

Options:
  --instances <dir>  Directory holding instance folders (default: instances)
  -h, --help         Show this help

Exit codes: 0 success, 1 usage or configuration error, 2 unexpected failure.
`;

/** Exit codes: 0 success, 1 the operator can fix it, 2 unexpected. */
export type ExitCode = 0 | 1 | 2;

const USER_ERRORS: ReadonlySet<ErrorCode> = new Set([
  'invalid_input',
  'invalid_config',
  'not_found',
  'forbidden',
  'unauthenticated',
]);

const COMMON = {
  help: { type: 'boolean', short: 'h', default: false },
  instances: { type: 'string', default: 'instances' },
} as const;

function parse<O extends NonNullable<ParseArgsConfig['options']>>(args: string[], options: O) {
  return parseArgs({ args, options, allowPositionals: true, strict: true });
}

function isParseError(error: unknown): boolean {
  return (
    error instanceof TypeError &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code.startsWith('ERR_PARSE_ARGS')
  );
}

async function dispatch(context: CliContext, command: string, rest: string[]): Promise<boolean> {
  switch (command) {
    case 'migrate':
      if (rest.includes('--help') || rest.includes('-h')) return false;
      await migrateCommand(context, rest);
      return true;
    case 'init': {
      const { values, positionals } = parse(rest, COMMON);
      if (values.help) return false;
      await initCommand(context, positionals, values.instances);
      return true;
    }
    case 'train': {
      const { values, positionals } = parse(rest, { ...COMMON, source: { type: 'string' } });
      if (values.help) return false;
      await trainCommand(context, positionals, {
        instancesDir: values.instances,
        source: values.source,
      });
      return true;
    }
    case 'eval': {
      const { values, positionals } = parse(rest, {
        ...COMMON,
        'min-recall': { type: 'string' },
      });
      if (values.help) return false;
      await evalCommand(context, positionals, {
        instancesDir: values.instances,
        minRecall: values['min-recall'],
      });
      return true;
    }
    case 'versions': {
      const { values, positionals } = parse(rest, {
        ...COMMON,
        json: { type: 'boolean', default: false },
      });
      if (values.help) return false;
      await versionsCommand(context, positionals, values.json);
      return true;
    }
    case 'activate': {
      const { values, positionals } = parse(rest, {
        ...COMMON,
        force: { type: 'boolean', default: false },
        reason: { type: 'string' },
        operator: { type: 'string' },
      });
      if (values.help) return false;
      await activateCommand(context, positionals, {
        force: values.force,
        reason: values.reason,
        operator: values.operator,
      });
      return true;
    }
    default:
      context.stderr(`Unknown command "${command}".\n\n${USAGE}`);
      return true;
  }
}

/**
 * Runs one `ragctl` invocation and returns its exit code. Errors are printed
 * to stderr, never thrown.
 */
export async function run(args: readonly string[], context: CliContext): Promise<ExitCode> {
  const [command, ...rest] = args;
  if (command === undefined) {
    context.stderr(USAGE);
    return 1;
  }
  if (command === '--help' || command === '-h' || command === 'help') {
    context.stdout(USAGE);
    return 0;
  }
  const known = ['migrate', 'init', 'train', 'eval', 'versions', 'activate'].includes(command);
  try {
    if (!(await dispatch(context, command, rest))) {
      context.stdout(USAGE);
      return 0;
    }
    return known ? 0 : 1;
  } catch (error) {
    if (isParseError(error)) {
      context.stderr(`Error: ${(error as Error).message}\n\n${USAGE}`);
      return 1;
    }
    if (isChatbotError(error) && USER_ERRORS.has(error.code)) {
      context.stderr(`Error: ${error.message}\n`);
      return 1;
    }
    const message = error instanceof Error ? error.message : String(error);
    context.stderr(`Unexpected error: ${message}\n`);
    return 2;
  }
}
