import { describe, it, expect } from "vitest";
import type {
  SemanticIR,
  SemanticNode,
  SemanticEdge,
  NodeType,
} from "../schema.js";
import type { GoldDocument, GoldSegment, GoldEdge } from "./gold.js";
import {
  alignNodes,
  classificationReport,
  attributionReport,
  edgeReport,
  jaccard,
  irEdgeKeys,
  stabilityReport,
  countDirectionCorrections,
  evaluateRun,
  summarize,
  mean,
  std,
  NO_PREDICTION,
  NO_GOLD,
} from "./metrics.js";

type AttributionType = "self" | "citation" | "external";

function segment(
  start: number,
  end: number,
  type: NodeType,
  attribution?: AttributionType
): GoldSegment {
  return {
    start,
    end,
    type,
    ...(attribution ? { attribution: { type: attribution } } : {}),
  };
}

function node(
  id: string,
  start: number,
  end: number,
  type: NodeType,
  attribution: AttributionType = "self"
): SemanticNode {
  return {
    id,
    type,
    text_span: `text-${id}`,
    source_document_id: "doc",
    span_location: { start, end },
    attribution: { type: attribution, ref: null },
    temporal_position: null,
    epistemic_confidence: null,
    synthetic: false,
  };
}

function edge(
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
    extraction_confidence: 1,
    evidence_span: "evidence",
  };
}

function makeIR(nodes: SemanticNode[], edges: SemanticEdge[]): SemanticIR {
  return {
    document_id: "doc",
    nodes,
    edges,
    generated_at: "2026-01-01T00:00:00.000Z",
    schema_version: "1.0",
  };
}

function goldEdge(
  source: [number, number],
  target: [number, number],
  relation: SemanticEdge["relation"]
): GoldEdge {
  return {
    source: { start: source[0], end: source[1] },
    target: { start: target[0], end: target[1] },
    relation,
  };
}

function makeGold(segments: GoldSegment[], edges: GoldEdge[]): GoldDocument {
  return {
    document: "doc.txt",
    document_sha256: "0".repeat(64),
    labeled_by: "test",
    reviewed: true,
    created_at: "2026-01-01T00:00:00.000Z",
    segments,
    edges,
  };
}

describe("alignNodes", () => {
  it("matches on identical spans and reports the rest", () => {
    const gold = [segment(0, 10, "Claim"), segment(20, 30, "Emotion")];
    const nodes = [
      node("n-0", 0, 10, "Claim"),
      node("n-1", 40, 50, "Event"),
    ];

    const result = alignNodes(gold, nodes);

    expect(result.matched).toEqual([{ goldIndex: 0, nodeIndex: 0 }]);
    expect(result.missed).toEqual([1]);
    expect(result.spurious).toEqual([1]);
  });

  it("never aligns synthetic nodes", () => {
    const gold = [segment(0, 10, "Claim")];
    const nodes: SemanticNode[] = [
      { ...node("n-conf", 0, 0, "Confluence"), synthetic: true, text_span: null },
    ];

    const result = alignNodes(gold, nodes);

    expect(result.matched).toEqual([]);
    expect(result.missed).toEqual([0]);
    expect(result.spurious).toEqual([]);
  });
});

