export interface LLMClient {
  complete(systemPrompt: string, userPrompt: string): Promise<string>;
}

export class OpenAICompatibleClient implements LLMClient {
  private baseUrl: string;
  private apiKey: string;
  private model: string;
  private maxTokens: number;

  constructor(config: { baseUrl: string; apiKey: string; model: string; maxTokens?: number }) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.apiKey = config.apiKey;
    this.model = config.model;
    // Default to 8192 — a reasonable starting point for most providers,
    // not a verified per-provider limit. Override via config.maxTokens
    // if a provider's actual limit is known.
    this.maxTokens = config.maxTokens ?? 8192;
  }

  async complete(systemPrompt: string, userPrompt: string): Promise<string> {
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        response_format: { type: "json_object" },
        max_tokens: this.maxTokens,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `LLM request failed with status ${response.status}: ${body}`
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
