import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { estimateTokens } from '../chunking/chunker.js';
import type { InstanceConfig } from '../config/schema.js';
import { ChatbotError } from '../errors.js';
import { formatContext } from '../llm/context.js';
import { ZERO_USAGE, addUsage } from '../llm/types.js';
import type { ChatMessage, ChatModel, ChatRequest, ChatTool, TokenUsage } from '../llm/types.js';
import type { EmbeddingProvider } from '../providers/types.js';
import { RETRIEVAL } from '../retrieval/types.js';
import type {
  ActiveIndexVersion,
  RetrievalAccess,
  RetrievalStore,
  RetrievedChunk,
} from '../retrieval/types.js';
import type { ChatEvent, FinalState } from './events.js';
import { checkParagraph, guardInput, instructionShingles } from './guards.js';
import type { OutputPolicy, ParagraphFailure } from './guards.js';
import {
  ANSWER_RULES,
  JUDGE_SYSTEM,
  ROUTE_RULES,
  answerSystem,
  fallbackText,
  routeSystem,
} from './prompts.js';

/**
 * Per-turn budgets from ADR 0005. Input is estimated as characters ÷ 4 and capped per call, so
 * three calls stay within 24,000 input tokens per turn. Judge calls (verification.judge) are
 * outside this budget and capped at JUDGE_MAX_CALLS.
 */
export const TURN_BUDGET = {
  modelCalls: 3,
  deadlineMs: 30_000,
  routeOutputTokens: 256,
  inputTokensPerCall: 8_000,
  historyTokens: 2_000,
} as const;

const MAX_QUERIES = 3;
/** Judge calls per turn: one per paragraph of an answer, at most this many (ADR 0005). */
const JUDGE_MAX_CALLS = 3;
const JUDGE_OUTPUT_TOKENS = 4;

const EXCERPT_CHARS = 240;

const ROUTE_TOOL: ChatTool = {
  name: 'route',
  description:
    'Classify the latest user message and, for a knowledge question, write up to three search queries for the help documents.',
  inputSchema: {
    properties: {
      intent: {
        type: 'string',
        enum: ['knowledge', 'small_talk', 'out_of_scope', 'unsafe'],
        description:
          'knowledge: a question the documents may answer. small_talk: greetings and thanks. out_of_scope: unrelated to the documents. unsafe: harmful requests.',
      },
      queries: {
        type: 'array',
        items: { type: 'string' },
        maxItems: MAX_QUERIES,
        description: 'Self-contained search queries; empty unless intent is knowledge.',
      },
    },
    required: ['intent', 'queries'],
  },
};

const routeSchema = z.object({
  intent: z.enum(['knowledge', 'small_talk', 'out_of_scope', 'unsafe']),
  queries: z.array(z.string().trim().min(1).max(300)).max(MAX_QUERIES),
});

type Route = z.infer<typeof routeSchema>;

export interface ModelCallRecord {
  node: 'route' | 'answer' | 'judge';
  provider: string;
  model: string;
  usage: TokenUsage;
}

export interface RunChatOptions {
  config: InstanceConfig;
  access: RetrievalAccess;
  requestId: string;
  conversationId: string;
  message: string;
  /** Earlier turns of the conversation, oldest first, alternating user and assistant. */
  history: readonly ChatMessage[];
  chatModel: ChatModel;
  models: { chat: string; router: string };
  embeddings: EmbeddingProvider;
  retrieval: RetrievalStore;
  signal: AbortSignal;
  emit: (event: ChatEvent) => void;
  /** Called after every model call, for usage logging and budgets (ADR 0008). */
  onModelCall?: (call: ModelCallRecord) => Promise<void> | void;
  deadlineMs?: number;
  /**
   * Scores a specific version instead of the active one. Only the eval harness sets it, after it
   * has checked the version belongs to the instance (ADR 0002). Chat never sets it.
   */
  version?: ActiveIndexVersion;
}

export interface ChatOutcome {
  state: FinalState;
  /** The text released to the client. */
  text: string;
  citationIds: string[];
  usage: TokenUsage;
  indexVersion: string;
}

interface Citation {
  citationId: string;
  chunk: RetrievedChunk;
}

function newCitationIds(count: number): string[] {
  const ids = new Set<string>();
  while (ids.size < count) ids.add(`c${randomBytes(3).toString('hex')}`);
  return [...ids];
}

// The chunker prepends the heading path as the first block; excerpts show the text under it.
function chunkBody(chunk: RetrievedChunk): string {
  if (chunk.headingPath.length === 0) return chunk.content;
  const split = chunk.content.indexOf('\n\n');
  return split === -1 ? chunk.content : chunk.content.slice(split + 2);
}

