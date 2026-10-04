import { describe, it, expect } from "vitest";
import type { SemanticIR, SemanticNode, SemanticEdge } from "../schema.js";
import {
  checkIRInvariants,
  assertIRInvariants,
  formatViolations,
} from "./invariants.js";

const SOURCE = "Alpha beta. Gamma delta. Epsilon zeta.";

function spanOf(needle: string, haystack: string = SOURCE) {
  const start = haystack.indexOf(needle);
  if (start < 0) throw new Error(`fixture text not found: ${needle}`);
  return { start, end: start + needle.length };
}

function makeNode(
  id: string,
  text: string,
  overrides: Partial<SemanticNode> = {}
): SemanticNode {
  return {
    id,
    type: "Claim",
    text_span: text,
    source_document_id: "doc-1",
    span_location: spanOf(text),
    attribution: { type: "self", ref: null },
    temporal_position: null,
    epistemic_confidence: null,
    synthetic: false,
    ...overrides,
  };
}

function makeEdge(
  id: string,
  source: string,
  target: string,
  relation: SemanticEdge["relation"],
  evidence: string,
  overrides: Partial<SemanticEdge> = {}
): SemanticEdge {
  return {
    id,
    source_node_id: source,
    target_node_id: target,
    relation,
    extraction_confidence: 0.9,
    evidence_span: evidence,
    ...overrides,
  };
}

function buildValidIR(): { ir: SemanticIR; sourceText: string } {
  const nodes = [
    makeNode("n-0", "Alpha beta."),
    makeNode("n-1", "Gamma delta."),
    makeNode("n-2", "Epsilon zeta."),
  ];
  const edges = [
    makeEdge("p-0-1", "n-0", "n-1", "precedes", "Alpha beta."),
    makeEdge("p-1-2", "n-1", "n-2", "precedes", "Gamma delta."),
    makeEdge("llm-0", "n-0", "n-2", "supports", "Alpha beta. Gamma delta."),
  ];
  return {
    ir: {
      document_id: "doc-1",
      nodes,
      edges,
      generated_at: "2026-01-01T00:00:00.000Z",
      schema_version: "1.0",
    },
    sourceText: SOURCE,
  };
}

function mutate(
  fn: (ir: SemanticIR) => void
): { ir: SemanticIR; sourceText: string } {
  const built = buildValidIR();
  fn(built.ir);
  return built;
}

function rulesOf(ir: SemanticIR, sourceText: string): string[] {
  return checkIRInvariants(ir, sourceText).map((v) => v.rule);
}

describe("checkIRInvariants — clean IR", () => {
  it("returns no violations for a well-formed IR", () => {
    const { ir, sourceText } = buildValidIR();
    expect(checkIRInvariants(ir, sourceText)).toEqual([]);
  });

  it("accepts an IR with a correctly directed causes edge", () => {
    const { ir, sourceText } = mutate((draft) => {
      draft.edges.push(
        makeEdge("c-0", "n-0", "n-2", "causes", "Alpha beta.")
      );
    });
    expect(rulesOf(ir, sourceText)).toEqual([]);
  });

  it("accepts an IR with a correctly directed revises edge", () => {
    const { ir, sourceText } = mutate((draft) => {
      draft.edges.push(
        makeEdge("r-0", "n-2", "n-0", "revises", "Alpha beta.")
      );
    });
    expect(rulesOf(ir, sourceText)).toEqual([]);
  });

  it("accepts an IR with a synthetic Confluence node fed by contributes_to", () => {
    const { ir, sourceText } = mutate((draft) => {
      const synthetic = makeNode("n-conf", "Alpha beta.", {
        type: "Confluence",
        synthetic: true,
        text_span: null,
        span_location: { start: SOURCE.length, end: SOURCE.length },
      });
      draft.nodes.push(synthetic);
      draft.edges.push(
        makeEdge("ct-0", "n-0", "n-conf", "contributes_to", "Alpha beta.")
      );
    });
    expect(rulesOf(ir, sourceText)).toEqual([]);
  });
});

