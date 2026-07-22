import { z } from "zod";
import type { SemanticNode, SemanticEdge, SemanticIR, NodeType } from "../schema.js";

// Zod schemas mirroring the TypeScript interfaces in schema.ts exactly.

const NodeTypeSchema = z.enum([
  "Claim", "Observation", "Decision", "Memory",
  "Value", "Emotion", "Event", "Confluence",
]) as z.ZodType<NodeType>;

const AttributionSchema = z.object({
  type: z.enum(["self", "citation", "external"]),
  ref: z.string().nullable(),
});

const SemanticNodeSchema = z.object({
  id: z.string(),
  type: NodeTypeSchema,
  subtype: z.string().optional(),
  text_span: z.string().nullable(),
  source_document_id: z.string(),
  span_location: z.object({ start: z.number(), end: z.number() }),
  attribution: AttributionSchema,
  temporal_position: z.string().nullable(),
  epistemic_confidence: z.number().nullable(),
  synthetic: z.boolean(),
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

export function assembleSemanticIR(
  nodes: SemanticNode[],
  precedesEdges: SemanticEdge[],
  llmEdges: SemanticEdge[],
  documentId: string
): SemanticIR {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));

  // Correct revises-edge directionality.
  // Empirically confirmed: real smoke-test runs produced 1 correct / 2
  // backwards results when this rule was left to the prompt alone.
  // The correct direction is source.span_location.start > target.span_location.start
  // (source = the later, revising node). If the LLM got it wrong, produce
  // a new edge with the ids swapped — do not mutate the original object.
  const correctedLlmEdges = llmEdges.map((edge) => {
    if (edge.relation !== "revises") return edge;

    const srcNode = nodeMap.get(edge.source_node_id);
    if (!srcNode) {
      throw new Error(
        `Revises edge "${edge.id}" references unknown source_node_id "${edge.source_node_id}"`
      );
    }
    const tgtNode = nodeMap.get(edge.target_node_id);
    if (!tgtNode) {
      throw new Error(
        `Revises edge "${edge.id}" references unknown target_node_id "${edge.target_node_id}"`
      );
    }

    if (srcNode.span_location.start < tgtNode.span_location.start) {
      // Source is earlier than target — direction is backwards. Swap.
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
