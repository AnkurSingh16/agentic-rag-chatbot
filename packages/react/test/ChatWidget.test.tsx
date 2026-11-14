import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatWidget } from '../src/ChatWidget.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

// Splits the stream at arbitrary points so frames arrive across chunk boundaries.
function streamOf(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
      controller.close();
    },
  });
}

describe('ChatWidget', () => {
  it('gets a session, streams an answer with citations and handles reset', async () => {
    const body =
      frame('meta', { requestId: 'r1', conversationId: 'conv-1', indexVersion: 'v1' }) +
      ': ping\n\n' +
      frame('token', { text: 'Draft that fails later.' }) +
      frame('reset', { reason: 'verification_failed' }) +
      frame('token', { text: 'Export to Markdown, PDF or HTML. [c1a2b3c]' }) +
      frame('citation', {
        citationId: 'c1a2b3c',
        title: 'Exporting notes',
        excerpt: 'Choose File > Export.',
        sourceUri: 'data/export.md',
      }) +
      frame('final', { state: 'ANSWERED', citationIds: ['c1a2b3c'], usage: {} });
    const fetchMock = vi.fn((url: string) =>
      Promise.resolve(
        url.endsWith('/session')
          ? new Response(JSON.stringify({ token: 'session-token' }))
          : new Response(streamOf(body), { headers: { 'content-type': 'text/event-stream' } }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<ChatWidget apiUrl="http://api.test" instanceId="demo" />);
    fireEvent.click(screen.getByRole('button', { name: 'Chat' }));
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'How do I export?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByText(/^Export to Markdown, PDF or HTML\./)).toBeTruthy();
    expect(screen.getByText(/Exporting notes/).textContent).toContain('data/export.md');
    expect(screen.queryByText(/Draft that fails later/)).toBeNull();
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      'http://api.test/v1/instances/demo/session',
      'http://api.test/v1/instances/demo/chat',
    ]);
    const init = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(new Headers(init[1].headers).get('x-session-token')).toBe('session-token');
  });

  it('numbers citations as footnotes in order of first use and hides the markers', async () => {
    const body =
      frame('meta', { requestId: 'r2', conversationId: 'conv-2', indexVersion: 'v1' }) +
      frame('token', {
        text: 'Sync takes about thirty seconds. [c4d5e6f]\n\nExport to PDF too. [c1a2b3c] [c4d5e6f]',
      }) +
      frame('citation', {
        citationId: 'c1a2b3c',
        title: 'Exporting notes',
        excerpt: 'Choose File > Export.',
        sourceUri: 'https://example.com/help/export',
      }) +
      frame('citation', {
        citationId: 'c4d5e6f',
        title: 'Sync',
        excerpt: 'Changes sync in about thirty seconds.',
        sourceUri: 'data/sync.md',
      }) +
      frame('final', { state: 'ANSWERED', citationIds: ['c4d5e6f', 'c1a2b3c'], usage: {} });
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        Promise.resolve(
          url.endsWith('/session')
            ? new Response(JSON.stringify({ token: 'session-token' }))
            : new Response(streamOf(body), { headers: { 'content-type': 'text/event-stream' } }),
        ),
      ),
    );

    const { container } = render(<ChatWidget apiUrl="http://api.test" instanceId="demo" />);
    fireEvent.click(screen.getByRole('button', { name: 'Chat' }));
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Sync and export?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await screen.findByText(/Export to PDF too/);
    const answer = container.querySelector('.cw-assistant .cw-text')?.textContent ?? '';
    expect(answer).toBe('Sync takes about thirty seconds.1\n\nExport to PDF too.21');
    expect(answer).not.toContain('[c');

    const footnotes = Array.from(container.querySelectorAll('.cw-footnotes li')).map(
      (item) => item.textContent,
    );
    expect(footnotes).toEqual([
      'Sync data/sync.md',
      'Exporting notes https://example.com/help/export',
    ]);
    const webLink = container.querySelector('.cw-footnote-ref a[href^="https://"]');
    expect(webLink?.textContent).toBe('2');
    const localRef = container.querySelector('.cw-footnote-ref');
    expect(localRef?.querySelector('a')).toBeNull();
  });

  it('shows limit errors and the insufficient-evidence state', async () => {
    const responses = [
      new Response(JSON.stringify({ token: 't' })),
      new Response(JSON.stringify({ error: { code: 'rate_limited', retryable: true } }), {
        status: 429,
      }),
      new Response(
        streamOf(
          frame('token', { text: 'I could not find an answer.' }) +
            frame('final', { state: 'INSUFFICIENT_EVIDENCE', citationIds: [], usage: {} }),
        ),
      ),
      new Response(streamOf(frame('error', { code: 'provider_unavailable', retryable: true }))),
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(responses.shift())),
    );

    render(<ChatWidget apiUrl="http://api.test" instanceId="demo" />);
    fireEvent.click(screen.getByRole('button', { name: 'Chat' }));
    const send = async (text: string) => {
      fireEvent.change(screen.getByLabelText('Message'), { target: { value: text } });
      fireEvent.click(await screen.findByRole('button', { name: 'Send' }));
    };
    await send('one');
    expect(await screen.findByText(/Too many messages/)).toBeTruthy();
    await send('two');
    expect(await screen.findByText('Not found in the documents')).toBeTruthy();
    await send('three');
    expect(await screen.findByText(/unavailable right now/)).toBeTruthy();
  });

  it('shows an AI disclaimer for the whole session once the chat is open', () => {
    render(<ChatWidget apiUrl="https://api.example.test" instanceId="help" />);
    fireEvent.click(screen.getByRole('button', { name: 'Chat' }));
    expect(screen.getByText(/AI assistant and can make mistakes/)).toBeTruthy();
  });

  it('minimises to the launcher and reopens with the conversation kept', async () => {
    const fetchMock = vi.fn((url: string) =>
      Promise.resolve(
        url.endsWith('/session')
          ? new Response(JSON.stringify({ token: 'session-token' }))
          : new Response(streamOf(frame('final', { state: 'ANSWERED' })), {
              headers: { 'content-type': 'text/event-stream' },
            }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    render(<ChatWidget apiUrl="http://api.test" instanceId="demo" />);
    fireEvent.click(screen.getByRole('button', { name: 'Chat' }));
    fireEvent.click(screen.getByRole('button', { name: 'Minimise chat' }));
    await waitFor(() => {
      expect(screen.queryByRole('region', { name: 'Chat' })).toBeNull();
    });
    expect(screen.getByRole('button', { name: 'Chat' }).className).toContain('is-visible');
    fireEvent.click(screen.getByRole('button', { name: 'Chat' }));
    expect(screen.getByRole('region', { name: 'Chat' })).toBeTruthy();
  });

  it('offers a handoff to the owner when the answer is refused, and sends the question', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url.endsWith('/session'))
        return Promise.resolve(new Response(JSON.stringify({ token: 't' })));
      if (url === 'https://contact.test/form')
        return Promise.resolve(new Response('{}', { status: 200 }));
      return Promise.resolve(
        new Response(streamOf(frame('final', { state: 'OUT_OF_SCOPE' })), {
          headers: { 'content-type': 'text/event-stream' },
        }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    render(
      <ChatWidget
        apiUrl="http://api.test"
        instanceId="demo"
        contactEndpoint="https://contact.test/form"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Chat' }));
    fireEvent.change(screen.getByLabelText('Message'), {
      target: { value: 'What is the weather?' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Send to Ankur' }));
    expect(await screen.findByText(/Sent\. Ankur will reply/)).toBeTruthy();
    const calls = fetchMock.mock.calls as unknown as [string, RequestInit | undefined][];
    const sent = calls.find((call) => call[0] === 'https://contact.test/form')?.[1];
    const body = JSON.parse(typeof sent?.body === 'string' ? sent.body : '{}') as Record<
      string,
      unknown
    >;
    expect(body).toMatchObject({
      message: 'What is the weather?',
      source: 'chat-widget',
      instanceId: 'demo',
    });
    expect(calls.map((call) => call[0])).not.toContain('What is the weather?');
  });
});
