import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Session lifetime from ADR 0004. */
export const SESSION_TTL_SECONDS = 24 * 60 * 60;

export interface IssuedSession {
  token: string;
  expiresAt: Date;
}

export interface VerifiedSession {
  sessionId: string;
  /** A hash of the session ID; stored as the conversation owner key, never the ID itself. */
  ownerKey: string;
}

export interface SessionSigner {
  issue(instanceId: string): IssuedSession;
  /** Returns undefined for a token that is malformed, forged, expired or for another instance. */
  verify(token: string, instanceId: string): VerifiedSession | undefined;
}

const SESSION_ID = /^[A-Za-z0-9_-]{22}$/;

/**
 * Signs public-mode session tokens with HMAC-SHA256 (ADR 0004). A token is
 * `v1.<instanceId>.<sessionId>.<expiresAt>.<signature>`; binding the instance keeps a session
 * from one instance being replayed against another.
 */
export function createSessionSigner(secret: string, now: () => number = Date.now): SessionSigner {
  const sign = (payload: string) => createHmac('sha256', secret).update(payload).digest();

  return {
    issue(instanceId) {
      const sessionId = randomBytes(16).toString('base64url');
      const expires = Math.floor(now() / 1000) + SESSION_TTL_SECONDS;
      const payload = `v1.${instanceId}.${sessionId}.${expires}`;
      return {
        token: `${payload}.${sign(payload).toString('base64url')}`,
        expiresAt: new Date(expires * 1000),
      };
    },

    verify(token, instanceId) {
      const parts = token.split('.');
      if (parts.length !== 5) return undefined;
      const [version, tokenInstance, sessionId, expires, signature] = parts as [
        string,
        string,
        string,
        string,
        string,
      ];
      const expected = sign(parts.slice(0, 4).join('.'));
      const given = Buffer.from(signature, 'base64url');
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
      if (version !== 'v1' || tokenInstance !== instanceId || !SESSION_ID.test(sessionId)) {
        return undefined;
      }
      if (!/^\d{1,12}$/.test(expires) || Number(expires) * 1000 <= now()) return undefined;
      return {
        sessionId,
        ownerKey: createHash('sha256').update(`session:${sessionId}`).digest('hex'),
      };
    },
  };
}
