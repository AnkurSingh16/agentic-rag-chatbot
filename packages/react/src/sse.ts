export interface SseEvent {
  event: string;
  data: unknown;
}

/**
 * Parses a server-sent event stream read through `fetch`. EventSource cannot send a POST body or
 * headers, so the chat API is read this way. Comment lines (pings) are skipped.
 */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    // stream: true keeps a multi-byte character split across chunks intact.
    buffer += decoder.decode(value, { stream: !done }).replaceAll('\r\n', '\n');
    let split = buffer.indexOf('\n\n');
    while (split !== -1) {
      const frame = parseFrame(buffer.slice(0, split));
      buffer = buffer.slice(split + 2);
      if (frame !== undefined) yield frame;
      split = buffer.indexOf('\n\n');
    }
    if (done) return;
  }
}

function parseFrame(frame: string): SseEvent | undefined {
  let event = 'message';
  const data: string[] = [];
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  if (data.length === 0) return undefined;
  return { event, data: JSON.parse(data.join('\n')) as unknown };
}