function excerpt(chunk: RetrievedChunk): string {
  const body = chunkBody(chunk).replace(/\s+/g, ' ').trim();
  return body.length <= EXCERPT_CHARS ? body : `${body.slice(0, EXCERPT_CHARS - 1)}…`;
}

function estimateInput(request: Omit<ChatRequest, 'signal'>): number {
  const messages = request.messages.map((message) => message.content).join('\n');
  const tools = request.tools === undefined ? '' : JSON.stringify(request.tools);
  return estimateTokens(`${request.system}\n${request.context}\n${messages}\n${tools}`);
}

/** The newest turns that fit in `budget` estimated tokens, starting with a user turn. */
export function trimHistory(history: readonly ChatMessage[], budget: number): ChatMessage[] {
  const kept: ChatMessage[] = [];
  let used = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i];
    if (message === undefined) continue;
    used += estimateTokens(message.content);
    if (used > budget) break;
    kept.unshift(message);
  }
  while (kept[0]?.role === 'assistant') kept.shift();
  return kept;
}

/**
 * Runs one chat turn through the agent graph of ADR 0005: guard_in, route, retrieve, answer,
 * verify and guard_out. Paragraphs are released as `token` events only after they pass
 * verification and the forbidden-topic check; if the whole answer then fails, a `reset` event
 * tells the client to discard them. A failed verification is retried once with broader
 * retrieval, then the turn ends with `INSUFFICIENT_EVIDENCE`.
 *
 * Budgets: three model calls, `limits.maxOutputTokens` per answer call and a deadline (30 s by
 * default) that includes the retry. Errors are thrown as ChatbotError; the caller reports them.
 */
