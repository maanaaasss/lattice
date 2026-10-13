import { describe, it, expect, vi, afterEach } from "vitest";
import { OpenAICompatibleClient, DailyTokenLimitError } from "./llm-client.js";
import type { HttpTransport } from "./transport.js";

function makeClient(transport: HttpTransport) {
  return new OpenAICompatibleClient({
    baseUrl: "https://api.example.com/v1",
    apiKey: "test-key",
    model: "test-model",
    transport,
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
    const fetchSpy = vi.fn<HttpTransport>().mockResolvedValue(
      jsonResponse({
        choices: [{ message: { content: '{"result":"ok"}' } }],
      })
    );

    const client = makeClient(fetchSpy);
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
    const transport = vi.fn<HttpTransport>().mockResolvedValue(
      textResponse("Unauthorized access", 401)
    );

    const client = makeClient(transport);
    await expect(client.complete("sys", "usr")).rejects.toThrow(
      "LLM request failed with status 401: Unauthorized access"
    );
  });

  it("throws on 500 response with body", async () => {
    const transport = vi.fn<HttpTransport>().mockResolvedValue(
      textResponse("Internal Server Error", 500)
    );

    const client = makeClient(transport);
    await expect(client.complete("sys", "usr")).rejects.toThrow(
      "LLM request failed with status 500: Internal Server Error"
    );
  });

  it("throws on empty choices array", async () => {
    const transport = vi.fn<HttpTransport>().mockResolvedValue(
      jsonResponse({ choices: [] })
    );

    const client = makeClient(transport);
    await expect(client.complete("sys", "usr")).rejects.toThrow(
      'LLM response missing or empty "choices" array'
    );
  });

  it("throws when choices is not an array", async () => {
    const transport = vi.fn<HttpTransport>().mockResolvedValue(
      jsonResponse({ choices: "not-an-array" })
    );

    const client = makeClient(transport);
    await expect(client.complete("sys", "usr")).rejects.toThrow(
      'LLM response missing or empty "choices" array'
    );
  });

  it("throws when choices is missing entirely", async () => {
    const transport = vi.fn<HttpTransport>().mockResolvedValue(
      jsonResponse({ usage: { total_tokens: 0 } })
    );

    const client = makeClient(transport);
    await expect(client.complete("sys", "usr")).rejects.toThrow(
      'LLM response missing or empty "choices" array'
    );
  });

  it("throws when message.content is missing", async () => {
    const transport = vi.fn<HttpTransport>().mockResolvedValue(
      jsonResponse({
        choices: [{ message: { role: "assistant" } }],
      })
    );

    const client = makeClient(transport);
    await expect(client.complete("sys", "usr")).rejects.toThrow(
      "choices[0].message.content is missing or not a string"
    );
  });

  it("throws when message.content is not a string", async () => {
    const transport = vi.fn<HttpTransport>().mockResolvedValue(
      jsonResponse({
        choices: [{ message: { content: 123 } }],
      })
    );

    const client = makeClient(transport);
    await expect(client.complete("sys", "usr")).rejects.toThrow(
      "choices[0].message.content is missing or not a string"
    );
  });

  it("truncates long response bodies in error messages", async () => {
    const longBody = { choices: null, detail: "x".repeat(1000) };
    const transport = vi.fn<HttpTransport>().mockResolvedValue(
      jsonResponse(longBody)
    );

    const client = makeClient(transport);
    const err: unknown = await client.complete("sys", "usr").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("choices");
    expect((err as Error).message.length).toBeLessThan(2000);
  });

  it("sends max_tokens: 4096 by default when no maxTokens is provided", async () => {
    const fetchSpy = vi.fn<HttpTransport>().mockResolvedValue(
      jsonResponse({ choices: [{ message: { content: "ok" } }] })
    );

    const client = makeClient(fetchSpy);
    await client.complete("sys", "usr");

    const body = JSON.parse(String(fetchSpy.mock.calls[0][1].body)) as { max_tokens: number };
    expect(body.max_tokens).toBe(4096);
  });

  it("sends a custom maxTokens value when provided in config", async () => {
    const fetchSpy = vi.fn<HttpTransport>().mockResolvedValue(
      jsonResponse({ choices: [{ message: { content: "ok" } }] })
    );

    const client = new OpenAICompatibleClient({
      baseUrl: "https://api.example.com/v1",
      apiKey: "test-key",
      model: "test-model",
      transport: fetchSpy,
      maxTokens: 4096,
    });
    await client.complete("sys", "usr");

    const body = JSON.parse(String(fetchSpy.mock.calls[0][1].body)) as { max_tokens: number };
    expect(body.max_tokens).toBe(4096);
  });
});

