const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, name: string) => {
    if (name.startsWith('#')) {
      const code =
        name[1] === 'x' || name[1] === 'X'
          ? Number.parseInt(name.slice(2), 16)
          : Number.parseInt(name.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
    }
    return ENTITIES[name.toLowerCase()] ?? entity;
  });
}

// A single pass can leave markup behind when tags are nested inside each other
// (`<scr<script>ipt>`), so replace until nothing changes.
function replaceUntilStable(text: string, pattern: RegExp, replacement: string): string {
  let previous: string;
  let current = text;
  do {
    previous = current;
    current = current.replace(pattern, replacement);
  } while (current !== previous);
  return current;
}

// Output is plain text, so any angle bracket left after tag removal is a fragment
// of broken markup rather than content. Literal brackets survive as entities and
// are decoded afterwards.
function stripMarkup(text: string): string {
  return replaceUntilStable(text, /<[^>]*>/g, '').replace(/[<>]/g, '');
}

function collapse(text: string): string {
  return decodeEntities(stripMarkup(text)).replace(/\s+/g, ' ').trim();
}

export interface HtmlText {
  title: string | undefined;
  text: string;
}

/**
 * A deliberately small HTML-to-text conversion for help pages: drops scripts,
 * styles and markup, keeps headings as markdown headings so the chunker can
 * split on them, and keeps paragraphs apart. It is not a full HTML parser.
 */
export function htmlToText(html: string): HtmlText {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleMatch ? collapse(titleMatch[1] ?? '') : undefined;

  const withoutHidden = replaceUntilStable(
    replaceUntilStable(html, /<!--[\s\S]*?-->/g, ''),
    /<(script|style|noscript|template|head|svg)\b[\s\S]*?<\/\1\s*>/gi,
    '',
  );

  const blocks = withoutHidden
    .replace(
      /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi,
      (_match, level: string, inner: string) =>
        `\n\n${'#'.repeat(Number(level))} ${collapse(inner)}\n\n`,
    )
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(
      /<\/?(p|div|section|article|main|header|footer|nav|aside|ul|ol|table|tr|blockquote|pre)\b[^>]*>/gi,
      '\n\n',
    );

  const text = stripMarkup(blocks)
    .split('\n')
    .map((line) =>
      decodeEntities(line)
        .replace(/[ \t\f\v]+/g, ' ')
        .trim(),
    )
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { title: title === '' ? undefined : title, text };
}
