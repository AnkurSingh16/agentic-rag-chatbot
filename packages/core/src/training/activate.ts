import { ChatbotError } from '../errors.js';
import type { IndexVersionSummary, IngestStore } from '../store/types.js';

export interface ActivateOptions {
  store: IngestStore;
  instanceId: string;
  versionId: string;
  /** Skips the eval gate. Requires `reason`. */
  force?: boolean;
  reason?: string;
  /** Who ran the activation; recorded with a forced activation. */
  operator: string;
  log: (event: Readonly<Record<string, unknown>>) => void;
}

export interface ActivateResult {
  versionId: string;
  previousVersionId: string | null;
  forced: boolean;
}

/**
 * Why a version may not be activated without `--force`, or undefined when the
 * eval gate passes: its latest eval run must have passed with the version's
 * own embedding provider and model (ADR 0002).
 */
export function evalGateFailure(version: IndexVersionSummary): string | undefined {
  const run = version.latestEval;
  if (run === null) return 'it has no eval run';
  if (!run.passed) return `its latest eval run (${run.id}) failed`;
  if (
    run.embeddingProvider !== version.embeddingProvider ||
    run.embeddingModel !== version.embeddingModel
  ) {
    return (
      `its latest eval run used ${run.embeddingProvider}/${run.embeddingModel}, ` +
      `but the version was built with ${version.embeddingProvider}/${version.embeddingModel}`
    );
  }
  return undefined;
}

/**
 * Activates a ready or retired version after checking the eval gate. Activating
 * a retired version is how a rollback is done. `force` skips the gate but needs
 * a reason, and is logged with the operator.
 *
 * @throws ChatbotError `not_found` for an unknown version, `invalid_input` when
 *   the version cannot be activated or the gate fails.
 */
export async function activateVersion(options: ActivateOptions): Promise<ActivateResult> {
  const { store, instanceId, versionId } = options;
  const force = options.force ?? false;
  const reason = options.reason?.trim() ?? '';
  if (force && reason === '') {
    throw new ChatbotError('invalid_input', '--force needs --reason explaining why');
  }

  const version = await store.getVersion(instanceId, versionId);
  if (version === undefined) {
    throw new ChatbotError(
      'not_found',
      `Index version ${versionId} does not exist for "${instanceId}"`,
    );
  }
  if (version.status !== 'ready' && version.status !== 'retired') {
    throw new ChatbotError(
      'invalid_input',
      `Index version ${versionId} is ${version.status}; only ready or retired versions can be activated`,
    );
  }

  const failure = evalGateFailure(version);
  if (failure !== undefined && !force) {
    throw new ChatbotError(
      'invalid_input',
      `Index version ${versionId} cannot be activated: ${failure}. ` +
        'Record a passing eval run for it, or pass --force --reason "<why>" to skip the gate.',
    );
  }
  if (force) {
    options.log({
      event: 'index.activation_forced',
      instanceId,
      versionId,
      operator: options.operator,
      reason,
      gate: failure ?? 'passed',
    });
  }

  const previousVersionId = await store.activate(instanceId, versionId);
  options.log({
    event: 'index.activated',
    instanceId,
    versionId,
    previousVersionId,
    forced: force,
  });
  return { versionId, previousVersionId, forced: force };
}
