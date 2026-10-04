# 141-segment stress test — benchmark record

**Date:** 2026-10-04
**Document:** `test-documents/trimmed-diary.txt` (9,683 chars, 141 segments)
**Configuration:** Groq free tier, `https://api.groq.com/openai/v1`, model `openai/gpt-oss-20b`, client-side throttle 8000 TPM
**Harness:** `scripts/smoke-test.ts` (classify batch size 10, relation batch size 10)
**Duration:** 21 minutes (17:07:40 → 17:28:46)

This is a benchmark under one known API configuration, not a pass/fail gate. Quota or throttling outcomes here describe that environment, not plugin correctness.

## Result

The document completed end to end. No failures of any kind.

| Stage | Result |
|---|---|
| Segmentation | 141 segments |
| Classification | 141 nodes — **100% yield, none dropped** |
| Precedes derivation | 140 edges (complete chain, n−1) |
| Revision candidates | 0 |
| LLM relation extraction | 27 edges from 29 proposals (2 rejected by evidence verification) |
| Assembly | 141 nodes, 167 edges, invariant gate passed against source |
| Independent re-check of the emitted IR | 0 violations across all 16 invariant rules |
| Final directionality check | Direction correct |

**Calls:** 32 total — 15 classification, 15 relation extraction, 2 directionality check.
**Tokens:** 90,956 total.
**Rate-limit events:** 0 (no 429, no retries, no daily-cap trip).

### Node types

Event 40 · Claim 30 · Observation 29 · Memory 24 · Emotion 11 · Decision 6 · Value 1

### Edge relations

elaborates 11 · causes 8 · supports 3 · extends 2 · undercuts 1 · generalizes 1 · contradicts 1

## Findings

1. **Batching held across 15 batches of each kind.** Every segment classified, every batch returned, and the assembled IR passed byte-level source verification. This is the specific thing the benchmark was for.

2. **Evidence verification rejected 2 of 29 proposed edges (6.9%), both for the right reason.** The model quoted source text after normalizing apostrophes (`didn’t` for `didn't`) or truncating mid-sentence. Neither is verbatim, so neither was admitted. This is the "no fabricated evidence" guarantee working on real model output — previously exercised only on hand-written fixtures.

3. **No cross-batch relation measurement was possible.** The documented `extractRelations` cross-batch blind spot remains unmeasured: with no gold labels for this document, there is no way to know what was missed. See "Deliberately deferred" in `PROJECT_STATUS.md`.

4. **`revises` was not exercised on this document** — it contained 0 revision candidates. Revision direction is covered separately by the `smoke:direction` check, which passed.

## What this does not establish

No ground-truth labels exist for this document, so nothing here says the relations are *right* — only that the pipeline ran, obeyed its own invariants, and verified itself against the source. Semantic accuracy is what `npm run gold:label` → `npm run eval` measures, and it needs a human-reviewed gold file first.
