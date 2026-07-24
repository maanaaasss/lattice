import { describe, it, expect, vi, afterEach } from "vitest";
import { OpenAICompatibleClient } from "./llm-client.js";

function makeClient() {
  return new OpenAICompatibleClient({
    baseUrl: "https://api.example.com/v1",
    apiKey: "test-key",
    model: "test-model",
  });
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function textResponse(body: string, status: number) {
  return new Response(body, { status });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("OpenAICompatibleClient", () => {
  it("returns content from a well-formed response", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse({
        choices: [{ message: { content: '{"result":"ok"}' } }],
      })
    );
    vi.stubGlobal("fetch", fetchSpy);

    const client = makeClient();
    const result = await client.complete("sys", "usr");

    expect(result).toBe('{"result":"ok"}');
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://api.example.com/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer test-key",
        },
      })
    );
  });

  it("throws on non-2xx response with status and body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      textResponse("Unauthorized access", 401)
    ));

    const client = makeClient();
    await expect(client.complete("sys", "usr")).rejects.toThrow(
      "LLM request failed with status 401: Unauthorized access"
    );
  });

  it("throws on 500 response with body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      textResponse("Internal Server Error", 500)
    ));

    const client = makeClient();
    await expect(client.complete("sys", "usr")).rejects.toThrow(
      "LLM request failed with status 500: Internal Server Error"
    );
  });

  it("throws on empty choices array", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      jsonResponse({ choices: [] })
    ));

    const client = makeClient();
    await expect(client.complete("sys", "usr")).rejects.toThrow(
      'LLM response missing or empty "choices" array'
    );
  });

  it("throws when choices is not an array", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      jsonResponse({ choices: "not-an-array" })
    ));

    const client = makeClient();
    await expect(client.complete("sys", "usr")).rejects.toThrow(
      'LLM response missing or empty "choices" array'
    );
  });

  it("throws when choices is missing entirely", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      jsonResponse({ usage: { total_tokens: 0 } })
    ));

    const client = makeClient();
    await expect(client.complete("sys", "usr")).rejects.toThrow(
      'LLM response missing or empty "choices" array'
    );
  });

  it("throws when message.content is missing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      jsonResponse({
        choices: [{ message: { role: "assistant" } }],
      })
    ));

    const client = makeClient();
    await expect(client.complete("sys", "usr")).rejects.toThrow(
      "choices[0].message.content is missing or not a string"
    );
  });

  it("throws when message.content is not a string", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      jsonResponse({
        choices: [{ message: { content: 123 } }],
      })
    ));

    const client = makeClient();
    await expect(client.complete("sys", "usr")).rejects.toThrow(
      "choices[0].message.content is missing or not a string"
    );
  });

  it("truncates long response bodies in error messages", async () => {
    const longBody = { choices: null, detail: "x".repeat(1000) };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      jsonResponse(longBody)
    ));

    const client = makeClient();
    const err: unknown = await client.complete("sys", "usr").catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("choices");
    expect((err as Error).message.length).toBeLessThan(2000);
  });

  it("sends max_tokens: 8192 by default when no maxTokens is provided", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse({ choices: [{ message: { content: "ok" } }] })
    );
    vi.stubGlobal("fetch", fetchSpy);

    const client = makeClient();
    await client.complete("sys", "usr");

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.max_tokens).toBe(8192);
  });

  it("sends a custom maxTokens value when provided in config", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse({ choices: [{ message: { content: "ok" } }] })
    );
    vi.stubGlobal("fetch", fetchSpy);

    const client = new OpenAICompatibleClient({
      baseUrl: "https://api.example.com/v1",
      apiKey: "test-key",
      model: "test-model",
      maxTokens: 4096,
    });
    await client.complete("sys", "usr");

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.max_tokens).toBe(4096);
  });
});
