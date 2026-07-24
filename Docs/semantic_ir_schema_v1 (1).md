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

## Open questions for Phase 2

- Untested domains: scientific/technical prose (would likely stress the currency problem harder — findings get superseded constantly).
- Multi-document identity resolution (the same person, place, or claim recurring across separate documents) hasn't been touched at all yet — everything so far has been single-document.
- `interpretation_group` resolution logic — how/when the system or user actually collapses a group down to one reading, if ever — is unspecified.
