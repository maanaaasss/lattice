import { sleep } from "../runtime.js";
import type { HttpTransport, HttpResponse } from "./transport.js";

export interface LLMClient {
  complete(systemPrompt: string, userPrompt: string): Promise<string>;
}

export interface LLMUsageRecord {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  reasoningTokens: number | null;
}

export class DailyTokenLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DailyTokenLimitError";
  }
}

// Provider error bodies are untrusted JSON: every field is read through a
// narrow, typed accessor rather than trusting the shape.
interface ApiErrorFields {
  message?: string;
  code?: string;
  failedGeneration?: string;
}

function readApiError(responseBody: string): ApiErrorFields {
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseBody) as unknown;
  } catch {
    return {};
  }
  if (parsed == null || typeof parsed !== "object") return {};
  const error = (parsed as Record<string, unknown>).error;
  if (error == null || typeof error !== "object") return {};
  const fields = error as Record<string, unknown>;
  const out: ApiErrorFields = {};
  if (typeof fields.message === "string") out.message = fields.message;
  if (typeof fields.code === "string") out.code = fields.code;
  if (typeof fields.failed_generation === "string") {
    out.failedGeneration = fields.failed_generation;
  }
  return out;
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: unknown } }>;
  usage?: {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    total_tokens?: unknown;
    completion_tokens_details?: { reasoning_tokens?: unknown };
  };
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export class OpenAICompatibleClient implements LLMClient {
  // Every response's token accounting, accumulated across the client's
  // lifetime so callers can report what a run actually cost instead of
  // reconstructing it from stdout.
  readonly usageLog: LLMUsageRecord[] = [];

  private baseUrl: string;
  private apiKey: string;
  private model: string;
  private maxTokens: number;
  private maxRetries: number;
  private transport: HttpTransport;

  constructor(config: {
    baseUrl: string;
    apiKey: string;
    model: string;
    transport: HttpTransport;
    maxTokens?: number;
    maxRetries?: number;
  }) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.transport = config.transport;
    // Default to 4096 — enough for a 10-20 segment classification batch's JSON
    // output on gpt-oss-20b.  Keeps reserved cost under Groq's 8K TPM limit so
    // RateLimitedClient can actually enforce its sliding window.  Override via
    // config.maxTokens.
    this.maxTokens = config.maxTokens ?? 4096;
    this.maxRetries = config.maxRetries ?? 3;
  }

  async complete(systemPrompt: string, userPrompt: string): Promise<string> {
    const requestBody = JSON.stringify({
      model: this.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      response_format: { type: "json_object" },
      max_tokens: this.maxTokens,
    });

    let retriesLeft = this.maxRetries;

    while (true) {
      const response = await this.transport(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: requestBody,
      });

      if (!response.ok) {
        const bodyText = await response.text();

        if (response.status === 429 && retriesLeft > 0) {
          const apiError = readApiError(bodyText);
          if (apiError.message && /tokens per day/i.test(apiError.message)) {
            // A TPD 429's "try again in Xs" is a rolling-window artifact that
            // only guarantees room for one more request — retrying into it the
            // way a TPM 429 is retried would be wrong. Fail fast instead.
            throw new DailyTokenLimitError(apiError.message);
          }
          retriesLeft--;
          const waitMs = parseRetryAfter(response.headers, bodyText);
          await sleep(waitMs);
          continue;
        }

        if (response.status === 400) {
          const apiError = readApiError(bodyText);
          if (
            apiError.code === "json_validate_failed" &&
            apiError.failedGeneration !== undefined
          ) {
            return apiError.failedGeneration;
          }
        }

        throw new Error(
          `LLM request failed with status ${response.status}: ${bodyText}`
        );
      }

      const data = (await response.json()) as ChatCompletionResponse;
      const preview = JSON.stringify(data).slice(0, 500);

      if (!Array.isArray(data.choices) || data.choices.length === 0) {
        throw new Error(
          `LLM response missing or empty "choices" array. Response body: ${preview}`
        );
      }

      const choice = data.choices[0];
      if (!choice.message || typeof choice.message.content !== "string") {
        throw new Error(
          `LLM response choices[0].message.content is missing or not a string. Response body: ${preview}`
        );
      }

      if (data.usage) {
        this.usageLog.push({
          promptTokens: asNumber(data.usage.prompt_tokens) ?? 0,
          completionTokens: asNumber(data.usage.completion_tokens) ?? 0,
          totalTokens: asNumber(data.usage.total_tokens) ?? 0,
          reasoningTokens: asNumber(
            data.usage.completion_tokens_details?.reasoning_tokens
          ),
        });
      }

      return choice.message.content;
    }
  }
}

function parseRetryAfter(
  headers: HttpResponse["headers"],
  bodyText: string
): number {
  const retryAfterHeader = headers.get("Retry-After");
  if (retryAfterHeader) {
    const seconds = parseFloat(retryAfterHeader);
    if (!isNaN(seconds) && seconds > 0) {
      return seconds * 1000 + 500;
    }
  }

  const bodyMatch = bodyText.match(/try again in ([\d.]+)s/i);
  if (bodyMatch) {
    const seconds = parseFloat(bodyMatch[1]);
    if (!isNaN(seconds) && seconds > 0) {
      return seconds * 1000 + 500;
    }
  }

  return 5500;
}
