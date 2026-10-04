import { describe, it, expect } from "vitest";
import {
  validateGoldDocument,
  verifySource,
  findSegmentOverlaps,
  type GoldDocument,
} from "./gold.js";

function validDoc(): GoldDocument {
  return {
    document: "test-documents/short-diary.txt",
    document_sha256: "a".repeat(64),
    labeled_by: "draft-model",
    reviewed: false,
    created_at: "2026-01-01T00:00:00.000Z",
    segments: [
      { start: 0, end: 11, type: "Claim" },
      { start: 12, end: 24, type: "Emotion" },
    ],
    edges: [
      {
        source: { start: 0, end: 11 },
        target: { start: 12, end: 24 },
        relation: "supports",
      },
    ],
  };
}

describe("validateGoldDocument", () => {
  it("accepts a well-formed document", () => {
    const result = validateGoldDocument(validDoc());

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.data?.segments).toHaveLength(2);
  });

  it("rejects a node type outside the schema enum", () => {
    const doc = validDoc() as unknown as { segments: Array<Record<string, unknown>> };
    doc.segments[0].type = "Holding";

    const result = validateGoldDocument(doc);

    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toMatch(/segments\.0\.type/);
  });

  it("rejects a malformed digest", () => {
    const doc = { ...validDoc(), document_sha256: "not-a-digest" };

    const result = validateGoldDocument(doc);

    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toMatch(/document_sha256/);
  });

  it("requires the reviewed flag to be present", () => {
    const { reviewed: _reviewed, ...withoutFlag } = validDoc();

    const result = validateGoldDocument(withoutFlag);

    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toMatch(/reviewed/);
  });

  it("rejects an empty segment list", () => {
    const result = validateGoldDocument({ ...validDoc(), segments: [] });

    expect(result.ok).toBe(false);
  });

  it("reports the path of each bad field", () => {
    const doc = {
      ...validDoc(),
      edges: [
        {
          source: { start: 0, end: 11 },
          target: { start: 12, end: 24 },
          relation: "made_up",
        },
      ],
    };

    const result = validateGoldDocument(doc);

    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.startsWith("edges.0.relation"))).toBe(true);
  });
});

describe("verifySource", () => {
  it("accepts a matching digest and a source long enough for every span", () => {
    const problems = verifySource(validDoc(), {
      sourceText: "x".repeat(64),
      sha256: "a".repeat(64),
    });

    expect(problems).toEqual([]);
  });

  it("flags a digest mismatch", () => {
    const problems = verifySource(validDoc(), {
      sourceText: "x".repeat(64),
      sha256: "b".repeat(64),
    });

    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/document_sha256 mismatch/);
  });

  it("flags spans that run past the end of the source", () => {
    const problems = verifySource(validDoc(), {
      sourceText: "x".repeat(10),
      sha256: "a".repeat(64),
    });

    expect(problems.join("\n")).toMatch(/is only 10 characters/);
  });

  it("flags an out-of-range segment that is not the last entry", () => {
    const doc = {
      ...validDoc(),
      segments: [
        { start: 0, end: 500, type: "Claim" as const },
        { start: 12, end: 24, type: "Emotion" as const },
      ],
    };

    const problems = verifySource(doc, {
      sourceText: "x".repeat(64),
      sha256: "a".repeat(64),
    });

    expect(problems.join("\n")).toMatch(/\[0, 500\)/);
  });
});

describe("findSegmentOverlaps", () => {
  it("accepts non-overlapping segments", () => {
    expect(
      findSegmentOverlaps([
        { start: 0, end: 11, type: "Claim" },
        { start: 12, end: 24, type: "Emotion" },
      ])
    ).toEqual([]);
  });

  it("flags overlapping segments", () => {
    const problems = findSegmentOverlaps([
      { start: 0, end: 20, type: "Claim" },
      { start: 12, end: 24, type: "Emotion" },
    ]);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/segments overlap/);
  });

  it("flags an empty segment", () => {
    const problems = findSegmentOverlaps([{ start: 5, end: 5, type: "Claim" }]);

    expect(problems.join("\n")).toMatch(/is empty/);
  });
});
