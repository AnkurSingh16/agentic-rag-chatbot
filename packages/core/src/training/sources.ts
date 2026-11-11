import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { SourceConfig } from '../config/schema.js';
import { ChatbotError } from '../errors.js';
import { sha256Hex } from '../hash.js';
import { parseFrontMatter } from './front-matter.js';
import { htmlToText } from './html.js';

/** The part of the Fetch API the URL loader uses, so tests can inject a stub. */
export type FetchLike = (
  url: string,
  init: { signal: AbortSignal; headers: Record<string, string>; redirect: 'follow' },
) => Promise<Response>;

/** Where and how sources are read. */
export interface SourceAccess {
  /** Folder sources resolve relative to this directory, normally `instances/<id>`. */
  baseDir: string;
  fetch: FetchLike;
  /** Largest document accepted from a file or URL. Defaults to {@link DEFAULT_MAX_DOCUMENT_BYTES}. */
  maxDocumentBytes?: number;
}

/** 2 MiB: far above a help page, low enough that a wrong URL cannot exhaust memory. */
export const DEFAULT_MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;

export interface LoadedDocument {
  sourceUri: string;
  title: string;
  /** Text to chunk, with any front-matter removed. */
  text: string;
  /** sha256 of the document as read, front-matter included, so a tag change changes it. */
  contentSha256: string;
  /** Tags from front-matter; undefined when the document has none. */
  accessTags: string[] | undefined;
}

const FOLDER_EXTENSIONS: ReadonlySet<string> = new Set(['.md', '.markdown', '.txt']);
const MARKDOWN_EXTENSIONS: ReadonlySet<string> = new Set(['.md', '.markdown']);
const FIRST_HEADING = /^ {0,3}#{1,6}\s+(.+?)(?:\s+#+)?\s*$/m;

function titleFrom(text: string, fallback: string): string {
  const heading = FIRST_HEADING.exec(text)?.[1]?.trim();
  return heading !== undefined && heading !== '' ? heading : fallback;
}

function tooLarge(sourceUri: string, limit: number): ChatbotError {
  return new ChatbotError(
    'invalid_input',
    `${sourceUri}: document is larger than the ${limit}-byte limit`,
  );
}

// Sorted by code unit at every level so the same tree always yields the same order on every
// platform. Hidden entries (.git, editor state) and symbolic links are skipped: a link could
// point outside the instance directory.
async function listFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(path)));
    else if (entry.isFile() && FOLDER_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      files.push(path);
    }
  }
  return files;
}

async function loadFolder(path: string, access: SourceAccess, limit: number) {
  const root = resolve(access.baseDir, path);
  const fromBase = relative(access.baseDir, root);
  if (fromBase.startsWith('..') || isAbsolute(fromBase)) {
    throw new ChatbotError(
      'invalid_config',
      `Folder source "${path}" must be inside the instance directory`,
    );
  }
  let files: string[];
  try {
    files = await listFiles(root);
  } catch (error) {
    throw new ChatbotError('invalid_config', `Folder source "${path}" cannot be read`, {
      cause: error,
    });
  }
  const documents: LoadedDocument[] = [];
  for (const file of files) {
    // Relative, forward-slash URIs keep source_uri identical on every machine.
    const sourceUri = relative(access.baseDir, file).split(sep).join('/');
    if ((await stat(file)).size > limit) throw tooLarge(sourceUri, limit);
    const raw = await readFile(file, 'utf8');
    const extension = extname(file).toLowerCase();
    const isMarkdown = MARKDOWN_EXTENSIONS.has(extension);
    const { accessTags, body } = isMarkdown
      ? parseFrontMatter(raw, sourceUri)
      : { accessTags: undefined, body: raw };
    const fileName = basename(file, extname(file));
    documents.push({
      sourceUri,
      title: isMarkdown ? titleFrom(body, fileName) : fileName,
      text: body,
      contentSha256: sha256Hex(raw),
      accessTags,
    });
  }
  return documents;
}