export async function runChat(options: RunChatOptions): Promise<ChatOutcome> {
  const { config, access, emit, embeddings, retrieval } = options;
  const signal = AbortSignal.any([
    options.signal,
    AbortSignal.timeout(options.deadlineMs ?? TURN_BUDGET.deadlineMs),
  ]);
  let usage: TokenUsage = { ...ZERO_USAGE };
  let modelCalls = 0;
  let judgeCalls = 0;

  const message = guardInput(options.message);
  const messages: ChatMessage[] = [
    ...trimHistory(options.history, TURN_BUDGET.historyTokens),
    { role: 'user', content: message },
  ];
  // guard_out blocks paragraphs that copy eight words in a row from these instructions. The
  // insufficient-evidence sentence is left out because the model is told to reply with it.
  const policy: OutputPolicy = {
    forbiddenTopics: config.persona.forbiddenTopics,
    protectedShingles: instructionShingles([
      config.persona.systemPrompt,
      ROUTE_RULES,
      ANSWER_RULES,
    ]),
  };

  const version = options.version ?? (await retrieval.activeVersion(access));
  if (version === undefined) {
    throw new ChatbotError('not_found', `Instance "${config.id}" has no active index version`);
  }
  if (
    version.embeddingProvider !== embeddings.provider ||
    version.embeddingModel !== embeddings.model
  ) {
    throw new ChatbotError(
      'invalid_config',
      `The active index of "${config.id}" was built with ${version.embeddingProvider}/${version.embeddingModel} ` +
        `but the server embeds with ${embeddings.provider}/${embeddings.model}; retrain or change EMBEDDING_PROVIDER`,
    );
  }
  const versionId = version.id;
  emit({
    event: 'meta',
    data: {
      requestId: options.requestId,
      conversationId: options.conversationId,
      indexVersion: version.id,
    },
  });

  async function callModel(
    node: 'route' | 'answer',
    request: Omit<ChatRequest, 'signal'>,
    onText: (text: string) => void,
  ) {
    modelCalls += 1;
    if (modelCalls > TURN_BUDGET.modelCalls) {
      throw new ChatbotError('internal', 'Model call budget for the turn exceeded');
    }
    if (estimateInput(request) > TURN_BUDGET.inputTokensPerCall) {
      throw new ChatbotError('internal', 'Model input budget for the call exceeded');
    }
    let toolInput: unknown;
    let callUsage: TokenUsage | undefined;
    try {
      for await (const event of options.chatModel.generate({ ...request, signal })) {
        if (event.type === 'text') onText(event.text);
        else if (event.type === 'tool_use') toolInput ??= event.input;
        else callUsage = event.usage;
      }
    } catch (error) {
      if (signal.aborted && !options.signal.aborted) {
        throw new ChatbotError('provider_unavailable', 'The turn deadline passed', {
          cause: error,
        });
      }
      throw error;
    }
    if (callUsage !== undefined) {
      usage = addUsage(usage, callUsage);
      await options.onModelCall?.({
        node,
        provider: options.chatModel.provider,
        model: request.model,
        usage: callUsage,
      });
    }
    return toolInput;
  }

  /**
   * Asks the chat model whether a paragraph states only what its cited documents say. Anything
   * other than a clear YES is a failure, and so is going over the judge budget.
   */
  async function judgeParagraph(
    paragraph: string,
    cited: { citationId: string; title: string; text: string }[],
  ): Promise<boolean> {
    judgeCalls += 1;
    if (judgeCalls > JUDGE_MAX_CALLS) return false;
    let verdict = '';
    let callUsage: TokenUsage | undefined;
    for await (const event of options.chatModel.generate({
      model: options.models.chat,
      system: JUDGE_SYSTEM,
      context: formatContext(cited),
      messages: [{ role: 'user', content: `Paragraph to check:\n${paragraph}` }],
      maxOutputTokens: JUDGE_OUTPUT_TOKENS,
      signal,
    })) {
      if (event.type === 'text') verdict += event.text;
      else if (event.type === 'done') callUsage = event.usage;
    }
    if (callUsage !== undefined) {
      usage = addUsage(usage, callUsage);
      await options.onModelCall?.({
        node: 'judge',
        provider: options.chatModel.provider,
        model: options.models.chat,
        usage: callUsage,
      });
    }
    return /^\s*YES\b/i.test(verdict);
  }

  function finish(state: FinalState, text: string, citationIds: string[]): ChatOutcome {
    emit({ event: 'final', data: { state, citationIds, usage } });
    return { state, text, citationIds, usage, indexVersion: versionId };
  }

  function fixedReply(state: FinalState, text: string): ChatOutcome {
    emit({ event: 'token', data: { text } });
    return finish(state, text, []);
  }

  emit({ event: 'status', data: { node: 'route' } });
  const routeInput = await callModel(
    'route',
    {
      model: options.models.router,
      system: routeSystem(config),
      context: '',
      messages,
      maxOutputTokens: Math.min(TURN_BUDGET.routeOutputTokens, config.limits.maxOutputTokens),
      tools: [ROUTE_TOOL],
      toolChoice: ROUTE_TOOL.name,
    },
    () => undefined,
  );
  // An unusable routing answer falls back to treating the message as a question, which still
  // has to pass retrieval and verification.
  const parsed = routeSchema.safeParse(routeInput);
  const route: Route = parsed.success ? parsed.data : { intent: 'knowledge', queries: [] };

  switch (route.intent) {
    case 'small_talk':
      return fixedReply('ANSWERED', `Happy to help. Ask me anything about ${config.displayName}.`);
    case 'out_of_scope':
      return fixedReply('OUT_OF_SCOPE', fallbackText(config.persona.fallback));
    case 'unsafe':
      return fixedReply('REFUSED', fallbackText(config.persona.fallback));
    case 'knowledge':
      break;
  }
  const queries = route.queries.length > 0 ? route.queries : [message];
  const queryVectors = await embeddings.embed(queries, signal);

  for (const limit of [RETRIEVAL.limit, RETRIEVAL.retryLimit]) {
    // Each attempt gets its own judge budget; a shared one would leave a retry unable to pass (ADR 0005).
    judgeCalls = 0;
    emit({ event: 'status', data: { node: 'retrieve' } });
    const lists = await retrieval.search(
      access,
      version.id,
      queries.map((text, i) => ({ text, embedding: queryVectors[i] ?? [], limit })),
    );
    const answerBase = {
      system: answerSystem(config),
      context: '',
      messages,
      model: '',
      maxOutputTokens: 0,
    };
    const chunks = fitContext(
      mergeResults(lists, limit),
      TURN_BUDGET.inputTokensPerCall - estimateInput(answerBase),
    );
    // Nothing above the minimum score: no answer call (ADR 0006), and a broader retry would
    // apply the same threshold.
    if (chunks.length === 0) break;

    const ids = newCitationIds(chunks.length);
    const citations = new Map<string, Citation>(
      chunks.map((chunk, i) => [ids[i] ?? '', { citationId: ids[i] ?? '', chunk }]),
    );
    const known = new Map([...citations].map(([id, { chunk }]) => [id, chunkBody(chunk)]));
    const released: string[] = [];
    const releasedIds: string[] = [];
    let failure: ParagraphFailure | undefined;

    const emitParagraph = (text: string, citationIds: string[]) => {
      emit({ event: 'token', data: { text: released.length === 0 ? text : `\n\n${text}` } });
      released.push(text);
      for (const id of citationIds) {
        const citation = citations.get(id);
        if (citation === undefined || releasedIds.includes(id)) continue;
        releasedIds.push(id);
        emit({
          event: 'citation',
          data: {
            citationId: id,
            title: citation.chunk.title,
            excerpt: excerpt(citation.chunk),
            sourceUri: citation.chunk.sourceUri,
          },
        });
      }
    };

    // With the judge on, paragraphs wait here until the answer has streamed and each one has
    // been judged, so no unjudged text is released (ADR 0005).
    const judged: { text: string; citationIds: string[] }[] = [];
    const release = (paragraph: string) => {
      const text = paragraph.trim();
      if (text === '' || failure !== undefined) return;
      const check = checkParagraph(text, known, policy);
      if (!check.ok) {
        failure = check.reason;
        return;
      }
      if (config.verification.judge) {
        judged.push({ text, citationIds: check.citationIds });
        return;
      }
      emitParagraph(text, check.citationIds);
    };

    emit({ event: 'status', data: { node: 'answer' } });
    let buffer = '';
    // The stream is read to the end even after a failed paragraph, so the usage reported for
    // the call is complete.
    await callModel(
      'answer',
      {
        model: options.models.chat,
        system: answerBase.system,
        context: formatContext(
          [...citations.values()].map(({ citationId, chunk }) => ({
            citationId,
            title: chunk.title,
            text: chunk.content,
          })),
        ),
        messages,
        maxOutputTokens: config.limits.maxOutputTokens,
      },
      (text) => {
        buffer += text;
        let split = buffer.indexOf('\n\n');
        while (split !== -1) {
          release(buffer.slice(0, split));
          buffer = buffer.slice(split + 2);
          split = buffer.indexOf('\n\n');
        }
      },
    );
    release(buffer);

    if (config.verification.judge) {
      for (const paragraph of judged) {
        if (failure !== undefined) break;
        const cited = paragraph.citationIds.flatMap((id) => {
          const citation = citations.get(id);
          return citation === undefined
            ? []
            : [{ citationId: id, title: citation.chunk.title, text: citation.chunk.content }];
        });
        if (!(await judgeParagraph(paragraph.text, cited))) {
          failure = 'unsupported_claim';
          break;
        }
        emitParagraph(paragraph.text, paragraph.citationIds);
      }
    }

    emit({ event: 'status', data: { node: 'verify' } });
    const blocked =
      failure === 'forbidden_topic' || failure === 'injection' || failure === 'disclosure';
    if (failure === undefined && released.length > 0) {
      return finish('ANSWERED', released.join('\n\n'), releasedIds);
    }
    if (released.length > 0) {
      emit({
        event: 'reset',
        data: { reason: blocked ? 'guard_out' : 'verification_failed' },
      });
    }
    if (blocked) {
      emit({ event: 'status', data: { node: 'guard_out' } });
      return fixedReply('REFUSED', fallbackText(config.persona.fallback));
    }
  }
  return fixedReply('INSUFFICIENT_EVIDENCE', fallbackText(config.persona.fallback));
}

