import { describe, expect, it } from 'vitest';
import { ChatbotError, MAX_REDIRECTS, isForbiddenAddress, loadDocuments } from '../src/index.js';
import type { FetchLike, LookupLike, SourceConfig } from '../src/index.js';

const signal = new AbortController().signal;
const urls = (...list: string[]): SourceConfig[] => [{ type: 'urls', urls: list }];

// Host names map to fixed addresses so no test depends on real DNS.
function dns(table: Record<string, string[]>): LookupLike & { asked: string[] } {
  const asked: string[] = [];
  const lookup = (hostname: string) => {
    asked.push(hostname);
    const addresses = table[hostname];
    return addresses === undefined
      ? Promise.reject(Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }))
      : Promise.resolve(addresses.map((address) => ({ address })));
  };
  return Object.assign(lookup, { asked });
}

interface Recorded {
  url: string;
  redirect: string;
}

function fetchFrom(responses: Record<string, () => Response>): FetchLike & { calls: Recorded[] } {
  const calls: Recorded[] = [];
  const stub: FetchLike = (url, init) => {
    calls.push({ url, redirect: init.redirect });
    const respond = responses[url];
    return respond ? Promise.resolve(respond()) : Promise.reject(new Error('unreachable'));
  };
  return Object.assign(stub, { calls });
}

const text = (body: string) => () =>
  new Response(body, { headers: { 'content-type': 'text/plain' } });
const redirect =
  (location: string, status = 302) =>
  () =>
    new Response(null, { status, headers: { location } });

async function failure(promise: Promise<unknown>): Promise<ChatbotError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ChatbotError) return error;
    throw error;
  }
  throw new Error('Expected a ChatbotError');
}

const PUBLIC = ['192.0.2.10'];

describe('isForbiddenAddress', () => {
  it.each([
    ['127.0.0.1', 'loopback'],
    ['127.255.0.9', 'loopback'],
    ['10.1.2.3', 'private 10/8'],
    ['172.16.0.1', 'private 172.16/12'],
    ['172.31.255.255', 'private 172.16/12'],
    ['192.168.1.1', 'private 192.168/16'],
    ['169.254.169.254', 'link-local, cloud metadata'],
    ['100.64.0.1', 'CGNAT'],
    ['100.127.255.255', 'CGNAT'],
    ['0.0.0.0', 'this network'],
    ['0.1.2.3', 'this network'],
    ['::1', 'IPv6 loopback'],
    ['::', 'IPv6 unspecified'],
    ['fe80::1', 'IPv6 link-local'],
    ['febf::1', 'IPv6 link-local'],
    ['fc00::1', 'IPv6 unique-local'],
    ['fd12:3456::1', 'IPv6 unique-local'],
    ['::ffff:127.0.0.1', 'IPv4-mapped loopback'],
    ['::ffff:7f00:1', 'IPv4-mapped loopback, hex form'],
    ['::ffff:a9fe:a9fe', 'IPv4-mapped link-local'],
    ['0:0:0:0:0:ffff:c0a8:101', 'IPv4-mapped private, full form'],
    ['not-an-address', 'not an IP address'],
  ])('refuses %s (%s)', (address) => {
    expect(isForbiddenAddress(address)).toBe(true);
  });

  it.each([
    '192.0.2.10',
    '8.8.8.8',
    '172.32.0.1',
    '100.128.0.1',
    '2606:4700::1111',
    '::ffff:8.8.8.8',
  ])('allows the public address %s', (address) => {
    expect(isForbiddenAddress(address)).toBe(false);
  });
});

