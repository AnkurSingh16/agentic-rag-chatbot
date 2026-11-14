import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  ChatbotError,
  DEFAULT_MIN_RECALL,
  OLLAMA_DEFAULT_BASE_URL,
  createChatModel,
  chatConfigFingerprint,
  createEmbeddingProvider,
  ollamaBaseUrl,
  parseEvalSet,
  resolveChatModels,
  runChatEval,
  runRetrievalEval,
} from '@agentic-rag/core';
import type {
  ActiveIndexVersion,
  ChatEvalResult,
  EvalSet,
  InstanceConfig,
  RetrievalStore,
} from '@agentic-rag/core';
import type { CliContext } from '../context.js';
import { checkInstanceId, loadInstance, requireEnv, withIngestStore } from '../context.js';
import { formatTable } from './versions.js';

/** Temperature and seed the chat harness pins, so repeated runs are comparable (ADR 0009). */
const CHAT_SAMPLING = { temperature: 0, seed: 1 } as const;

function parseMinRecall(value: string | undefined): number {
  if (value === undefined) return DEFAULT_MIN_RECALL;
  const parsed = Number(value);
  if (!/^\d*\.?\d+$/.test(value) || parsed <= 0 || parsed > 1) {
    throw new ChatbotError('invalid_input', '--min-recall must be above 0 and at most 1');
  }
  return parsed;
}

/** The digest Ollama reports for a pulled model, so an eval run names the exact weights. */
async function ollamaDigest(context: CliContext, baseUrl: string, model: string): Promise<string> {
  const response = await context.fetch(`${baseUrl}/api/tags`, {
    signal: context.signal,
    headers: {},
    redirect: 'manual',
  });
  const body = (await response.json()) as { models?: { name?: unknown; digest?: unknown }[] };
  const found = body.models?.find((entry) => entry.name === model);
  if (typeof found?.digest !== 'string') {
    throw new ChatbotError('invalid_config', `Ollama does not have the model "${model}"`);
  }
  return found.digest;
}

/**
 * The Ollama digest of the chat model, or 'none' with another provider. Activation computes the same
 * value, so a re-pulled model under the same tag invalidates the chat run (naysayer, ADR 0009).
 */
export async function chatDigest(context: CliContext, model: string): Promise<string> {
  if (context.env.LLM_PROVIDER !== 'ollama') return 'none';
  const baseUrl = ollamaBaseUrl(
    context.env.OLLAMA_BASE_URL ?? OLLAMA_DEFAULT_BASE_URL,
    context.env.OLLAMA_ALLOW_REMOTE === 'true',
  );
  return ollamaDigest(context, baseUrl, model);
}

interface ChatHarnessInput {
  context: CliContext;
  config: InstanceConfig;
  evalSet: EvalSet;
  version: ActiveIndexVersion;
  retrieval: RetrievalStore;
  signal: AbortSignal;
  id: string;
}

interface ChatHarnessRun {
  result: ChatEvalResult;
  model: string;
  modelDigest: string;
  configFingerprint: string;
}

/**
 * Runs the end-to-end refusal check with the local Ollama model only, so an eval never spends on a
 * hosted model (ADR 0008). Refuses other providers before any work starts.
 */
async function runChatHarness(input: ChatHarnessInput): Promise<ChatHarnessRun> {
  const { context, config, evalSet, version, retrieval, signal, id } = input;
  if (context.env.LLM_PROVIDER !== 'ollama') {
    throw new ChatbotError(
      'invalid_config',
      '--chat needs LLM_PROVIDER=ollama; the chat harness does not run on hosted models',
    );
  }
  const baseUrl = ollamaBaseUrl(
    context.env.OLLAMA_BASE_URL ?? OLLAMA_DEFAULT_BASE_URL,
    context.env.OLLAMA_ALLOW_REMOTE === 'true',
  );
  const chatModel = createChatModel(context.env, { ollamaSampling: CHAT_SAMPLING });
  const models = resolveChatModels(config, context.env);
  const modelDigest = await ollamaDigest(context, baseUrl, models.chat);
  const embeddings = createEmbeddingProvider(context.env, config);
  const result = await runChatEval({
    evalSet,
    config,
    access: { instanceId: id, tenantKey: '_', accessTags: ['public'] },
    version,
    chatModel,
    models,
    embeddings,
    retrieval,
    signal,
  });
  return {
    result,
    model: models.chat,
    modelDigest,
    configFingerprint: chatConfigFingerprint(config, models, { chatDigest: modelDigest }),
  };
}

/**
 * Scores one index version against the instance's eval set and records the result as eval runs,
 * which the activation gate reads. Retrieval always runs. With `chat`, the end-to-end refusal
 * check runs too and records its own run. Exits with 1 when a harness fails.
 */
