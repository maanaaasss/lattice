import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RateLimitedClient, estimateTokens } from "./rate-limited-client.js";
import type { LLMClient } from "./llm-client.js";

function mockClient(response = "ok"): LLMClient & { calls: Array<{ systemPrompt: string; userPrompt: string }> } {
  const calls: Array<{ systemPrompt: string; userPrompt: string }> = [];
  return {
    calls,
    async complete(systemPrompt: string, userPrompt: string) {
      calls.push({ systemPrompt, userPrompt });
      return response;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers({ now: 0 });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("estimateTokens", () => {
  it("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("returns ceil(length / 4)", () => {
    expect(estimateTokens("a")).toBe(1);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens("abcdefgh")).toBe(2);
    expect(estimateTokens("abcdefghi")).toBe(3);
    expect(estimateTokens("x".repeat(100))).toBe(25);
  });
});

describe("RateLimitedClient", () => {
  it("single call under tpmLimit resolves without delay", async () => {
    const inner = mockClient("hello");
    const client = new RateLimitedClient(inner, { tpmLimit: 100_000, reservedCompletionTokens: 1000 });

    const result = await client.complete("system", "user");
    expect(result).toBe("hello");
    expect(inner.calls).toHaveLength(1);
  });

  it("delays call that would exceed tpmLimit", async () => {
    // cost per call = estimateTokens("su") + 100 = ceil(2/4) + 100 = 101
    // tpmLimit = 200 → room for one call, second call needs to wait
    const inner = mockClient("result");
    const client = new RateLimitedClient(inner, { tpmLimit: 200, reservedCompletionTokens: 100 });

    // First call fits (101 <= 200)
    const r1 = await client.complete("s", "u");
    expect(r1).toBe("result");

    // Second call would be 202 > 200, must wait for first entry to age out
    let resolved = false;
    const p2 = client.complete("s", "u").then((v) => {
      resolved = true;
      return v;
    });

    // Not enough time advanced yet
    await vi.advanceTimersByTimeAsync(10_000);
    expect(resolved).toBe(false);

    // Advance past the 60s + 100ms safety margin
    await vi.advanceTimersByTimeAsync(51_000);
    expect(resolved).toBe(true);

    const r2 = await p2;
    expect(r2).toBe("result");
    expect(inner.calls).toHaveLength(2);
  });

  it("expired entry no longer counts against window", async () => {
    const inner = mockClient("ok");
    const client = new RateLimitedClient(inner, { tpmLimit: 200, reservedCompletionTokens: 100 });

    // First call: cost = 101
    await client.complete("s", "u");

    // Wait long enough for the entry to expire
    await vi.advanceTimersByTimeAsync(61_000);

    // Second call should succeed immediately — first entry is expired
    const r = await client.complete("s", "u");
    expect(r).toBe("ok");
    expect(inner.calls).toHaveLength(2);
  });

  it("estimateTokens and reservedCompletionTokens are summed correctly", async () => {
    // systemPrompt = "abcde" (5 chars → 2 tokens), userPrompt = "abcde" (5 chars → 2 tokens)
    // cost = estimateTokens("abcdeabcde") + 500 = ceil(10/4) + 500 = 3 + 500 = 503
    const inner = mockClient("r");
    const client = new RateLimitedClient(inner, { tpmLimit: 600, reservedCompletionTokens: 500 });

    // First call: 503 <= 600, fits
    await client.complete("abcde", "abcde");

    // Second call: 503 + 503 = 1006 > 600, must wait
    let resolved = false;
    client.complete("abcde", "abcde").then(() => {
      resolved = true;
    });

    await vi.advanceTimersByTimeAsync(50_000);
    expect(resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(11_000);
    expect(resolved).toBe(true);
  });

  it("transparent decorator — passes prompts unchanged and returns inner result", async () => {
    const inner = mockClient("decoration");
    const client = new RateLimitedClient(inner, { tpmLimit: 1_000_000, reservedCompletionTokens: 1000 });

    const result = await client.complete("You are helpful.", "What is 2+2?");
    expect(inner.calls[0]).toEqual({
      systemPrompt: "You are helpful.",
      userPrompt: "What is 2+2?",
    });
    expect(result).toBe("decoration");
  });
});
