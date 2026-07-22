import { describe, it, expect } from "vitest";
import type { SemanticNode } from "../schema.js";
import type { LLMClient } from "./llm-client.js";
import type { RevisionCandidate } from "./relations-rule-based.js";
import {
  extractRelations,
  EXTRACT_RELATIONS_SYSTEM_PROMPT,
} from "./extract-relations.js";

function mockClient(response: string): LLMClient {
  return {
    async complete(_systemPrompt: string, _userPrompt: string) {
      return response;
    },
  };
}

function node(id: string, text: string): SemanticNode {
  return {
    id,
    type: "Claim",
    text_span: text,
    source_document_id: "doc-1",
    span_location: { start: 0, end: text.length },
    attribution: { type: "self", ref: null },
    temporal_position: null,
    epistemic_confidence: null,
    synthetic: false,
  };
}

const sourceDoc =
  "I used to believe in fairness. The court held that bail is a right. This undermined access to justice.";

const nodes: SemanticNode[] = [
  node("seg-0", "I used to believe in fairness."),
  node("seg-1", "The court held that bail is a right."),
  node("seg-2", "This undermined access to justice."),
];

const noRevisions: RevisionCandidate[] = [];

describe("extractRelations", () => {
  it("returns correct SemanticEdge[] for a valid response with 2 edges", async () => {
    const response = JSON.stringify({
      edges: [
        {
          source_node_id: "seg-0",
          target_node_id: "seg-1",
          relation: "supports",
          evidence_span: "I used to believe in fairness.",
          extraction_confidence: 0.7,
          interpretation_group: null,
        },
        {
          source_node_id: "seg-2",
          target_node_id: "seg-1",
          relation: "undercuts",
          evidence_span: "This undermined access to justice.",
          extraction_confidence: 0.9,
        },
      ],
    });

    const edges = await extractRelations(
      nodes,
      noRevisions,
      sourceDoc,
      mockClient(response)
    );

    expect(edges).toHaveLength(2);

    expect(edges[0].id).toBe("edge-llm-0");
    expect(edges[0].source_node_id).toBe("seg-0");
    expect(edges[0].target_node_id).toBe("seg-1");
    expect(edges[0].relation).toBe("supports");
    expect(edges[0].extraction_confidence).toBe(0.7);
    expect(edges[0].evidence_span).toBe("I used to believe in fairness.");
    expect(edges[0].interpretation_group).toBeUndefined();

    expect(edges[1].id).toBe("edge-llm-1");
    expect(edges[1].source_node_id).toBe("seg-2");
    expect(edges[1].target_node_id).toBe("seg-1");
    expect(edges[1].relation).toBe("undercuts");
    expect(edges[1].extraction_confidence).toBe(0.9);
    expect(edges[1].interpretation_group).toBeUndefined();
  });

  it("throws when source_node_id is not in the node list", async () => {
    const response = JSON.stringify({
      edges: [
        {
          source_node_id: "seg-99",
          target_node_id: "seg-1",
          relation: "supports",
          evidence_span: "I used to believe in fairness.",
          extraction_confidence: 0.5,
        },
      ],
    });

    await expect(
      extractRelations(nodes, noRevisions, sourceDoc, mockClient(response))
    ).rejects.toThrow(/Invalid source_node_id "seg-99"/);
  });

  it("throws when target_node_id is not in the node list", async () => {
    const response = JSON.stringify({
      edges: [
        {
          source_node_id: "seg-0",
          target_node_id: "seg-99",
          relation: "supports",
          evidence_span: "I used to believe in fairness.",
          extraction_confidence: 0.5,
        },
      ],
    });

    await expect(
      extractRelations(nodes, noRevisions, sourceDoc, mockClient(response))
    ).rejects.toThrow(/Invalid target_node_id "seg-99"/);
  });

  it("throws on a self-loop", async () => {
    const response = JSON.stringify({
      edges: [
        {
          source_node_id: "seg-0",
          target_node_id: "seg-0",
          relation: "elaborates",
          evidence_span: "I used to believe in fairness.",
          extraction_confidence: 0.6,
        },
      ],
    });

    await expect(
      extractRelations(nodes, noRevisions, sourceDoc, mockClient(response))
    ).rejects.toThrow(/Self-loop.*seg-0/);
  });

  it("throws when evidence_span is not a verbatim substring of sourceDocumentText", async () => {
    const response = JSON.stringify({
      edges: [
        {
          source_node_id: "seg-0",
          target_node_id: "seg-1",
          relation: "supports",
          evidence_span: "this text does not appear in the source document",
          extraction_confidence: 0.5,
        },
      ],
    });

    await expect(
      extractRelations(nodes, noRevisions, sourceDoc, mockClient(response))
    ).rejects.toThrow(/not a verbatim substring/);
  });

  it("throws on a disallowed relation type (e.g. 'precedes') via Zod", async () => {
    const response = JSON.stringify({
      edges: [
        {
          source_node_id: "seg-0",
          target_node_id: "seg-1",
          relation: "precedes",
          evidence_span: "I used to believe in fairness.",
          extraction_confidence: 1.0,
        },
      ],
    });

    await expect(
      extractRelations(nodes, noRevisions, sourceDoc, mockClient(response))
    ).rejects.toThrow();
  });

  it("throws on an invented relation type via Zod", async () => {
    const response = JSON.stringify({
      edges: [
        {
          source_node_id: "seg-0",
          target_node_id: "seg-1",
          relation: "magically_transforms",
          evidence_span: "I used to believe in fairness.",
          extraction_confidence: 0.5,
        },
      ],
    });

    await expect(
      extractRelations(nodes, noRevisions, sourceDoc, mockClient(response))
    ).rejects.toThrow();
  });

  it("preserves interpretation_group when two edges share one", async () => {
    const response = JSON.stringify({
      edges: [
        {
          source_node_id: "seg-0",
          target_node_id: "seg-1",
          relation: "supports",
          evidence_span: "I used to believe in fairness.",
          extraction_confidence: 0.6,
          interpretation_group: "ambig-1",
        },
        {
          source_node_id: "seg-0",
          target_node_id: "seg-1",
          relation: "generalizes",
          evidence_span: "I used to believe in fairness.",
          extraction_confidence: 0.4,
          interpretation_group: "ambig-1",
        },
      ],
    });

    const edges = await extractRelations(
      nodes,
      noRevisions,
      sourceDoc,
      mockClient(response)
    );

    expect(edges).toHaveLength(2);
    expect(edges[0].interpretation_group).toBe("ambig-1");
    expect(edges[1].interpretation_group).toBe("ambig-1");
  });

  it("returns empty array for an empty edges response", async () => {
    const response = JSON.stringify({ edges: [] });

    const edges = await extractRelations(
      nodes,
      noRevisions,
      sourceDoc,
      mockClient(response)
    );

    expect(edges).toHaveLength(0);
  });

  it("passes the system prompt and a JSON user prompt to the client", async () => {
    let capturedSystem = "";
    let capturedUser = "";
    const spy: LLMClient = {
      async complete(systemPrompt: string, userPrompt: string) {
        capturedSystem = systemPrompt;
        capturedUser = userPrompt;
        return JSON.stringify({ edges: [] });
      },
    };

    await extractRelations(nodes, noRevisions, sourceDoc, spy);

    expect(capturedSystem).toBe(EXTRACT_RELATIONS_SYSTEM_PROMPT);
    const parsed = JSON.parse(capturedUser);
    expect(parsed.nodes).toHaveLength(3);
    expect(parsed.nodes[0].id).toBe("seg-0");
    expect(parsed.nodes[0].type).toBe("Claim");
    expect(parsed.nodes[0].text).toBe("I used to believe in fairness.");
    expect(parsed.revision_candidates).toEqual([]);
  });

  it("includes revision candidates in the user prompt", async () => {
    let capturedUser = "";
    const candidates: RevisionCandidate[] = [
      { node_id: "seg-0", matched_marker: "used to...anymore" },
    ];
    const spy: LLMClient = {
      async complete(_systemPrompt: string, userPrompt: string) {
        capturedUser = userPrompt;
        return JSON.stringify({ edges: [] });
      },
    };

    await extractRelations(nodes, candidates, sourceDoc, spy);

    const parsed = JSON.parse(capturedUser);
    expect(parsed.revision_candidates).toHaveLength(1);
    expect(parsed.revision_candidates[0].node_id).toBe("seg-0");
    expect(parsed.revision_candidates[0].matched_marker).toBe(
      "used to...anymore"
    );
  });
});