describe("rule: SCHEMA_INVALID", () => {
  it("flags a node type outside the closed enum", () => {
    const { ir, sourceText } = mutate((draft) => {
      (draft.nodes[0] as { type: string }).type = "NotAType";
    });
    expect(rulesOf(ir, sourceText)).toContain("SCHEMA_INVALID");
  });

  it("flags an edge relation outside the closed enum", () => {
    const { ir, sourceText } = mutate((draft) => {
      (draft.edges[2] as { relation: string }).relation = "made_up_relation";
    });
    expect(rulesOf(ir, sourceText)).toContain("SCHEMA_INVALID");
  });

  it("flags an empty evidence_span", () => {
    const { ir, sourceText } = mutate((draft) => {
      draft.edges[2].evidence_span = "";
    });
    expect(rulesOf(ir, sourceText)).toContain("SCHEMA_INVALID");
  });

  it("flags a wrong schema_version", () => {
    const { ir, sourceText } = mutate((draft) => {
      draft.schema_version = "2.0" as "1.0";
    });
    expect(rulesOf(ir, sourceText)).toContain("SCHEMA_INVALID");
  });
});

describe("rule: SPAN_LOCATION_INVALID / SPAN_OUT_OF_RANGE", () => {
  it("flags a non-integer span", () => {
    const { ir, sourceText } = mutate((draft) => {
      draft.nodes[0].span_location = { start: 0.5, end: 11 };
    });
    expect(rulesOf(ir, sourceText)).toContain("SPAN_LOCATION_INVALID");
  });

  it("flags a span running past the end of the source document", () => {
    const { ir, sourceText } = mutate((draft) => {
      draft.nodes[0].span_location = { start: 0, end: SOURCE.length + 10 };
    });
    expect(rulesOf(ir, sourceText)).toContain("SPAN_OUT_OF_RANGE");
  });

  it("flags a negative span start", () => {
    const { ir, sourceText } = mutate((draft) => {
      draft.nodes[0].span_location = { start: -1, end: 11 };
    });
    expect(rulesOf(ir, sourceText)).toContain("SPAN_OUT_OF_RANGE");
  });

  it("flags an empty span on a non-synthetic node", () => {
    const { ir, sourceText } = mutate((draft) => {
      draft.nodes[0].span_location = { start: 0, end: 0 };
    });
    expect(rulesOf(ir, sourceText)).toContain("SPAN_OUT_OF_RANGE");
  });

  it("flags a non-empty span on a synthetic node", () => {
    const { ir, sourceText } = mutate((draft) => {
      draft.nodes.push(
        makeNode("n-conf", "Alpha beta.", {
          type: "Confluence",
          synthetic: true,
          text_span: null,
          span_location: { start: 0, end: 11 },
        })
      );
      draft.edges.push(
        makeEdge("ct-0", "n-0", "n-conf", "contributes_to", "Alpha beta.")
      );
    });
    expect(rulesOf(ir, sourceText)).toContain("SPAN_OUT_OF_RANGE");
  });
});

describe("rule: DUPLICATE_NODE_ID / DUPLICATE_EDGE_ID", () => {
  it("flags a repeated node id", () => {
    const { ir, sourceText } = mutate((draft) => {
      draft.nodes.push({ ...draft.nodes[1] });
    });
    expect(rulesOf(ir, sourceText)).toContain("DUPLICATE_NODE_ID");
  });

  it("flags a repeated edge id", () => {
    const { ir, sourceText } = mutate((draft) => {
      draft.edges.push({ ...draft.edges[2] });
    });
    expect(rulesOf(ir, sourceText)).toContain("DUPLICATE_EDGE_ID");
  });
});

describe("rule: DANGLING_EDGE_ENDPOINT / SELF_LOOP", () => {
  it("flags an edge whose source does not resolve", () => {
    const { ir, sourceText } = mutate((draft) => {
      draft.edges[2].source_node_id = "n-99";
    });
    expect(rulesOf(ir, sourceText)).toContain("DANGLING_EDGE_ENDPOINT");
  });

  it("flags an edge whose target does not resolve", () => {
    const { ir, sourceText } = mutate((draft) => {
      draft.edges[2].target_node_id = "n-99";
    });
    expect(rulesOf(ir, sourceText)).toContain("DANGLING_EDGE_ENDPOINT");
  });

  it("flags a self-loop", () => {
    const { ir, sourceText } = mutate((draft) => {
      draft.edges[2].target_node_id = draft.edges[2].source_node_id;
    });
    expect(rulesOf(ir, sourceText)).toContain("SELF_LOOP");
  });
});

