# Lattice — Project Status

**One-line summary:** Free, open-source Obsidian plugin that compiles notes into a navigable semantic graph (typed nodes + typed edges, evidence-linked, schema-validated) using an LLM.

## Current phase: Phase 2 (tiny prototype → hardened, near release)

Phase 0 (philosophy) and Phase 1 (schema design) are complete and documented in `Docs/semantic_ir_schema_v1.md`. Phase 2 (prove the architecture on real documents) is functionally complete — the full pipeline works, has been extensively hardened against real-world model failures, and the Obsidian plugin runs live in a real vault. Functional correctness is established across short and medium documents, including relation extraction with the dual-client configuration.

A 141-segment stress test was completed on 2026-10-04 and is recorded in `Docs/stress_test_141.md`. It was run as a **benchmark, not a release gate** — it covers long-run batching, rate-limiter behavior, cross-batch relations, and quota handling under one specific API configuration (Groq free tier, 8000 TPM). Quota failures under that configuration reflect the test environment's limits, not plugin correctness. The document completed end to end with no failures: 141/141 segments classified, the invariant gate passed against source, and 0 rate-limit events across 32 calls.

## What's done

- Full pipeline: segmentation → batched node classification → rule-based + LLM relation extraction → schema-validated assembly, with an evidence-verification and taxonomy-enforcement layer at every stage
- Reliability layer: retry-on-429, retry-on-transient-validation-failure, a sliding-window rate limiter, and fail-fast detection for the daily token cap (distinct from per-minute)
- Obsidian plugin: settings UI, one command to compile the active note, confirmed working live in a real vault
- A major validation-integrity incident (eight unreviewed commits weakened core schema checks) was fully found and reversed — documented in `Docs/semantic_ir_schema_v1.md`
- A mid-project model migration (the original model was discontinued by the provider) was navigated, with new rate limits and token budgets re-calibrated from real data
- Packaging: README (accurate, discloses network/privacy behavior), LICENSE (MIT), CONTRIBUTING.md, manifest at v0.1.0
- Provider-agnostic configuration: base URL, API key, model, and client-side TPM throttle are all user-configurable — no provider-specific limits baked into the product
- A 16-rule structural invariant suite that runs during assembly against the source text, plus fixture coverage over every committed IR (`src/pipeline/invariants.ts`)
- A gold-standard label format and semantic eval harness (`src/eval`, `npm run gold:label`, `npm run eval`) — measures node macro/micro-F1, per-family edge P/R/F1, attribution accuracy, direction accuracy, and across-run stability
- 141-segment stress test completed as a documented benchmark (`Docs/stress_test_141.md`)

## What's blocking release right now

Nothing functional. The pipeline, plugin, and packaging are all proven, and the 141-segment benchmark is recorded. One operational item remains: execute the release steps (repo, tag, submit).

## What's left before "v0.1 ships"

1. Create the public GitHub repo, push, tag a `v0.1.0` release with `main.js` + `manifest.json`
2. Submit to the Obsidian Community Plugins directory (PR to `obsidianmd/obsidian-releases`)

Semantic accuracy is not a release blocker, but it is also not yet measured: `npm run eval` needs at least one human-reviewed gold file before any score means anything.

## Deliberately deferred, not blocking release

- The `extractRelations` cross-batch blind spot (a relation between nodes in different batches can be missed) — real, documented, still unmeasured: the 141-segment run exercised 15 batches but had no gold labels to measure against
- Causal-edge recall gap, hedged-confidence calibration — both real, minor, logged
- Phase 3 (multi-document processing, real hierarchy/clustering, an interactive exploration UI) — a substantial future expansion, not required for a working v0.1
