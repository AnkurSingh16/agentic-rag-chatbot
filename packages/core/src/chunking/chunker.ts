import { chunkingSchema } from '../config/schema.js';
import type { ChunkingConfig } from '../config/schema.js';
import { canonicalJson, sha256Hex } from '../hash.js';

/** Bump whenever chunk output changes for the same input, so index versions record it. */
export const CHUNKER_VERSION = 1;

/** Chunk sizes from ADR 0006. */
export const DEFAULT_CHUNKING: ChunkingConfig = chunkingSchema.parse({});

export interface ChunkInput {
  sourceUri: string;
  title: string;
  /** Markdown or plain text. */
  text: string;
}

export interface Chunk {
  sourceUri: string;
  /** Position of the chunk within its document, starting at 0. */
  ordinal: number;
  /** Document title followed by the enclosing headings, outermost first. */
  headingPath: string[];
  /** The heading path joined with " > ", a blank line, then the chunk text. This is what gets embedded. */
  content: string;
  tokenEstimate: number;
}

interface Section {
  headingPath: string[];
  blocks: string[];
}

interface Limits {
  target: number;
  max: number;
  min: number;
  overlap: number;
}

const CHARS_PER_TOKEN = 4;
const BLOCK_SEPARATOR = '\n\n';
const HEADING_SEPARATOR = ' > ';
const MAX_PREFIX_CHARS = 200;
const ELLIPSIS = '…';
const HEADING = /^ {0,3}(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;

/** Estimates tokens as characters / 4, rounded up (ADR 0006). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** sha256 of the chunk content, the key of the embedding cache (ADR 0002). */
export function contentSha256(content: string): string {
  return sha256Hex(content);
}

/** A stable hash of the chunker version and settings, stored on each index version. */
export function chunkerHash(settings: ChunkingConfig = DEFAULT_CHUNKING): string {
  return sha256Hex(canonicalJson({ version: CHUNKER_VERSION, settings }));
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function truncate(text: string, length: number): string {
  if (text.length <= length) return text;
  let end = length - ELLIPSIS.length;
  if (end > 0 && isHighSurrogate(text.charCodeAt(end - 1))) end -= 1;
  return text.slice(0, end).trimEnd() + ELLIPSIS;
}

// Joins the heading path within MAX_PREFIX_CHARS so that a long title or deep
// headings cannot crowd out the chunk text. Short segments stay whole and the
// remaining space is shared equally by the long ones.
function headingPrefix(path: readonly string[]): string {
  const joined = path.join(HEADING_SEPARATOR);
  if (joined.length <= MAX_PREFIX_CHARS) return joined;
  let available = MAX_PREFIX_CHARS - HEADING_SEPARATOR.length * (path.length - 1);
  let longSegments = path.length;
  let share = Math.floor(available / longSegments);
  for (const length of path.map((segment) => segment.length).sort((a, b) => a - b)) {
    if (length > share) break;
    available -= length;
    longSegments -= 1;
    share = Math.floor(available / longSegments);
  }
  return path.map((segment) => truncate(segment, Math.max(share, 1))).join(HEADING_SEPARATOR);
}

function closesFence(line: string, fence: string): boolean {
  const trimmed = line.trim();
  return trimmed.length >= fence.length && trimmed === fence.charAt(0).repeat(trimmed.length);
}

function buildHeadingPath(title: string, headings: readonly string[]): string[] {
  const cleanTitle = title.trim();
  if (cleanTitle === '') return [...headings];
  // Most documents repeat their title as the first heading; showing it twice adds nothing.
  const rest = headings[0] === cleanTitle ? headings.slice(1) : headings;
  return [cleanTitle, ...rest];
}

function parseSections(text: string, title: string): Section[] {
  const sections: Section[] = [];
  const stack: { level: number; text: string }[] = [];
  let blocks: string[] = [];
  let blockLines: string[] = [];
  let fence: string | undefined;

  const flushBlock = (): void => {
    const block = blockLines.join('\n').trim();
    if (block !== '') blocks.push(block);
    blockLines = [];
  };
  const flushSection = (): void => {
    flushBlock();
    if (blocks.length > 0) {
      sections.push({
        headingPath: buildHeadingPath(
          title,
          stack.map((entry) => entry.text),
        ),
        blocks,
      });
    }
    blocks = [];
  };

  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (fence !== undefined) {
      blockLines.push(line);
      if (closesFence(line, fence)) {
        fence = undefined;
        flushBlock();
      }
      continue;
    }
    const fenceOpen = FENCE_OPEN.exec(line);
    if (fenceOpen?.[1] !== undefined) {
      // A code block is kept whole as one block: blank lines inside it are not paragraph breaks.
      flushBlock();
      fence = fenceOpen[1];
      blockLines.push(line);
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading?.[1] !== undefined && heading[2] !== undefined) {
      flushSection();
      const level = heading[1].length;
      while ((stack.at(-1)?.level ?? 0) >= level) stack.pop();
      stack.push({ level, text: heading[2] });
      continue;
    }
    if (line.trim() === '') {
      flushBlock();
      continue;
    }
    blockLines.push(line);
  }
  flushSection();
  return sections;
}

function lastMatchEnd(text: string, pattern: RegExp): number {
  let end = -1;
  for (const match of text.matchAll(pattern)) end = match.index + match[0].length;
  return end;
}

function cutPoint(text: string, limit: number): number {
  // One extra character lets a sentence or word that ends exactly at the limit count.
  const window = text.slice(0, limit + 1);
  const floor = Math.floor(limit / 2);
  // Ends just after the punctuation (and any closing quote or bracket), before the whitespace.
  const sentenceEnd = lastMatchEnd(window, /[.!?]["')\]]*(?=\s)/g);
  if (sentenceEnd > floor) return sentenceEnd;
  const wordEnd = lastMatchEnd(window, /\S(?=\s)/g);
  if (wordEnd > floor) return wordEnd;
  // Never separate the two halves of a surrogate pair, unless the limit is a
  // single character and the cut must still make progress.
  return limit > 1 && isHighSurrogate(text.charCodeAt(limit - 1)) ? limit - 1 : limit;
}

function hardSplit(text: string, limit: number): string[] {
  const pieces: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const cut = cutPoint(rest, limit);
    pieces.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  pieces.push(rest);
  return pieces;
}

function overlapTail(text: string, chars: number): string {
  if (chars === 0 || text.length <= chars) return '';
  let start = text.length - chars;
  if (!/\s/.test(text.charAt(start - 1))) {
    const nextSpace = text.slice(start).search(/\s/);
    if (nextSpace === -1) return '';
    start += nextSpace;
  }
  return text.slice(start).trim();
}

function packSection(blocks: readonly string[], limits: Limits): string[] {
  const bodies: string[] = [];
  let current = '';
  // The part of `current` that was not copied from the previous chunk as overlap.
  let fresh = '';

  for (const block of blocks.flatMap((b) =>
    b.length > limits.max ? hardSplit(b, limits.target) : [b],
  )) {
    if (current === '') {
      current = block;
      fresh = block;
      continue;
    }
    const joined = current + BLOCK_SEPARATOR + block;
    if (
      joined.length <= limits.target ||
      (fresh.length < limits.min && joined.length <= limits.max)
    ) {
      current = joined;
      fresh = fresh + BLOCK_SEPARATOR + block;
      continue;
    }
    bodies.push(current);
    const tail = overlapTail(current, limits.overlap);
    const withTail = tail + BLOCK_SEPARATOR + block;
    current = tail !== '' && withTail.length <= limits.max ? withTail : block;
    fresh = block;
  }

  if (current !== '') {
    const last = bodies.at(-1);
    if (
      fresh.length < limits.min &&
      last !== undefined &&
      last.length + BLOCK_SEPARATOR.length + fresh.length <= limits.max
    ) {
      bodies[bodies.length - 1] = last + BLOCK_SEPARATOR + fresh;
    } else {
      bodies.push(current);
    }
  }
  return bodies;
}

/**
 * Splits a document into chunks for embedding (ADR 0006).
 *
 * The text is split on ATX markdown headings (`#` to `######`) first; setext
 * headings (a line underlined with `===` or `---`) are treated as body text.
 * Paragraphs within a section are packed up to `targetTokens`, consecutive
 * chunks of one section share about `overlapTokens` of text, and a paragraph
 * longer than `maxTokens` is split at sentence, then word, then character
 * boundaries. A short trailing piece is merged into the previous chunk of its
 * section, but a whole section shorter than `minTokens` stays a chunk of its
 * own so it keeps its heading. The heading path prepended to the content is
 * capped at 200 characters, so for settings the schema accepts no chunk
 * exceeds `maxTokens`. `headingPath` itself is not shortened. The output
 * depends only on the input and settings.
 */
export function chunkMarkdown(
  input: ChunkInput,
  settings: ChunkingConfig = DEFAULT_CHUNKING,
): Chunk[] {
  const chunks: Chunk[] = [];
  for (const section of parseSections(input.text, input.title)) {
    const prefix =
      section.headingPath.length > 0 ? headingPrefix(section.headingPath) + BLOCK_SEPARATOR : '';
    const maxChars = settings.maxTokens * CHARS_PER_TOKEN;
    const targetChars = settings.targetTokens * CHARS_PER_TOKEN;
    // The floors only matter for settings below the schema minimum, where the
    // prefix alone could fill the budget; they keep every limit positive.
    const max = Math.max(maxChars - prefix.length, Math.floor(maxChars / 4));
    const limits: Limits = {
      max,
      target: Math.min(Math.max(targetChars - prefix.length, Math.floor(targetChars / 4)), max),
      min: settings.minTokens * CHARS_PER_TOKEN,
      overlap: settings.overlapTokens * CHARS_PER_TOKEN,
    };
    for (const body of packSection(section.blocks, limits)) {
      const content = prefix + body;
      chunks.push({
        sourceUri: input.sourceUri,
        ordinal: chunks.length,
        headingPath: [...section.headingPath],
        content,
        tokenEstimate: estimateTokens(content),
      });
    }
  }
  return chunks;
}