export async function evalCommand(
  context: CliContext,
  positionals: readonly string[],
  options: { instancesDir: string; minRecall: string | undefined; chat?: boolean },
): Promise<void> {
  if (positionals.length < 1 || positionals.length > 2) {
    throw new ChatbotError(
      'invalid_input',
      'Usage: ragctl eval <id> [versionId] [--min-recall <0..1>] [--chat]',
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

  // Scoring runs as rag_runtime with the access a public visitor gets, so it reads the candidate
  // version through the same row-level policies as chat. Recording the runs stays on rag_ingest.
  if (instance.config.auth.mode !== 'public') {
    throw new ChatbotError(
      'invalid_config',
      `Instance "${id}" uses auth.mode "${instance.config.auth.mode}"; ragctl eval scores only public instances until per-role eval profiles exist`,
    );
  }
  const { versionId, result, chat } = await withIngestStore(context, async ({ store }) => {
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
    const runtime = context.openIngestStore(requireEnv(context, 'DATABASE_URL'));
    let evaluated: Awaited<ReturnType<typeof runRetrievalEval>>;
    let chatRun: ChatHarnessRun | undefined;
    try {
      evaluated = await runRetrievalEval({
        evalSet,
        access: { instanceId: id, tenantKey: '_', accessTags: ['public'] },
        versionId: version.id,
        embeddings,
        retrieval: runtime.retrieval,
        signal: context.signal,
        minRecall,
        minUnanswerableEmptyRate: instance.config.evaluation.minUnanswerableEmptyRate,
        // With --chat, the end-to-end refusal check decides unanswerable questions (ADR 0009).
        gateUnanswerable: options.chat !== true,
      });
      if (options.chat === true) {
        chatRun = await runChatHarness({
          context,
          config: instance.config,
          evalSet,
          version: {
            id: version.id,
            embeddingProvider: version.embeddingProvider,
            embeddingModel: version.embeddingModel,
          },
          retrieval: runtime.retrieval,
          signal: context.signal,
          id,
        });
      }
    } finally {
      await runtime.close();
    }
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
        unanswerableCriterion: options.chat === true ? 'diagnostic' : 'gate',
        questions: evaluated.questions.length,
      },
    });
    if (chatRun !== undefined) {
      await store.recordEvalRun(id, version.id, {
        embeddingProvider: embeddings.provider,
        embeddingModel: embeddings.model,
        passed: chatRun.result.passed,
        metrics: {
          harness: 'chat',
          model: chatRun.model,
          modelDigest: chatRun.modelDigest,
          configFingerprint: chatRun.configFingerprint,
          temperature: CHAT_SAMPLING.temperature,
          seed: CHAT_SAMPLING.seed,
          repeats: chatRun.result.repeats,
          unanswerable: chatRun.result.unanswerable,
          refusedAll: chatRun.result.refusedAll,
          routeRefusalRuns: chatRun.result.routeRefusalRuns,
          answerRefusalRuns: chatRun.result.answerRefusalRuns,
          minRefusedRate: chatRun.result.minRefusedRate,
          answerable: chatRun.result.answerable,
          answeredRuns: chatRun.result.answeredRuns,
          answerableRuns: chatRun.result.answerableRuns,
          minAnsweredRate: chatRun.result.minAnsweredRate,
        },
      });
    }
    return {
      versionId: version.id,
      result: evaluated,
      chat: chatRun,
    };
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
  let output = `${formatTable(rows)}

Version ${versionId}: recall@8 ${result.recallAt8.toFixed(2)} (minimum ${minRecall.toFixed(2)}), unanswerable questions with no retrieval ${result.unanswerableEmpty}/${result.unanswerable} (minimum rate ${result.minUnanswerableEmptyRate.toFixed(2)}${options.chat === true ? ', diagnostic: the chat check decides these' : ''}). Eval ${verdict}.
`;
  if (chat !== undefined) {
    const chatRows = [
      ['QUESTION', 'EXPECTED', 'RUNS', 'OK'],
      ...chat.result.questions.map((question) => [
        question.id,
        question.answerable ? 'answer' : 'nothing',
        question.runs.map((run) => run.state).join(', '),
        question.answerable
          ? `${question.answeredRuns}/${question.runs.length}`
          : question.refused
            ? 'yes'
            : 'no',
      ]),
    ];
    output += `
${formatTable(chatRows)}

Chat harness with ${chat.model} (digest ${chat.modelDigest.slice(0, 12)}, temperature ${CHAT_SAMPLING.temperature}, seed ${CHAT_SAMPLING.seed}, ${chat.result.repeats} runs each): ${chat.result.refusedAll}/${chat.result.unanswerable} unanswerable questions refused on every run (minimum rate ${chat.result.minRefusedRate.toFixed(2)}); router refusals ${chat.result.routeRefusalRuns}, answer refusals ${chat.result.answerRefusalRuns}; answerable questions answered with a citation on ${chat.result.answeredRuns}/${chat.result.answerableRuns} runs (minimum rate ${chat.result.minAnsweredRate.toFixed(2)}). Chat ${chat.result.passed ? 'passed' : 'failed'}.
`;
    for (const question of chat.result.questions) {
      for (const [index, run] of question.runs.entries()) {
        if (question.answerable && !run.answered) {
          output += `Not answered: ${question.id}, run ${index + 1} (${run.state}, ${run.citations} citations): ${run.excerpt}\n`;
        } else if (!question.answerable && !run.refused) {
          output += `Not refused: ${question.id}, run ${index + 1} (${run.state}, ${run.citations} citations): ${run.excerpt}\n`;
        }
      }
    }
  }
  context.stdout(output);
  const failed = !result.passed || (chat !== undefined && !chat.result.passed);
  if (failed) {
    throw new ChatbotError('invalid_input', `Eval failed for ${versionId}; it cannot be activated`);
  }
}
