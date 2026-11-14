import type { ChatEvent, FinalState } from '../agent/events.js';
import { runChat } from '../agent/run-chat.js';
import type { InstanceConfig } from '../config/schema.js';
import type { ChatModel } from '../llm/types.js';
import type { EmbeddingProvider } from '../providers/types.js';
import type { ActiveIndexVersion, RetrievalAccess, RetrievalStore } from '../retrieval/types.js';
import type { EvalSet } from './eval-set.js';

/** Runs per question. Each run is a full chat turn. */
export const CHAT_EVAL_REPEATS = 3;

/** The turn deadline for eval runs, which can take longer than a chat turn on a local model. */
export const CHAT_EVAL_DEADLINE_MS = 180_000;

/** Share of answerable runs that must be answered with a citation. Recorded with the run. */
export const CHAT_EVAL_MIN_ANSWERED_RATE = 0.8;

/** States that mean the instance declined to answer, with no citation and nothing released. */
const REFUSAL_STATES: ReadonlySet<FinalState> = new Set(['OUT_OF_SCOPE', 'INSUFFICIENT_EVIDENCE']);

export interface ChatEvalRun {
  state: FinalState;
  citations: number;
  /** Paragraphs released and then retracted; a reset means text reached the client first. */
  resets: number;
  /** Unanswerable questions: no citation and nothing released. */
  refused: boolean;
  /** Answerable questions: released with a citation and no reset. */
  answered: boolean;
  /** The start of the released text, so a failing run can be read without a rerun. */
  excerpt: string;
}

export interface ChatEvalQuestionResult {
  id: string;
  answerable: boolean;
  runs: ChatEvalRun[];
  /** Unanswerable only: every run refused. */
  refused: boolean;
  /** Answerable only: how many runs were answered. */
  answeredRuns: number;
}

export interface ChatEvalResult {
  passed: boolean;
  repeats: number;
  unanswerable: number;
  /** Unanswerable questions that every run refused. */
  refusedAll: number;
  /** Unanswerable runs refused by the router before retrieval (OUT_OF_SCOPE). */
  routeRefusalRuns: number;
  /** Unanswerable runs refused after retrieval, by the answer step (INSUFFICIENT_EVIDENCE). */
  answerRefusalRuns: number;
  minRefusedRate: number;
  answerable: number;
  /** Answerable runs answered with a citation. */
  answeredRuns: number;
  /** Every answerable run, across all answerable questions. */
  answerableRuns: number;
  minAnsweredRate: number;
  questions: ChatEvalQuestionResult[];
}

export interface ChatEvalOptions {
  evalSet: EvalSet;
  config: InstanceConfig;
  access: RetrievalAccess;
  version: ActiveIndexVersion;
  chatModel: ChatModel;
  models: { chat: string; router: string };
  embeddings: EmbeddingProvider;
  retrieval: RetrievalStore;
  signal: AbortSignal;
  repeats?: number;
  /** Share of unanswerable questions that must be refused on every run. Defaults to all. */
  minRefusedRate?: number;
  /** Share of answerable runs that must be answered with a citation. */
  minAnsweredRate?: number;
}

/**
 * End-to-end check of the chat turn (ADR 0009). Each question is sent through the full turn,
 * `repeats` times. Unanswerable questions must be refused on every run, with no citation and no
 * released text. Answerable questions must be answered with a citation on at least
 * `minAnsweredRate` of their runs, so a model that refuses everything cannot pass. The answer
 * step therefore has to run for the check to pass. The result depends on the chat model, so it is
 * not a CI check (ADR 0009).
 */
export async function runChatEval(options: ChatEvalOptions): Promise<ChatEvalResult> {
  const repeats = options.repeats ?? CHAT_EVAL_REPEATS;
  const minRefusedRate = options.minRefusedRate ?? 1;
  const minAnsweredRate = options.minAnsweredRate ?? CHAT_EVAL_MIN_ANSWERED_RATE;
  const unanswerable = options.evalSet.questions.filter((question) => !question.answerable);
  const answerable = options.evalSet.questions.filter((question) => question.answerable);
  const questions: ChatEvalQuestionResult[] = [];

  for (const question of options.evalSet.questions) {
    const runs: ChatEvalRun[] = [];
    for (let i = 0; i < repeats; i++) {
      const events: ChatEvent[] = [];
      const outcome = await runChat({
        config: options.config,
        access: options.access,
        requestId: `eval-${question.id}-${i}`,
        conversationId: `eval-${question.id}-${i}`,
        message: question.question,
        history: [],
        chatModel: options.chatModel,
        models: options.models,
        embeddings: options.embeddings,
        retrieval: options.retrieval,
        signal: options.signal,
        deadlineMs: CHAT_EVAL_DEADLINE_MS,
        version: options.version,
        emit: (event) => events.push(event),
      });
      const resets = events.filter((event) => event.event === 'reset').length;
      const citations = outcome.citationIds.length;
      runs.push({
        state: outcome.state,
        citations,
        resets,
        refused: REFUSAL_STATES.has(outcome.state) && citations === 0 && resets === 0,
        answered: outcome.state === 'ANSWERED' && citations > 0 && resets === 0,
        excerpt: outcome.text.slice(0, 200).replace(/\s+/g, ' '),
      });
    }
    questions.push({
      id: question.id,
      answerable: question.answerable,
      runs,
      refused: !question.answerable && runs.every((run) => run.refused),
      answeredRuns: runs.filter((run) => run.answered).length,
    });
  }

  const unanswerableQuestions = questions.filter((question) => !question.answerable);
  const answerableQuestions = questions.filter((question) => question.answerable);
  const refusedAll = unanswerableQuestions.filter((question) => question.refused).length;
  const unanswerableRuns = unanswerableQuestions.flatMap((question) => question.runs);
  const answerableRuns = answerableQuestions.flatMap((question) => question.runs);
  const answeredRuns = answerableQuestions.reduce(
    (sum, question) => sum + question.answeredRuns,
    0,
  );
  const refusedRate = unanswerable.length === 0 ? 0 : refusedAll / unanswerable.length;
  const answeredRate = answerableRuns.length === 0 ? 0 : answeredRuns / answerableRuns.length;
  return {
    passed:
      unanswerable.length > 0 &&
      answerable.length > 0 &&
      refusedRate >= minRefusedRate &&
      answeredRate >= minAnsweredRate,
    repeats,
    unanswerable: unanswerable.length,
    refusedAll,
    routeRefusalRuns: unanswerableRuns.filter((run) => run.state === 'OUT_OF_SCOPE').length,
    answerRefusalRuns: unanswerableRuns.filter((run) => run.state === 'INSUFFICIENT_EVIDENCE')
      .length,
    minRefusedRate,
    answerable: answerable.length,
    answeredRuns,
    answerableRuns: answerableRuns.length,
    minAnsweredRate,
    questions,
  };
}
