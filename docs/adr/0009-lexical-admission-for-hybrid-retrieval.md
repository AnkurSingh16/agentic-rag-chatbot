# ADR 0009: Lexical admission for hybrid retrieval

## Status

Accepted by the owner for implementation on `feat/portfolio-instance`. Not merged. The pull request is blocked on the config-binding gap in the naysayer review (see Naysayer review of the branch below). The coverage admission rule was rejected by measurement. This ADR records the debate, the naysayer's reviews, the measurements and the decision.

## Context

Hybrid retrieval (ADR 0006) fuses a full-text search and a vector search with Reciprocal Rank Fusion. The full-text query uses `websearch_to_tsquery`, which requires every term to match. A chunk found by only one search scores at most 1 / (60 + 1) = 0.01639, and `RETRIEVAL.minFusedScore` (0.0165) keeps only chunks found by both searches (ADR 0006 amendment). This was calibrated on the demo eval set.

The portfolio instance exposed the cost of that rule:

- For "Do you offer fractional engineering leadership?", the query becomes `'offer' & 'fraction' & 'engin' & 'leadership'`. No chunk contains "offer", so full-text returns nothing and the answerable chunk is dropped.
- The portfolio eval gave recall@8 of 0.07 against a minimum of 0.60, measured on the local database. Unanswerable questions retrieved nothing (8 of 8).
- The demo passes its gate at 0.70 recall while losing three answerable questions, which are vector-only matches (ADR 0006 amendment, calibration table).

## Options debated

Two architect proposals were drafted, critiqued once each, and merged. The merged design was reviewed by the naysayer.

1. **Lexical coverage admission.** Build an OR query from the question's lexemes in SQL. Count, per question, how many informative terms each chunk matches. Admit a vector candidate whose coverage is at least 0.5. Informative terms are those present in at least one visible chunk and in fewer than 30% of them. Counts are taken at query time under row-level security, so eval and production read the same data.
2. **Stored per-version term counts.** Rejected: a global table leaks vocabulary across tenants, and it goes stale on incremental training and retention.
3. **Fixed minimum of two matched terms.** Rejected: it drops single-concept questions such as "Where is Ankur based?".
4. **Lowering the fusion floor or the unanswerable gate.** Rejected: the first re-admits vector-only unanswerable questions at 0.0164, and the second weakens the gate.
5. **Reranker or a different embedding model.** Deferred: the vector bands overlap for both groups with the current model, and ADR 0008 fixes the dimensions.

## Naysayer findings (merged design, round 1)

The naysayer's verdict was not ready, with two blockers:

- **Blocker 1: the coverage path as written admits nothing new.** The SQL filter `WHERE f.score >= $8` still applies to every chunk. A vector-only coverage match scores at most 0.01639, so it is dropped. The keep rule must change in SQL, for example with a separate admission step or a third fusion list, and that needs its own test.
- **Blocker 2: unanswerable questions are at risk, and nothing measures it.** Counts from the demo database show that a single chunk containing one informative term gives coverage of 0.5 or 1.0 for "Is Ankur available for hire right now?", "Is Ankur looking for a new job?", "Is he open to new full-time roles?" and "Is Ankur currently employed?". The vector cap of 0.8 does not separate these. The nearest demo unanswerable question is at cosine distance 0.263 and another at 0.368, both inside the cap.
- **Major: division by zero.** Three off-topic questions have no informative terms, so the coverage division must be guarded (for example with `NULLIF`).
- **Major: eval parity.** The eval runs under the ingest role, which sees every tenant's chunks. Production sees only visible chunks. Eval and production can disagree for a narrow-tag context on rbac instances. The design does not say which context eval uses.
- **Major: query escaping.** The design quotes lexemes with `quote_literal` and joins them into a `to_tsquery` string. A lexeme with a backslash or quote can raise a syntax error, which would surface as a 500. Passing lexemes as a `text[]` bind parameter avoids tsquery parsing entirely.
- **Major: the acceptance numbers do not measure the change.** The demo gate already passes at HEAD, and the sweep was chosen on the same questions used to accept it. The 0.07 portfolio baseline is recorded only in this ADR, not in a committed eval run.
- **Minor:** the 30% cut is unstable on small corpora (on the demo, a term at 7 of 25 chunks passes and at 8 fails). The query-time count adds a visible-chunk count per query. Source pages are live, so recall can change without a code change. Forbidden-topic refusal is enforced by the answer model, which this retrieval-only eval does not run.

