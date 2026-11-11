/** One retrieved chunk as the answer model sees it. */
export interface ContextDocument {
  citationId: string;
  title: string;
  text: string;
}

const DOCUMENT = /<document citation="([^"]*)" title="([^"]*)">\n([\s\S]*?)\n<\/document>/g;

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

/** The inverse of {@link formatContext}, used by the mock model. Text keeps its escaping. */
export function parseContext(context: string): ContextDocument[] {
  return [...context.matchAll(DOCUMENT)].map((match) => ({
    citationId: unescapeAttribute(match[1] ?? ''),
    title: unescapeAttribute(match[2] ?? ''),
    text: match[3] ?? '',
  }));
}
