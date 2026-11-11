import { parse } from 'yaml';
import { ChatbotError } from '../errors.js';

export interface FrontMatter {
  /** Access tags from `access:`; undefined when the document does not set any. */
  accessTags: string[] | undefined;
  /** The document with the front-matter block removed. */
  body: string;
}

const BLOCK = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
// Same rule as access tags in instance.yaml, so a document tag can always be granted by a role.
const ACCESS_TAG = /^[a-z0-9][a-z0-9._:-]{0,63}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseFrontMatter(text: string, sourceUri: string): FrontMatter {
  const match = BLOCK.exec(text);
  if (!match) return { accessTags: undefined, body: text };

  let data: unknown;
  try {
    data = parse(match[1] ?? '');
  } catch (error) {
    throw new ChatbotError('invalid_input', `${sourceUri}: front-matter is not valid YAML`, {
      cause: error,
    });
  }
  const body = text.slice(match[0].length);
  if (data === null || data === undefined) return { accessTags: undefined, body };
  if (!isRecord(data)) {
    throw new ChatbotError('invalid_input', `${sourceUri}: front-matter must be a YAML mapping`);
  }
  // Silently ignoring a tenant would put a document every tenant can read where its author
  // expected one tenant only.
  if ('tenant' in data) {
    throw new ChatbotError(
      'invalid_input',
      `${sourceUri}: front-matter "tenant" is not supported yet; documents are stored with tenant "_"`,
    );
  }
  if (!('access' in data)) return { accessTags: undefined, body };

  const access = data.access;
  if (
    !Array.isArray(access) ||
    access.length === 0 ||
    !access.every((tag): tag is string => typeof tag === 'string' && ACCESS_TAG.test(tag))
  ) {
    throw new ChatbotError(
      'invalid_input',
      `${sourceUri}: front-matter "access" must be a non-empty list of lower-case access tags`,
    );
  }
  return { accessTags: [...new Set(access)].sort(), body };
}