describe('URL source guard', () => {
  it('refuses http URLs without resolving or fetching them', async () => {
    const lookup = dns({ 'x.example': PUBLIC });
    const fetch = fetchFrom({ 'http://x.example/a': text('a') });
    const error = await failure(
      loadDocuments(urls('http://x.example/a'), { baseDir: '/', fetch, lookup }, signal),
    );
    expect(error.code).toBe('invalid_input');
    expect(error.message).toContain('only https URLs are fetched');
    expect(lookup.asked).toEqual([]);
    expect(fetch.calls).toEqual([]);
  });

  it.each([
    ['loopback', '127.0.0.1'],
    ['private 10/8', '10.0.0.5'],
    ['private 172.16/12', '172.20.1.1'],
    ['private 192.168/16', '192.168.0.10'],
    ['link-local', '169.254.169.254'],
    ['CGNAT', '100.64.1.1'],
    ['0.0.0.0/8', '0.0.0.0'],
    ['IPv6 loopback', '::1'],
    ['IPv6 link-local', 'fe80::1'],
    ['IPv6 unique-local', 'fd00::1'],
    ['IPv4-mapped loopback', '::ffff:127.0.0.1'],
  ])('refuses a host that resolves to a %s address', async (_label, address) => {
    const fetch = fetchFrom({ 'https://inside.example/a': text('secret') });
    const lookup = dns({ 'inside.example': [address] });
    const error = await failure(
      loadDocuments(urls('https://inside.example/a'), { baseDir: '/', fetch, lookup }, signal),
    );
    expect(error.code).toBe('invalid_input');
    expect(error.message).toContain(`resolves to ${address}, which is not a public address`);
    expect(fetch.calls).toEqual([]);
  });

  it('refuses a host when any one of its addresses is not public', async () => {
    const fetch = fetchFrom({ 'https://mixed.example/a': text('a') });
    const lookup = dns({ 'mixed.example': ['192.0.2.10', '10.0.0.1'] });
    const error = await failure(
      loadDocuments(urls('https://mixed.example/a'), { baseDir: '/', fetch, lookup }, signal),
    );
    expect(error.message).toContain('resolves to 10.0.0.1');
    expect(fetch.calls).toEqual([]);
  });

  it.each(['https://127.0.0.1/a', 'https://[::1]/a', 'https://[::ffff:169.254.169.254]/a'])(
    'refuses the IP literal in %s without a DNS lookup',
    async (url) => {
      const lookup = dns({});
      const fetch = fetchFrom({});
      const error = await failure(
        loadDocuments(urls(url), { baseDir: '/', fetch, lookup }, signal),
      );
      expect(error.message).toContain('which is not a public address');
      expect(lookup.asked).toEqual([]);
      expect(fetch.calls).toEqual([]);
    },
  );

  it('refuses a host that resolves to no address, and reports one that does not resolve', async () => {
    const fetch = fetchFrom({});
    const empty = await failure(
      loadDocuments(
        urls('https://empty.example/a'),
        { baseDir: '/', fetch, lookup: dns({ 'empty.example': [] }) },
        signal,
      ),
    );
    expect(empty.message).toContain('resolves to no address');
    const missing = await failure(
      loadDocuments(
        urls('https://missing.example/a'),
        { baseDir: '/', fetch, lookup: dns({}) },
        signal,
      ),
    );
    expect(missing).toMatchObject({
      code: 'provider_unavailable',
      message: 'https://missing.example/a: cannot resolve missing.example',
    });
  });

  it('follows redirects manually and checks every target', async () => {
    const lookup = dns({ 'a.example': PUBLIC, 'b.example': PUBLIC });
    const fetch = fetchFrom({
      'https://a.example/start': redirect('/moved', 301),
      'https://a.example/moved': redirect('https://b.example/final', 308),
      'https://b.example/final': text('Final page'),
    });
    const [document] = await loadDocuments(
      urls('https://a.example/start'),
      { baseDir: '/', fetch, lookup },
      signal,
    );
    expect(document).toMatchObject({ sourceUri: 'https://a.example/start', text: 'Final page' });
    expect(fetch.calls).toEqual([
      { url: 'https://a.example/start', redirect: 'manual' },
      { url: 'https://a.example/moved', redirect: 'manual' },
      { url: 'https://b.example/final', redirect: 'manual' },
    ]);
    expect(lookup.asked).toEqual(['a.example', 'a.example', 'b.example']);
  });

  it('refuses a redirect to a private address before connecting to it', async () => {
    const lookup = dns({ 'public.example': PUBLIC, 'internal.example': ['192.168.1.20'] });
    const fetch = fetchFrom({
      'https://public.example/a': redirect('https://internal.example/admin'),
      'https://internal.example/admin': text('secret'),
    });
    const error = await failure(
      loadDocuments(urls('https://public.example/a'), { baseDir: '/', fetch, lookup }, signal),
    );
    expect(error.code).toBe('invalid_input');
    expect(error.message).toContain('internal.example resolves to 192.168.1.20');
    expect(fetch.calls.map((call) => call.url)).toEqual(['https://public.example/a']);
  });

  it('refuses a redirect to a metadata IP literal or to http', async () => {
    const lookup = dns({ 'public.example': PUBLIC });
    const fetch = fetchFrom({
      'https://public.example/meta': redirect('https://169.254.169.254/latest/meta-data/'),
      'https://public.example/plain': redirect('http://public.example/plain'),
    });
    const access = { baseDir: '/', fetch, lookup };
    expect(
      (await failure(loadDocuments(urls('https://public.example/meta'), access, signal))).message,
    ).toContain('resolves to 169.254.169.254');
    expect(
      (await failure(loadDocuments(urls('https://public.example/plain'), access, signal))).message,
    ).toContain('only https URLs are fetched');
    expect(fetch.calls).toHaveLength(2);
  });

  it(`stops after ${MAX_REDIRECTS} redirects`, async () => {
    const lookup = dns({ 'loop.example': PUBLIC });
    const fetch = fetchFrom({
      'https://loop.example/0': redirect('/1'),
      'https://loop.example/1': redirect('/2'),
      'https://loop.example/2': redirect('/3'),
      'https://loop.example/3': redirect('/4'),
      'https://loop.example/4': text('too far'),
    });
    const error = await failure(
      loadDocuments(urls('https://loop.example/0'), { baseDir: '/', fetch, lookup }, signal),
    );
    expect(error.message).toBe('https://loop.example/0: refused more than 3 redirects');
    expect(fetch.calls).toHaveLength(MAX_REDIRECTS + 1);
  });

  it('rejects a redirect without a usable Location', async () => {
    const lookup = dns({ 'x.example': PUBLIC });
    const fetch = fetchFrom({
      'https://x.example/none': () => new Response(null, { status: 302 }),
      'https://x.example/bad': redirect('https://exa mple.com:99999/'),
    });
    const access = { baseDir: '/', fetch, lookup };
    for (const url of ['https://x.example/none', 'https://x.example/bad']) {
      expect((await failure(loadDocuments(urls(url), access, signal))).message).toContain(
        'has no valid Location',
      );
    }
  });

  it('gives each request a timeout and reports it', async () => {
    const lookup = dns({ 'slow.example': PUBLIC });
    let received: AbortSignal | undefined;
    const fetch: FetchLike = (_url, init) => {
      received = init.signal;
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          reject(init.signal.reason as Error);
        });
      });
    };
    const error = await failure(
      loadDocuments(
        urls('https://slow.example/a'),
        { baseDir: '/', fetch, lookup, requestTimeoutMs: 20 },
        signal,
      ),
    );
    expect(error).toMatchObject({
      code: 'provider_unavailable',
      message: 'https://slow.example/a: no response within 20 ms',
    });
    expect(received?.aborted).toBe(true);
  });

  it('applies the timeout to reading the body', async () => {
    const lookup = dns({ 'stall.example': PUBLIC });
    const fetch: FetchLike = (_url, init) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('partial'));
          init.signal.addEventListener('abort', () => {
            controller.error(init.signal.reason);
          });
        },
      });
      return Promise.resolve(new Response(body, { headers: { 'content-type': 'text/plain' } }));
    };
    const error = await failure(
      loadDocuments(
        urls('https://stall.example/a'),
        { baseDir: '/', fetch, lookup, requestTimeoutMs: 20 },
        signal,
      ),
    );
    expect(error).toMatchObject({
      code: 'provider_unavailable',
      message: 'https://stall.example/a: reading the response failed',
    });
  });

  it("passes the caller's abort through instead of reporting a timeout", async () => {
    const controller = new AbortController();
    const lookup = dns({ 'x.example': PUBLIC });
    const fetch: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          reject(init.signal.reason as Error);
        });
        controller.abort(new Error('stopped by operator'));
      });
    await expect(
      loadDocuments(
        urls('https://x.example/a'),
        { baseDir: '/', fetch, lookup },
        controller.signal,
      ),
    ).rejects.toThrow('stopped by operator');
  });
});
