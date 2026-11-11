import { isIPv4, isIPv6 } from 'node:net';

function expandIPv6(address: string): string[] {
  const [head = '', tail] = address.split('::');
  const left = head === '' ? [] : head.split(':');
  const right = tail === undefined || tail === '' ? [] : tail.split(':');
  const missing = tail === undefined ? 0 : 8 - left.length - right.length;
  return [...left, ...Array<string>(missing).fill('0'), ...right].map((group) =>
    group.toLowerCase().replace(/^0+(?=.)/, ''),
  );
}

/**
 * The key a client address is limited under (ADR 0004): IPv4 addresses as they are, IPv6
 * addresses by their /64 prefix so one host cannot rotate through its own prefix. IPv4-mapped
 * IPv6 addresses count as IPv4.
 */
export function ipKey(address: string): string {
  const unzoned = address.split('%')[0] ?? address;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(unzoned)?.[1];
  if (mapped !== undefined && isIPv4(mapped)) return mapped;
  if (isIPv4(unzoned)) return unzoned;
  if (isIPv6(unzoned)) return `${expandIPv6(unzoned).slice(0, 4).join(':')}::/64`;
  return unzoned;
}

const WINDOW_MS = 60_000;
// Bounds memory under a flood of distinct addresses; expired windows are dropped first.
const MAX_TRACKED = 50_000;

/**
 * A fixed one-minute window per key, held in this process's memory. With several server
 * processes each enforces its own count, so the effective limit is the configured value times
 * the number of processes; the daily caps in PostgreSQL hold across all of them.
 */
export class MinuteRateLimiter {
  readonly #windows = new Map<string, { start: number; count: number }>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /** Counts one request and returns false when the key is over `limit` in the current minute. */
  take(key: string, limit: number): boolean {
    const now = this.#now();
    let window = this.#windows.get(key);
    if (window === undefined || now - window.start >= WINDOW_MS) {
      if (window === undefined && this.#windows.size >= MAX_TRACKED) this.#prune(now);
      window = { start: now, count: 0 };
      this.#windows.set(key, window);
    }
    window.count += 1;
    return window.count <= limit;
  }

  #prune(now: number): void {
    for (const [key, window] of this.#windows) {
      if (now - window.start >= WINDOW_MS) this.#windows.delete(key);
    }
    // Still full: every key is active, so the oldest is dropped rather than refusing the new one.
    if (this.#windows.size >= MAX_TRACKED) {
      const oldest = this.#windows.keys().next().value;
      if (oldest !== undefined) this.#windows.delete(oldest);
    }
  }
}
