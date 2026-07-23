import { describe, it, expect } from "vitest";
import type { SemanticNode, SemanticEdge, SemanticIR } from "../schema.js";
import { assembleSemanticIR, SemanticIRSchema } from "./assemble.js";

function makeNode(id: string, start: number, end: number): SemanticNode {
  return {
    id,
    type: "Claim",
    text_span: `text of ${id}`,
    source_document_id: "doc-1",
    span_location: { start, end },
    attribution: { type: "self", ref: null },
    temporal_position: null,
    epistemic_confidence: null,
    synthetic: false,
  };
}

function makeEdge(
  id: string,
  source: string,
  target: string,
  relation: SemanticEdge["relation"]
): SemanticEdge {
  return {
    id,
    source_node_id: source,
    target_node_id: target,
    relation,
    extraction_confidence: 0.9,
    evidence_span: "some evidence",
  };
}

describe("assembleSemanticIR", () => {
  const nodes = [
    makeNode("n-early", 0, 10),
    makeNode("n-mid", 20, 30),
    makeNode("n-late", 50, 60),
  ];

  it("swaps a backwards revises edge so source is the later node", () => {
    // Edge points from early → late (backwards)
    const backwards: SemanticEdge[] = [
      makeEdge("rev-1", "n-early", "n-late", "revises"),
    ];

    const ir = assembleSemanticIR(nodes, [], backwards, "doc-1");
    const revEdge = ir.edges.find((e) => e.relation === "revises")!;

    expect(revEdge.source_node_id).toBe("n-late");
    expect(revEdge.target_node_id).toBe("n-early");
  });

  it("leaves a correctly-directed revises edge unchanged", () => {
    // Edge points from late → early (correct)
    const correct: SemanticEdge[] = [
      makeEdge("rev-1", "n-late", "n-early", "revises"),
    ];

    const ir = assembleSemanticIR(nodes, [], correct, "doc-1");
    const revEdge = ir.edges.find((e) => e.relation === "revises")!;

    expect(revEdge.source_node_id).toBe("n-late");
    expect(revEdge.target_node_id).toBe("n-early");
  });

  it("does not touch non-revises edges even if positions would fail the check", () => {
    // A "causes" edge from early → late — same positions as the backwards
    // revises case, but direction correction must not apply.
    const causes: SemanticEdge[] = [
      makeEdge("c-1", "n-early", "n-late", "causes"),
    ];

    const ir = assembleSemanticIR(nodes, [], causes, "doc-1");
    const cEdge = ir.edges.find((e) => e.relation === "causes")!;

    expect(cEdge.source_node_id).toBe("n-early");
    expect(cEdge.target_node_id).toBe("n-late");
  });

  it("combines precedes edges first, then llm edges", () => {
    const precedes: SemanticEdge[] = [
      makeEdge("p-1", "n-early", "n-mid", "precedes"),
    ];
    const llm: SemanticEdge[] = [
      makeEdge("c-1", "n-early", "n-late", "causes"),
    ];

    const ir = assembleSemanticIR(nodes, precedes, llm, "doc-1");

    expect(ir.edges).toHaveLength(2);
    expect(ir.edges[0].id).toBe("p-1");
    expect(ir.edges[1].id).toBe("c-1");
  });

  it("throws if a revises edge references an unknown node id", () => {
    const bad: SemanticEdge[] = [
      makeEdge("rev-1", "n-early", "n-nonexistent", "revises"),
    ];

    expect(() => assembleSemanticIR(nodes, [], bad, "doc-1")).toThrow(
      /unknown target_node_id "n-nonexistent"/
    );
  });

  it("produces an object that passes SemanticIRSchema.safeParse", () => {
    const precedes: SemanticEdge[] = [
      makeEdge("p-1", "n-early", "n-mid", "precedes"),
    ];
    const llm: SemanticEdge[] = [
      makeEdge("rev-1", "n-late", "n-early", "revises"),
    ];

    const ir = assembleSemanticIR(nodes, precedes, llm, "doc-1");
    const result = SemanticIRSchema.safeParse(ir);

    expect(result.success).toBe(true);
  });

  it("does not mutate the original edge objects in the llmEdges array", () => {
    const original = makeEdge("rev-1", "n-early", "n-late", "revises");
    const llm: SemanticEdge[] = [original];

    const ir = assembleSemanticIR(nodes, [], llm, "doc-1");

    // The IR's edge should be correctly swapped
    const revEdge = ir.edges.find((e) => e.relation === "revises")!;
    expect(revEdge.source_node_id).toBe("n-late");
    expect(revEdge.target_node_id).toBe("n-early");

    // But the ORIGINAL object must remain untouched
    expect(original.source_node_id).toBe("n-early");
    expect(original.target_node_id).toBe("n-late");
  });

  it("swaps a backwards causes edge so source ends up earlier", () => {
    // Edge points from late → early (backwards for source-earlier rule)
    const backwards: SemanticEdge[] = [
      makeEdge("c-1", "n-late", "n-early", "causes"),
    ];

    const ir = assembleSemanticIR(nodes, [], backwards, "doc-1");
    const cEdge = ir.edges.find((e) => e.relation === "causes")!;

    expect(cEdge.source_node_id).toBe("n-early");
    expect(cEdge.target_node_id).toBe("n-late");
  });

  it("leaves a correctly-directed causes edge unchanged", () => {
    // Edge points from early → late (correct for source-earlier rule)
    const correct: SemanticEdge[] = [
      makeEdge("c-1", "n-early", "n-late", "causes"),
    ];

    const ir = assembleSemanticIR(nodes, [], correct, "doc-1");
    const cEdge = ir.edges.find((e) => e.relation === "causes")!;

    expect(cEdge.source_node_id).toBe("n-early");
    expect(cEdge.target_node_id).toBe("n-late");
  });

  it("swaps a backwards enables edge so source ends up earlier", () => {
    const backwards: SemanticEdge[] = [
      makeEdge("en-1", "n-late", "n-early", "enables"),
    ];

    const ir = assembleSemanticIR(nodes, [], backwards, "doc-1");
    const enEdge = ir.edges.find((e) => e.relation === "enables")!;

    expect(enEdge.source_node_id).toBe("n-early");
    expect(enEdge.target_node_id).toBe("n-late");
  });

  it("does not touch a supports edge even with positions that would fail either directional check", () => {
    // supports has no direction rule — must pass through unchanged regardless
    const edge: SemanticEdge[] = [
      makeEdge("s-1", "n-early", "n-late", "supports"),
    ];

    const ir = assembleSemanticIR(nodes, [], edge, "doc-1");
    const sEdge = ir.edges.find((e) => e.relation === "supports")!;

    expect(sEdge.source_node_id).toBe("n-early");
    expect(sEdge.target_node_id).toBe("n-late");
  });

  it("throws if a causes edge references an unknown node id", () => {
    const bad: SemanticEdge[] = [
      makeEdge("c-1", "n-late", "n-nonexistent", "causes"),
    ];

    expect(() => assembleSemanticIR(nodes, [], bad, "doc-1")).toThrow(
      /unknown target_node_id "n-nonexistent"/
    );
  });
});

describe("SemanticIRSchema strictness", () => {
  it("rejects a malformed object (invalid relation)", () => {
    const bad = {
      document_id: "doc-1",
      nodes: [],
      edges: [
        {
          id: "e-1",
          source_node_id: "a",
          target_node_id: "b",
          relation: "made_up_relation",
          extraction_confidence: 0.5,
          evidence_span: "text",
        },
      ],
      generated_at: new Date().toISOString(),
      schema_version: "1.0",
    };

    const result = SemanticIRSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("rejects a malformed object (missing schema_version)", () => {
    const bad = {
      document_id: "doc-1",
      nodes: [],
      edges: [],
      generated_at: new Date().toISOString(),
    };

    const result = SemanticIRSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("rejects a malformed object (invalid node type)", () => {
    const bad = {
      document_id: "doc-1",
      nodes: [
        {
          id: "n-1",
          type: "NotAType",
          text_span: "hello",
          source_document_id: "doc-1",
          span_location: { start: 0, end: 5 },
          attribution: { type: "self", ref: null },
          epistemic_confidence: null,
          synthetic: false,
        },
      ],
      edges: [],
      generated_at: new Date().toISOString(),
      schema_version: "1.0",
    };

    const result = SemanticIRSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });
});
