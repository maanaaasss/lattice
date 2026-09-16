# Contributing to Lattice

## Getting started

See the README's [Development](README.md#development) section for local setup (`npm install`, `npm run build`, `npm test`) and running the smoke test against a real LLM.

## Pull requests

All changes to `src/` require test coverage. If a PR touches extraction logic, classification, relation derivation, or pipeline assembly, there should be a test that exercises the changed behavior.

Changes to validation logic — Zod schemas, the `evidence_span` verbatim check, node/edge type enums — need explicit justification for why the change doesn't weaken integrity guarantees. The empirical-findings sections in [Docs/semantic_ir_schema_v1.md](Docs/semantic_ir_schema_v1.md) are the model for what that justification should look like: concrete examples, not abstract reasoning.

## Design principle

Prefer a missing edge over a false one. Never loosen validation to route around a model failure — report it instead. This is the reason certain checks are stricter than they might appear from the code alone, and it's the one thing worth understanding before modifying the extraction or validation layers.

## License

Contributions are made under the [MIT License](LICENSE).