describe("OpenAICompatibleClient retry-on-429", () => {
  function rateLimitResponse(body: string, retryAfter?: string) {
    const headers: Record<string, string> = { "Content-Type": "text/plain" };
    if (retryAfter !== undefined) {
      headers["Retry-After"] = retryAfter;
    }
    return new Response(body, { status: 429, headers });
  }

  function successResponse(content: string) {
    return jsonResponse({
      choices: [{ message: { content } }],
    });
  }

  it("retries on 429 with Retry-After header and resolves on success", async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.fn<HttpTransport>()
      .mockResolvedValueOnce(rateLimitResponse("rate limited", "2"))
      .mockResolvedValueOnce(successResponse("ok after retry"));

    const client = new OpenAICompatibleClient({
      baseUrl: "https://api.example.com/v1",
      apiKey: "test-key",
      model: "test-model",
      transport: fetchSpy,
    });

    const promise = client.complete("sys", "usr");

    // Advance past Retry-After: 2s + 500ms safety margin = 2500ms
    await vi.advanceTimersByTimeAsync(2500);

    const result = await promise;
    expect(result).toBe("ok after retry");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("parses wait time from response body when no Retry-After header", async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.fn<HttpTransport>()
      .mockResolvedValueOnce(rateLimitResponse("Please try again in 3.5s"))
      .mockResolvedValueOnce(successResponse("ok after body retry"));

    const client = new OpenAICompatibleClient({
      baseUrl: "https://api.example.com/v1",
      apiKey: "test-key",
      model: "test-model",
      transport: fetchSpy,
    });

    const promise = client.complete("sys", "usr");

    // 3.5s + 500ms safety = 4000ms
    await vi.advanceTimersByTimeAsync(4000);

    const result = await promise;
    expect(result).toBe("ok after body retry");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("throws after exhausting maxRetries on persistent 429", async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.fn<HttpTransport>()
      .mockImplementation(() => Promise.resolve(rateLimitResponse("rate limited", "1")));

    const client = new OpenAICompatibleClient({
      baseUrl: "https://api.example.com/v1",
      apiKey: "test-key",
      model: "test-model",
      transport: fetchSpy,
      maxRetries: 2,
    });

    const promise = client.complete("sys", "usr").catch((e: unknown) => e);

    // Flush all pending microtasks and timers
    await vi.runAllTimersAsync();

    const err = await promise;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe(
      "LLM request failed with status 429: rate limited"
    );
    // 1 initial + 2 retries = 3 fetch calls
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it("retried request has the same body as the original attempt", async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.fn<HttpTransport>()
      .mockResolvedValueOnce(rateLimitResponse("rate limited", "1"))
      .mockResolvedValueOnce(successResponse("ok"));

    const client = new OpenAICompatibleClient({
      baseUrl: "https://api.example.com/v1",
      apiKey: "test-key",
      model: "test-model",
      transport: fetchSpy,
    });

    const promise = client.complete("sys prompt", "usr prompt");

    await vi.advanceTimersByTimeAsync(1500);

    await promise;

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[0][1].body).toBe(fetchSpy.mock.calls[1][1].body);
    vi.useRealTimers();
  });
});

describe("OpenAICompatibleClient daily token limit (TPD)", () => {
  const TPD_BODY = '{"error":{"message":"Rate limit reached for model `openai/gpt-oss-120b` in organization `org_01kdyjjc50e6xb2qnxyj43kv66` service tier `on_demand` on tokens per day (TPD): Limit 200000, Used 197494, Requested 4035. Please try again in 11m0.528s. Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing","type":"compound","code":"rate_limit_exceeded"}}';

  const TPM_BODY = '{"error":{"message":"Rate limit reached for model `llama-3.3-70b-versatile` in organization `org_01kdyjjc50e6xb2qnxyj43kv66` service tier `on_demand` on tokens per minute (TPM): Limit 12000, Used 8560, Requested 4177. Please try again in 3.685s. Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing","type":"compound","code":"rate_limit_exceeded"}}';

  function tpdResponse() {
    return new Response(TPD_BODY, {
      status: 429,
      headers: { "Content-Type": "application/json" },
    });
  }

  function tpmResponse() {
    return new Response(TPM_BODY, {
      status: 429,
      headers: { "Content-Type": "application/json" },
    });
  }

  function successResponse(content: string) {
    return jsonResponse({
      choices: [{ message: { content } }],
    });
  }

  it("throws DailyTokenLimitError immediately on TPD 429 with exactly 1 fetch call and zero retries", async () => {
    const fetchSpy = vi.fn<HttpTransport>().mockResolvedValueOnce(tpdResponse());

    const client = new OpenAICompatibleClient({
      baseUrl: "https://api.example.com/v1",
      apiKey: "test-key",
      model: "test-model",
      transport: fetchSpy,
      maxRetries: 3,
    });

    const err: unknown = await client.complete("sys", "usr").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DailyTokenLimitError);
    expect((err as Error).message).toContain("tokens per day (TPD)");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("includes the full raw Groq message in DailyTokenLimitError", async () => {
    const fetchSpy = vi.fn<HttpTransport>().mockResolvedValueOnce(tpdResponse());

    const client = makeClient(fetchSpy);

    const err: unknown = await client.complete("sys", "usr").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DailyTokenLimitError);
    expect((err as DailyTokenLimitError).message).toContain("openai/gpt-oss-120b");
    expect((err as DailyTokenLimitError).message).toContain("200000");
    expect((err as DailyTokenLimitError).message).toContain("try again in 11m0.528s");
  });

  it("TPM 429 still retries normally — not affected by TPD detection", async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.fn<HttpTransport>()
      .mockResolvedValueOnce(tpmResponse())
      .mockResolvedValueOnce(successResponse("ok after tpm retry"));

    const client = new OpenAICompatibleClient({
      baseUrl: "https://api.example.com/v1",
      apiKey: "test-key",
      model: "test-model",
      transport: fetchSpy,
    });

    const promise = client.complete("sys", "usr");

    // TPM body says "try again in 3.685s" → 3685ms + 500ms safety = 4185ms
    await vi.advanceTimersByTimeAsync(4200);

    const result = await promise;
    expect(result).toBe("ok after tpm retry");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});

describe("OpenAICompatibleClient.usageLog", () => {
  function successWithUsage(content: string, usage: Record<string, unknown>) {
    return new Response(
      JSON.stringify({ choices: [{ message: { content } }], usage }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }

  function successWithoutUsage(content: string) {
    return new Response(
      JSON.stringify({ choices: [{ message: { content } }] }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }

  it("starts empty", () => {
    expect(makeClient(vi.fn<HttpTransport>()).usageLog).toEqual([]);
  });

  it("records one entry per successful call with reasoning tokens", async () => {
    const transport = vi.fn<HttpTransport>().mockResolvedValue(
      successWithUsage("a", {
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
        completion_tokens_details: { reasoning_tokens: 30 },
      })
    );

    const client = makeClient(transport);
    await client.complete("sys", "usr");

    expect(client.usageLog).toEqual([
      {
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
        reasoningTokens: 30,
      },
    ]);
  });

  it("records null reasoning tokens when the detail is absent", async () => {
    const transport = vi.fn<HttpTransport>().mockResolvedValue(
      successWithUsage("a", {
        prompt_tokens: 200,
        completion_tokens: 80,
        total_tokens: 280,
      })
    );

    const client = makeClient(transport);
    await client.complete("sys", "usr");

    expect(client.usageLog).toHaveLength(1);
    expect(client.usageLog[0].reasoningTokens).toBeNull();
  });

  it("appends across calls rather than overwriting", async () => {
    const transport = vi
      .fn<HttpTransport>()
      .mockResolvedValueOnce(
        successWithUsage("a", {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
        })
      )
      .mockResolvedValueOnce(
        successWithUsage("b", {
          prompt_tokens: 20,
          completion_tokens: 5,
          total_tokens: 25,
        })
      );

    const client = makeClient(transport);
    await client.complete("sys", "usr");
    await client.complete("sys", "usr");

    expect(client.usageLog).toHaveLength(2);
    expect(client.usageLog.map((u) => u.totalTokens)).toEqual([15, 25]);
  });

  it("records nothing when the response omits usage", async () => {
    const transport = vi.fn<HttpTransport>().mockResolvedValue(successWithoutUsage("ok"));

    const client = makeClient(transport);
    await client.complete("sys", "usr");

    expect(client.usageLog).toEqual([]);
  });

  it("does not record an entry for a failed request", async () => {
    const transport = vi.fn<HttpTransport>().mockResolvedValue(new Response("boom", { status: 500 }));

    const client = makeClient(transport);
    await expect(client.complete("sys", "usr")).rejects.toThrow();

    expect(client.usageLog).toEqual([]);
  });
});
