import { describe, expect, it } from 'vitest';
import { ChatbotError, isChatbotError, toChatbotError } from '../src/errors.js';

describe('ChatbotError', () => {
  it('marks rate limits and provider outages as retryable by default', () => {
    expect(new ChatbotError('rate_limited', 'slow down').retryable).toBe(true);
    expect(new ChatbotError('provider_unavailable', 'upstream 503').retryable).toBe(true);
    expect(new ChatbotError('forbidden', 'no access').retryable).toBe(false);
  });

  it('lets callers override retryability', () => {
    const error = new ChatbotError('provider_unavailable', 'bad request upstream', {
      retryable: false,
    });
    expect(error.retryable).toBe(false);
  });

  it('keeps the original cause', () => {
    const cause = new Error('socket hang up');
    expect(new ChatbotError('internal', 'failed', { cause }).cause).toBe(cause);
  });
});

describe('toChatbotError', () => {
  it('returns ChatbotError instances unchanged', () => {
    const original = new ChatbotError('not_found', 'missing instance');
    expect(toChatbotError(original)).toBe(original);
  });

  it('wraps plain errors with the fallback code', () => {
    const wrapped = toChatbotError(new TypeError('boom'), 'provider_unavailable');
    expect(isChatbotError(wrapped)).toBe(true);
    expect(wrapped.code).toBe('provider_unavailable');
    expect(wrapped.message).toBe('boom');
  });

  it('handles non-error throws', () => {
    const wrapped = toChatbotError('a string');
    expect(wrapped.code).toBe('internal');
    expect(wrapped.cause).toBe('a string');
  });
});