describe("rule: DOCUMENT_ID_MISMATCH", () => {
  it("flags a node claiming a different source document than the IR", () => {
    const { ir, sourceText } = mutate((draft) => {
      draft.nodes[1].source_document_id = "other-doc.md";
    });
    expect(rulesOf(ir, sourceText)).toContain("DOCUMENT_ID_MISMATCH");
  });

  it("accepts nodes whose source_document_id matches the IR", () => {
    const { ir, sourceText } = buildValidIR();
    expect(rulesOf(ir, sourceText)).toEqual([]);
  });
});

describe("rule: TEXT_SPAN_NOT_VERBATIM", () => {
  it("flags a text_span that is not the source slice at its own offsets", () => {
    const { ir, sourceText } = mutate((draft) => {
      draft.nodes[0].text_span = "Alpha beta gamma.";
    });
    expect(rulesOf(ir, sourceText)).toContain("TEXT_SPAN_NOT_VERBATIM");
  });

  it("flags a paraphrased text_span even when lengths match", () => {
    const { ir, sourceText } = mutate((draft) => {
      draft.nodes[1].text_span = "Gamma betta.";
    });
    expect(rulesOf(ir, sourceText)).toContain("TEXT_SPAN_NOT_VERBATIM");
  });
});

describe("rule: EVIDENCE_NOT_VERBATIM", () => {
  it("flags an evidence_span fabricated by the model", () => {
    const { ir, sourceText } = mutate((draft) => {
      draft.edges[2].evidence_span = "Alpha beta and then some invented text.";
    });
    expect(rulesOf(ir, sourceText)).toContain("EVIDENCE_NOT_VERBATIM");
  });

  it("flags an evidence_span that is a paraphrase of real text", () => {
    const { ir, sourceText } = mutate((draft) => {
      draft.edges[2].evidence_span = "Alpha beta. Gamma betta.";
    });
    expect(rulesOf(ir, sourceText)).toContain("EVIDENCE_NOT_VERBATIM");
  });

  it("flags a precedes edge whose evidence is not its source node's text", () => {
    const { ir, sourceText } = mutate((draft) => {
      draft.edges[0].evidence_span = "Gamma delta.";
    });
    expect(rulesOf(ir, sourceText)).toContain("EVIDENCE_NOT_VERBATIM");
  });
});

describe("rule: PRECEDES_COUNT_INVALID / PRECEDES_CHAIN_INVALID", () => {
  it("flags a missing precedes edge", () => {
    const { ir, sourceText } = mutate((draft) => {
      draft.edges = draft.edges.filter((e) => e.id !== "p-1-2");
    });
    expect(rulesOf(ir, sourceText)).toContain("PRECEDES_COUNT_INVALID");
  });

  it("flags an extra precedes edge", () => {
    const { ir, sourceText } = mutate((draft) => {
      draft.edges.push(
        makeEdge("p-extra", "n-2", "n-0", "precedes", "Epsilon zeta.")
      );
    });
    const rules = rulesOf(ir, sourceText);
    expect(rules).toContain("PRECEDES_COUNT_INVALID");
    expect(rules).toContain("PRECEDES_CHAIN_INVALID");
  });

  it("flags a precedes edge that skips a node while keeping the count", () => {
    const { ir, sourceText } = mutate((draft) => {
      const edge = draft.edges.find((e) => e.id === "p-1-2")!;
      edge.source_node_id = "n-0";
      edge.target_node_id = "n-2";
    });
    expect(rulesOf(ir, sourceText)).toContain("PRECEDES_CHAIN_INVALID");
  });

  it("flags a precedes edge pointing backwards in document order", () => {
    const { ir, sourceText } = mutate((draft) => {
      const edge = draft.edges.find((e) => e.id === "p-0-1")!;
      edge.source_node_id = "n-1";
      edge.target_node_id = "n-0";
      edge.evidence_span = "Gamma delta.";
    });
    expect(rulesOf(ir, sourceText)).toContain("PRECEDES_CHAIN_INVALID");
  });
});

