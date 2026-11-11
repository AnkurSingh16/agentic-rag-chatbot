import { describe, expect, it } from 'vitest';
import {
  CHUNKER_VERSION,
  DEFAULT_CHUNKING,
  chunkMarkdown,
  chunkerHash,
  contentSha256,
  estimateTokens,
} from '../src/chunking/chunker.js';
import { chunkingSchema } from '../src/config/schema.js';
import type { ChunkingConfig } from '../src/config/schema.js';

// 80-character target, 160 maximum, 20 minimum and 20 overlap, so tests stay
// readable. These are below the schema minimum for maxTokens, which only
// matters for headings; heading tests use the defaults.
const small: ChunkingConfig = { targetTokens: 20, overlapTokens: 5, minTokens: 5, maxTokens: 40 };

function words(count: number, seed: string): string {
  return Array.from({ length: count }, (_, i) => `${seed}${i}`).join(' ');
}

// Exactly 6 * count - 1 characters.
function lorem(count: number): string {
  return 'lorem '.repeat(count).trimEnd();
}

function chunk(text: string, settings: ChunkingConfig = small, title = '') {
  return chunkMarkdown({ sourceUri: 'docs/page.md', title, text }, settings);
}

function bodyOf(content: string): string {
  const split = content.indexOf('\n\n');
  return split === -1 ? content : content.slice(split + 2);
}

describe('chunkMarkdown headings', () => {
  const doc = [
    '# Guide',
    'Intro paragraph.',
    '## Install',
    'Install steps.',
    '### Linux',
    'Linux steps.',
    '## Usage ##',
    'Usage notes.',
  ].join('\n');

  it('builds the heading path from nested headings and pops on a shallower heading', () => {
    const paths = chunk(doc, DEFAULT_CHUNKING, 'Guide').map((c) => c.headingPath);
    expect(paths).toEqual([
      ['Guide'],
      ['Guide', 'Install'],
      ['Guide', 'Install', 'Linux'],
      ['Guide', 'Usage'],
    ]);
  });

  it('prepends the heading path to the content', () => {
    const linux = chunk(doc, DEFAULT_CHUNKING, 'Guide')[2];
    expect(linux?.content).toBe('Guide > Install > Linux\n\nLinux steps.');
  });

  it('puts the title first when it differs from the first heading', () => {
    expect(chunk(doc, DEFAULT_CHUNKING, 'Handbook')[1]?.headingPath).toEqual([
      'Handbook',
      'Guide',
      'Install',
    ]);
  });

  it('leaves content unprefixed when there is no title and no heading', () => {
    const [only] = chunk('Just text.');
    expect(only?.headingPath).toEqual([]);
    expect(only?.content).toBe('Just text.');
  });

  it('uses the title alone for text before the first heading', () => {
    expect(
      chunk('Preamble.\n## Part\nBody.', DEFAULT_CHUNKING, 'Doc').map((c) => c.content),
    ).toEqual(['Doc\n\nPreamble.', 'Doc > Part\n\nBody.']);
  });

  it('skips headings with no text of their own but keeps them in child paths', () => {
    const chunks = chunk('# A\n\n## B\nText.', DEFAULT_CHUNKING);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.headingPath).toEqual(['A', 'B']);
  });

  it('ignores heading-like lines inside fenced code and keeps the code block whole', () => {
    const text = ['## Real', '```sh', '# not a heading', '', 'echo hi', '```', 'After.'].join('\n');
    const chunks = chunk(text, DEFAULT_CHUNKING);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.content).toBe('Real\n\n```sh\n# not a heading\n\necho hi\n```\n\nAfter.');
  });

  it('keeps an unclosed code fence to the end of the document', () => {
    const [only] = chunk('~~~\n# inside\n\nstill inside', DEFAULT_CHUNKING);
    expect(only?.content).toBe('~~~\n# inside\n\nstill inside');
  });

  it('treats setext headings as body text', () => {
    const [only] = chunk('Title\n=====\nIntro.\n\nSection\n-------\nMore.', DEFAULT_CHUNKING);
    expect(only?.headingPath).toEqual([]);
    expect(only?.content).toBe('Title\n=====\nIntro.\n\nSection\n-------\nMore.');
  });

  it('does not treat #hashtags or seven hashes as headings', () => {
    const chunks = chunk('#tag line\n####### seven', DEFAULT_CHUNKING);
    expect(chunks[0]?.headingPath).toEqual([]);
  });

  it('normalises Windows line endings', () => {
    expect(chunk('## A\r\nOne.\r\n\r\nTwo.', DEFAULT_CHUNKING)[0]?.content).toBe(
      'A\n\nOne.\n\nTwo.',
    );
  });

  it('returns no chunks for empty or whitespace-only text', () => {
    expect(chunk('')).toEqual([]);
    expect(chunk('\n\n   \n## Empty heading\n')).toEqual([]);
  });
});

