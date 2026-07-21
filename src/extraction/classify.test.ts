import { describe, it, expect } from "vitest";
import type { LLMClient } from "./llm-client.js";
import type { RawSegment } from "../segmentation/segment.js";
import { classifySegments, EXTRACTION_SYSTEM_PROMPT, ClassificationSchema } from "./classify.js";

function mockClient(response: string): LLMClient {
  return {
    async complete(_systemPrompt: string, _userPrompt: string) {
      return response;
    },
  };
}

const sampleSegments: RawSegment[] = [
  { text: "I feel overwhelmed by the workload.", start: 0, end: 35, paragraph_index: 0 },
  { text: "The legal aid Act was passed in 1987.", start: 36, end: 73, paragraph_index: 0 },
  { text: "I decided to take a break.", start: 74, end: 100, paragraph_index: 1 },
];

function validResponse() {
  return JSON.stringify({
    classifications: [
      {
        segment_id: "seg-0",
        type: "Emotion",
        attribution: { type: "self", ref: null },
        epistemic_confidence: null,
      },
      {
        segment_id: "seg-1",
        type: "Claim",
        subtype: "Legal fact",
        attribution: { type: "citation", ref: "Legal Aid Act" },
        epistemic_confidence: 0.9,
      },
      {
        segment_id: "seg-2",
        type: "Decision",
        attribution: { type: "self", ref: null },
        epistemic_confidence: null,
      },
    ],
  });
}

describe("classifySegments", () => {
  it("returns correct SemanticNodes from valid LLM output", async () => {
    const client = mockClient(validResponse());
    const nodes = await classifySegments(sampleSegments, "doc-1", client);

    expect(nodes).toHaveLength(3);

    expect(nodes[0].id).toBe("seg-0");
    expect(nodes[0].type).toBe("Emotion");
    expect(nodes[0].text_span).toBe("I feel overwhelmed by the workload.");
    expect(nodes[0].source_document_id).toBe("doc-1");
    expect(nodes[0].span_location).toEqual({ start: 0, end: 35 });
    expect(nodes[0].attribution).toEqual({ type: "self", ref: null });
    expect(nodes[0].epistemic_confidence).toBeNull();
    expect(nodes[0].synthetic).toBe(false);
    expect(nodes[0].temporal_position).toBeNull();

    expect(nodes[1].type).toBe("Claim");
    expect(nodes[1].subtype).toBe("Legal fact");
    expect(nodes[1].attribution).toEqual({ type: "citation", ref: "Legal Aid Act" });
    expect(nodes[1].epistemic_confidence).toBe(0.9);

    expect(nodes[2].type).toBe("Decision");
    expect(nodes[2].text_span).toBe("I decided to take a break.");
    expect(nodes[2].span_location).toEqual({ start: 74, end: 100 });
  });

  it("strips markdown code fences before parsing", async () => {
    const fenced = "```json\n" + validResponse() + "\n```";
    const client = mockClient(fenced);
    const nodes = await classifySegments(sampleSegments, "doc-1", client);

    expect(nodes).toHaveLength(3);
    expect(nodes[0].type).toBe("Emotion");
  });

  it("throws on invalid node type", async () => {
    const invalid = JSON.stringify({
      classifications: [
        {
          segment_id: "seg-0",
          type: "Confluence",
          attribution: { type: "self", ref: null },
          epistemic_confidence: null,
        },
        {
          segment_id: "seg-1",
          type: "Claim",
          attribution: { type: "self", ref: null },
          epistemic_confidence: null,
        },
        {
          segment_id: "seg-2",
          type: "Decision",
          attribution: { type: "self", ref: null },
          epistemic_confidence: null,
        },
      ],
    });

    const client = mockClient(invalid);
    await expect(classifySegments(sampleSegments, "doc-1", client)).rejects.toThrow();
  });

  it("throws on missing required field", async () => {
    const missing = JSON.stringify({
      classifications: [
        {
          segment_id: "seg-0",
          type: "Emotion",
          attribution: { type: "self", ref: null },
          // missing epistemic_confidence
        },
        {
          segment_id: "seg-1",
          type: "Claim",
          attribution: { type: "self", ref: null },
          epistemic_confidence: null,
        },
        {
          segment_id: "seg-2",
          type: "Decision",
          attribution: { type: "self", ref: null },
          epistemic_confidence: null,
        },
      ],
    });

    const client = mockClient(missing);
    await expect(classifySegments(sampleSegments, "doc-1", client)).rejects.toThrow();
  });

  it("throws on count mismatch (fewer classifications than segments)", async () => {
    const tooFew = JSON.stringify({
      classifications: [
        {
          segment_id: "seg-0",
          type: "Emotion",
          attribution: { type: "self", ref: null },
          epistemic_confidence: null,
        },
      ],
    });

    const client = mockClient(tooFew);
    await expect(classifySegments(sampleSegments, "doc-1", client)).rejects.toThrow(
      "Classification count mismatch"
    );
  });

  it("throws on mismatched segment_id", async () => {
    const wrongId = JSON.stringify({
      classifications: [
        {
          segment_id: "seg-0",
          type: "Emotion",
          attribution: { type: "self", ref: null },
          epistemic_confidence: null,
        },
        {
          segment_id: "seg-1",
          type: "Claim",
          attribution: { type: "self", ref: null },
          epistemic_confidence: null,
        },
        {
          segment_id: "seg-99",
          type: "Decision",
          attribution: { type: "self", ref: null },
          epistemic_confidence: null,
        },
      ],
    });

    const client = mockClient(wrongId);
    await expect(classifySegments(sampleSegments, "doc-1", client)).rejects.toThrow(
      'Missing classification for segment "seg-2"'
    );
  });

  it("passes the system prompt to the client", async () => {
    let capturedSystem = "";
    let capturedUser = "";
    const spy: LLMClient = {
      async complete(systemPrompt: string, userPrompt: string) {
        capturedSystem = systemPrompt;
        capturedUser = userPrompt;
        return validResponse();
      },
    };

    await classifySegments(sampleSegments, "doc-1", spy);

    expect(capturedSystem).toBe(EXTRACTION_SYSTEM_PROMPT);
    const parsed = JSON.parse(capturedUser);
    expect(parsed).toHaveLength(3);
    expect(parsed[0].id).toBe("seg-0");
    expect(parsed[0].text).toBe("I feel overwhelmed by the workload.");
  });
});

describe("ClassificationSchema", () => {
  it("parses valid classification data", () => {
    const result = ClassificationSchema.safeParse({
      classifications: [
        {
          segment_id: "seg-0",
          type: "Claim",
          attribution: { type: "self", ref: null },
          epistemic_confidence: 0.5,
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects Confluence as a type", () => {
    const result = ClassificationSchema.safeParse({
      classifications: [
        {
          segment_id: "seg-0",
          type: "Confluence",
          attribution: { type: "self", ref: null },
          epistemic_confidence: null,
        },
      ],
    });
    expect(result.success).toBe(false);
  });
});
