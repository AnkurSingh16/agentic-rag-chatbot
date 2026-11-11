import { estimateTokens } from '../chunking/chunker.js';
import { parseContext } from './context.js';
import type { ChatModel, ChatRequest, ChatStreamEvent } from './types.js';

/** What the mock answers when the request carries no context. */
export const MOCK_INSUFFICIENT_EVIDENCE =
  'I could not find this in the provided documents, so I cannot answer it.';

// Matches messages that are only a greeting or a thank-you, not ones that also ask something.
const SMALL_TALK =
  /^\s*(?:hi|hello|hey|thanks|thank you|thank you very much|cheers|good (?:morning|afternoon|evening))[\s!.,]*$/i;
const PIECE_LENGTH = 16;
const ANSWER_PARAGRAPHS = 2;

function lastUserMessage(request: ChatRequest): string {
  for (let i = request.messages.length - 1; i >= 0; i--) {
    const message = request.messages[i];
    if (message?.role === 'user') return message.content;
  }
  return '';
}

// Heading-path prefixes, headings and blockquote notes carry no answer, so the first prose block
// with a full sentence is used.
function firstSentence(text: string): string | undefined {
  for (const block of text.split(/\n{2,}/)) {
    const trimmed = block.trim();
    if (trimmed.startsWith('#') || trimmed.startsWith('>')) continue;
    const sentence = /^[\s\S]*?[.!?](?=\s|$)/.exec(trimmed)?.[0];
    if (sentence !== undefined) {
      return sentence.replaceAll('**', '').replace(/\s+/g, ' ').trim();
    }
  }
  return undefined;
}

function answerFrom(context: string): string {
  const paragraphs = parseContext(context)
    .map((document) => {
      const sentence = firstSentence(document.text);
      return sentence === undefined ? undefined : `${sentence} [${document.citationId}]`;
    })
    .filter((paragraph) => paragraph !== undefined)
    .slice(0, ANSWER_PARAGRAPHS);
  return paragraphs.length === 0 ? MOCK_INSUFFICIENT_EVIDENCE : paragraphs.join('\n\n');
}

// The agent graph's routing tool is called "route"; other tools get an empty input.
function toolInput(name: string, request: ChatRequest): unknown {
  if (name !== 'route') return {};
  const question = lastUserMessage(request).trim();
  return SMALL_TALK.test(question)
    ? { intent: 'small_talk', queries: [] }
    : { intent: 'knowledge', queries: [question] };
}

function inputTokens(request: ChatRequest): number {
  const messages = request.messages.map((message) => message.content).join('\n');
  return estimateTokens(`${request.system}\n${request.context}\n${messages}`);
}

/**
 * A deterministic chat model for local development, tests and CI (ADR 0008). It makes no
 * network calls. Tool requests get a tool call; answer requests get one short paragraph per top
 * context document, built from its first sentence and ending with its citation. Token counts
 * are estimated as characters ÷ 4.
 */
export function createMockChatModel(): ChatModel {
  return {
    provider: 'mock',
    async *generate(request): AsyncGenerator<ChatStreamEvent> {
      request.signal.throwIfAborted();
      const tool =
        request.tools?.find((candidate) => candidate.name === request.toolChoice) ??
        request.tools?.[0];
      let output: string;
      if (tool === undefined) {
        output = answerFrom(request.context);
        for (let i = 0; i < output.length; i += PIECE_LENGTH) {
          await Promise.resolve();
          request.signal.throwIfAborted();
          yield { type: 'text', text: output.slice(i, i + PIECE_LENGTH) };
        }
      } else {
        const input = toolInput(tool.name, request);
        output = JSON.stringify(input);
        yield { type: 'tool_use', name: tool.name, input };
      }
      yield {
        type: 'done',
        usage: {
          inputTokens: inputTokens(request),
          outputTokens: estimateTokens(output),
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      };
    },
  };
}