describe("rule: SYNTHETIC_INCONSISTENT / SYNTHETIC_NO_CONTRIBUTOR", () => {
  it("flags a synthetic node carrying source text", () => {
    const { ir, sourceText } = mutate((draft) => {
      draft.nodes.push(
        makeNode("n-conf", "Alpha beta.", {
          type: "Confluence",
          synthetic: true,
          span_location: { start: SOURCE.length, end: SOURCE.length },
        })
      );
      draft.edges.push(
        makeEdge("ct-0", "n-0", "n-conf", "contributes_to", "Alpha beta.")
      );
    });
    expect(rulesOf(ir, sourceText)).toContain("SYNTHETIC_INCONSISTENT");
  });

  it("flags a non-synthetic node with a null text_span", () => {
    const { ir, sourceText } = mutate((draft) => {
      draft.nodes[0].text_span = null;
    });
    expect(rulesOf(ir, sourceText)).toContain("SYNTHETIC_INCONSISTENT");
  });

  it("flags a synthetic node with no inbound contributes_to edge", () => {
    const { ir, sourceText } = mutate((draft) => {
      draft.nodes.push(
        makeNode("n-conf", "Alpha beta.", {
          type: "Confluence",
          synthetic: true,
          text_span: null,
          span_location: { start: SOURCE.length, end: SOURCE.length },
        })
      );
    });
    expect(rulesOf(ir, sourceText)).toContain("SYNTHETIC_NO_CONTRIBUTOR");
  });
});

describe("rule: DIRECTION_RULE_VIOLATION", () => {
  it("flags a causes edge whose source is later than its target", () => {
    const { ir, sourceText } = mutate((draft) => {
      draft.edges.push(
        makeEdge("c-0", "n-2", "n-0", "causes", "Alpha beta.")
      );
    });
    expect(rulesOf(ir, sourceText)).toContain("DIRECTION_RULE_VIOLATION");
  });

  it("flags an enables edge whose source is later than its target", () => {
    const { ir, sourceText } = mutate((draft) => {
      draft.edges.push(
        makeEdge("e-0", "n-2", "n-0", "enables", "Alpha beta.")
      );
    });
    expect(rulesOf(ir, sourceText)).toContain("DIRECTION_RULE_VIOLATION");
  });

  it("flags a revises edge whose source is earlier than its target", () => {
    const { ir, sourceText } = mutate((draft) => {
      draft.edges.push(
        makeEdge("r-0", "n-0", "n-2", "revises", "Alpha beta.")
      );
    });
    expect(rulesOf(ir, sourceText)).toContain("DIRECTION_RULE_VIOLATION");
  });

  it("does not impose a direction rule on relations that have none", () => {
    const { ir, sourceText } = mutate((draft) => {
      draft.edges.push(
        makeEdge("s-0", "n-2", "n-0", "supports", "Alpha beta.")
      );
    });
    expect(rulesOf(ir, sourceText)).toEqual([]);
  });
});

describe("rule: CONFIDENCE_OUT_OF_RANGE", () => {
  it("flags an extraction_confidence above 1", () => {
    const { ir, sourceText } = mutate((draft) => {
      draft.edges[2].extraction_confidence = 1.5;
    });
    expect(rulesOf(ir, sourceText)).toContain("CONFIDENCE_OUT_OF_RANGE");
  });

  it("flags a negative extraction_confidence", () => {
    const { ir, sourceText } = mutate((draft) => {
      draft.edges[2].extraction_confidence = -0.1;
    });
    expect(rulesOf(ir, sourceText)).toContain("CONFIDENCE_OUT_OF_RANGE");
  });

  it("flags an epistemic_confidence above 1", () => {
    const { ir, sourceText } = mutate((draft) => {
      draft.nodes[0].epistemic_confidence = 2;
    });
    expect(rulesOf(ir, sourceText)).toContain("CONFIDENCE_OUT_OF_RANGE");
  });

  it("accepts null epistemic_confidence", () => {
    const { ir, sourceText } = buildValidIR();
    expect(rulesOf(ir, sourceText)).toEqual([]);
  });
});

describe("assertIRInvariants", () => {
  it("does not throw for a clean IR", () => {
    const { ir, sourceText } = buildValidIR();
    expect(() => assertIRInvariants(ir, sourceText)).not.toThrow();
  });

  it("throws with every violation listed", () => {
    const { ir, sourceText } = mutate((draft) => {
      draft.edges[2].evidence_span = "also fabricated";
      draft.edges.push(
        makeEdge("s-bad", "n-0", "n-1", "supports", "fabricated too")
      );
    });

    expect(() => assertIRInvariants(ir, sourceText)).toThrow(
      /Semantic IR failed 2 invariant check\(s\)/
    );
  });

  it("formats violations with rule, subject, and message", () => {
    const { ir, sourceText } = mutate((draft) => {
      draft.edges[2].evidence_span = "fabricated";
    });
    const formatted = formatViolations(checkIRInvariants(ir, sourceText));
    expect(formatted).toMatch(/\[EVIDENCE_NOT_VERBATIM\] llm-0:/);
  });
});
