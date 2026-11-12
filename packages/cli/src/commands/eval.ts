import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  ChatbotError,
  DEFAULT_MIN_RECALL,
  createEmbeddingProvider,
  parseEvalSet,
  runRetrievalEval,
} from '@agentic-rag/core';
import type { CliContext } from '../context.js';
import { checkInstanceId, loadInstance, withIngestStore } from '../context.js';
import { formatTable } from './versions.js';

function parseMinRecall(value: string | undefined): number {
  if (value === undefined) return DEFAULT_MIN_RECALL;
  const parsed = Number(value);
  if (!/^\d*\.?\d+$/.test(value) || parsed > 1) {
    throw new ChatbotError('invalid_input', '--min-recall must be a number from 0 to 1');
  }
  return parsed;
}

/**
 * Scores retrieval for one index version against the instance's eval set and records the result
 * as an eval run, which the activation gate reads. Exits with 1 when the version fails.
 */
export async function evalCommand(
  context: CliContext,
  positionals: readonly string[],
  options: { instancesDir: string; minRecall: string | undefined },
): Promise<void> {
  if (positionals.length < 1 || positionals.length > 2) {
    throw new ChatbotError(
      'invalid_input',
      'Usage: ragctl eval <id> [versionId] [--min-recall <0..1>]',
    );
  }
  const id = checkInstanceId(positionals[0]);
  const minRecall = parseMinRecall(options.minRecall);
  const instance = await loadInstance(context, options.instancesDir, id);
  const { evalSet: evalPath } = instance.config;
  if (evalPath === undefined) {
    throw new ChatbotError('invalid_config', `Instance "${id}" has no evalSet in instance.yaml`);
  }
  const evalSet = parseEvalSet(await readFile(resolve(instance.directory, evalPath), 'utf8'));
  const embeddings = createEmbeddingProvider(context.env, instance.config);

  const { versionId, result } = await withIngestStore(context, async ({ store, retrieval }) => {
    const versions = await store.listVersions(id);
    const version =
      positionals[1] === undefined
        ? versions.find((candidate) => candidate.status !== 'building')
        : versions.find((candidate) => candidate.id === positionals[1]);
    if (version === undefined) {
      throw new ChatbotError(
        'not_found',
        positionals[1] === undefined
          ? `Instance "${id}" has no trained version; run "ragctl train ${id}"`
          : `Index version ${positionals[1]} does not exist for "${id}"`,
      );
    }
    if (
      version.embeddingProvider !== embeddings.provider ||
      version.embeddingModel !== embeddings.model
    ) {
      throw new ChatbotError(
        'invalid_config',
        `Version ${version.id} was built with ${version.embeddingProvider}/${version.embeddingModel} ` +
          `but EMBEDDING_PROVIDER selects ${embeddings.provider}/${embeddings.model}`,
      );
    }
    const evaluated = await runRetrievalEval({
      evalSet,
      // rag_ingest reads every chunk of its instance, so tags do not narrow the eval.
      access: { instanceId: id, tenantKey: '_', accessTags: ['public'] },
      versionId: version.id,
      embeddings,
      retrieval,
      signal: context.signal,
      minRecall,
      minUnanswerableEmptyRate: instance.config.evaluation.minUnanswerableEmptyRate,
    });
    await store.recordEvalRun(id, version.id, {
      embeddingProvider: embeddings.provider,
      embeddingModel: embeddings.model,
      passed: evaluated.passed,
      metrics: {
        harness: 'retrieval',
        recallAt8: evaluated.recallAt8,
        minRecall,
        unanswerableEmpty: evaluated.unanswerableEmpty,
        unanswerable: evaluated.unanswerable,
        minUnanswerableEmptyRate: evaluated.minUnanswerableEmptyRate,
        questions: evaluated.questions.length,
      },
    });
    return { versionId: version.id, result: evaluated };
  });

  const rows = [
    ['QUESTION', 'EXPECTED', 'RECALL', 'OK', 'RETRIEVED'],
    ...result.questions.map((question) => [
      question.id,
      question.answerable ? 'answer' : 'nothing',
      question.recall === undefined ? '-' : question.recall.toFixed(2),
      question.ok ? 'yes' : 'no',
      question.retrievedSources.join(', ') || '-',
    ]),
  ];
  const verdict = result.passed ? 'passed' : 'failed';
  context.stdout(`${formatTable(rows)}

Version ${versionId}: recall@8 ${result.recallAt8.toFixed(2)} (minimum ${minRecall.toFixed(2)}), unanswerable questions with no retrieval ${result.unanswerableEmpty}/${result.unanswerable} (minimum rate ${result.minUnanswerableEmptyRate.toFixed(2)}). Eval ${verdict}.
`);
  if (!result.passed) {
    throw new ChatbotError('invalid_input', `Eval failed for ${versionId}; it cannot be activated`);
  }
}
