import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ChatbotError, loadDocuments } from '../src/index.js';
import type { FetchLike, LookupLike, SourceConfig } from '../src/index.js';
import { parseFrontMatter } from '../src/training/front-matter.js';
import { htmlToText } from '../src/training/html.js';

const directories: string[] = [];
const signal = new AbortController().signal;

afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function instanceDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'core-sources-'));
  directories.push(dir);
  for (const [name, text] of Object.entries(files)) {
    const path = join(dir, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
  }
  return dir;
}

const noFetch: FetchLike = () => Promise.reject(new Error('no network'));
// A documentation address (RFC 5737) standing in for any public host, so no test uses real DNS.
const publicDns: LookupLike = () => Promise.resolve([{ address: '192.0.2.10' }]);

function fetchReturning(pages: Record<string, Response>): FetchLike & { urls: string[] } {
  const urls: string[] = [];
  const stub = (url: string) => {
    urls.push(url);
    const response = pages[url];
    return response ? Promise.resolve(response) : Promise.reject(new Error('unreachable'));
  };
  return Object.assign(stub, { urls });
}

function page(body: string | ReadableStream<Uint8Array>, type: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': type } });
}

async function failure(promise: Promise<unknown>): Promise<ChatbotError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ChatbotError) return error;
    throw error;
  }
  throw new Error('Expected a ChatbotError');
}

const folder = (path = 'data'): SourceConfig[] => [{ type: 'folder', path }];
const urls = (...list: string[]): SourceConfig[] => [{ type: 'urls', urls: list }];

