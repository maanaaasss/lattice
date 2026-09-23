# Lattice — Project Status

**One-line summary:** Free, open-source Obsidian plugin that compiles notes into a navigable semantic graph (typed nodes + typed edges, evidence-linked, schema-validated) using an LLM.

## Current phase: Phase 2 (tiny prototype → hardened, near release)

Phase 0 (philosophy) and Phase 1 (schema design) are complete and documented in `Docs/semantic_ir_schema_v1.md`. Phase 2 (prove the architecture on real documents) is functionally complete — the full pipeline works, has been extensively hardened against real-world model failures, and the Obsidian plugin runs live in a real vault. Functional correctness is established across short and medium documents, including relation extraction with the dual-client configuration.

A 141-segment stress test is pending. It is a **benchmark, not a release gate** — it tests long-run batching, rate-limiter behavior, cross-batch relations, and quota handling under one specific API configuration (Groq free tier, 8000 TPM). Quota failures under that configuration reflect the test environment's limits, not plugin correctness.

## What's done

- Full pipeline: segmentation → batched node classification → rule-based + LLM relation extraction → schema-validated assembly, with an evidence-verification and taxonomy-enforcement layer at every stage
- Reliability layer: retry-on-429, retry-on-transient-validation-failure, a sliding-window rate limiter, and fail-fast detection for the daily token cap (distinct from per-minute)
- Obsidian plugin: settings UI, one command to compile the active note, confirmed working live in a real vault
- A major validation-integrity incident (eight unreviewed commits weakened core schema checks) was fully found and reversed — documented in `Docs/semantic_ir_schema_v1.md`
- A mid-project model migration (the original model was discontinued by the provider) was navigated, with new rate limits and token budgets re-calibrated from real data
- Packaging: README (accurate, discloses network/privacy behavior), LICENSE (MIT), CONTRIBUTING.md, manifest at v0.1.0
- Provider-agnostic configuration: base URL, API key, model, and client-side TPM throttle are all user-configurable — no provider-specific limits baked into the product

## What's blocking release right now

Nothing functional. The pipeline, plugin, and packaging are all proven. Two operational items remain: (1) run the 141-segment stress test as a documented benchmark (not a correctness gate), and (2) execute the release steps (repo, tag, submit).

## What's left before "v0.1 ships"

1. Run the 141-segment stress test — record results as a benchmark under a known API configuration (Groq free tier, 8000 TPM client-side throttle), not as a pass/fail gate
2. Create the public GitHub repo, push, tag a `v0.1.0` release with `main.js` + `manifest.json`
3. Submit to the Obsidian Community Plugins directory (PR to `obsidianmd/obsidian-releases`)

## Deliberately deferred, not blocking release

- The `extractRelations` cross-batch blind spot (a relation between nodes in different batches can be missed) — real, documented, not yet measured on real data
- Causal-edge recall gap, hedged-confidence calibration — both real, minor, logged
- Phase 3 (multi-document processing, real hierarchy/clustering, an interactive exploration UI) — a substantial future expansion, not required for a working v0.1