/**
 * The ranked chunks that fit in `budget` estimated tokens once formatted as context, in rank
 * order; a chunk too large for what is left is skipped.
 */
export function fitContext(chunks: readonly RetrievedChunk[], budget: number): RetrievedChunk[] {
  const kept: RetrievedChunk[] = [];
  // The wrapper of each document (tag, citation, title) is counted with its text.
  let used = estimateTokens('<documents>\n</documents>');
  for (const chunk of chunks) {
    const cost = estimateTokens(
      `<document citation="c000000" title="${chunk.title}">\n${chunk.content}\n</document>\n`,
    );
    if (used + cost > budget) continue;
    used += cost;
    kept.push(chunk);
  }
  return kept;
}

/** Merges the ranked lists of several queries, keeping each chunk's best score. */
export function mergeResults(lists: readonly RetrievedChunk[][], limit: number): RetrievedChunk[] {
  const best = new Map<string, RetrievedChunk>();
  for (const chunk of lists.flat()) {
    const current = best.get(chunk.chunkId);
    if (current === undefined || chunk.score > current.score) best.set(chunk.chunkId, chunk);
  }
  return [...best.values()]
    .sort((a, b) => b.score - a.score || (a.chunkId < b.chunkId ? -1 : 1))
    .slice(0, limit);
}
