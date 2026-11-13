import type { EmbeddingProvider } from '../providers/types.js';
import { RETRIEVAL } from '../retrieval/types.js';
import type { RetrievalAccess, RetrievalStore } from '../retrieval/types.js';
import type { EvalSet } from './eval-set.js';

/** Recall@8 an index version needs to pass by default. */
export const DEFAULT_MIN_RECALL = 0.6;

export interface EvalQuestionResult {
  id: string;
  answerable: boolean;
  /** Share of expected sources found in the top 8; undefined for questions without sources. */
  recall: number | undefined;
  retrievedSources: string[];
  /** Answerable: every expected source was found. Unanswerable: nothing passed the threshold. */
  ok: boolean;
}

export interface RetrievalEvalResult {
  passed: boolean;
  minRecall: number;
  recallAt8: number;
  /** Unanswerable questions for which retrieval correctly returned nothing. */
  unanswerableEmpty: number;
  unanswerable: number;
  /** The share of unanswerable questions that must retrieve nothing for the eval to pass. */
  minUnanswerableEmptyRate: number;
  questions: EvalQuestionResult[];
}

export interface RetrievalEvalOptions {
  evalSet: EvalSet;
  access: RetrievalAccess;
  versionId: string;
  embeddings: EmbeddingProvider;
  retrieval: RetrievalStore;
  signal: AbortSignal;
  minRecall?: number;
  /** See `evaluation.minUnanswerableEmptyRate` in instance.yaml. Defaults to requiring all. */
  minUnanswerableEmptyRate?: number;
  /**
   * When false, the unanswerable check is reported but does not decide the verdict. Used with the
   * chat refusal check, which judges the same questions end to end (ADR 0009). Defaults to true.
   */
  gateUnanswerable?: boolean;
}

/**
 * Retrieval-only evaluation of one index version. Answerable questions with sources score
 * recall@8 over source URIs; the version passes when the mean reaches `minRecall` and at least
 * `minUnanswerableEmptyRate` of the unanswerable questions retrieve nothing. Retrieval returns
 * only chunks at or above the minimum fused score (ADR 0006), so anything retrieved for an
 * unanswerable question is above that threshold.
 */
export async function runRetrievalEval(
  options: RetrievalEvalOptions,
): Promise<RetrievalEvalResult> {
  const { evalSet, access, versionId, embeddings, retrieval, signal } = options;
  const minRecall = options.minRecall ?? DEFAULT_MIN_RECALL;
  const minUnanswerableEmptyRate = options.minUnanswerableEmptyRate ?? 1;
  const gateUnanswerable = options.gateUnanswerable ?? true;
  const questions = evalSet.questions;
  const vectors = await embeddings.embed(
    questions.map((question) => question.question),
    signal,
  );
  const lists = await retrieval.search(
    access,
    versionId,
    questions.map((question, i) => ({
      text: question.question,
      embedding: vectors[i] ?? [],
      limit: RETRIEVAL.limit,
    })),
  );

  const results = questions.map((question, i): EvalQuestionResult => {
    const retrievedSources = [...new Set((lists[i] ?? []).map((chunk) => chunk.sourceUri))];
    if (!question.answerable) {
      return {
        id: question.id,
        answerable: false,
        recall: undefined,
        retrievedSources,
        ok: retrievedSources.length === 0,
      };
    }
    if (question.sources.length === 0) {
      return { id: question.id, answerable: true, recall: undefined, retrievedSources, ok: true };
    }
    const found = question.sources.filter((source) => retrievedSources.includes(source)).length;
    const recall = found / question.sources.length;
    return { id: question.id, answerable: true, recall, retrievedSources, ok: recall === 1 };
  });

  const scored = results.flatMap((result) => (result.recall === undefined ? [] : [result.recall]));
  const recallAt8 =
    scored.length === 0 ? 0 : scored.reduce((sum, value) => sum + value, 0) / scored.length;
  const unanswerable = results.filter((result) => !result.answerable);
  const unanswerableEmpty = unanswerable.filter((result) => result.ok).length;
  const unanswerableRate = unanswerable.length === 0 ? 1 : unanswerableEmpty / unanswerable.length;
  return {
    passed:
      scored.length > 0 &&
      recallAt8 >= minRecall &&
      (!gateUnanswerable || unanswerableRate >= minUnanswerableEmptyRate),
    minRecall,
    recallAt8,
    unanswerableEmpty,
    unanswerable: unanswerable.length,
    minUnanswerableEmptyRate,
    questions: results,
  };
}
