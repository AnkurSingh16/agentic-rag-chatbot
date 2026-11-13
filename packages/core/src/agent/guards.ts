import { ChatbotError } from '../errors.js';

/** Longest accepted user message (ADR 0004). */
export const MAX_MESSAGE_CHARS = 2000;

// Control characters other than tab and line breaks have no place in a chat message and can hide
// text from reviewers of logs and transcripts.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/**
 * `guard_in`: returns the trimmed message, or throws `invalid_input` for an empty or too long
 * message or one with control characters.
 */
export function guardInput(message: string): string {
  const trimmed = message.trim();
  if (trimmed === '') throw new ChatbotError('invalid_input', 'Message is empty');
  if (trimmed.length > MAX_MESSAGE_CHARS) {
    throw new ChatbotError(
      'invalid_input',
      `Message is longer than ${MAX_MESSAGE_CHARS} characters`,
    );
  }
  if (CONTROL.test(trimmed)) {
    throw new ChatbotError('invalid_input', 'Message contains control characters');
  }
  return trimmed;
}

/** Citation markers as the answer prompt asks for them: `[c` and six hex digits `]`. */
export const CITATION = /\[(c[0-9a-f]{6})\]/g;

export type ParagraphFailure =
  | 'unsupported'
  | 'unknown_citation'
  | 'low_overlap'
  | 'unsupported_claim'
  | 'forbidden_topic'
  | 'injection'
  | 'disclosure';

/**
 * Share of a paragraph's content words that must also appear in the chunks it cites (ADR 0005).
 * A lexical floor, not an entailment check: it rejects paragraphs that cite a chunk but say
 * things the chunk does not contain.
 */
export const LEXICAL_OVERLAP_MIN = 0.5;

// Words of at least four letters that carry no topic. Short words are excluded by length.
const STOPWORDS: ReadonlySet<string> = new Set([
  'about',
  'also',
  'another',
  'because',
  'been',
  'before',
  'being',
  'both',
  'could',
  'does',
  'each',
  'from',
  'have',
  'here',
  'into',
  'just',
  'like',
  'more',
  'most',
  'only',
  'other',
  'over',
  'should',
  'some',
  'such',
  'than',
  'that',
  'their',
  'them',
  'then',
  'there',
  'these',
  'they',
  'this',
  'those',
  'through',
  'under',
  'very',
  'were',
  'what',
  'when',
  'where',
  'which',
  'while',
  'will',
  'with',
  'would',
  'your',
]);

function contentWords(text: string): string[] {
  return words(text.replace(CITATION, ' ')).filter(
    (word) => word.length >= 4 && !STOPWORDS.has(word),
  );
}

export type ParagraphCheck =
  { ok: true; citationIds: string[] } | { ok: false; reason: ParagraphFailure };

/** What `guard_out` checks a paragraph against. */
export interface OutputPolicy {
  forbiddenTopics: readonly string[];
  /** Word sequences of the instructions; see {@link instructionShingles}. */
  protectedShingles: ReadonlySet<string>;
}

// Phrases that only appear in output when the model follows instructions planted in a document
// or talks about its own instructions. Help content has no reason to contain them.
const INJECTION_PATTERNS: readonly RegExp[] = [
  /\b(?:ignore|disregard|forget) (?:all |any |the |your )?(?:previous|prior|above|earlier|preceding) (?:instructions|messages|rules|prompts?)\b/i,
  /\bsystem prompt\b/i,
  /\byou are now\b/i,
  /\bnew instructions?\s*:/i,
];

const WORD = /[\p{L}\p{N}]+/gu;
/** Consecutive words that count as copying the instructions. */
export const SHINGLE_WORDS = 8;

function words(text: string): string[] {
  return text.toLowerCase().match(WORD) ?? [];
}

// A text shorter than SHINGLE_WORDS words is kept whole, so a short system prompt is protected too.
function shingles(text: string): string[] {
  const list = words(text);
  if (list.length < SHINGLE_WORDS) return list.length === 0 ? [] : [list.join(' ')];
  const result: string[] = [];
  for (let i = 0; i + SHINGLE_WORDS <= list.length; i++) {
    result.push(list.slice(i, i + SHINGLE_WORDS).join(' '));
  }
  return result;
}

/**
 * Every run of {@link SHINGLE_WORDS} words in the given instruction texts, lower-cased and
 * without punctuation; texts with fewer words are kept whole.
 */
export function instructionShingles(texts: readonly string[]): Set<string> {
  return new Set(texts.flatMap(shingles));
}

/**
 * `verify` and `guard_out` for one paragraph, before it is released: no forbidden topic
 * (case-insensitive), no phrase typical of a followed prompt injection, no run of eight words
 * copied from the instructions, every citation one of this request's IDs, at least one
 * citation, and enough of the paragraph's content words in the cited chunks (see
 * {@link LEXICAL_OVERLAP_MIN}). `known` maps each citation ID of this request to its chunk text.
 * This is not an entailment check (ADR 0005).
 */
export function checkParagraph(
  paragraph: string,
  known: ReadonlyMap<string, string>,
  policy: OutputPolicy,
): ParagraphCheck {
  const lower = paragraph.toLowerCase();
  if (policy.forbiddenTopics.some((topic) => lower.includes(topic.toLowerCase()))) {
    return { ok: false, reason: 'forbidden_topic' };
  }
  if (INJECTION_PATTERNS.some((pattern) => pattern.test(paragraph))) {
    return { ok: false, reason: 'injection' };
  }
  const normalized = ` ${words(paragraph).join(' ')} `;
  if ([...policy.protectedShingles].some((shingle) => normalized.includes(` ${shingle} `))) {
    return { ok: false, reason: 'disclosure' };
  }
  const cited = [...paragraph.matchAll(CITATION)].map((match) => match[1] ?? '');
  if (cited.some((id) => !known.has(id))) return { ok: false, reason: 'unknown_citation' };
  if (cited.length === 0) return { ok: false, reason: 'unsupported' };
  const own = contentWords(paragraph);
  if (own.length > 0) {
    const source = new Set(cited.flatMap((id) => contentWords(known.get(id) ?? '')));
    const shared = own.filter((word) => source.has(word)).length;
    if (shared / own.length < LEXICAL_OVERLAP_MIN) return { ok: false, reason: 'low_overlap' };
  }
  return { ok: true, citationIds: [...new Set(cited)] };
}