describe('folder sources', () => {
  it('reads markdown and text files recursively, skipping hidden and other files', async () => {
    const dir = await instanceDir({
      'data/guide.markdown': 'Intro without heading.\n\n## Later heading',
      'data/sub/notes.TXT': '# Not a title in text files',
      'data/sub/readme.md': '## Second-level title ##\n\nBody.',
      'data/.hidden/secret.md': '# Hidden',
      'data/.draft.md': '# Draft',
      'data/image.png': 'binary',
    });
    const documents = await loadDocuments(folder(), { baseDir: dir, fetch: noFetch }, signal);
    expect(documents.map((d) => [d.sourceUri, d.title])).toEqual([
      ['data/guide.markdown', 'Later heading'],
      ['data/sub/notes.TXT', 'notes'],
      ['data/sub/readme.md', 'Second-level title'],
    ]);
    expect(documents[0]?.contentSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('reads front-matter from text files too, keeping the file name as title', async () => {
    const dir = await instanceDir({
      'data/rota.txt': '---\naccess: [staff, managers]\n---\nRota for this week.',
    });
    const [document] = await loadDocuments(folder(), { baseDir: dir, fetch: noFetch }, signal);
    expect(document).toMatchObject({
      sourceUri: 'data/rota.txt',
      title: 'rota',
      text: 'Rota for this week.',
      accessTags: ['managers', 'staff'],
    });
  });

  it('falls back to the file name when a markdown file has no heading', async () => {
    const dir = await instanceDir({ 'data/getting-started.md': 'Just text.' });
    const [document] = await loadDocuments(folder(), { baseDir: dir, fetch: noFetch }, signal);
    expect(document?.title).toBe('getting-started');
  });

  it('skips symbolic links', async () => {
    const dir = await instanceDir({ 'data/real.md': '# Real', 'outside.md': '# Outside' });
    await symlink(join(dir, 'outside.md'), join(dir, 'data', 'link.md'));
    const documents = await loadDocuments(folder(), { baseDir: dir, fetch: noFetch }, signal);
    expect(documents.map((d) => d.sourceUri)).toEqual(['data/real.md']);
  });

  it('refuses a folder outside the instance directory', async () => {
    const dir = await instanceDir({});
    const error = await failure(
      loadDocuments(folder('../elsewhere'), { baseDir: dir, fetch: noFetch }, signal),
    );
    expect(error).toMatchObject({ code: 'invalid_config' });
    expect(error.message).toContain('inside the instance directory');
  });

  it('reports a missing folder as a config error', async () => {
    const dir = await instanceDir({});
    const error = await failure(
      loadDocuments(folder('missing'), { baseDir: dir, fetch: noFetch }, signal),
    );
    expect(error).toMatchObject({ code: 'invalid_config' });
  });

  it('rejects files above the size limit', async () => {
    const dir = await instanceDir({ 'data/big.md': 'x'.repeat(101) });
    const error = await failure(
      loadDocuments(folder(), { baseDir: dir, fetch: noFetch, maxDocumentBytes: 100 }, signal),
    );
    expect(error.message).toBe('data/big.md: document is larger than the 100-byte limit');
  });

  it('rejects a document listed by two sources', async () => {
    const dir = await instanceDir({ 'data/a.md': '# A' });
    const error = await failure(
      loadDocuments([...folder(), ...folder('./data')], { baseDir: dir, fetch: noFetch }, signal),
    );
    expect(error.message).toContain('data/a.md is listed by more than one source');
  });
});

describe('url sources', () => {
  it('converts HTML to text with markdown headings and uses the page title', async () => {
    const fetch = fetchReturning({
      'https://help.example.com/a': page(
        '<html><head><title>Help &amp; FAQ</title><style>p{}</style></head>' +
          '<body><h1>Welcome</h1><p>Hello&nbsp;there.</p><script>alert(1)</script></body></html>',
        'text/html; charset=utf-8',
      ),
    });
    const [document] = await loadDocuments(
      urls('https://help.example.com/a'),
      { baseDir: '/', fetch, lookup: publicDns },
      signal,
    );
    expect(document).toMatchObject({
      sourceUri: 'https://help.example.com/a',
      title: 'Help & FAQ',
      text: '# Welcome\n\nHello there.',
      accessTags: undefined,
    });
  });

  it('reads markdown front-matter and plain text as is', async () => {
    const fetch = fetchReturning({
      'https://x.example/b.md': page(
        '---\naccess: [faq]\n---\n# B title\n\nBody.',
        'text/markdown',
      ),
      'https://x.example/a.txt': page('# not a title', 'text/plain'),
      'https://x.example/c.txt': page('---\naccess: [staff]\n---\nPlain body.', 'text/plain'),
    });
    const documents = await loadDocuments(
      urls('https://x.example/b.md', 'https://x.example/a.txt', 'https://x.example/c.txt'),
      { baseDir: '/', fetch, lookup: publicDns },
      signal,
    );
    expect(documents.map((d) => [d.sourceUri, d.title, d.accessTags])).toEqual([
      ['https://x.example/a.txt', 'https://x.example/a.txt', undefined],
      ['https://x.example/b.md', 'B title', ['faq']],
      ['https://x.example/c.txt', 'https://x.example/c.txt', ['staff']],
    ]);
    expect(documents[2]?.text).toBe('Plain body.');
    expect(fetch.urls).toEqual([
      'https://x.example/b.md',
      'https://x.example/a.txt',
      'https://x.example/c.txt',
    ]);
  });

  it('reads access tags from a rag-access meta tag in HTML', async () => {
    const fetch = fetchReturning({
      'https://x.example/m1': page(
        '<head><meta name="rag-access" content="staff, faq , staff"></head><p>One</p>',
        'text/html',
      ),
      'https://x.example/m2': page(
        "<head><META content='hr' NAME='RAG-ACCESS'/></head><p>Two</p>",
        'text/html',
      ),
      'https://x.example/m3': page(
        '<!-- <meta name="rag-access" content="hidden"> --><meta name="description" content="x"><p>Three</p>',
        'text/html',
      ),
    });
    const documents = await loadDocuments(
      urls('https://x.example/m1', 'https://x.example/m2', 'https://x.example/m3'),
      { baseDir: '/', fetch, lookup: publicDns },
      signal,
    );
    expect(documents.map((d) => d.accessTags)).toEqual([['faq', 'staff'], ['hr'], undefined]);
  });

  it.each([
    ['<meta name="rag-access" content="">', 'non-empty list'],
    ['<meta name="rag-access">', 'non-empty list'],
    ['<meta name="rag-access" content="a,,b">', 'non-empty list'],
    ['<meta name="rag-access" content="Staff">', 'lower-case access tags'],
    [
      '<meta name="rag-access" content="a"><meta name="rag-access" content="b">',
      'more than one <meta name="rag-access"> tag',
    ],
  ])('rejects the HTML access tag %s', async (meta, message) => {
    const fetch = fetchReturning({
      'https://x.example/bad': page(`<head>${meta}</head><p>x</p>`, 'text/html'),
    });
    const error = await failure(
      loadDocuments(
        urls('https://x.example/bad'),
        { baseDir: '/', fetch, lookup: publicDns },
        signal,
      ),
    );
    expect(error.code).toBe('invalid_input');
    expect(error.message).toContain(message);
  });

  it('falls back to the first heading, then the URL, for HTML without a title', async () => {
    const fetch = fetchReturning({
      'https://x.example/h': page('<h2>Section</h2><p>Text</p>', 'text/html'),
      'https://x.example/n': page('<p>Only text</p>', 'text/html'),
    });
    const documents = await loadDocuments(
      urls('https://x.example/h', 'https://x.example/n'),
      { baseDir: '/', fetch, lookup: publicDns },
      signal,
    );
    expect(documents.map((d) => d.title)).toEqual(['Section', 'https://x.example/n']);
  });

  it('rejects a declared length above the limit without reading the body', async () => {
    const response = new Response('small', {
      headers: { 'content-type': 'text/plain', 'content-length': '5000' },
    });
    const fetch = fetchReturning({ 'https://x.example/big': response });
    const error = await failure(
      loadDocuments(
        urls('https://x.example/big'),
        { baseDir: '/', fetch, lookup: publicDns, maxDocumentBytes: 1000 },
        signal,
      ),
    );
    expect(error.message).toContain('larger than the 1000-byte limit');
    expect(response.bodyUsed).toBe(false);
  });

  it('stops reading a streamed body once it passes the limit', async () => {
    let pulls = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        controller.enqueue(new Uint8Array(400));
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetch = fetchReturning({ 'https://x.example/s': page(stream, 'text/plain') });
    const error = await failure(
      loadDocuments(
        urls('https://x.example/s'),
        { baseDir: '/', fetch, lookup: publicDns, maxDocumentBytes: 1000 },
        signal,
      ),
    );
    expect(error.code).toBe('invalid_input');
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThan(10);
  });

  it('rejects error statuses, unsupported types and unreachable hosts', async () => {
    const fetch = fetchReturning({
      'https://x.example/404': page('gone', 'text/plain', 404),
      'https://x.example/pdf': page('%PDF', 'application/pdf'),
    });
    const access = { baseDir: '/', fetch, lookup: publicDns };
    expect(
      (await failure(loadDocuments(urls('https://x.example/404'), access, signal))).message,
    ).toBe('https://x.example/404: server answered 404');
    expect(
      (await failure(loadDocuments(urls('https://x.example/pdf'), access, signal))).message,
    ).toContain('unsupported content type "application/pdf"');
    expect(
      await failure(loadDocuments(urls('https://x.example/down'), access, signal)),
    ).toMatchObject({ code: 'provider_unavailable' });
  });

  it('treats a response without a body as empty', async () => {
    const fetch = fetchReturning({ 'https://x.example/e': page(null as never, 'text/plain') });
    const [document] = await loadDocuments(
      urls('https://x.example/e'),
      { baseDir: '/', fetch, lookup: publicDns },
      signal,
    );
    expect(document?.text).toBe('');
  });
});

describe('planned sources', () => {
  it.each([
    { type: 'sitemap', url: 'https://x.example/sitemap.xml' },
    { type: 'github', repo: 'owner/name', path: 'docs', ref: 'main' },
  ] as SourceConfig[])('rejects $type sources as not supported yet', async (source) => {
    const error = await failure(loadDocuments([source], { baseDir: '/', fetch: noFetch }, signal));
    expect(error.code).toBe('invalid_config');
    expect(error.message).toContain(`"${source.type}" is not supported yet`);
  });
});

describe('parseFrontMatter', () => {
  it('returns the body without the block and sorted, unique tags', () => {
    expect(parseFrontMatter('---\naccess: [b, a, b]\nauthor: x\n---\n# T\n', 'doc')).toEqual({
      accessTags: ['a', 'b'],
      body: '# T\n',
    });
  });

  it('leaves text without front-matter, or with empty front-matter, untouched', () => {
    expect(parseFrontMatter('# T\n---\n', 'doc')).toEqual({
      accessTags: undefined,
      body: '# T\n---\n',
    });
    expect(parseFrontMatter('---\n\n---\nBody', 'doc')).toEqual({
      accessTags: undefined,
      body: 'Body',
    });
    expect(parseFrontMatter('---\ntitle: T\n---\nBody', 'doc').accessTags).toBeUndefined();
  });

  it.each([
    ['---\naccess: public\n---\n', 'non-empty list'],
    ['---\naccess: []\n---\n', 'non-empty list'],
    ['---\naccess: [Public]\n---\n', 'non-empty list'],
    ['---\naccess: [1]\n---\n', 'non-empty list'],
    ['---\n- a\n---\n', 'must be a YAML mapping'],
    ['---\naccess: [a\n---\n', 'not valid YAML'],
    ['---\ntenant: north\naccess: [a]\n---\n', '"tenant" is not supported yet'],
  ])('rejects invalid front-matter %#', (text, message) => {
    expect(() => parseFrontMatter(text, 'doc.md')).toThrow(message);
  });
});

describe('htmlToText', () => {
  it('keeps list items, line breaks and paragraphs apart and decodes entities', () => {
    expect(
      htmlToText(
        '<!-- note --><ul><li>One &lt;1&gt;</li><li>Two&#33; &#x41;</li></ul>a<br>b<div>c &bogus; &#0;</div>',
      ),
    ).toEqual({ title: undefined, text: '- One <1>\n- Two! A\n\na\nb\n\nc &bogus; &#0;' });
  });

  it('treats an empty title as missing', () => {
    expect(htmlToText('<title> </title><p>x</p>').title).toBeUndefined();
  });
});

describe('htmlToText with nested or broken markup', () => {
  it('leaves no tags behind when tags are nested inside each other', () => {
    const { text } = htmlToText('<p>Hi</p><scr<script>ipt>alert(1)</script><p>there</p>');
    expect(text).not.toMatch(/[<>]/);
    expect(text).toContain('Hi');
    expect(text).toContain('there');
  });

  it('removes nested comment openers and hidden blocks', () => {
    const { text } = htmlToText(
      '<!<!--- x -->-- y --><p>Body</p><scr<script></script>ipt>z</script>',
    );
    expect(text).not.toMatch(/[<>]/);
    expect(text).toContain('Body');
  });

  it('keeps literal brackets written as entities', () => {
    expect(htmlToText('<p>a &lt; b &gt; c</p>').text).toBe('a < b > c');
  });

  it('strips stray brackets from titles', () => {
    expect(htmlToText('<title>Help <b>page</title>').title).toBe('Help page');
  });
});
