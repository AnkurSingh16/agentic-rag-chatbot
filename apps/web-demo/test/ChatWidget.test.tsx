import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
});
