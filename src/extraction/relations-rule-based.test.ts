import { describe, it, expect } from "vitest";
import type { SemanticNode } from "../schema.js";
import {
  derivePrecedesEdges,
  detectRevisionCandidates,
} from "./relations-rule-based.js";

function node(
  id: string,
  start: number,
  end: number,
  text: string = `text of ${id}`
): SemanticNode {
  return {
    id,
    type: "Claim",
    text_span: text,
    source_document_id: "doc-1",
    span_location: { start, end },
    attribution: { type: "self", ref: null },
    temporal_position: null,
    epistemic_confidence: null,
    synthetic: false,
  };
}

describe("derivePrecedesEdges", () => {
  it("produces n-1 edges for n nodes in order", () => {
    const nodes = [node("a", 0, 10), node("b", 11, 20), node("c", 21, 30)];
    const edges = derivePrecedesEdges(nodes);

    expect(edges).toHaveLength(2);

    expect(edges[0].id).toBe("edge-precedes-a-b");
    expect(edges[0].source_node_id).toBe("a");
    expect(edges[0].target_node_id).toBe("b");
    expect(edges[0].relation).toBe("precedes");
    expect(edges[0].extraction_confidence).toBe(1.0);
    expect(edges[0].evidence_span).toBe("text of a");

    expect(edges[1].id).toBe("edge-precedes-b-c");
    expect(edges[1].source_node_id).toBe("b");
    expect(edges[1].target_node_id).toBe("c");
    expect(edges[1].evidence_span).toBe("text of b");
  });

  it("sorts by span_location.start, not input order", () => {
    // Deliberately shuffled: c comes first in the array but has the highest start
    const nodes = [node("c", 21, 30), node("a", 0, 10), node("b", 11, 20)];
    const edges = derivePrecedesEdges(nodes);

    expect(edges).toHaveLength(2);

    // Edge order must reflect chronological position, not array position
    expect(edges[0].source_node_id).toBe("a");
    expect(edges[0].target_node_id).toBe("b");
    expect(edges[1].source_node_id).toBe("b");
    expect(edges[1].target_node_id).toBe("c");
  });

  it("returns empty array for a single node", () => {
    const edges = derivePrecedesEdges([node("a", 0, 10)]);
    expect(edges).toHaveLength(0);
  });

  it("returns empty array for empty input", () => {
    const edges = derivePrecedesEdges([]);
    expect(edges).toHaveLength(0);
  });

  it("throws if a node has null text_span", () => {
    const synthetic: SemanticNode = {
      id: "syn-1",
      type: "Confluence",
      text_span: null,
      source_document_id: "doc-1",
      span_location: { start: 0, end: 0 },
      attribution: { type: "self", ref: null },
      temporal_position: null,
      epistemic_confidence: null,
      synthetic: true,
    };
    const real = node("a", 10, 20);

    expect(() => derivePrecedesEdges([synthetic, real])).toThrow(
      /null text_span/
    );
  });
});

describe("detectRevisionCandidates", () => {
  it("flags a node matching 'once...now'", () => {
    const nodes = [
      node("a", 0, 50, "Once I loved mornings, now I dread them."),
    ];
    const candidates = detectRevisionCandidates(nodes);

    expect(candidates).toHaveLength(1);
    expect(candidates[0].node_id).toBe("a");
    expect(candidates[0].matched_marker).toBe("once...now");
  });

  it("flags a node matching 'used to...anymore'", () => {
    const nodes = [
      node("a", 0, 50, "I used to run every day, but I don't anymore."),
    ];
    const candidates = detectRevisionCandidates(nodes);

    expect(candidates).toHaveLength(1);
    expect(candidates[0].matched_marker).toBe("used to...anymore");
  });

  it("flags a node matching 'not until...that'", () => {
    const nodes = [
      node(
        "a",
        0,
        60,
        "It was not until the final hearing that the court acknowledged the delay."
      ),
    ];
    const candidates = detectRevisionCandidates(nodes);

    expect(candidates).toHaveLength(1);
    expect(candidates[0].matched_marker).toBe("not until...that");
  });

  it("omits nodes matching no pattern", () => {
    const nodes = [node("a", 0, 30, "The sky is blue today.")];
    const candidates = detectRevisionCandidates(nodes);

    expect(candidates).toHaveLength(0);
  });

  it("returns a node at most once even if multiple patterns match", () => {
    // "once...now" and "used to...anymore" both present
    const nodes = [
      node(
        "a",
        0,
        70,
        "Once I used to believe in fairness, now I don't trust it anymore."
      ),
    ];
    const candidates = detectRevisionCandidates(nodes);

    expect(candidates).toHaveLength(1);
    expect(candidates[0].matched_marker).toBe("once...now");
  });

  it("skips nodes with null text_span", () => {
    const synthetic: SemanticNode = {
      id: "syn-1",
      type: "Confluence",
      text_span: null,
      source_document_id: "doc-1",
      span_location: { start: 0, end: 0 },
      attribution: { type: "self", ref: null },
      temporal_position: null,
      epistemic_confidence: null,
      synthetic: true,
    };
    const candidates = detectRevisionCandidates([synthetic]);
    expect(candidates).toHaveLength(0);
  });
});
