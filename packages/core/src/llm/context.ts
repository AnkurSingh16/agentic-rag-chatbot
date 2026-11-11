/** One retrieved chunk as the answer model sees it. */
export interface ContextDocument {
  citationId: string;
  title: string;
  text: string;
}

const OPEN = '<document citation="';
const TITLE = '" title="';
const OPEN_END = '">\n';
const CLOSE = '\n</document>';

function escapeAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
}

function unescapeAttribute(value: string): string {
  return value.replaceAll('&lt;', '<').replaceAll('&quot;', '"').replaceAll('&amp;', '&');
}

// Retrieved text is untrusted (ADR 0005). Escaping the tag openers keeps a document from closing
// its own wrapper and posing as instructions or as another document.
function escapeText(value: string): string {
  return value.replace(/<(\/?)(documents?)\b/gi, '&lt;$1$2');
}

/**
 * Formats retrieved chunks as the context block of an answer request. Each chunk is wrapped in a
 * `<document>` element carrying its citation ID.
 */
export function formatContext(documents: readonly ContextDocument[]): string {
  if (documents.length === 0) return '';
  const body = documents
    .map(
      (document) =>
        `<document citation="${escapeAttribute(document.citationId)}" title="${escapeAttribute(document.title)}">\n${escapeText(document.text)}\n</document>`,
    )
    .join('\n');
  return `<documents>\n${body}\n</documents>`;
}

/**
 * The inverse of {@link formatContext}, used by the mock model. Text keeps its escaping. Scans
 * with indexOf so the time is linear in the input length, whatever the input holds.
 */
export function parseContext(context: string): ContextDocument[] {
  const documents: ContextDocument[] = [];
  let position = context.indexOf(OPEN);
  while (position !== -1) {
    const citationStart = position + OPEN.length;
    const titleAt = context.indexOf(TITLE, citationStart);
    const openEndAt = titleAt === -1 ? -1 : context.indexOf(OPEN_END, titleAt + TITLE.length);
    const closeAt = openEndAt === -1 ? -1 : context.indexOf(CLOSE, openEndAt + OPEN_END.length);
    if (closeAt === -1) break;
    const citationId = context.slice(citationStart, titleAt);
    const title = context.slice(titleAt + TITLE.length, openEndAt);
    // Attribute values are escaped, so a quote inside one means this is not a formatted header.
    if (!citationId.includes('"') && !title.includes('"')) {
      documents.push({
        citationId: unescapeAttribute(citationId),
        title: unescapeAttribute(title),
        text: context.slice(openEndAt + OPEN_END.length, closeAt),
      });
    }
    position = context.indexOf(OPEN, closeAt + CLOSE.length);
  }
  return documents;
}
