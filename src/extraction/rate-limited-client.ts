import type { LLMClient } from "./llm-client.js";

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

interface WindowEntry {
  timestamp: number;
  cost: number;
}

export class RateLimitedClient implements LLMClient {
  private inner: LLMClient;
  private tpmLimit: number;
  // Deliberately separate from OpenAICompatibleClient's maxTokens (the API
  // ceiling).  This is a calibrated reservation for rate-limiter budgeting
  // only — conflating the two caused a value safe for the API (4096) to make
  // the limiter wait ~60 s before every single call.
  private reservedCompletionTokens: number;
  private window: WindowEntry[] = [];

  constructor(inner: LLMClient, config: { tpmLimit: number; reservedCompletionTokens: number }) {
    this.inner = inner;
    this.tpmLimit = config.tpmLimit;
    this.reservedCompletionTokens = config.reservedCompletionTokens;
  }

  async complete(systemPrompt: string, userPrompt: string): Promise<string> {
    const cost = estimateTokens(systemPrompt + userPrompt) + this.reservedCompletionTokens;

    while (true) {
      const now = Date.now();
      this.window = this.window.filter((e) => now - e.timestamp < 60_000);

      const currentUsage = this.window.reduce((sum, e) => sum + e.cost, 0);
      if (currentUsage + cost <= this.tpmLimit) {
        break;
      }

      const oldest = this.window[0];
      if (!oldest) break;
      const waitMs = oldest.timestamp + 60_000 - now + 100;
      await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
    }

    this.window.push({ timestamp: Date.now(), cost });
    return this.inner.complete(systemPrompt, userPrompt);
  }
}
