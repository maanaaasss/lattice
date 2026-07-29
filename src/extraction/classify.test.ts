import { describe, it, expect } from "vitest";
import type { LLMClient } from "./llm-client.js";
import type { RawSegment } from "../segmentation/segment.js";
import { classifySegments, classifySegmentsBatched, EXTRACTION_SYSTEM_PROMPT, ClassificationSchema } from "./classify.js";

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

  it("includes raw response text and classifications array length in Zod validation error", async () => {
    const rawFrag = "some unexpected model output with unique marker XYZZY";
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
      _note: rawFrag,
    });

    const client = mockClient(invalid);
    const err = await classifySegments(sampleSegments, "doc-1", client).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(msg).toContain("Classification schema validation failed");
    expect(msg).toContain("Actual classifications array length: 3");
    expect(msg).toContain(rawFrag);
    expect(msg).toContain("invalid_value");
  });

  it("tolerates omitted epistemic_confidence and normalizes to null", async () => {
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
    const nodes = await classifySegments(sampleSegments, "doc-1", client);

    expect(nodes).toHaveLength(3);
    expect(nodes[0].epistemic_confidence).toBeNull();
    expect(nodes[1].epistemic_confidence).toBeNull();
    expect(nodes[2].epistemic_confidence).toBeNull();
  });

  it("throws on malformed epistemic_confidence (wrong type)", async () => {
    const malformed = JSON.stringify({
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
          epistemic_confidence: "high",
        },
        {
          segment_id: "seg-2",
          type: "Decision",
          attribution: { type: "self", ref: null },
          epistemic_confidence: null,
        },
      ],
    });

    const client = mockClient(malformed);
    await expect(classifySegments(sampleSegments, "doc-1", client)).rejects.toThrow();
  });

  it("tolerates omitted attribution.ref and normalizes to null", async () => {
    const omittedRef = JSON.stringify({
      classifications: [
        {
          segment_id: "seg-0",
          type: "Emotion",
          attribution: { type: "self" },
          epistemic_confidence: null,
        },
        {
          segment_id: "seg-1",
          type: "Claim",
          attribution: { type: "citation", ref: "Legal Aid Act" },
          epistemic_confidence: 0.9,
        },
        {
          segment_id: "seg-2",
          type: "Decision",
          attribution: { type: "self" },
          epistemic_confidence: null,
        },
      ],
    });

    const client = mockClient(omittedRef);
    const nodes = await classifySegments(sampleSegments, "doc-1", client);

    expect(nodes).toHaveLength(3);
    expect(nodes[0].attribution).toEqual({ type: "self", ref: null });
    expect(nodes[2].attribution).toEqual({ type: "self", ref: null });
  });

  it("throws on malformed attribution.ref (wrong type)", async () => {
    const malformedRef = JSON.stringify({
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
          attribution: { type: "self", ref: 42 },
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

    const client = mockClient(malformedRef);
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

  it("accepts explicit null subtype and normalizes to undefined", async () => {
    const nullSubtypeResponse = JSON.stringify({
      classifications: [
        {
          segment_id: "seg-0",
          type: "Emotion",
          subtype: null,
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

    const client = mockClient(nullSubtypeResponse);
    const nodes = await classifySegments(sampleSegments, "doc-1", client);

    expect(nodes).toHaveLength(3);
    expect(nodes[0].subtype).toBeUndefined();
    expect(nodes[1].subtype).toBe("Legal fact");
    expect(nodes[2].subtype).toBeUndefined();
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

  it("uses startIndex to generate globally correct segment ids", async () => {
    const dynamicClient: LLMClient = {
      async complete(_systemPrompt: string, userPrompt: string) {
        const segments = JSON.parse(userPrompt);
        return JSON.stringify({
          classifications: segments.map((s: { id: string }) => ({
            segment_id: s.id,
            type: "Emotion",
            attribution: { type: "self", ref: null },
            epistemic_confidence: null,
          })),
        });
      },
    };
    const nodes = await classifySegments(sampleSegments, "doc-1", dynamicClient, 5);

    expect(nodes).toHaveLength(3);
    expect(nodes[0].id).toBe("seg-5");
    expect(nodes[1].id).toBe("seg-6");
    expect(nodes[2].id).toBe("seg-7");
  });
});

describe("classifySegmentsBatched", () => {
  function makeSegments(count: number): RawSegment[] {
    return Array.from({ length: count }, (_, i) => ({
      text: `Segment ${i} text.`,
      start: i * 20,
      end: (i + 1) * 20 - 1,
      paragraph_index: 0,
    }));
  }

  function makeDynamicClient(): LLMClient & { calls: string[][] } {
    const client: LLMClient & { calls: string[][] } = {
      calls: [],
      async complete(_systemPrompt: string, userPrompt: string) {
        const segments = JSON.parse(userPrompt);
        client.calls.push(segments.map((s: { id: string }) => s.id));

        return JSON.stringify({
          classifications: segments.map((s: { id: string; text: string }) => ({
            segment_id: s.id,
            type: "Claim",
            attribution: { type: "self", ref: null },
            epistemic_confidence: null,
          })),
        });
      },
    };
    return client;
  }

  it("makes exactly one call when segments.length <= batchSize", async () => {
    const segments = makeSegments(3);
    const client = makeDynamicClient();

    const nodes = await classifySegmentsBatched(segments, "doc-1", client, 5);

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]).toEqual(["seg-0", "seg-1", "seg-2"]);
    expect(nodes).toHaveLength(3);
    expect(nodes[0].id).toBe("seg-0");
    expect(nodes[1].id).toBe("seg-1");
    expect(nodes[2].id).toBe("seg-2");
  });

  it("produces the same result as classifySegments for non-batched input", async () => {
    const segments = makeSegments(3);
    const client1 = makeDynamicClient();
    const client2 = makeDynamicClient();

    const batched = await classifySegmentsBatched(segments, "doc-1", client1, 5);
    const direct = await classifySegments(segments, "doc-1", client2);

    expect(batched).toEqual(direct);
  });

  it("splits into correct batches with globally unique ids", async () => {
    const segments = makeSegments(5);
    const client = makeDynamicClient();

    const nodes = await classifySegmentsBatched(segments, "doc-1", client, 2);

    expect(client.calls).toHaveLength(3);
    expect(client.calls[0]).toEqual(["seg-0", "seg-1"]);
    expect(client.calls[1]).toEqual(["seg-2", "seg-3"]);
    expect(client.calls[2]).toEqual(["seg-4"]);

    expect(nodes).toHaveLength(5);
    expect(nodes.map((n) => n.id)).toEqual(["seg-0", "seg-1", "seg-2", "seg-3", "seg-4"]);
  });

  it("runs batches sequentially, not concurrently", async () => {
    const segments = makeSegments(5);
    let inFlight = 0;
    let maxConcurrent = 0;

    const client: LLMClient = {
      async complete(_systemPrompt: string, userPrompt: string) {
        inFlight++;
        if (inFlight > maxConcurrent) maxConcurrent = inFlight;

        const segs = JSON.parse(userPrompt);
        await new Promise((r) => setTimeout(r, 10));
        inFlight--;

        return JSON.stringify({
          classifications: segs.map((s: { id: string }) => ({
            segment_id: s.id,
            type: "Claim",
            attribution: { type: "self", ref: null },
            epistemic_confidence: null,
          })),
        });
      },
    };

    await classifySegmentsBatched(segments, "doc-1", client, 2);

    expect(maxConcurrent).toBe(1);
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
