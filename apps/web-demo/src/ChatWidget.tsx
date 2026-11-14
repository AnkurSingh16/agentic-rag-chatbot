import { useRef, useState } from 'react';
import type { ReactNode, SyntheticEvent } from 'react';
import { readSse } from './sse.js';

interface Citation {
  citationId: string;
  title: string;
  excerpt: string;
  sourceUri: string;
}

type FinalState = 'ANSWERED' | 'INSUFFICIENT_EVIDENCE' | 'OUT_OF_SCOPE' | 'REFUSED';

interface Message {
  id: number;
  role: 'user' | 'assistant';
  text: string;
  citations: Citation[];
  state?: FinalState;
  error?: string;
}

export interface ChatWidgetProps {
  apiUrl: string;
  instanceId: string;
}

const STATE_NOTES: Partial<Record<FinalState, string>> = {
  INSUFFICIENT_EVIDENCE: 'Not found in the documents',
  OUT_OF_SCOPE: 'Outside what this assistant covers',
  REFUSED: 'Declined',
};

// Citation markers as the server emits them in the answer text, for example [c1a2b3c].
const CITATION_MARKER = /\s*\[(c[0-9a-f]{6})\]/g;

function isWebLink(uri: string): boolean {
  return /^https?:\/\//.test(uri);
}

/**
 * Replaces citation markers with superscript numbers and lists the cited sources under the answer,
 * numbered in the order they first appear. A number links to its source when the source is a web
 * address; other sources are shown as text.
 */
