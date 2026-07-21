import { describe, it, expect } from "vitest";
import { segmentText } from "./segment.js";

describe("segmentText", () => {
  it("splits a short multi-sentence paragraph into correct segments", () => {
    const input = "Hello world. This is a test. Goodbye for now.";
    const segs = segmentText(input);

    expect(segs).toHaveLength(3);
    expect(segs[0].text).toBe("Hello world.");
    expect(segs[1].text).toBe("This is a test.");
    expect(segs[2].text).toBe("Goodbye for now.");
    expect(segs[0].paragraph_index).toBe(0);
  });

  it("does not split on common abbreviations", () => {
    const input = "Dr. Smith arrived. The meeting began at 3 p.m. sharp.";
    const segs = segmentText(input);

    expect(segs).toHaveLength(2);
    expect(segs[0].text).toBe("Dr. Smith arrived.");
    expect(segs[1].text).toBe("The meeting began at 3 p.m. sharp.");
  });

  it("handles multiple abbreviations in one sentence", () => {
    const input = "The U.S. and U.K. agreed. Then they signed the treaty.";
    const segs = segmentText(input);

    expect(segs).toHaveLength(2);
    expect(segs[0].text).toBe("The U.S. and U.K. agreed.");
    expect(segs[1].text).toBe("Then they signed the treaty.");
  });

  it("increments paragraph_index across blank-line-separated paragraphs", () => {
    const input = "First sentence. Second sentence.\n\nThird sentence. Fourth sentence.";
    const segs = segmentText(input);

    expect(segs).toHaveLength(4);
    expect(segs[0].paragraph_index).toBe(0);
    expect(segs[1].paragraph_index).toBe(0);
    expect(segs[2].paragraph_index).toBe(1);
    expect(segs[3].paragraph_index).toBe(1);
  });

  it("handles three paragraphs separated by blank lines", () => {
    const input = "Alpha. Beta.\n\nGamma. Delta.\n\nEpsilon. Zeta.";
    const segs = segmentText(input);

    expect(segs).toHaveLength(6);
    expect(segs[0].paragraph_index).toBe(0);
    expect(segs[1].paragraph_index).toBe(0);
    expect(segs[2].paragraph_index).toBe(1);
    expect(segs[3].paragraph_index).toBe(1);
    expect(segs[4].paragraph_index).toBe(2);
    expect(segs[5].paragraph_index).toBe(2);
  });

  it("satisfies the offset invariant for a multi-paragraph sample", () => {
    const input = "Dr. Smith went to Washington. He arrived on Monday.\n\nThe U.S. delegation met him. They discussed Ph.D. programs. Everything went well.";
    const segs = segmentText(input);

    for (const seg of segs) {
      expect(input.slice(seg.start, seg.end)).toBe(seg.text);
    }
  });

  it("returns empty array for empty input", () => {
    expect(segmentText("")).toEqual([]);
  });

  it("handles single sentence", () => {
    const input = "Just one sentence.";
    const segs = segmentText(input);

    expect(segs).toHaveLength(1);
    expect(segs[0].text).toBe("Just one sentence.");
    expect(segs[0].start).toBe(0);
    expect(segs[0].end).toBe(input.length);
  });
});