**Corrections to earlier statements in this debate.** The instance-config note asking for at least 10 unanswerable questions (line 233) is the author's own note about the demo set, not a requirement. Routed-rewrite scoring (the eval runs only the raw question) is not implemented.

## Decision

The coverage admission rule is rejected. Measurement shows it cannot pass the answerable and unanswerable gates together on the portfolio, held-out or demo sets, at any coverage or cut value tested.

### Owner decision (recorded 2026-11-13)

The owner chose the two-stage design in the Recommendation below, built as follows:

- Vector admission within `maxVectorDistance` (round 7), with the fused floor kept as the ordering rule.
- The refusal check runs end to end through the chat turn (`ragctl eval --chat`, rounds 5 and 7). The retrieval unanswerable count is diagnostic under `--chat`.
- The judge is opt-in (`verification.judge`, round 6). The portfolio instance turns it on.
- Judge decision (owner, 2026-11-13: "Keep judge on"): the portfolio keeps `verification.judge: true`. Measured cost: with the router change, answerable runs answered fell from 32 of 42 (judge off) to 31 of 42 on the chat gate with the judge on, under the 0.8 minimum. The portfolio does not pass the chat gate and is not activated. The judge is kept for the employment leak it stops (round 5).
- The naysayer's answerable-question requirement (below) was added before the PR.

The owner's instructions in chat were "Sure, let's go ahead and do it" (the contact referral), "Build it next" (vector admission), "Build the gate", "Add a judge" and "Yes, make it diagnostic".

Not chosen: the embedding-model comparison and the content change (options 1 and 3 above, which were only partly tested). Option 2 (keeping milestone 2 blocked) was not chosen, and it is the fallback if the config-binding gap cannot be closed.

Process gap, stated plainly: the architect debate covered the coverage rule and the two-stage recommendation. The vector admission, the judge and the chat gate as built have not had an architect round. This ADR's naysayer reviews are their only review.

Earlier open options, for reference:

1. Measure a second local embedding model with 384 dimensions (ADR 0008 allows this), using the same tuning, held-out and demo sets. Calibrate the vector cap from measured distances.
2. Accept that the portfolio cannot pass with the current retrieval rule, and keep milestone 2 blocked.
3. Narrow the portfolio's sources or wording so that the answerable questions share vocabulary with the documents. This is a content change and would be a weaker proof of retrieval.

## Naysayer review of the branch

The first review of the branch returned NO with three blockers:

- **B1, the chat gate could pass without the answer step running.** Fixed: `runChatEval` now also runs the answerable questions. Each answerable run must be released with a citation and no reset. Passing needs at least `CHAT_EVAL_MIN_ANSWERED_RATE` (0.8) of those runs, and the rate is recorded. Tests cover a model that refuses everything and a model that returns empty answers. Both fail.
- **B2, the chat run is not bound to the config it tested.** Fixed. Each chat eval run records a fingerprint of the persona, forbidden topics, verification judge, limits and model names (`chatConfigFingerprint`). `ragctl activate` computes the current fingerprint from the instance folder, and migration 0010 refuses a non-forced activation whose latest chat run carries a different one. Tests cover the in-memory store, the SQL function (a changed configuration is refused), and the CLI (a changed judge setting is refused). A version whose chat run predates this change must have its chat eval run again before it can be activated.
- **B3, this record did not say what was decided.** Fixed by the section above.

Major documentation findings, fixed in `docs/reference/cli.md`, `docs/reference/instance-config.md` and `activate.ts`: the activation gate needs both the latest retrieval run and the latest chat run, and the judge's calls sit outside the three-model-call budget (see ADR 0005).

### Recommendation

Change the approach from retrieval-only gating to a two-stage design, and decide it as an ADR amendment before any code:

1. Retrieval admits vector candidates whose cosine distance is within `maxVectorDistance`, without requiring a full-text match. This restores recall for questions that share no words with a document. The fused floor stays as the ordering rule.
2. The unanswerable gate moves to the answer stage. An unanswerable question passes when the answer step returns the fallback, not when retrieval is empty. Measure this end to end with the local Ollama model, on the tuning and held-out sets and the demo set, with the refusal rate recorded per question.
3. The retrieval-only metric stays in the eval output as a diagnostic, but it no longer decides pass or fail for unanswerable questions.

Trade-offs: the gate becomes model-dependent and not deterministic, so it cannot run in CI (CI stays mock-only). Off-topic questions reach the model, which costs tokens in production. The change affects every instance, including the demo, so the demo must be re-measured. The safety property rests on the answer stage and the guards in ADR 0005, which are tested less than retrieval.

