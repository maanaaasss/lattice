import { z } from "zod";
import type { SemanticNode, SemanticEdge, EdgeRelation } from "../schema.js";
import type { RevisionCandidate } from "./relations-rule-based.js";
import type { LLMClient } from "./llm-client.js";

export const EXTRACT_RELATIONS_SYSTEM_PROMPT = `You are performing semantic relation extraction for a text-analysis pipeline. You will receive a JSON array of nodes from a single document (each with an id, type, and text), and a list of revision-candidate hints — nodes whose text contains a lexical marker suggesting they revise an earlier belief or claim.

Available relation types and their meaning:
- supports: one node is offered as backing for another
- contradicts: genuine same-time, same-context logical tension between two nodes (not a belief simply changing over time — that's revises)
- undercuts: two things are co-present in tension without logically negating each other (an aspiration alongside its own failure, a surface state alongside what's underneath it)
- elaborates: adds detail or scope to another node without changing its truth value
- generalizes: a specific instance is abstracted into a broader claim
- causes / enables: a DIRECT causal relation — the source is the actual reason the target happened, not simply something that happened earlier in the same passage. Before proposing this relation, apply this test: replace the connection between the two spans with "and then" — if the passage still reads naturally and stays true, this is mere sequence, not causation, and you should propose NO relation between them (sequence alone is handled elsewhere in the pipeline, not by you). Only propose causes/enables if replacing the connection with "and because of this" also reads naturally and stays true. Two examples of what NOT to propose as causes, because they are only sequence: "I got a new manager. Her name was Alex." (getting a manager doesn't cause her name); "I moved to a new city. It has nice parks." (moving doesn't cause the parks to exist). Two examples of genuine causation: "I missed the deadline. My manager was upset."; "I broke my leg. I couldn't attend the wedding."
- establishes: an event or ruling gives rise to a principle — not a psychological cause, a doctrine or fact being created
- extends: a later claim broadens the scope of an earlier one without replacing it
- depends_on: one node's validity or occurrence is conditional on another
- revises: the same underlying belief or claim changed over time. ONLY use this for nodes appearing in the revision-candidate hints, and always point FROM the later (revising) node TO the earlier (revised) node it changes.

Do NOT use these relation types — they are handled elsewhere: precedes, contributes_to, overrules.

For each relation you identify:
- source_node_id and target_node_id: MUST be exact ids from the node list provided. Never invent an id.
- evidence_span: the exact verbatim text — a direct quote, character-for-character, from the document — that justifies this relation. Do not paraphrase or summarize. If you cannot find literal text that justifies a relation, do not propose that relation.
- extraction_confidence: 0 to 1 — how clearly the text itself states this relation, independent of whether you believe it's true.
- interpretation_group: OPTIONAL. If a single span genuinely supports two different, mutually competing readings, you may propose both as separate edges sharing the same interpretation_group string. Only use this for genuine ambiguity, not as a hedge on every relation.

Do not propose ANY relation — not just causes — on thematic similarity or mere adjacency alone. Most sequential pairs in a narrative have no meaningful relation beyond sequence, which is handled elsewhere in the pipeline; propose nothing for these pairs rather than forcing a weak causes or supports label onto them. When genuinely uncertain whether a real relation exists, propose no edge — a missing edge is a smaller error than a false one.

Return ONLY valid JSON, no commentary, in exactly this shape:
{"edges":[{"source_node_id":"seg-0","target_node_id":"seg-2","relation":"causes","evidence_span":"exact quoted text here","extraction_confidence":0.8,"interpretation_group":null}]}

An empty edges array is a completely valid response if no genuine relations are found.`;

const RELATION_ENUM = [
  "supports", "contradicts", "undercuts", "elaborates", "generalizes",
  "causes", "enables", "establishes", "extends", "depends_on", "revises",
] as const;

const RelationProposalSchema = z.object({
  source_node_id: z.any().transform(String),
  target_node_id: z.any().transform(String),
  relation: z.enum(RELATION_ENUM),
  evidence_span: z.string().min(1),
  extraction_confidence: z.any().optional().transform((v) => {
    if (v == null) return 0.5;
    const n = typeof v === "number" ? v : parseFloat(v);
    return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.5;
  }),
  interpretation_group: z.any().optional().transform((v) => (v == null ? null : String(v))),
});


function stripCodeFences(raw: string): string {
  const trimmed = raw.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
  let s = fenceMatch ? fenceMatch[1].trim() : trimmed;
  s = s.replace(/\/\/[^\n]*/g, "");
  s = s.replace(/#[^\n]*/g, "");
  s = s.replace(/,\s*([}\]])/g, "$1");
  return s;
}

