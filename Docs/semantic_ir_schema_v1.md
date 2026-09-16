# Semantic IR — Schema v1

**Status:** Draft, validated by hand-annotation against two domains — an introspective personal diary and a formal legal-doctrine text. Both held up structurally; each surfaced specific gaps, which this schema now closes. Not yet tested against scientific/technical prose or narrative fiction — see Open Questions.

---

## Design principles (why the schema looks like this)

1. **Nodes and edges are both directly traceable to source text, or explicitly marked as synthetic.** No node or edge may exist without an `evidence_span`/`text_span`, except a small, flagged class of engine-generated aggregator nodes (see Confluence, below). This is what makes "no hallucination" a checkable property instead of a promise.
2. **The core type vocabulary stays small and domain-general; domain flavor lives in a `subtype` tag, not new core types.** The legal pass wanted "Holding," "Definition," "Case-fact" — none of these needed to be new node types. They're all `Claim` with a `subtype`. This is what actually makes "one engine, only the ontology changes" true at the code level, not just the pitch level.
3. **Confidence is two separate axes at two separate schema levels, not one number.** Whether a claim is *true* (node-level, `epistemic_confidence`) and whether the text *clearly states* a given relation (edge-level, `extraction_confidence`) are different questions that got conflated in earlier drafts. Splitting them by level, not just by name, resolves that cleanly.
4. **Ambiguity is preserved structurally, not resolved away at extraction time.** Competing readings of the same span are allowed to coexist as separate edges tied together by `interpretation_group`, rather than forcing the extractor to pick one true relation. Resolution happens at query time, if at all.
5. **Relations that look causal but aren't psychological get their own vocabulary.** A case doesn't "cause" a legal principle the way a memory causes a feeling — it `establishes` one. Forcing doctrinal reasoning through the diary's causal vocabulary was the biggest real error found in testing.

---

## Core objects

```typescript
type NodeType =
  | "Claim" | "Observation" | "Decision" | "Memory"
  | "Value" | "Emotion" | "Event"
  | "Confluence";          // synthetic infrastructure node — see below

interface Attribution {
  type: "self" | "citation" | "external";
  ref: string | null;       // e.g. "Hussainara Khatoon v. State of Bihar (1980) 1 SCC 98"
                             // null when type = "self"
}

interface SemanticNode {
  id: string;
  type: NodeType;
  subtype?: string;                    // domain-specific flavor: "Holding", "Definition",
                                        // "Case-fact" — does not change core engine behavior
  text_span: string | null;            // verbatim source text; null only for type = "Confluence"
  source_document_id: string;
  span_location: { start: number; end: number };  // offsets into source_document_id
  attribution: Attribution;
  temporal_position: string | null;    // ISO date, relative marker ("day 3"), or null if undated
  epistemic_confidence: number | null; // 0–1. Meaningful for Claim nodes checked against
                                        // external fact. Null (implicit high trust) for
                                        // self-report types: Observation, Memory, Value,
                                        // Emotion, Decision — the person reporting their own
                                        // feeling/intent *is* the ground truth.
  synthetic: boolean;                  // true only for engine-generated nodes (Confluence);
                                        // false for anything directly extracted from text
  segmentation_note?: string;          // optional audit trail from human annotation passes;
                                        // not required at extraction time
}

type EdgeRelation =
  // logical / argumentative
  | "supports" | "contradicts" | "undercuts" | "elaborates" | "generalizes"
  // causal / doctrinal
  | "causes" | "enables" | "establishes" | "extends" | "overrules" | "contributes_to"
  // temporal
  | "precedes" | "revises"
  // dependency
  | "depends_on";

interface SemanticEdge {
  id: string;
  source_node_id: string;
  target_node_id: string;
  relation: EdgeRelation;
  extraction_confidence: number;   // 0–1, required. How clearly the text itself states
                                    // this relation — independent of whether it's true.
  evidence_span: string;           // required, non-empty. Verbatim text justifying the
                                    // edge. Structurally enforces "no edge without a
                                    // textual signal" — thematic similarity alone is
                                    // never a valid edge.
  interpretation_group?: string;   // edges sharing this id are mutually competing
                                    // readings of the same underlying text. At most
                                    // one is expected to be selected at query time.
                                    // This is the "parse forest" mechanism.
}
```

---

## Node type taxonomy

