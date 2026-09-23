# Lattice — Project Status

**One-line summary:** Free, open-source Obsidian plugin that compiles notes into a navigable semantic graph (typed nodes + typed edges, evidence-linked, schema-validated) using an LLM.

## Current phase: Phase 2 (tiny prototype → hardened, near release)

Phase 0 (philosophy) and Phase 1 (schema design) are complete and documented in `Docs/semantic_ir_schema_v1.md`. Phase 2 (prove the architecture on real documents) is functionally complete — the full pipeline works, has been extensively hardened against real-world model failures, and the Obsidian plugin runs live in a real vault. One thing is still unconfirmed: a full clean run of the pipeline (through relation extraction) on a genuinely long real document (141 segments) — every attempt so far has failed at relation extraction for a different reason (fabricated evidence, daily token cap, token-budget exhaustion), each one fixed. The next attempt, once Groq's daily token cap resets, is expected to be the first fully clean one.

## What's done

- Full pipeline: segmentation → batched node classification → rule-based + LLM relation extraction → schema-validated assembly, with an evidence-verification and taxonomy-enforcement layer at every stage
- Reliability layer: retry-on-429, retry-on-transient-validation-failure, a sliding-window rate limiter, and fail-fast detection for the daily token cap (distinct from per-minute)
- Obsidian plugin: settings UI, one command to compile the active note, confirmed working live in a real vault
- A major validation-integrity incident (eight unreviewed commits weakened core schema checks) was fully found and reversed — documented in `Docs/semantic_ir_schema_v1.md`
- A mid-project model migration (the original model was discontinued by the provider) was navigated, with new rate limits and token budgets re-calibrated from real data
- Packaging: README (accurate, discloses network/privacy behavior), LICENSE (MIT), CONTRIBUTING.md, manifest at v0.1.0

## What's blocking release right now

One thing only: a full, successful pipeline run on the 141-segment test document, pending Groq's daily token quota resetting. Everything else needed for a v0.1 release is ready.

## What's left before "v0.1 ships"

1. Confirm the clean 141-segment run
2. Create the public GitHub repo, push, tag a `v0.1.0` release with `main.js` + `manifest.json`
3. Submit to the Obsidian Community Plugins directory (PR to `obsidianmd/obsidian-releases`)

## Deliberately deferred, not blocking release

- The `extractRelations` cross-batch blind spot (a relation between nodes in different batches can be missed) — real, documented, not yet measured on real data
- Causal-edge recall gap, hedged-confidence calibration — both real, minor, logged
- Phase 3 (multi-document processing, real hierarchy/clustering, an interactive exploration UI) — a substantial future expansion, not required for a working v0.1
