export interface LLMClient {
  complete(systemPrompt: string, userPrompt: string): Promise<string>;
}

export class DailyTokenLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DailyTokenLimitError";
  }
}

export class OpenAICompatibleClient implements LLMClient {
  private baseUrl: string;
  private apiKey: string;
  private model: string;
  private maxTokens: number;
  private maxRetries: number;

  constructor(config: { baseUrl: string; apiKey: string; model: string; maxTokens?: number; maxRetries?: number }) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.apiKey = config.apiKey;
    this.model = config.model;
    // Default to 2048 — confirmed safe for Groq's free tier (6000 TPM);
    // 8192 caused immediate 413 (TPM budget exceeded) even on tiny requests.
    // Still not sufficient for large documents (needs chunking) and not
    // verified against every provider. Override via config.maxTokens.
    this.maxTokens = config.maxTokens ?? 2048;
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

    const requestInit: RequestInit = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: requestBody,
    };

    let retriesLeft = this.maxRetries;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const response = await fetch(`${this.baseUrl}/chat/completions`, requestInit);

      if (!response.ok) {
        const bodyText = await response.text();

        if (response.status === 429 && retriesLeft > 0) {
          try {
            const body = JSON.parse(bodyText);
            if (typeof body?.error?.message === "string" && /tokens per day/i.test(body.error.message)) {
              throw new DailyTokenLimitError(body.error.message);
            }
          } catch (e) {
            if (e instanceof DailyTokenLimitError) throw e;
            /* not parseable or no message field — fall through to retry */
          }
          retriesLeft--;
          const waitMs = this.parseRetryAfter(response.headers, bodyText);
          await new Promise((resolve) => setTimeout(resolve, waitMs));
          continue;
        }

        if (response.status === 400) {
          try {
            const body = JSON.parse(bodyText);
            if (body?.error?.code === "json_validate_failed" && typeof body?.error?.failed_generation === "string") {
              return body.error.failed_generation;
            }
          } catch { /* not parseable, fall through */ }
        }

        throw new Error(
          `LLM request failed with status ${response.status}: ${bodyText}`
        );
      }

      const data = await response.json();
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

      return choice.message.content;
    }
  }

  private parseRetryAfter(headers: Headers, bodyText: string): number {
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
}