| Type | Definition | Validated in |
|---|---|---|
| `Claim` | A truth-apt statement, belief, or assertion | Both |
| `Observation` | A reported fact about oneself or the world, not evaluated for external truth | Diary |
| `Decision` | A resolved choice or commitment to act | Diary |
| `Memory` | A recalled past experience, first- or second-hand | Diary |
| `Value` | A stable disposition or attachment | Diary |
| `Emotion` | A felt state | Diary |
| `Event` | Something that happened, reported as fact | Both |
| `Confluence` | Synthetic aggregator — see below | Legal |

Seven core types survived two very different domains without needing new ones. The legal text simply didn't use `Emotion` or `Memory` — that's evidence the taxonomy generalizes, not evidence those types are unnecessary elsewhere.

---

## Edge relation families

**Logical / argumentative**
- `supports` — one node is offered as backing for another
- `contradicts` — genuine same-time, same-context logical tension (not evolution)
- `undercuts` — *new in this pass.* Two things are co-present in tension without logically negating each other — an aspiration alongside its own failure, a surface state alongside what's underneath it. Found independently in both the diary ("happy but drowning") and the legal text ("enacted to protect... governments lazy to implement"). Two unrelated domains producing the same shape is why this is now a core relation rather than a one-off patch.
- `elaborates` — adds detail or scope without changing truth value
- `generalizes` — a specific instance is abstracted into a broader claim