describe("classificationReport", () => {
  it("scores a perfect prediction at 1 across the board", () => {
    const gold = [
      segment(0, 10, "Claim"),
      segment(20, 30, "Emotion"),
      segment(40, 50, "Claim"),
      segment(60, 70, "Event"),
    ];
    const nodes = [
      node("n-0", 0, 10, "Claim"),
      node("n-1", 20, 30, "Emotion"),
      node("n-2", 40, 50, "Claim"),
      node("n-3", 60, 70, "Event"),
    ];

    const report = classificationReport(gold, nodes);

    expect(report.macroF1).toBeCloseTo(1, 5);
    expect(report.microF1).toBeCloseTo(1, 5);
    expect(report.accuracy).toBeCloseTo(1, 5);
    expect(report.missed).toBe(0);
    expect(report.spurious).toBe(0);
  });

  it("produces the hand-computed values for a mixed prediction", () => {
    const gold = [
      segment(0, 10, "Claim"),
      segment(20, 30, "Emotion"),
      segment(40, 50, "Claim"),
      segment(60, 70, "Event"),
    ];
    const nodes = [
      node("n-0", 0, 10, "Claim"),
      node("n-1", 20, 30, "Claim"),
      node("n-2", 40, 50, "Claim"),
    ];

    const report = classificationReport(gold, nodes);
    const byType = Object.fromEntries(report.perType.map((r) => [r.type, r]));

    expect(byType.Claim.precision).toBeCloseTo(2 / 3, 5);
    expect(byType.Claim.recall).toBeCloseTo(1, 5);
    expect(byType.Claim.f1).toBeCloseTo(0.8, 5);
    expect(byType.Emotion.f1).toBe(0);
    expect(byType.Event.f1).toBe(0);

    expect(report.macroF1).toBeCloseTo(0.8 / 3, 5);
    expect(report.accuracy).toBeCloseTo(0.5, 5);
    expect(report.microF1).toBeCloseTo(0.5714285, 5);
    expect(report.missed).toBe(1);
  });

  it("records a missed segment as no prediction", () => {
    const gold = [segment(0, 10, "Claim")];
    const report = classificationReport(gold, []);

    expect(report.confusion).toEqual([
      { gold: "Claim", predicted: NO_PREDICTION, count: 1 },
    ]);
    expect(report.perType[0].recall).toBe(0);
  });

  it("records an unpredicted node as spurious", () => {
    const gold = [segment(0, 10, "Claim")];
    const nodes = [node("n-0", 0, 10, "Claim"), node("n-1", 20, 30, "Event")];

    const report = classificationReport(gold, nodes);

    expect(report.spurious).toBe(1);
    expect(report.confusion).toContainEqual({
      gold: NO_GOLD,
      predicted: "Event",
      count: 1,
    });
    expect(report.accuracy).toBeCloseTo(1, 5);
    expect(report.microF1).toBeCloseTo(2 * 0.5 * 1 / 1.5, 5);
    expect(report.macroF1).toBeCloseTo(0.5, 5);
  });

  it("counts a type absent from gold as a zero-precision class", () => {
    const gold = [segment(0, 10, "Claim"), segment(20, 30, "Claim")];
    const nodes = [
      node("n-0", 0, 10, "Value"),
      node("n-1", 20, 30, "Claim"),
    ];

    const report = classificationReport(gold, nodes);
    const byType = Object.fromEntries(report.perType.map((r) => [r.type, r]));

    expect(report.perType.map((r) => r.type)).toEqual(["Claim", "Value"]);
    expect(byType.Claim.recall).toBeCloseTo(0.5, 5);
    expect(byType.Claim.precision).toBeCloseTo(1, 5);
    expect(byType.Value.precision).toBe(0);
    expect(byType.Value.f1).toBe(0);
    expect(report.macroF1).toBeCloseTo((2 * 1 * 0.5 / 1.5) / 2, 5);
  });
});

describe("attributionReport", () => {
  it("reports null accuracies when nothing is labeled", () => {
    const gold = [segment(0, 10, "Emotion")];
    const nodes = [node("n-0", 0, 10, "Emotion")];

    const report = attributionReport(gold, nodes);

    expect(report.labeled).toBe(0);
    expect(report.accuracy).toBeNull();
    expect(report.nonSelfAccuracy).toBeNull();
  });

  it("hides a citation miss inside a perfect aggregate, then exposes it", () => {
    const gold = [
      segment(0, 10, "Emotion", "self"),
      segment(20, 30, "Claim", "citation"),
    ];
    const nodes = [
      node("n-0", 0, 10, "Emotion", "self"),
      node("n-1", 20, 30, "Claim", "self"),
    ];

    const report = attributionReport(gold, nodes);

    expect(report.accuracy).toBeCloseTo(0.5, 5);
    expect(report.nonSelfLabeled).toBe(1);
    expect(report.nonSelfAccuracy).toBe(0);
    expect(report.mismatches).toEqual([
      { start: 20, end: 30, gold: "citation", predicted: "self" },
    ]);
  });

  it("scores every labeled span correct when predictions agree", () => {
    const gold = [
      segment(0, 10, "Emotion", "self"),
      segment(20, 30, "Claim", "citation"),
    ];
    const nodes = [
      node("n-0", 0, 10, "Emotion", "self"),
      node("n-1", 20, 30, "Claim", "citation"),
    ];

    const report = attributionReport(gold, nodes);

    expect(report.accuracy).toBe(1);
    expect(report.nonSelfAccuracy).toBe(1);
    expect(report.mismatches).toEqual([]);
  });
});

