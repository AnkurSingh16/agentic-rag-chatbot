import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { ChatbotError } from '../errors.js';

/** The part of the Fetch API the URL loader uses, so tests can inject a stub. */
export type FetchLike = (
  url: string,
  init: { signal: AbortSignal; headers: Record<string, string>; redirect: 'manual' },
) => Promise<Response>;

/** Resolves a host name to every address it has, like `dns.promises.lookup` with `all: true`. */
export type LookupLike = (hostname: string) => Promise<readonly { address: string }[]>;

export const MAX_REDIRECTS = 3;
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

// Addresses a training run must never reach: a URL in instance.yaml, or a redirect from a public
// page, could otherwise read the cloud metadata service, the database or other internal services
// and store the answer as a document. BlockList also matches IPv4-mapped IPv6 forms such as
// ::ffff:127.0.0.1 against the IPv4 ranges.
const FORBIDDEN = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
] as const) {
  FORBIDDEN.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fe80::', 10],
  ['fc00::', 7],
] as const) {
  FORBIDDEN.addSubnet(network, prefix, 'ipv6');
}

/** True for loopback, private, link-local, unique-local, CGNAT and unspecified addresses. */
export function isForbiddenAddress(address: string): boolean {
  const family = isIP(address);
  // Anything that is not an IP address cannot be judged, so it is refused.
  if (family === 0) return true;
  return FORBIDDEN.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

const defaultLookup: LookupLike = (hostname) => dnsLookup(hostname, { all: true });

function refused(sourceUri: string, why: string): ChatbotError {
  return new ChatbotError('invalid_input', `${sourceUri}: refused ${why}`);
}

async function checkTarget(target: URL, sourceUri: string, lookup: LookupLike): Promise<void> {
  if (target.protocol !== 'https:') {
    throw refused(sourceUri, `${target.href}: only https URLs are fetched`);
  }
  const host = target.hostname.replace(/^\[(.*)\]$/, '$1');
  let addresses: readonly { address: string }[];
  if (isIP(host) !== 0) {
    addresses = [{ address: host }];
  } else {
    try {
      addresses = await lookup(host);
    } catch (error) {
      throw new ChatbotError('provider_unavailable', `${sourceUri}: cannot resolve ${host}`, {
        cause: error,
      });
    }
  }
  // Every address must be public, because the connection may use any of them.
  const blocked = addresses.find((entry) => isForbiddenAddress(entry.address));
  if (addresses.length === 0 || blocked !== undefined) {
    throw refused(
      sourceUri,
      `${target.href}: ${host} resolves to ${blocked?.address ?? 'no address'}, which is not a public address`,
    );
  }
}

export interface PublicFetchOptions {
  fetch: FetchLike;
  lookup?: LookupLike;
  timeoutMs?: number;
  headers: Record<string, string>;
}

/**
 * Fetches a public https URL, following at most {@link MAX_REDIRECTS}
 * redirects and checking every target before connecting: https only, and
 * every resolved address public. Each request gets its own timeout, combined
 * with `signal`; the returned response's body is still bound to it.
 *
 * The check and the connection resolve the name separately, so a DNS server
 * that changes its answer between the two (DNS rebinding) is not stopped.
 */
export async function fetchPublicUrl(
  url: string,
  options: PublicFetchOptions,
  signal: AbortSignal,
): Promise<Response> {
  const lookup = options.lookup ?? defaultLookup;
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  let target = new URL(url);
  for (let redirects = 0; ; redirects++) {
    await checkTarget(target, url, lookup);
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
    let response: Response;
    try {
      response = await options.fetch(target.href, {
        signal: requestSignal,
        headers: options.headers,
        redirect: 'manual',
      });
    } catch (error) {
      signal.throwIfAborted();
      const why = requestSignal.aborted ? `no response within ${timeoutMs} ms` : 'request failed';
      throw new ChatbotError('provider_unavailable', `${url}: ${why}`, { cause: error });
    }
    if (!REDIRECT_STATUSES.has(response.status)) return response;

    await response.body?.cancel();
    if (redirects === MAX_REDIRECTS) {
      throw refused(url, `more than ${MAX_REDIRECTS} redirects`);
    }
    const location = response.headers.get('location');
    const next = location === null ? null : URL.parse(location, target.href);
    if (next === null) {
      throw new ChatbotError(
        'invalid_input',
        `${url}: redirect ${response.status} has no valid Location`,
      );
    }
    target = next;
  }
}
