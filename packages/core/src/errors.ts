export type ErrorCode =
  | 'invalid_input'
  | 'invalid_config'
  | 'not_found'
  | 'unauthenticated'
  | 'forbidden'
  | 'rate_limited'
  | 'budget_exceeded'
  | 'provider_unavailable'
  | 'internal';

// Only failures caused by something outside our control are worth retrying.
const RETRYABLE_BY_DEFAULT: ReadonlySet<ErrorCode> = new Set([
  'rate_limited',
  'provider_unavailable',
]);

export interface ChatbotErrorOptions {
  cause?: unknown;
  retryable?: boolean;
}

/**
 * The single error type thrown across package boundaries.
 *
 * `message` is safe to log but is not shown to end users; transport layers map
 * `code` to a status and a fixed user-facing message.
 */
export class ChatbotError extends Error {
  override readonly name = 'ChatbotError';
  readonly code: ErrorCode;
  readonly retryable: boolean;

  constructor(code: ErrorCode, message: string, options: ChatbotErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.retryable = options.retryable ?? RETRYABLE_BY_DEFAULT.has(code);
  }
}

export function isChatbotError(value: unknown): value is ChatbotError {
  return value instanceof ChatbotError;
}

/** Wraps anything thrown by third-party code so callers only ever handle ChatbotError. */
export function toChatbotError(value: unknown, fallback: ErrorCode = 'internal'): ChatbotError {
  if (isChatbotError(value)) return value;
  const message = value instanceof Error ? value.message : 'Unexpected non-error value thrown';
  return new ChatbotError(fallback, message, { cause: value });
}