describe('chunkMarkdown sizing', () => {
  const paragraphs = Array.from({ length: 12 }, (_, i) => words(6, `p${i}w`)).join('\n\n');

  it('packs paragraphs up to the target and never exceeds the maximum', () => {
    const chunks = chunk(paragraphs);
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) {
      expect(c.content.length).toBeLessThanOrEqual(small.maxTokens * 4);
      expect(c.tokenEstimate).toBe(Math.ceil(c.content.length / 4));
    }
  });

  it('numbers chunks in order across sections', () => {
    const chunks = chunk(`## A\n\n${paragraphs}\n\n## B\n\n${paragraphs}`);
    expect(chunks.map((c) => c.ordinal)).toEqual(chunks.map((_, i) => i));
    expect(chunks.every((c) => c.sourceUri === 'docs/page.md')).toBe(true);
  });

  it('starts each chunk of a section with the tail of the previous chunk', () => {
    const chunks = chunk(paragraphs);
    for (let i = 1; i < chunks.length; i += 1) {
      const previous = chunks[i - 1]?.content ?? '';
      const firstLine = (chunks[i]?.content ?? '').split('\n\n')[0] ?? '';
      expect(previous.endsWith(firstLine)).toBe(true);
      expect(firstLine.length).toBeGreaterThan(0);
      expect(firstLine.length).toBeLessThanOrEqual(small.overlapTokens * 4);
    }
  });

  it('starts overlap on a word boundary', () => {
    const chunks = chunk(paragraphs);
    for (const c of chunks.slice(1)) {
      expect(c.content).toMatch(/^p\d+w\d+/);
    }
  });

  it('does not overlap across headings', () => {
    const chunks = chunk(`## A\n\n${paragraphs}\n\n## B\n\n${words(4, 'b')}`);
    const firstOfB = chunks.find((c) => c.headingPath[0] === 'B');
    expect(firstOfB?.content).toBe(`B\n\n${words(4, 'b')}`);
  });

  it('adds no overlap when overlapTokens is zero', () => {
    const chunks = chunk(paragraphs, { ...small, overlapTokens: 0 });
    const all = chunks.map((c) => c.content).join('\n\n');
    expect(all).toBe(paragraphs);
  });

  it('merges a short trailing paragraph into the previous chunk', () => {
    const text = `${words(10, 'a')}\n\n${words(10, 'b')}\n\nEnd.`;
    const chunks = chunk(text);
    expect(chunks.at(-1)?.content.endsWith(`${words(10, 'b')}\n\nEnd.`)).toBe(true);
    expect(chunks.some((c) => c.content === 'End.')).toBe(false);
  });

  it('keeps growing a chunk past the target while it is below the minimum', () => {
    const text = `Tiny.\n\n${lorem(16)}`;
    const [first] = chunk(text);
    expect(first?.content).toBe(text);
    expect(first?.content.length).toBeGreaterThan(small.targetTokens * 4);
  });

  it('keeps a section shorter than the minimum as its own chunk', () => {
    const chunks = chunk(`## Short\n\nHi.\n\n## Long\n\n${paragraphs}`);
    expect(chunks[0]?.content).toBe('Short\n\nHi.');
  });

  it('emits a paragraph between target and maximum as one chunk', () => {
    const paragraph = lorem(20);
    expect(paragraph.length).toBeGreaterThan(80);
    expect(paragraph.length).toBeLessThanOrEqual(160);
    expect(chunk(paragraph).map((c) => c.content)).toEqual([paragraph]);
  });

  it('drops the overlap when overlap plus the next paragraph would exceed the maximum', () => {
    const big = lorem(25);
    const chunks = chunk(`${words(14, 'a')}\n\n${big}`);
    expect(chunks.map((c) => c.content)).toEqual([words(14, 'a'), big]);
  });

  it('keeps a whole word as overlap when the overlap window starts on a word', () => {
    const first = `${lorem(9)} ${'z'.repeat(20)}`;
    const chunks = chunk(`${first}\n\n${lorem(5)}`);
    expect(chunks.map((c) => c.content)).toEqual([first, `${'z'.repeat(20)}\n\n${lorem(5)}`]);
  });

  it('adds no overlap when the overlap window holds no word boundary', () => {
    const token = 'x'.repeat(500);
    expect(
      chunk(token)
        .map((c) => c.content)
        .join(''),
    ).toBe(token);
  });

  it('keeps a short trailing paragraph separate when merging would exceed the maximum', () => {
    const chunks = chunk(`${lorem(26)}\n\nEnd.`);
    expect(chunks.map((c) => c.content)).toEqual([lorem(26), 'lorem lorem lorem\n\nEnd.']);
  });

  it('splits an overlong paragraph at sentence boundaries', () => {
    const sentences = Array.from({ length: 10 }, (_, i) => `Sentence ${i} has a few words.`);
    const chunks = chunk(sentences.join(' '), { ...small, overlapTokens: 0 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.content).toMatch(/\.$/);
      expect(c.content.length).toBeLessThanOrEqual(small.maxTokens * 4);
    }
    expect(chunks.map((c) => c.content).join(' ')).toBe(sentences.join(' '));
  });

  it('splits an overlong sentence at word boundaries', () => {
    const sentence = words(60, 'w');
    const chunks = chunk(sentence, { ...small, overlapTokens: 0 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((c) => bodyOf(c.content)).join(' ')).toBe(sentence);
    for (const c of chunks) expect(c.content.length).toBeLessThanOrEqual(small.maxTokens * 4);
  });

  it('cuts text with no whitespace at character boundaries without losing characters', () => {
    const token = 'x'.repeat(500);
    const chunks = chunk(token, { ...small, overlapTokens: 0 });
    expect(chunks.map((c) => c.content).join('')).toBe(token);
    for (const c of chunks) expect(c.content.length).toBeLessThanOrEqual(small.maxTokens * 4);
  });

  it('does not split a surrogate pair at a hard cut', () => {
    const text = 'a'.repeat(79) + '😀'.repeat(60);
    const chunks = chunk(text, { ...small, overlapTokens: 0 });
    expect(chunks.map((c) => c.content).join('')).toBe(text);
    const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    expect(chunks.some((c) => loneSurrogate.test(c.content))).toBe(false);
  });

  it('caps the heading prefix at 200 characters but keeps headingPath whole', () => {
    const longHeading = 'H'.repeat(300);
    const [first] = chunk(`## ${longHeading}\n\nBody.`, DEFAULT_CHUNKING, 'Title');
    const prefix = first?.content.split('\n\n')[0] ?? '';
    expect(prefix.length).toBeLessThanOrEqual(200);
    expect(prefix.startsWith('Title > HHH')).toBe(true);
    expect(prefix.endsWith('…')).toBe(true);
    expect(first?.headingPath).toEqual(['Title', longHeading]);
  });

  it('keeps short heading segments whole and shares the rest between long ones', () => {
    const text = `# ${'A'.repeat(150)}\n## Short\n### ${'B'.repeat(150)}\nBody.`;
    const [first] = chunk(text, DEFAULT_CHUNKING, 'Guide');
    const segments = (first?.content.split('\n\n')[0] ?? '').split(' > ');
    expect(segments[0]).toBe('Guide');
    expect(segments[2]).toBe('Short');
    expect(segments[1]?.length).toBe(segments[3]?.length);
    expect(segments[1]?.endsWith('…')).toBe(true);
    expect(segments.join(' > ').length).toBeLessThanOrEqual(200);
  });

  it('does not split a surrogate pair when truncating a heading', () => {
    const [first] = chunk(`## ${'😀'.repeat(150)}\n\nBody.`, DEFAULT_CHUNKING, 'T');
    const prefix = first?.content.split('\n\n')[0] ?? '';
    expect(prefix.length).toBeLessThanOrEqual(200);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(prefix)).toBe(false);
  });

  it('never exceeds maxTokens with the smallest settings the schema accepts', () => {
    const settings = chunkingSchema.parse({
      targetTokens: 64,
      overlapTokens: 10,
      minTokens: 10,
      maxTokens: 100,
    });
    const headings = [1, 2, 3, 4, 5, 6]
      .map((level) => `${'#'.repeat(level)} ${'Heading '.repeat(15)}${level}`)
      .join('\n');
    const body = Array.from({ length: 8 }, (_, i) => words(40, `s${i}w`)).join('\n\n');
    const chunks = chunk(`${headings}\n\n${body}\n\n${'z'.repeat(900)}`, settings, 'T'.repeat(80));
    expect(chunks.length).toBeGreaterThan(5);
    for (const c of chunks) expect(c.tokenEstimate).toBeLessThanOrEqual(100);
  });

  it('still terminates and keeps every character for settings below the schema minimum', () => {
    const tiny: ChunkingConfig = { targetTokens: 1, overlapTokens: 0, minTokens: 0, maxTokens: 1 };
    const text = 'ab😀cd';
    const chunks = chunk(`## ${'H'.repeat(250)}\n\n${text}`, tiny);
    expect(chunks.map((c) => bodyOf(c.content)).join('')).toBe(text);
  });

  it('applies the default settings from ADR 0006', () => {
    const text = Array.from({ length: 60 }, (_, i) => words(30, `d${i}w`)).join('\n\n');
    const chunks = chunk(text, DEFAULT_CHUNKING);
    for (const c of chunks) expect(c.tokenEstimate).toBeLessThanOrEqual(800);
    const middle = chunks.slice(0, -1);
    expect(middle.every((c) => c.tokenEstimate >= 50)).toBe(true);
  });
});

describe('chunkMarkdown determinism', () => {
  const text = `# T\n\n${Array.from({ length: 30 }, (_, i) => words(9, `q${i}`)).join('\n\n')}`;

  it('returns identical chunks for identical input', () => {
    expect(chunk(text)).toEqual(chunk(text));
  });

  it('returns heading paths that callers can change without affecting other chunks', () => {
    const chunks = chunk(text);
    chunks[0]?.headingPath.push('mutated');
    expect(chunks[1]?.headingPath).toEqual(['T']);
  });
});

describe('hashes and estimates', () => {
  it('estimates tokens as characters divided by four, rounded up', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });

  it('hashes content with sha256', () => {
    expect(contentSha256('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('gives the chunker a stable hash that changes with settings', () => {
    expect(CHUNKER_VERSION).toBe(1);
    expect(chunkerHash()).toBe(chunkerHash({ ...DEFAULT_CHUNKING }));
    expect(chunkerHash()).toMatch(/^[0-9a-f]{64}$/);
    expect(chunkerHash(small)).not.toBe(chunkerHash());
    expect(
      chunkerHash({ maxTokens: 800, minTokens: 50, overlapTokens: 60, targetTokens: 450 }),
    ).toBe(chunkerHash());
  });
});