**Causal / doctrinal**
- `causes` / `enables` — direct causal relation between events, decisions, or claims about the world
- `establishes` — *new in this pass.* A case, event, or ruling gives rise to a principle. Distinct from `causes`: nothing psychological is happening, a doctrine is being created.
- `extends` — *new in this pass.* A later claim broadens the scope of an earlier one without replacing it (Khatri extending Hussainara's principle to an earlier procedural stage).
- `overrules` — **reserved, not yet observed.** Anticipated for a later claim fully replacing an earlier one (the doctrinal analogue of `revises`). Flagging it now rather than waiting to discover it under time pressure in Phase 2.
- `contributes_to` — used only with `Confluence` nodes, see below.

**Temporal**
- `precedes` — pure chronology, no claimed influence. This is the *default* relation between sequential nodes; it does almost all the work in dense chronological text, exactly because most sequential events don't actually influence each other.
- `revises` — same underlying belief or claim, changed over time. Strong lexical tell: "once X... now Y," "used to... anymore," "it was not until... that." Confirmed across both the diary and the historical section of the legal text — this heuristic generalizes well and is cheap to detect before running any heavier extraction.

**Dependency**
- `depends_on` — one node's validity or occurrence is conditional on another

---

## Special constructs

**Confluence nodes.** Some outcomes have many independent contributing causes rather than one ("successive reports of committees, conferences, judgements... stimulated the government to give Legal Aid a statutory expression"). Rather than building full hypergraph support, each contributing source gets a `contributes_to` edge into a synthetic `Confluence` node, which then emits one `causes`/`enables` edge to the outcome. `Confluence` nodes always have `text_span: null` and `synthetic: true`, so they're structurally distinguishable from anything directly extracted — the UI and any downstream reasoning can treat them differently (e.g., never cite a Confluence node as if it were evidenced text).

**Attribution as a structural field.** Every node carries an `Attribution`, not just legal ones. Diary claims default to `{ type: "self", ref: null }` — a default boring enough to have gone unnoticed until the legal text made it visible. Legal claims carry `{ type: "citation", ref: "<case or article>" }`. This field is what lets a case get re-cited by name later in the same corpus without inventing a new mechanism for it.

**Interpretation groups (the parse-forest mechanism).** When a span genuinely supports more than one reading — e.g., "every hope... could turn to dust" as either cause or generalization of the preceding fatigue — both edges are stored, tagged with a shared `interpretation_group`, both confidences recorded honestly. The system is not forced to fabricate certainty it doesn't have.

---

## Known, stated limits (not solved — worth naming plainly)

- **Corpus currency.** A legal holding is only as current as what's in the corpus; a superseding case the corpus doesn't contain can't be represented. This isn't a schema problem to solve, it's an honest boundary: the compiler can only be as current as what it's fed.
- **`overrules` is speculative** until tested against a corpus that actually contains a doctrinal reversal.
- **Domain-specific edge vocabularies are real, not cosmetic.** The original assumption that "only node types change per domain" undersold this — edge vocabulary needed real extension (`establishes`, `extends`, `undercuts`) to fit legal reasoning. Future domains should be expected to need the same.

## Empirical findings — Phase 2 live smoke test

Confirmed against a real model (Groq, llama-3.1-8b-instant), not hand-annotation this time:

- **Third-person belief-reports don't reliably get attributed to their holder.** "Dr. Chen believes early mornings are the best time to study" was classified with `attribution: {type: "self", ref: null}` on two separate runs, even though the extraction prompt's own rule covers this case (a named person as belief-holder should trigger `citation`). This looks like a small-model attention limitation rather than a prompt design flaw — the rule is stated clearly, the model just isn't reliably applying it to this construction. Worth revisiting with either a stronger model or a more explicit few-shot example in the prompt; not a schema problem.
- **Sentence-level segmentation produces genuine classification instability on compound sentences.** "It was frustrating, but she stayed calm and finished the test an hour later" — same input, same prompt, two runs — classified as `Observation` with `subtype: "Emotion"` on one run and plain `Claim` on the other. This isn't classifier noise on an otherwise-clean input: the sentence actually contains two distinct semantic units (an Emotion clause and an Event/Decision-adjacent clause) glued by "but," and the model has no way to express that under one type per segment. The `subtype: "Emotion"` result is especially telling — the model reaching for a real top-level type name inside the free-text `subtype` field is it improvising a workaround for a segmentation boundary that's in the wrong place, not a labeling error. **This confirms, with evidence rather than speculation, that clause-level segmentation belongs in Phase 3** — sentence-level was a deliberate, disclosed simplification for Phase 2's architecture-proof goal, and this is what it costs in practice. Not being fixed now on purpose: reopening segmentation would delay closing out the proof for a refinement that doesn't affect whether the IR produced is structurally valid.
- **`response_format: json_object` (Groq) fully prevents fence-wrapping in practice** — zero fenced responses across both live runs. The fence-stripping defensive code remains untriggered outside the test suite; harmless to keep, consistent with how it was always scoped (a guard against a failure mode that may not occur with every provider, not one specific to this one).

## Empirical findings — Obsidian plugin live test

Confirmed by running the actual Obsidian plugin shell inside a real vault, not the dev smoke-test script:

- **`fetch` works cleanly from inside Obsidian's renderer sandbox — no CORS issue.** This was the one open technical question hanging over the plugin shell; a full successful run (settings → command → real vault read → real LLM calls → schema-valid IR written back into the vault) resolved it empirically rather than needing a fallback to Obsidian's `requestUrl` API.
- **Second-person imperative/instructional text doesn't map onto any of the 7 node types.** Run against Obsidian's own default "Welcome.md" boilerplate, "Make a note of something, [[create a link]], or try [the Importer]!" was classified `Decision` (nobody decided anything — it's an instruction to the reader) and "When you are ready, delete this note and make the vault your own" was classified `Claim` (not truth-apt at all — also a directive). Two imperative sentences, two different wrong-ish labels, not even a consistent miss. Diary was first-person reflection, legal text was doctrinal assertion — this is the first time the pipeline has hit second-person instruction, and the taxonomy has no natural home for it. Noted as low-priority for now: the tested text was throwaway onboarding copy, not representative of real user notes — worth re-checking against genuine personal content before deciding whether this needs a schema change.

## Empirical findings — PKM-note testing

Confirmed by testing against realistic PKM-style notes (meeting notes, reading notes, daily notes) and targeted smoke-test checks, rather than boilerplate or narrative text:

- **Markdown syntax was bleeding into node text.** Leading blockquote/bullet/checkbox/numbered-list/heading markers (e.g. `"> "`) were included verbatim in `text_span`, since segmentation deliberately treated input as plain text (a disclosed Phase 2 non-goal). This mattered immediately once testing moved to actual Obsidian-formatted content. Fixed by stripping these markers during segmentation while preserving the offset invariant exactly (commit 923c9f2) — node text_span is now clean prose, and no other pipeline stage needed to change.
- **`causes`/`enables` edges were systematically direction-reversed.** Unlike `revises`, which was merely unreliable (2/3 runs backwards), causal edges were reversed with total consistency: 6/6 observed across a meeting-note test and three dedicated smoke-test runs, always effect-as-source, cause-as-target. Fixed the same way as `revises` — a code-level correction in `assembleSemanticIR` — but generalized into a small rule table (`DIRECTION_RULES`) rather than duplicating the logic, since two relation families now need opposite direction conventions (commit 9b7954f). `establishes`/`extends` were deliberately left out of the rule table — same causal family, but untested, and adding them speculatively is exactly the kind of unearned confidence this whole approach has tried to avoid.
- Separately and still open: the model sometimes produces **zero** causal edges at all on inputs that plausibly warrant one — a recall gap, distinct from the direction problem above, not yet addressed.

## Empirical findings — validation integrity incident and recovery

While attempting to push a 141-segment document through the pipeline, eight commits landed unreviewed (outside the project's normal one-prompt-at-a-time review protocol) in an effort to get past a series of real validation failures. The aggregate effect significantly weakened the schema validation this project is built around: node `type` and edge `relation` became unconstrained strings instead of closed enums; `evidence_span`'s verbatim-substring verification — the core "no fabricated evidence" guarantee — was removed entirely, with a missing span silently defaulting to an empty string; `classifySegments` began silently dropping any segment it couldn't classify instead of throwing; and `assemble.ts`'s final validation gate began coercing malformed data toward plausible-looking defaults instead of rejecting it, including a TypeScript type assertion (`z.string() as z.ZodType<NodeType>`) that falsely told the type system data was enum-constrained when it no longer was at runtime.

Full restoration was completed across all three affected files (`classify.ts`, `extract-relations.ts`, `assemble.ts`) via careful, incremental, individually-reviewed fixes rather than a mass revert — several genuinely good ideas from the same commits were kept: lenient JSON parsing (stripping comments and trailing commas from near-miss LLM output), a specific recovery for Groq's `json_validate_failed`/`failed_generation` error shape, attribution defaulting to `{type: "self", ref: null}` when the whole object is missing, and `epistemic_confidence` coercing a malformed value to `null` (judged correct on the merits — `null` is the schema's own pre-existing "unknown" state for most node types, not a false positive the way an invented node type or a fabricated evidence span would be).

The lesson generalized beyond this one incident: **a validation failure during real usage is a finding to report, not an obstacle to route around.** Every one of the eight commits was a locally reasonable response to a real, blocking error — the failure was making each fix without surfacing it for review first.

## Empirical findings — model migration and rate-limit tuning

`llama-3.1-8b-instant`, the baseline for every tuned constant in this project (segmentation batch sizes, `max_tokens`, the original 6000 TPM figure, the causal-direction and attribution reliability findings above), was decommissioned by Groq mid-project (404 on request). Several replacements were tried before settling on `openai/gpt-oss-20b`: `qwen/qwen3.6-27b` returned empty classification output and was abandoned; `openai/gpt-oss-120b` worked for classification but exhausted its 200,000 TPD (tokens-per-day) budget quickly.

Two platform-level findings worth keeping distinct from the model-specific ones:
- **TPM limits are model-specific, not a fixed platform constant.** Confirmed values seen on Groq: 6000 (`llama-3.1-8b-instant`), 8000 (`gpt-oss-20b`, per Groq's published rate-limits page), 12000 (`llama-3.3-70b-versatile`).
- **TPD (daily) and TPM (per-minute) 429s are distinguishable only by a substring in the error body's `message` field** ("tokens per day" vs. "tokens per minute" — both share the same HTTP status, `code`, and `type` fields). TPD's own "try again in Xs" is a rolling-window artifact that only guarantees room for one more request, not a full reset — retrying into it the way TPM 429s are retried would be wrong. `DailyTokenLimitError` fails fast on a TPD match instead, verified against Groq's real error text.

`gpt-oss-20b` is a reasoning model: a real measured call showed 976 prompt tokens, 2473 completion tokens (1818 of which were internal reasoning, only ~655 actual content) for a 21-segment classification batch. Relation extraction, a harder task for the model to reason through, was confirmed via raw `usage` data to consume its entire 4096-token ceiling on reasoning alone (`reasoning_tokens: 4094`, `finish_reason: "length"`, zero content produced) before the ceiling was raised.

This led to two structural fixes, not just new constants:
- **Splitting the rate limiter's budget reservation from the API's actual `max_tokens`.** A single shared value can't correctly serve both: safe for the API request (generous, avoiding truncation) is unsafe for the rate limiter's own math (a reservation close to or above the TPM ceiling makes the limiter's "does this fit" check always fail, silently disabling it). `RateLimitedClient` now takes a `reservedCompletionTokens` field, separate from `OpenAICompatibleClient`'s `maxTokens`.
- **Classification and relation extraction now use separate client configurations entirely** (separate `OpenAICompatibleClient`/`RateLimitedClient` pairs), since they were confirmed to have genuinely different token needs — one shared configuration could not serve both without either truncating relation extraction or wasting rate-limiter budget on classification.

## Open questions for Phase 2

- Untested domains: scientific/technical prose (would likely stress the currency problem harder — findings get superseded constantly).
- Multi-document identity resolution (the same person, place, or claim recurring across separate documents) hasn't been touched at all yet — everything so far has been single-document.
- `interpretation_group` resolution logic — how/when the system or user actually collapses a group down to one reading, if ever — is unspecified.
