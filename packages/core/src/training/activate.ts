import { ChatbotError } from '../errors.js';
import type { IndexVersionSummary, IngestStore } from '../store/types.js';

export interface ActivateOptions {
  store: IngestStore;
  instanceId: string;
  versionId: string;
  /** Skips the eval gate. Requires `reason`. */
  force?: boolean;
  reason?: string;
  /** Who ran the activation; recorded with every activation. */
  operator: string;
  /** The current instance configuration fingerprint. Required by the store unless forced. */
  configFingerprint?: string | null;
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
 * own embedding provider and model (ADR 0002). This reads only the latest run of
 * any harness. The store also requires a passing latest retrieval run and a
 * passing latest chat run (migration 0009), and refuses activation when either is
 * missing, so this check can only give a less precise message, never allow more.
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

// The same limits as the activation_log columns, checked here so the operator gets a clear
// message instead of a constraint violation.
const MAX_REASON_LENGTH = 1000;
const MAX_OPERATOR_LENGTH = 128;

/**
 * Activates a ready or retired version after checking the eval gate. Activating
 * a retired version is how a rollback is done. `force` skips the gate but needs
 * a reason. The store enforces the same gate and records every activation with
 * the operator; this check runs first to give a clearer message.
 *
 * @throws ChatbotError `not_found` for an unknown version, `invalid_input` when
 *   the version cannot be activated or the gate fails.
 */
export async function activateVersion(options: ActivateOptions): Promise<ActivateResult> {
  const { store, instanceId, versionId } = options;
  const force = options.force ?? false;
  const reason = options.reason?.trim() ?? '';
  const operator = options.operator.trim();
  if (force && reason === '') {
    throw new ChatbotError('invalid_input', '--force needs --reason explaining why');
  }
  if (reason.length > MAX_REASON_LENGTH) {
    throw new ChatbotError(
      'invalid_input',
      `--reason must be at most ${MAX_REASON_LENGTH} characters`,
    );
  }
  if (operator === '' || operator.length > MAX_OPERATOR_LENGTH) {
    throw new ChatbotError(
      'invalid_input',
      `The operator name must be 1 to ${MAX_OPERATOR_LENGTH} characters; pass --operator <name>`,
    );
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
      operator,
      reason,
      gate: failure ?? 'passed',
    });
  }

  const previousVersionId = await store.activate(instanceId, versionId, {
    force,
    reason: reason === '' ? undefined : reason,
    operator,
    configFingerprint: options.configFingerprint ?? null,
  });
  options.log({
    event: 'index.activated',
    instanceId,
    versionId,
    previousVersionId,
    forced: force,
    operator,
  });
  return { versionId, previousVersionId, forced: force };
}
