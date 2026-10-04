import type { SemanticNode, SemanticEdge, SemanticIR } from "../schema.js";
import { SemanticIRSchema, DIRECTION_RULES } from "../schema.js";
import { assertIRInvariants } from "./invariants.js";

export function assembleSemanticIR(
  nodes: SemanticNode[],
  precedesEdges: SemanticEdge[],
  llmEdges: SemanticEdge[],
  documentId: string,
  sourceText?: string
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

  // The Zod gate above catches malformed shapes; the invariant suite
  // catches the things only the source document can settle — verbatim
  // offsets, verbatim evidence, referential integrity, edge direction.
  // Omit sourceText only when there is no source document to check against.
  if (sourceText !== undefined) {
    assertIRInvariants(ir, sourceText);
  }

  return ir;
}
