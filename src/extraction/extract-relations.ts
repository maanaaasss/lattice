import { z } from "zod";
import type { SemanticNode, SemanticEdge } from "../schema.js";
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

const RelationProposalSchema = z.object({
  source_node_id: z.string(),
  target_node_id: z.string(),
  relation: z.enum([
    "supports",
    "contradicts",
    "undercuts",
    "elaborates",
    "generalizes",
    "causes",
    "enables",
    "establishes",
    "extends",
    "depends_on",
    "revises",
  ]),
  evidence_span: z.string().min(1),
  extraction_confidence: z.number().min(0).max(1),
  interpretation_group: z.string().nullable().optional(),
});

const RelationExtractionSchema = z.object({
  edges: z.array(RelationProposalSchema),
});

function stripCodeFences(raw: string): string {
  const trimmed = raw.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
  if (fenceMatch) {
    return fenceMatch[1].trim();
  }
  return trimmed;
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
  const stripped = stripCodeFences(rawResponse);
  const parsed = JSON.parse(stripped);
  const validated = RelationExtractionSchema.parse(parsed);

  const nodeIds = new Set(nodes.map((n) => n.id));

  for (let i = 0; i < validated.edges.length; i++) {
    const edge = validated.edges[i];

    if (edge.source_node_id === edge.target_node_id) {
      throw new Error(
        `Self-loop detected in proposed edge ${i}: source and target are both "${edge.source_node_id}"`
      );
    }

    if (!nodeIds.has(edge.source_node_id)) {
      throw new Error(
        `Invalid source_node_id "${edge.source_node_id}" in proposed edge ${i} — not found in provided nodes`
      );
    }

    if (!nodeIds.has(edge.target_node_id)) {
      throw new Error(
        `Invalid target_node_id "${edge.target_node_id}" in proposed edge ${i} — not found in provided nodes`
      );
    }

    if (!sourceDocumentText.includes(edge.evidence_span)) {
      const preview =
        edge.evidence_span.length > 200
          ? edge.evidence_span.slice(0, 200) + "..."
          : edge.evidence_span;
      throw new Error(
        `evidence_span in proposed edge ${i} is not a verbatim substring of the source document: "${preview}"`
      );
    }
  }

  return validated.edges.map(
    (edge, i): SemanticEdge => ({
      id: `edge-llm-${i}`,
      source_node_id: edge.source_node_id,
      target_node_id: edge.target_node_id,
      relation: edge.relation,
      extraction_confidence: edge.extraction_confidence,
      evidence_span: edge.evidence_span,
      ...(edge.interpretation_group != null
        ? { interpretation_group: edge.interpretation_group }
        : {}),
    })
  );
}
