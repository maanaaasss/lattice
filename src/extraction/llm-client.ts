export interface LLMClient {
  complete(systemPrompt: string, userPrompt: string): Promise<string>;
}

export class OpenAICompatibleClient implements LLMClient {
  private baseUrl: string;
  private apiKey: string;
  private model: string;

  constructor(config: { baseUrl: string; apiKey: string; model: string }) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.apiKey = config.apiKey;
    this.model = config.model;
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
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `LLM request failed with status ${response.status}: ${body}`
      );
    }

    const data = (await response.json()) as {
      choices: { message: { content: string } }[];
    };

    return data.choices[0].message.content;
  }
}