function Answer({ text, citations }: { text: string; citations: Citation[] }) {
  const byId = new Map(citations.map((citation) => [citation.citationId, citation]));
  const order: string[] = [];
  for (const match of text.matchAll(CITATION_MARKER)) {
    const id = match[1] ?? '';
    if (byId.has(id) && !order.includes(id)) order.push(id);
  }

  const pieces: ReactNode[] = [];
  let cursor = 0;
  for (const match of text.matchAll(CITATION_MARKER)) {
    const index = match.index;
    pieces.push(text.slice(cursor, index));
    cursor = index + match[0].length;
    const id = match[1] ?? '';
    const citation = byId.get(id);
    if (citation === undefined) continue;
    const number = order.indexOf(id) + 1;
    pieces.push(
      <sup key={`${index}-${id}`} className="chat-footnote-ref">
        {isWebLink(citation.sourceUri) ? (
          <a href={citation.sourceUri} target="_blank" rel="noopener noreferrer">
            {number}
          </a>
        ) : (
          number
        )}
      </sup>,
    );
  }
  pieces.push(text.slice(cursor));

  return (
    <>
      <p className="chat-text">{pieces}</p>
      {order.length > 0 && (
        <ol className="chat-footnotes" aria-label="Sources">
          {order.map((id) => {
            const citation = byId.get(id);
            if (citation === undefined) return null;
            return (
              <li key={id} title={citation.excerpt}>
                {citation.title}{' '}
                <span className="chat-source">
                  {isWebLink(citation.sourceUri) ? (
                    <a href={citation.sourceUri} target="_blank" rel="noopener noreferrer">
                      {citation.sourceUri}
                    </a>
                  ) : (
                    citation.sourceUri
                  )}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </>
  );
}

const ERROR_TEXT: Record<string, string> = {
  rate_limited: 'Too many messages. Wait a minute and try again.',
  budget_exceeded: 'The daily message limit has been reached. Try again tomorrow.',
  provider_unavailable: 'The assistant is unavailable right now. Try again shortly.',
  not_found: 'This assistant has no documents yet.',
};

class ChatRequestError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

async function errorCode(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { code?: string } };
    return body.error?.code ?? 'internal';
  } catch {
    return 'internal';
  }
}

export function ChatWidget({ apiUrl, instanceId }: ChatWidgetProps) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const session = useRef<string | undefined>(undefined);
  const conversationId = useRef<string | undefined>(undefined);
  const nextId = useRef(0);
  const base = `${apiUrl}/v1/instances/${instanceId}`;

  function update(id: number, change: (message: Message) => Message) {
    setMessages((current) =>
      current.map((message) => (message.id === id ? change(message) : message)),
    );
  }

  async function sessionToken(): Promise<string> {
    if (session.current !== undefined) return session.current;
    const response = await fetch(`${base}/session`, { method: 'POST' });
    if (!response.ok) throw new ChatRequestError(await errorCode(response));
    const body = (await response.json()) as { token: string };
    session.current = body.token;
    return body.token;
  }

  async function post(message: string): Promise<Response> {
    const send = async () =>
      fetch(`${base}/chat`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          'x-session-token': await sessionToken(),
        },
        body: JSON.stringify({ message, conversationId: conversationId.current }),
      });
    let response = await send();
    // Sessions last 24 hours and end when a dev server restarts; get a new one once.
    if (response.status === 401) {
      session.current = undefined;
      conversationId.current = undefined;
      response = await send();
    }
    if (!response.ok || response.body === null) {
      throw new ChatRequestError(await errorCode(response));
    }
    return response;
  }

  async function ask(message: string, replyId: number) {
    const response = await post(message);
    for await (const { event, data } of readSse(response.body as ReadableStream<Uint8Array>)) {
      switch (event) {
        case 'meta':
          conversationId.current = (data as { conversationId: string }).conversationId;
          break;
        case 'token':
          update(replyId, (m) => ({ ...m, text: m.text + (data as { text: string }).text }));
          break;
        case 'citation':
          update(replyId, (m) => ({ ...m, citations: [...m.citations, data as Citation] }));
          break;
        case 'reset':
          // Released text failed the final check; the server sends a replacement.
          update(replyId, (m) => ({ ...m, text: '', citations: [] }));
          break;
        case 'final':
          update(replyId, (m) => ({ ...m, state: (data as { state: FinalState }).state }));
          break;
        case 'error':
          throw new ChatRequestError((data as { code: string }).code);
      }
    }
  }

  async function onSubmit(event: SyntheticEvent) {
    event.preventDefault();
    const message = input.trim();
    if (message === '' || busy) return;
    const userId = nextId.current++;
    const replyId = nextId.current++;
    setInput('');
    setBusy(true);
    setMessages((current) => [
      ...current,
      { id: userId, role: 'user', text: message, citations: [] },
      { id: replyId, role: 'assistant', text: '', citations: [] },
    ]);
    try {
      await ask(message, replyId);
    } catch (error) {
      const code = error instanceof ChatRequestError ? error.code : 'internal';
      update(replyId, (m) => ({
        ...m,
        error: ERROR_TEXT[code] ?? 'Something went wrong. Try again.',
      }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="chat">
      {open && (
        <section className="chat-panel" aria-label="Chat">
          <header className="chat-header">
            <span>Ask the help articles</span>
            <button
              type="button"
              aria-label="Close chat"
              onClick={() => {
                setOpen(false);
              }}
            >
              ×
            </button>
          </header>
          <ol className="chat-messages" aria-live="polite">
            {messages.map((message) => (
              <li key={message.id} className={`chat-message chat-${message.role}`}>
                {message.text !== '' && (
                  <Answer text={message.text} citations={message.citations} />
                )}
                {message.role === 'assistant' &&
                  message.text === '' &&
                  message.error === undefined && <p className="chat-pending">Thinking…</p>}
                {message.error !== undefined && (
                  <p className="chat-error" role="alert">
                    {message.error}
                  </p>
                )}
                {message.state !== undefined && STATE_NOTES[message.state] !== undefined && (
                  <p className="chat-note">{STATE_NOTES[message.state]}</p>
                )}
              </li>
            ))}
          </ol>
          <p className="chat-disclaimer">
            This is an AI assistant and can make mistakes. Check important details against the
            sources.
          </p>
          <form className="chat-form" onSubmit={(event) => void onSubmit(event)}>
            <input
              aria-label="Message"
              value={input}
              maxLength={2000}
              placeholder="Ask a question"
              onChange={(event) => {
                setInput(event.target.value);
              }}
            />
            <button type="submit" disabled={busy || input.trim() === ''}>
              Send
            </button>
          </form>
        </section>
      )}
      <button
        type="button"
        className="chat-launcher"
        aria-expanded={open}
        onClick={() => {
          setOpen((value) => !value);
        }}
      >
        {open ? 'Close' : 'Chat'}
      </button>
    </div>
  );
}