function parseJsonLenient(raw: string): unknown {
  const cleaned = stripCodeFences(raw);
  try {
    return JSON.parse(cleaned);
  } catch {
    const objMatch = cleaned.match(/\{[\s\S]*\}/);
    if (objMatch) {
      try { return JSON.parse(objMatch[0]); } catch { /* fall through */ }
    }
    const arrMatch = cleaned.match(/\[[\s\S]*\]/);
    if (arrMatch) {
      try { return JSON.parse(arrMatch[0]); } catch { /* fall through */ }
    }
    throw new Error(`Failed to parse JSON from LLM response:\n${cleaned.slice(0, 2000)}`);
  }
}

export async function extractRelations(
  nodes: SemanticNode[],
  revisionCandidates: RevisionCandidate[],
  sourceDocumentText: string,
  client: LLMClient
): Promise<SemanticEdge[]> {
  const nodeList = nodes.map((n) => ({
    id: n.id,
    type: n.type,
    text: n.text_span,
  }));

  const userPrompt = JSON.stringify({
    nodes: nodeList,
    revision_candidates: revisionCandidates,
  });

  const rawResponse = await client.complete(
    EXTRACT_RELATIONS_SYSTEM_PROMPT,
    userPrompt
  );
  const parsed = parseJsonLenient(rawResponse);

  // Rejecting one edge must never discard other, independently valid edges
  // from the same batch. We rechecked this after seeing real documents where
  // a single unrelated bad edge caused entirely correct results to be thrown
  // away — the old throw-on-first-failure approach from a few commits ago.
  const rawEdges: unknown[] =
    parsed != null &&
    typeof parsed === "object" &&
    Array.isArray((parsed as any).edges)
      ? (parsed as any).edges
      : [];

  const nodeIds = new Set(nodes.map((n) => n.id));
  const validEdges: z.infer<typeof RelationProposalSchema>[] = [];

  for (const raw of rawEdges) {
    const result = RelationProposalSchema.safeParse(raw);
    if (!result.success) {
      console.warn(
        `Skipping malformed edge (failed schema validation):`,
        raw,
        result.error
      );
      continue;
    }
    const edge = result.data;

    if (edge.source_node_id === edge.target_node_id) {
      console.warn(
        `Skipping edge with self-loop: source and target are both "${edge.source_node_id}"`
      );
      continue;
    }
    if (!nodeIds.has(edge.source_node_id)) {
      console.warn(
        `Skipping edge with invalid source_node_id "${edge.source_node_id}" — not found in provided nodes`
      );
      continue;
    }
    if (!nodeIds.has(edge.target_node_id)) {
      console.warn(
        `Skipping edge with invalid target_node_id "${edge.target_node_id}" — not found in provided nodes`
      );
      continue;
    }
    if (!sourceDocumentText.includes(edge.evidence_span)) {
      const preview =
        edge.evidence_span.length > 80
          ? edge.evidence_span.slice(0, 80) + "…"
          : edge.evidence_span;
      console.warn(
        `Skipping edge with non-verbatim evidence_span in edge ${edge.source_node_id}→${edge.target_node_id} (${edge.relation}): "${preview}"`
      );
      continue;
    }

    validEdges.push(edge);
  }

  return validEdges.map(
    (edge, i): SemanticEdge => ({
      id: `edge-llm-${i}`,
      source_node_id: edge.source_node_id,
      target_node_id: edge.target_node_id,
      relation: edge.relation as EdgeRelation,
      extraction_confidence: edge.extraction_confidence,
      evidence_span: edge.evidence_span,
      ...(edge.interpretation_group != null
        ? { interpretation_group: edge.interpretation_group }
        : {}),
    })
  );
}

// Batches are non-overlapping node windows, so a genuine relation between
// two nodes in DIFFERENT batches — including revises across a batch boundary
// — will not be found. This is a deliberate, documented scope limitation,
// pending real evidence on how often it matters.
export async function extractRelationsBatched(
  nodes: SemanticNode[],
  revisionCandidates: RevisionCandidate[],
  sourceDocumentText: string,
  client: LLMClient,
  batchSize: number = 20
): Promise<SemanticEdge[]> {
  if (nodes.length <= batchSize) {
    return extractRelations(nodes, revisionCandidates, sourceDocumentText, client);
  }

  const allEdges: SemanticEdge[] = [];
  for (let i = 0; i < nodes.length; i += batchSize) {
    const batch = nodes.slice(i, i + batchSize);
    const batchIds = new Set(batch.map((n) => n.id));
    const filteredCandidates = revisionCandidates.filter((c) => batchIds.has(c.node_id));
    const batchEdges = await extractRelations(batch, filteredCandidates, sourceDocumentText, client);
    allEdges.push(...batchEdges);
  }

  return allEdges.map((e, i) => ({ ...e, id: `edge-llm-${i}` }));
}
