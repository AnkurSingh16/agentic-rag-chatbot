import { useEffect, useRef, useState } from 'react';
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
  /** The visitor's question, kept on assistant replies for the handoff. */
  question?: string;
  handoff?: 'offer' | 'sent' | 'failed' | undefined;
}

export interface ChatWidgetProps {
  apiUrl: string;
  instanceId: string;
  /** Heading shown in the open panel. */
  title?: string;
  /**
   * Where a question the assistant could not answer is sent, for example the site's contact form
   * endpoint. Without it, no handoff is offered.
   */
  contactEndpoint?: string;
  /** Open the panel on first render instead of showing the launcher. */
  defaultOpen?: boolean;
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
      <sup key={`${index}-${id}`} className="cw-footnote-ref">
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
      <p className="cw-text">{pieces}</p>
      {order.length > 0 && (
        <ol className="cw-footnotes" aria-label="Sources">
          {order.map((id) => {
            const citation = byId.get(id);
            if (citation === undefined) return null;
            return (
              <li key={id} title={citation.excerpt}>
                {citation.title}{' '}
                <span className="cw-source">
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

// The panel stays mounted while it animates out, so the conversation survives minimising.
type Phase = 'closed' | 'open' | 'closing';
const CLOSE_MS = 220;

const HANDOFF_STATES: ReadonlySet<FinalState> = new Set([
  'INSUFFICIENT_EVIDENCE',
  'OUT_OF_SCOPE',
  'REFUSED',
]);

export function ChatWidget({
  apiUrl,
  instanceId,
  title = 'Ask a question',
  contactEndpoint,
  defaultOpen = false,
}: ChatWidgetProps) {
  const [phase, setPhase] = useState<Phase>(defaultOpen ? 'open' : 'closed');
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [handoffEmail, setHandoffEmail] = useState('');
  const session = useRef<string | undefined>(undefined);
  const conversationId = useRef<string | undefined>(undefined);
  const nextId = useRef(0);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const base = `${apiUrl}/v1/instances/${instanceId}`;

  useEffect(() => {
    return () => {
      clearTimeout(closeTimer.current);
    };
  }, []);

  function open() {
    clearTimeout(closeTimer.current);
    setPhase('open');
  }

  function minimise() {
    setPhase('closing');
    closeTimer.current = setTimeout(() => {
      setPhase((current) => (current === 'closing' ? 'closed' : current));
    }, CLOSE_MS);
  }

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
        case 'final': {
          const state = (data as { state: FinalState }).state;
          update(replyId, (m) => ({
            ...m,
            state,
            handoff:
              contactEndpoint !== undefined && HANDOFF_STATES.has(state) ? 'offer' : undefined,
          }));
          break;
        }
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
      { id: replyId, role: 'assistant', text: '', citations: [], question: message },
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

  // Sends the visitor's own question to the site's contact endpoint. The question and the optional
  // email go in the request body, never in the URL.
  async function sendToOwner(replyId: number, question: string) {
    if (contactEndpoint === undefined) return;
    update(replyId, (m) => ({ ...m, handoff: 'offer' }));
    try {
      const response = await fetch(contactEndpoint, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({
          message: question,
          email: handoffEmail.trim() === '' ? undefined : handoffEmail.trim(),
          source: 'chat-widget',
          instanceId,
        }),
      });
      update(replyId, (m) => ({ ...m, handoff: response.ok ? 'sent' : 'failed' }));
    } catch {
      update(replyId, (m) => ({ ...m, handoff: 'failed' }));
    }
  }

  const panelOpen = phase !== 'closed';
  return (
    <div className="cw-root">
      {panelOpen && (
        <section
          className={`cw-panel ${phase === 'closing' ? 'is-closing' : 'is-open'}`}
          aria-label="Chat"
        >
          <header className="cw-header">
            <span className="cw-title">{title}</span>
            <button
              type="button"
              className="cw-icon-button"
              aria-label="Minimise chat"
              onClick={minimise}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M6 12h12" />
              </svg>
            </button>
          </header>
          <ol className="cw-messages" aria-live="polite">
            {messages.map((message) => (
              <li key={message.id} className={`cw-message cw-${message.role}`}>
                {message.text !== '' && (
                  <Answer text={message.text} citations={message.citations} />
                )}
                {message.role === 'assistant' &&
                  message.text === '' &&
                  message.error === undefined && <p className="cw-pending">Thinking…</p>}
                {message.error !== undefined && (
                  <p className="cw-error" role="alert">
                    {message.error}
                  </p>
                )}
                {message.state !== undefined && STATE_NOTES[message.state] !== undefined && (
                  <p className="cw-note">{STATE_NOTES[message.state]}</p>
                )}
                {message.handoff !== undefined &&
                  message.question !== undefined &&
                  contactEndpoint !== undefined && (
                    <Handoff
                      status={message.handoff}
                      email={handoffEmail}
                      onEmail={setHandoffEmail}
                      onSend={() => void sendToOwner(message.id, message.question ?? '')}
                    />
                  )}
              </li>
            ))}
          </ol>
          <p className="cw-disclaimer">
            This is an AI assistant and can make mistakes. Check important details against the
            sources.
          </p>
          <form className="cw-form" onSubmit={(event) => void onSubmit(event)}>
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
        className={`cw-launcher ${panelOpen ? 'is-hidden' : 'is-visible'}`}
        aria-label="Chat"
        aria-expanded={panelOpen}
        onClick={open}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.5 3.5V16h0A2.5 2.5 0 0 1 4 13.5z" />
        </svg>
      </button>
    </div>
  );
}

function Handoff({
  status,
  email,
  onEmail,
  onSend,
}: {
  status: 'offer' | 'sent' | 'failed';
  email: string;
  onEmail: (value: string) => void;
  onSend: () => void;
}) {
  if (status === 'sent') return <p className="cw-note">Sent. Ankur will reply when he can.</p>;
  if (status === 'failed') {
    return (
      <p className="cw-error" role="alert">
        That did not send. Try the contact form on the site.
      </p>
    );
  }
  return (
    <div className="cw-handoff">
      <p className="cw-note">Send this question to Ankur?</p>
      <div className="cw-handoff-row">
        <input
          aria-label="Your email, optional"
          type="email"
          value={email}
          placeholder="Email (optional)"
          onChange={(event) => {
            onEmail(event.target.value);
          }}
        />
        <button type="button" onClick={onSend}>
          Send to Ankur
        </button>
      </div>
    </div>
  );
}
