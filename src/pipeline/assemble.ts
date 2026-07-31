import { z } from "zod";
import type { SemanticNode, SemanticEdge, SemanticIR, NodeType } from "../schema.js";

// Zod schemas mirroring the TypeScript interfaces in schema.ts exactly.

const NodeTypeSchema = z.string() as z.ZodType<NodeType>;

const AttributionSchema = z.any().optional().transform((v) => {
  if (v && typeof v === "object" && typeof v.type === "string") return { type: v.type, ref: v.ref ?? null };
  return { type: "self" as const, ref: null };
});

const SemanticNodeSchema = z.object({
  id: z.string(),
  type: NodeTypeSchema,
  subtype: z.string().optional(),
  text_span: z.string().nullable(),
  source_document_id: z.string(),
  span_location: z.any().optional().transform((v) => (v && typeof v === "object" ? { start: Number(v.start) || 0, end: Number(v.end) || 0 } : { start: 0, end: 0 })),
  attribution: AttributionSchema,
  temporal_position: z.any().optional().transform((v) => (v == null ? null : String(v))),
  epistemic_confidence: z.any().optional().transform((v) => {
    if (v == null) return null;
    const n = typeof v === "number" ? v : parseFloat(v);
    return Number.isFinite(n) ? n : null;
  }),
  synthetic: z.any().optional().transform((v) => Boolean(v)),
  segmentation_note: z.string().optional(),
});

const EdgeRelationSchema = z.enum([
  "supports", "contradicts", "undercuts", "elaborates", "generalizes",
  "causes", "enables", "establishes", "extends", "overrules", "contributes_to",
  "precedes", "revises",
  "depends_on",
]);

const SemanticEdgeSchema = z.object({
  id: z.string(),
  source_node_id: z.string(),
  target_node_id: z.string(),
  relation: EdgeRelationSchema,
  extraction_confidence: z.number(),
  evidence_span: z.string(),
  interpretation_group: z.string().optional(),
});

export const SemanticIRSchema = z.object({
  document_id: z.string(),
  nodes: z.array(SemanticNodeSchema),
  edges: z.array(SemanticEdgeSchema),
  generated_at: z.string(),
  schema_version: z.literal("1.0"),
});

type DirectionRule = "source-later" | "source-earlier";

const DIRECTION_RULES: Partial<Record<SemanticEdge["relation"], DirectionRule>> = {
  // Empirically confirmed via repeated live smoke-test runs — see
  // Docs/semantic_ir_schema_v1.md for the evidence behind each entry.
  revises: "source-later",   // 2/3 runs backwards when left to the prompt
  causes: "source-earlier",  // 6/6 causal edges observed backwards
  enables: "source-earlier", // same evidence set as causes
  // establishes/extends are NOT included — same causal family, but
  // their directionality has not been empirically tested. Do not add
  // them speculatively.
};

export function assembleSemanticIR(
  nodes: SemanticNode[],
  precedesEdges: SemanticEdge[],
  llmEdges: SemanticEdge[],
  documentId: string
): SemanticIR {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));

  // Correct edge directionality for relations with known rules.
  // Each rule defines the expected relative position of source vs target.
  // If the LLM got it wrong, produce a new edge with the ids swapped —
  // do not mutate the original object.
  const correctedLlmEdges = llmEdges.map((edge) => {
    const rule = DIRECTION_RULES[edge.relation];
    if (!rule) return edge;

    const srcNode = nodeMap.get(edge.source_node_id);
    if (!srcNode) {
      throw new Error(
        `${edge.relation} edge "${edge.id}" references unknown source_node_id "${edge.source_node_id}"`
      );
    }
    const tgtNode = nodeMap.get(edge.target_node_id);
    if (!tgtNode) {
      throw new Error(
        `${edge.relation} edge "${edge.id}" references unknown target_node_id "${edge.target_node_id}"`
      );
    }

    let backwards: boolean;
    if (rule === "source-later") {
      backwards = srcNode.span_location.start < tgtNode.span_location.start;
    } else {
      backwards = srcNode.span_location.start > tgtNode.span_location.start;
    }

    if (backwards) {
      return {
        ...edge,
        source_node_id: edge.target_node_id,
        target_node_id: edge.source_node_id,
      };
    }

    return edge;
  });

  const edges: SemanticEdge[] = [...precedesEdges, ...correctedLlmEdges];

  const ir: SemanticIR = {
    document_id: documentId,
    nodes,
    edges,
    generated_at: new Date().toISOString(),
    schema_version: "1.0",
  };

  SemanticIRSchema.parse(ir);

  return ir;
}
