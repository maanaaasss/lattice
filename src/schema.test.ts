import { describe, it, expect } from "vitest";
import type {
  NodeType,
  Attribution,
  SemanticNode,
  EdgeRelation,
  SemanticEdge,
  SemanticIR,
} from "./schema.js";

describe("schema types", () => {
  it("constructs a valid SemanticIR object", () => {
    const node: SemanticNode = {
      id: "node-1",
      type: "Claim",
      subtype: "Holding",
      text_span: "The right to legal aid is fundamental.",
      source_document_id: "doc-1",
      span_location: { start: 0, end: 44 },
      attribution: { type: "citation", ref: "Hussainara Khatoon v. State of Bihar" },
      temporal_position: "1980",
      epistemic_confidence: null,
      synthetic: false,
    };

    const edge: SemanticEdge = {
      id: "edge-1",
      source_node_id: "node-1",
      target_node_id: "node-2",
      relation: "supports",
      extraction_confidence: 0.9,
      evidence_span: "some text supporting the relation",
    };

    const ir: SemanticIR = {
      document_id: "doc-1",
      nodes: [node],
      edges: [edge],
      generated_at: new Date().toISOString(),
      schema_version: "1.0",
    };

    expect(ir.schema_version).toBe("1.0");
    expect(ir.nodes).toHaveLength(1);
    expect(ir.edges).toHaveLength(1);
  });
});
