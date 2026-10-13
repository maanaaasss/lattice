# Lattice — Project Status

**One-line summary:** Free, open-source Obsidian plugin that compiles notes into a navigable semantic graph (typed nodes + typed edges, evidence-linked, schema-validated) using an LLM.

## Current phase: Phase 2 (tiny prototype → hardened, released as v0.1.3)

Phase 0 (philosophy) and Phase 1 (schema design) are complete and documented in `Docs/semantic_ir_schema_v1.md`. Phase 2 (prove the architecture on real documents) is functionally complete — the full pipeline works, has been extensively hardened against real-world model failures, and the Obsidian plugin runs live in a real vault. Functional correctness is established across short and medium documents, including relation extraction with the dual-client configuration.

**Released:** `0.1.3` on 2026-10-13 — the Obsidian automated-review pass. Tag matches the `manifest.json` version; `main.js` + `manifest.json` are built by CI from the tag and carry GitHub build-provenance attestations; the root build is self-contained (a clean checkout with only root `npm install` produces `main.js`). `0.1.2`, `0.1.1`, and the pre-hardening `0.1.0` tag are left in place for history.

A 141-segment stress test was completed on 2026-10-04 and is recorded in `Docs/stress_test_141.md`. It was run as a **benchmark, not a release gate** — it covers long-run batching, rate-limiter behavior, cross-batch relations, and quota handling under one specific API configuration (Groq free tier, 8000 TPM). Quota failures under that configuration reflect the test environment's limits, not plugin correctness. The document completed end to end with no failures: 141/141 segments classified, the invariant gate passed against source, and 0 rate-limit events across 32 calls.

## What's done

- Full pipeline: segmentation → batched node classification → rule-based + LLM relation extraction → schema-validated assembly, with an evidence-verification and taxonomy-enforcement layer at every stage
- Reliability layer: retry-on-429, retry-on-transient-validation-failure, a sliding-window rate limiter, and fail-fast detection for the daily token cap (distinct from per-minute)
- Obsidian plugin: settings UI, one command to compile the active note, confirmed working live in a real vault
- A major validation-integrity incident (eight unreviewed commits weakened core schema checks) was fully found and reversed — documented in `Docs/semantic_ir_schema_v1.md`
- A mid-project model migration (the original model was discontinued by the provider) was navigated, with new rate limits and token budgets re-calibrated from real data
- Packaging: README (accurate, discloses network/privacy behavior), LICENSE (MIT), CONTRIBUTING.md, manifest + `versions.json` at v0.1.2, release automation in `.github/workflows/release.yml` (release notes + build-provenance attestations for both assets)
- Review hardening (`0.1.2`, build self-containment in `0.1.3`): the official Obsidian lint stack (`eslint-plugin-obsidianmd`) runs in CI at zero warnings — including against a root-only install, matching the community-review environment; `fetch` in the plugin path is replaced by an injected `requestUrl` transport; `getSettingDefinitions()` declared settings with a `display()` fallback; the root build emits `main.js` with no plugin-workspace install required
- Provider-agnostic configuration: base URL, API key, model, and client-side TPM throttle are all user-configurable — no provider-specific limits baked into the product
- A 16-rule structural invariant suite that runs during assembly against the source text, plus fixture coverage over every committed IR (`src/pipeline/invariants.ts`)
- A gold-standard label format and semantic eval harness (`src/eval`, `npm run gold:label`, `npm run eval`) — measures node macro/micro-F1, per-family edge P/R/F1, attribution accuracy, direction accuracy, and across-run stability
- 141-segment stress test completed as a documented benchmark (`Docs/stress_test_141.md`)

## What's blocking release right now

Nothing. `0.1.3` is published on the public repo (`maanaaasss/lattice`) with the required release assets, build attestations, and release notes; `versions.json` is committed at HEAD, CI is green (typecheck, lint at zero warnings, tests, plugin build), and the plugin ID `semantic-ir-compiler` is unclaimed across all 8,835 listed plugins.

## What's left to reach users

1. **Directory listing — the only open item, and it needs a human.** Submit at <https://community.obsidian.md>: sign in with an Obsidian account, link the GitHub account that owns `maanaaasss/lattice`, then "Add a plugin" (the directory reads `manifest.json` from the HEAD of `main`, and installs from the release whose tag matches its version — both already correct). This replaced the old `obsidianmd/obsidian-releases` PR flow, which is still described in that repo's README but is no longer the documented path.

Semantic accuracy is not a release blocker, but it is also not yet measured: `npm run eval` needs at least one human-reviewed gold file before any score means anything.

## Deliberately deferred, not blocking release

- The `extractRelations` cross-batch blind spot (a relation between nodes in different batches can be missed) — real, documented, still unmeasured: the 141-segment run exercised 15 batches but had no gold labels to measure against
- Causal-edge recall gap, hedged-confidence calibration — both real, minor, logged
- Phase 3 (multi-document processing, real hierarchy/clustering, an interactive exploration UI) — a substantial future expansion, not required for a working v0.1