This changes a safety gate, so the decision belongs to the owner. It needs the architect debate and naysayer review that CLAUDE.md requires before any code.

Eval parity for rbac (the ingest role sees every tenant's chunks) is still open and must be fixed before any rbac instance is evaluated.

## Measurement (round 2)

The held-out set is `instances/portfolio/evals-heldout.yaml`: 14 unanswerable questions written before any tuning, including employment, salary and off-topic questions. It was measured once and is no longer held out.

I added the candidate rule behind a temporary switch, ran the real `ragctl eval` path, and reverted the code afterwards. The candidate keeps the fused floor, and also admits a vector candidate (distance <= 0.8) whose share of informative terms reaches the coverage threshold. Informative terms are those present in some chunk and in fewer than the cut share of chunks.

| Set                                              | Rule                   | Recall@8       | Unanswerable with no retrieval |
| ------------------------------------------------ | ---------------------- | -------------- | ------------------------------ |
| Portfolio tuning (14 answerable, 8 unanswerable) | HEAD                   | 0.07           | 8 of 8                         |
| Portfolio tuning                                 | coverage 0.5, cut 0.3  | 1.00           | 4 of 8                         |
| Portfolio tuning                                 | coverage 0.5, cut 0.2  | 0.86           | 4 of 8                         |
| Portfolio tuning                                 | coverage 0.5, cut 0.4  | 1.00           | 4 of 8                         |
| Portfolio tuning                                 | coverage 0.75, cut 0.3 | 0.29           | 5 of 8                         |
| Portfolio tuning                                 | coverage 1.00, cut 0.3 | 0.29           | 5 of 8                         |
| Held-out (14 unanswerable)                       | HEAD                   | not applicable | 14 of 14                       |
| Held-out                                         | coverage 0.5, cut 0.3  | not applicable | 3 of 14                        |
| Held-out                                         | coverage 0.75, cut 0.3 | not applicable | 9 of 14                        |
| Held-out                                         | coverage 1.00, cut 0.3 | not applicable | 9 of 14                        |
| Demo (10 answerable, 2 unanswerable)             | HEAD                   | 0.70           | 2 of 2 (passes)                |
| Demo                                             | coverage 0.5, cut 0.3  | 1.00           | 1 of 2 (fails)                 |

"Not applicable" means the held-out file has no answerable questions, so `ragctl eval` reports recall 0.00 by construction; only the unanswerable column is meaningful for that set.

Findings:

- The informative-term sets are tiny (one or two terms per question), so coverage is close to all or nothing. Thresholds between 0.5 and 1.0 do not separate the unanswerable questions, and the employment and salary questions are admitted at every threshold tested.
- Coverage 0.5 recovers the portfolio's answerable questions, but it admits unanswerable questions on both the tuning set and the held-out set, and it breaks the demo gate.
- A higher threshold removes the recall gain. Recall falls back to 0.29 on the portfolio, and the unanswerable failures remain.
- The cut value moves recall only (0.86 at 0.2, 1.00 at 0.3 and 0.4), not the unanswerable result.

The candidate is rejected. Neither the coverage rule nor the cut found a setting that passes both the answerable and unanswerable gates. The naysayer's blocker 2 is confirmed by measurement, and blocker 1 is moot because the candidate is not being built.

### Second embedding model (round 3)

I tested `Xenova/all-MiniLM-L12-v2`, which has 384 dimensions and the same mean pooling that the local provider uses (ADR 0008). I trained scratch copies of the portfolio, held-out and demo instances with it, then ran the unchanged HEAD retrieval rule through `ragctl eval`.

| Set              | Model                   | Recall@8       | Unanswerable with no retrieval |
| ---------------- | ----------------------- | -------------- | ------------------------------ |
| Portfolio tuning | all-MiniLM-L6-v2 (HEAD) | 0.07           | 8 of 8                         |
| Portfolio tuning | all-MiniLM-L12-v2       | 0.07           | 8 of 8                         |
| Held-out         | all-MiniLM-L6-v2 (HEAD) | not applicable | 14 of 14                       |
| Held-out         | all-MiniLM-L12-v2       | not applicable | 14 of 14                       |
| Demo             | all-MiniLM-L6-v2 (HEAD) | 0.70 (passes)  | 2 of 2                         |
| Demo             | all-MiniLM-L12-v2       | 0.70 (passes)  | 2 of 2                         |

The numbers are identical on all three sets. The model change alone does not recover the portfolio. The cause is the fused floor and the all-words full-text match, which drop vector-only chunks whatever the vectors are. A better model would only help if the admission rule also changed.

I did not test a CLS-pooled model such as `bge-small-en-v1.5`. The local provider fixes mean pooling (`packages/core/src/providers/local-embeddings.ts`), so such a model would need a provider change first. I also did not measure vector distances under the L12 model, which would show whether the candidates separate once the rule changes.

Scratch instances `portfolio-l12`, `portfolio-l12-heldout` and `demo-l12` now exist in the local database. Their versions are not active.

Not measured: the 30 percent cut on a larger corpus, routed-rewrite queries, eval parity under rbac tags (the public-mode measurement does not exercise it), and a second embedding model. A second model with 384 dimensions, which ADR 0008 allows, is the next option to measure if the portfolio must pass.

## Dissent

The pragmatist's position is that a coverage path with a vector check is the smallest change that can recover the portfolio. The scale position is that the change must not add any path that admits chunks without a per-caller access check or a measured unanswerable result. The naysayer's position is that the design cannot pass its own acceptance numbers. The decision above follows the naysayer's blockers, because neither architect's measurement exists yet.

## Build progress (round 4)

- Done: `ragctl eval` scores public instances as `rag_runtime` (`DATABASE_URL`). Demo and portfolio results did not change.
- Done: lexical-overlap check in `verify` (ADR 0005 amendment). The demo answers are unchanged with the check on and off.
- Built and measured, then reverted from the tree: vector-only admission (`OR f.id IN (SELECT id FROM vec)`, within `maxVectorDistance` 0.8). The patch is kept outside the repo. Results:

| Set              | Recall@8        | Unanswerable with no retrieval | Notes                               |
| ---------------- | --------------- | ------------------------------ | ----------------------------------- |
| Portfolio tuning | 1.00 (was 0.07) | 3 of 8                         | 14 of 14 answerable questions found |
| Held-out         | not applicable  | 2 of 14                        | was 14 of 14                        |
| Demo             | 1.00 (was 0.70) | 0 of 2                         | retrieval-only gate fails           |

- End to end on the demo (one run per question, qwen2.5:7b, the vector-admission build): all 9 answerable questions are ANSWERED with citations and no verification resets (before: 3 of 9). Both unanswerable questions end with a refusal (`INSUFFICIENT_EVIDENCE` and `OUT_OF_SCOPE`), even though retrieval now returns up to seven chunks for them. This is one run per question, not the repeated runs the gate needs, and the portfolio cannot run end to end yet because `runChat` reads only the active version.
- Blocker for shipping: the retrieval-only gate in `ragctl eval` now fails on the demo, which passes today. The end-to-end gate has to exist before this change is committed. The integration test `passes the demo eval set` fails for the same reason, and the test that pins a vector-only paraphrase as dropped (`drops a paraphrase that only the vector search finds`) encodes the rule that this change reverses.

### Round 5: the refusal gate (built)

What is built:

- `runChat` takes an eval-only `version` option. Chat never sets it; the retrieval search still applies row-level security.
- `runChatEval` (`packages/core/src/eval/run-chat-eval.ts`) runs each unanswerable question three times through the full turn. A question passes only when every run ends in `OUT_OF_SCOPE` or `INSUFFICIENT_EVIDENCE`, with no citation and no reset. Router refusals and answer refusals are counted separately.
- Ollama sampling is pinned for the eval: temperature 0 and seed 1. Production keeps temperature 0.2 and no seed.
- `ragctl eval <id> [version] --chat` runs the retrieval harness and the chat harness, and records each as its own run with the Ollama model digest. It refuses any provider except Ollama, so an eval never spends on a hosted model.
- Migration 0009 changes the activation gate: the latest retrieval run and the latest chat run must both pass, each with the version's embedding provider and model. A chat run cannot unlock activation alone, and the retrieval run cannot stand in for the refusal check.

Measured, with the vector-admission patch applied temporarily (reverted afterwards), qwen2.5:7b, digest `845dbda0ea48`:

| Set                                 | Unanswerable refused on every run | Runs | Notes               |
| ----------------------------------- | --------------------------------- | ---- | ------------------- |
| Demo (HEAD retrieval)               | 2 of 2                            | 6    | Chat harness passes |
| Portfolio tuning (vector admission) | 7 of 8                            | 24   | Fails               |
| Held-out (vector admission)         | 14 of 14                          | 42   | Passes              |

The portfolio failure is `employment-available`, runs 1 and 3. The model answered: "Ankur is available for hire for fractional leadership and software delivery for small businesses, as well as mentoring and interview preparation for engineers." It cited a services chunk. The lexical-overlap check passed, because the words come from that chunk, and the forbidden-topic check missed it, because the paragraph does not contain the listed phrase. So the overlap check does not catch a claim that is inferred from the source, and this is a real answer about employment status that the instance forbids.

Observations:

- The held-out set was also used in the retrieval measurement above, so it no longer tests anything fresh.
- The router is not fully deterministic at temperature 0 with a fixed seed. On the demo, `company-headquarters` was `OUT_OF_SCOPE` in one run and `INSUFFICIENT_EVIDENCE` in another.
- The in-memory store in `packages/core/test/memory-store.ts` does not enforce the two-harness rule. Only the PostgreSQL gate does.

Decision still open: the vector-admission change is not in the tree. The portfolio cannot pass the chat gate with it, and the demo's retrieval gate fails with it. Options, for the owner to choose:

1. Keep vector admission out. The portfolio stays blocked.
2. Add a model-based judge for employment and availability claims (deferred in ADR 0005), and measure it on the same sets.
3. Reword the portfolio's services text so it does not imply availability. This is a website content decision.

## Consequences

- The portfolio instance stays uncommitted on `feat/portfolio-instance`. Its eval fails, so it cannot be activated.
- The demo keeps its documented limitation (three vector-only losses, ADR 0006 amendment).
- Milestone 2 waits on the measurement steps above.

### Round 6: the judge (built, measured)

`verification.judge` is an opt-in check on each answer paragraph (ADR 0005). Measured with qwen2.5:7b (judge calls at temperature 0):

- Portfolio, tuning set with vector admission (applied temporarily, reverted): the chat harness refuses 8 of 8 unanswerable questions on every run, up from 7 of 8. The `employment-available` leak is fixed. The retrieval harness still fails, because its unanswerable criterion is strict.
- Portfolio, held-out with vector admission: 14 of 14 refused on every run.
- Portfolio, answerable questions with vector admission, one run each: judge off gives 8 cited answers, judge on gives 8. The judge dropped `career-tpg` and kept `services-identity`.
- Demo, answerable questions with HEAD retrieval, one run each: judge off gives 4 cited answers, judge on gives 3. The judge dropped `sidebar-shortcut`.

So the judge closes the failure it was built for, at the cost of some false rejections. The sets are small, and each answer was sampled once. The retrieval harness still blocks the portfolio, because vector admission can't pass its strict unanswerable criterion. Making that criterion diagnostic whenever the chat harness is present is the next decision.

### Round 7: the decision (built, measured, not committed)

- `ragctl eval --chat` makes the retrieval harness's unanswerable check diagnostic. The chat refusal check decides those questions. Without `--chat`, the strict retrieval gate is unchanged. The activation gate still needs a passing chat run either way (migration 0009).
- Vector-only candidates within `maxVectorDistance` are admitted (the round 5 patch, now applied in the tree). The fused floor still orders results.
- Measured with qwen2.5:7b, three runs per unanswerable question, judge on for the portfolio:
  - Demo `eval --chat`: retrieval recall 1.00 (was 0.70). Both unanswerable questions refused on every run. Passes.
  - Portfolio `eval --chat`: retrieval recall 1.00 (was 0.07). Eight of eight unanswerable questions refused on every run. Passes.
  - Both versions now have passing retrieval and chat runs, so the activation gate would accept them. I did not activate either.
- Integration tests: the paraphrase test now asserts admission, and the demo eval test passes `gateUnanswerable: false`. `isolation.test.ts` > "finds the nearest chunk through the HNSW index" is still flaky. It failed in 3 of 6 full integration runs, including runs on a freshly emptied test database, so leftover data is not the cause. Measured on the test database, the runtime role gets no row from the HNSW index for a chunk that a sequential scan finds at distance 0, even with `hnsw.iterative_scan` on and a larger `ef_search`. The admin role gets the row with iterative scan on. So the row-level policy and the approximate index interact. This is a retrieval recall risk for small instances in a shared table, and it is not fixed. The test is not weakened, and it blocks the PR until the cause is found.

Done after the decision: the calibration section in `docs/reference/instance-config.md`, the `minFusedScore` notes in `docs/architecture/data-model.md`, the ADR 0006 amendment and the comments in `retrieval/types.ts` and `retrieval-store.ts` now describe vector admission. The judge's false rejections are measured only in single runs. Nothing is committed.