describe("edgeReport", () => {
  const nodes = [
    node("a", 0, 5, "Claim"),
    node("b", 10, 15, "Observation"),
    node("c", 20, 25, "Event"),
    node("d", 30, 35, "Event"),
    node("e", 40, 45, "Claim"),
    node("f", 50, 55, "Claim"),
  ];

  const gold: GoldEdge[] = [
    goldEdge([0, 5], [10, 15], "supports"),
    goldEdge([20, 25], [30, 35], "causes"),
  ];

  function predictedEdges(includePrecedes: boolean): SemanticEdge[] {
    const edges = [
      edge("e-0", "a", "b", "supports"),
      edge("e-1", "d", "c", "causes"),
      edge("e-2", "e", "f", "elaborates"),
    ];
    if (includePrecedes) edges.push(edge("p-0", "a", "b", "precedes"));
    return edges;
  }

  it("scores exact, reversed, and fabricated edges separately", () => {
    const report = edgeReport(gold, makeIR(nodes, predictedEdges(false)), "llm");

    expect(report.goldTotal).toBe(2);
    expect(report.predictedTotal).toBe(3);
    expect(report.tp).toBe(1);
    expect(report.fp).toBe(2);
    expect(report.fn).toBe(1);
    expect(report.precision).toBeCloseTo(1 / 3, 5);
    expect(report.recall).toBeCloseTo(1 / 2, 5);
    expect(report.f1).toBeCloseTo(0.4, 5);
    expect(report.direction.exact).toBe(1);
    expect(report.direction.reversed).toBe(1);
    expect(report.direction.accuracy).toBeCloseTo(0.5, 5);
  });

  it("groups results by relation family", () => {
    const report = edgeReport(gold, makeIR(nodes, predictedEdges(false)), "llm");
    const byFamily = Object.fromEntries(report.byFamily.map((f) => [f.family, f]));

    expect(byFamily.logical.goldTotal).toBe(1);
    expect(byFamily.logical.predictedTotal).toBe(2);
    expect(byFamily.logical.f1).toBeCloseTo(2 * 0.5 * 1 / 1.5, 5);
    expect(byFamily.causal.f1).toBe(0);
    expect(report.macroF1ByFamily).toBeCloseTo((2 * 0.5 * 1 / 1.5) / 2, 5);
  });

  it("excludes precedes from the llm scope and counts it in all", () => {
    const ir = makeIR(nodes, predictedEdges(true));

    const llm = edgeReport(gold, ir, "llm");
    const all = edgeReport(gold, ir, "all");

    expect(llm.predictedTotal).toBe(3);
    expect(all.predictedTotal).toBe(4);
    expect(all.fp).toBe(3);
    expect(llm.fp).toBe(2);
  });

  it("reports null direction accuracy when no direction-bearing edge exists", () => {
    const report = edgeReport([], makeIR(nodes, []), "llm");

    expect(report.direction.accuracy).toBeNull();
    expect(report.precision).toBe(0);
    expect(report.recall).toBe(0);
    expect(report.f1).toBe(0);
  });

  it("counts an edge reversed only when the reverse is in gold", () => {
    const reversedOnly = makeIR(nodes, [edge("e-1", "d", "c", "causes")]);
    const report = edgeReport(gold, reversedOnly, "llm");

    expect(report.tp).toBe(0);
    expect(report.fp).toBe(1);
    expect(report.direction.exact).toBe(0);
    expect(report.direction.reversed).toBe(1);
    expect(report.direction.accuracy).toBe(0);
  });

  it("counts a duplicated gold label once rather than deflating recall", () => {
    const repeated = [...gold, goldEdge([0, 5], [10, 15], "supports")];
    const perfectIr = makeIR(nodes, [
      edge("e-0", "a", "b", "supports"),
      edge("e-1", "c", "d", "causes"),
    ]);

    const report = edgeReport(repeated, perfectIr, "llm");
    const logical = report.byFamily.find((f) => f.family === "logical");

    expect(report.goldTotal).toBe(2);
    expect(report.recall).toBe(1);
    expect(logical?.goldTotal).toBe(1);
    expect(logical?.recall).toBe(1);
  });

  it("applies scope to gold as well as predictions", () => {
    const goldWithPrecedes = [
      ...gold,
      goldEdge([0, 5], [10, 15], "precedes"),
    ];
    const ir = makeIR(nodes, predictedEdges(true));

    const llm = edgeReport(goldWithPrecedes, ir, "llm");
    const all = edgeReport(goldWithPrecedes, ir, "all");

    expect(llm.goldTotal).toBe(2);
    expect(all.goldTotal).toBe(3);

    // Every rule-derived edge matches its gold counterpart, so the all-scope
    // run is perfect once the LLM edges are also correct.
    const perfectIr = makeIR(nodes, [
      edge("e-0", "a", "b", "supports"),
      edge("e-1", "c", "d", "causes"),
      edge("p-0", "a", "b", "precedes"),
    ]);
    const perfectAll = edgeReport(goldWithPrecedes, perfectIr, "all");
    expect(perfectAll.f1).toBe(1);
    expect(perfectAll.direction.accuracy).toBe(1);
  });
});

