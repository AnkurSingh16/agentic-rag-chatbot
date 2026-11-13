# ADR 0006: Retrieval and embeddings

## Status

Accepted. The embedding providers and the 1024 dimension are superseded by [ADR 0008](0008-model-access-and-cost-controls.md); the rest stands.

## Context

Corpora are small (tens to thousands of documents per instance) and mostly prose: help pages, service descriptions, articles. Keyword queries (product names, error codes) and paraphrased questions both need to work. Retrieval must respect RLS filters (ADR 0003) without losing recall.

## Options considered

- **Vector only**, **full-text only**, or **hybrid**. Vector search misses exact identifiers; full-text misses paraphrases. Hybrid costs one extra index scan.
- **HNSW** or **IVFFlat**. IVFFlat needs representative data before building and degrades as data is added per version. HNSW has no training step and works on growing tables.
- **One embedding dimension** or **mixed dimensions per instance**. Mixed dimensions need an untyped column plus partial indexes per dimension, doubling index tests for no current consumer.

## Decision

**Hybrid search in one SQL statement.** Two CTEs: full-text (`websearch_to_tsquery`, ranked by `ts_rank_cd`) top 40, and vector cosine top 40. Merge with Reciprocal Rank Fusion (k = 60), take the top 8, pass them through the reranker interface (no-op by default). Below a minimum fused score the turn returns `INSUFFICIENT_EVIDENCE` without calling the answer model.

**Index.** HNSW with `vector_cosine_ops`, `m = 16`, `ef_construction = 64`. Each retrieval transaction sets `hnsw.iterative_scan = relaxed_order` and `hnsw.ef_search = 100`, so RLS filtering after the index scan does not starve results.

**Chunking.** Split on headings first, then by size: about 450 tokens per chunk (estimated as characters ÷ 4), 60 tokens of overlap, minimum 50, maximum 800. The heading path is prepended to each chunk's text and stored separately for display.

**Embeddings.** One platform-wide dimension of 1024 in v1:

| Provider | Model                      | Notes                         |
| -------- | -------------------------- | ----------------------------- |
| `voyage` | `voyage-3.5` at 1024 dims  | default cloud provider        |
| `ollama` | `mxbai-embed-large`        | local, 1024 natively          |
| `fake`   | deterministic hash vectors | tests and offline development |

Boot and the per-request version check (ADR 0002) fail on any dimension or model mismatch. Moving to mixed dimensions later is one migration.

## Consequences

- CI compares HNSW results with an exact scan for a narrow-tag user and fails if recall@8 drops below 0.95 on the eval corpus.
- `nomic-embed-text` (768 dims) is not supported until mixed dimensions are.
- Retrieval quality is measured per instance with recall@k, MRR, citation validity and correct refusals (phase 3).

## Dissent

Architect B preferred an untyped `vector` column with partial `halfvec` HNSW indexes per dimension from the start, allowing 768- and 1024-dimension providers side by side and halving index memory. Deferred: no current consumer needs it, and the migration is straightforward when one does.

## Amendment: minimum fused score, then vector admission

I raised the minimum fused score from 0.0125 to 0.0165. A chunk found by full-text search alone scores at most 1 / 61, so the floor drops it. The floor also dropped vector-only matches, which left answerable questions with no retrieval. [ADR 0009](0009-lexical-admission-for-hybrid-retrieval.md) admits vector candidates within `maxVectorDistance` (cosine distance 0.8) whatever their fused score. The fused score still orders the chunks. The measurements and their limits are in the [instance.yaml reference](../reference/instance-config.md#calibration-of-the-retrieval-threshold). The fusion itself and the candidate counts are unchanged.