async function readCapped(response: Response, sourceUri: string, limit: number): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) throw tooLarge(sourceUri, limit);
  if (response.body === null) return '';
  // The declared length can be missing or wrong, so the body is counted as it streams and the
  // download stops once it passes the limit.
  const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw tooLarge(sourceUri, limit);
    }
    parts.push(value);
  }
  return Buffer.concat(parts).toString('utf8');
}

async function loadUrl(
  url: string,
  access: SourceAccess,
  limit: number,
  signal: AbortSignal,
): Promise<LoadedDocument> {
  let response: Response;
  try {
    response = await access.fetch(url, {
      signal,
      headers: { accept: 'text/markdown, text/plain, text/html;q=0.9' },
      redirect: 'follow',
    });
  } catch (error) {
    signal.throwIfAborted();
    throw new ChatbotError('provider_unavailable', `${url}: request failed`, { cause: error });
  }
  if (!response.ok) {
    throw new ChatbotError('invalid_input', `${url}: server answered ${response.status}`);
  }
  const contentType = (response.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? '';
  const isHtml = contentType === 'text/html' || contentType === 'application/xhtml+xml';
  const isMarkdown = contentType === 'text/markdown' || contentType === 'text/x-markdown';
  if (!isHtml && !isMarkdown && contentType !== 'text/plain') {
    throw new ChatbotError(
      'invalid_input',
      `${url}: unsupported content type "${contentType}"; expected text/html, text/markdown or text/plain`,
    );
  }
  const raw = await readCapped(response, url, limit);
  if (isHtml) {
    const { title, text } = htmlToText(raw);
    return {
      sourceUri: url,
      title: title ?? titleFrom(text, url),
      text,
      contentSha256: sha256Hex(raw),
      accessTags: undefined,
    };
  }
  const { accessTags, body } = isMarkdown
    ? parseFrontMatter(raw, url)
    : { accessTags: undefined, body: raw };
  return {
    sourceUri: url,
    title: isMarkdown ? titleFrom(body, url) : url,
    text: body,
    contentSha256: sha256Hex(raw),
    accessTags,
  };
}

/**
 * Reads every configured source and returns the documents sorted by source
 * URI. Folder sources read `.md`, `.markdown` and `.txt` files recursively;
 * URL sources accept HTML, markdown and plain text. Sitemap and GitHub sources
 * are planned and rejected for now.
 *
 * @throws ChatbotError `invalid_config` for unsupported or unreadable sources
 *   and duplicate documents, `invalid_input` for documents that cannot be used.
 */
export async function loadDocuments(
  sources: readonly SourceConfig[],
  access: SourceAccess,
  signal: AbortSignal,
): Promise<LoadedDocument[]> {
  const limit = access.maxDocumentBytes ?? DEFAULT_MAX_DOCUMENT_BYTES;
  const documents: LoadedDocument[] = [];
  for (const source of sources) {
    signal.throwIfAborted();
    switch (source.type) {
      case 'folder':
        documents.push(...(await loadFolder(source.path, access, limit)));
        break;
      case 'urls':
        for (const url of source.urls) documents.push(await loadUrl(url, access, limit, signal));
        break;
      case 'sitemap':
      case 'github':
        throw new ChatbotError(
          'invalid_config',
          `Source type "${source.type}" is not supported yet; use folder or urls sources`,
        );
    }
  }

  documents.sort((a, b) => (a.sourceUri < b.sourceUri ? -1 : a.sourceUri > b.sourceUri ? 1 : 0));
  for (let i = 1; i < documents.length; i++) {
    if (documents[i]?.sourceUri === documents[i - 1]?.sourceUri) {
      throw new ChatbotError(
        'invalid_config',
        `Document ${documents[i]?.sourceUri ?? ''} is listed by more than one source`,
      );
    }
  }
  return documents;
}