describe("jaccard and stability", () => {
  it("scores identical and disjoint sets", () => {
    expect(jaccard(new Set(["a", "b"]), new Set(["a", "b"]))).toBe(1);
    expect(jaccard(new Set(["a"]), new Set(["b"]))).toBe(0);
    expect(jaccard(new Set(["a", "b"]), new Set(["b", "c"]))).toBeCloseTo(1 / 3, 5);
    expect(jaccard(new Set<string>(), new Set<string>())).toBe(1);
  });

  it("reports nulls for a single run", () => {
    const ir = makeIR([node("a", 0, 5, "Claim")], []);
    const report = stabilityReport([ir]);

    expect(report.edgeJaccardMean).toBeNull();
    expect(report.nodeTypeAgreement).toBeNull();
  });

  it("reports perfect stability for identical runs", () => {
    const build = (): SemanticIR =>
      makeIR(
        [node("a", 0, 5, "Claim"), node("b", 10, 15, "Emotion")],
        [edge("e-0", "a", "b", "supports"), edge("p-0", "a", "b", "precedes")]
      );

    const report = stabilityReport([build(), build()]);

    expect(report.edgeJaccardMean).toBe(1);
    expect(report.edgeJaccardMin).toBe(1);
    expect(report.nodeTypeAgreement).toBe(1);
  });

  it("reports disagreement when one run labels a segment differently", () => {
    const runA = makeIR(
      [node("a", 0, 5, "Claim"), node("b", 10, 15, "Emotion")],
      [edge("e-0", "a", "b", "supports")]
    );
    const runB = makeIR(
      [node("a", 0, 5, "Claim"), node("b", 10, 15, "Claim")],
      [edge("e-0", "a", "b", "supports")]
    );

    const report = stabilityReport([runA, runB]);

    expect(report.edgeJaccardMean).toBe(1);
    expect(report.nodeTypeAgreement).toBeCloseTo(0.5, 5);
  });

  it("derives the edge key set from an IR", () => {
    const ir = makeIR(
      [node("a", 0, 5, "Claim"), node("b", 10, 15, "Emotion")],
      [edge("e-0", "a", "b", "supports")]
    );

    expect([...irEdgeKeys(ir)]).toEqual(["0:5->10:15|supports"]);
  });
});

describe("countDirectionCorrections", () => {
  it("counts edges whose source changed", () => {
    const before = [edge("e-0", "n-late", "n-early", "causes")];
    const after = [edge("e-0", "n-early", "n-late", "causes")];

    expect(countDirectionCorrections(before, after)).toBe(1);
  });

  it("counts nothing when directions are untouched", () => {
    const before = [edge("e-0", "n-early", "n-late", "supports")];
    const after = [edge("e-0", "n-early", "n-late", "supports")];

    expect(countDirectionCorrections(before, after)).toBe(0);
  });

  it("ignores edges dropped by assembly", () => {
    const before = [edge("e-0", "a", "b", "supports")];

    expect(countDirectionCorrections(before, [])).toBe(0);
  });
});

describe("summarize", () => {
  it("aggregates present values and drops nulls", () => {
    const result = summarize([0.5, null, 0.7]);

    expect(result.mean).toBeCloseTo(0.6, 5);
    expect(result.std).toBeCloseTo(Math.sqrt(0.02), 5);
    expect(result.min).toBe(0.5);
    expect(result.max).toBe(0.7);
  });

  it("returns nulls when every value is null", () => {
    expect(summarize([null, null])).toEqual({
      mean: null,
      std: null,
      min: null,
      max: null,
    });
  });

  it("reports zero spread for a single value", () => {
    expect(summarize([0.4]).std).toBe(0);
  });

  it("computes mean and sample standard deviation", () => {
    expect(mean([1, 2, 3])).toBe(2);
    expect(std([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.13809, 4);
  });
});

describe("evaluateRun", () => {
  it("bundles node, attribution, and edge reports", () => {
    const gold = makeGold(
      [segment(0, 5, "Claim"), segment(10, 15, "Observation", "self")],
      [goldEdge([0, 5], [10, 15], "supports")]
    );
    const ir = makeIR(
      [node("a", 0, 5, "Claim"), node("b", 10, 15, "Observation")],
      [edge("e-0", "a", "b", "supports")]
    );

    const metrics = evaluateRun(gold, ir);

    expect(metrics.nodes.macroF1).toBe(1);
    expect(metrics.attribution.accuracy).toBe(1);
    expect(metrics.edgesLlm.f1).toBe(1);
    expect(metrics.edgesAll.f1).toBe(1);
  });
});
