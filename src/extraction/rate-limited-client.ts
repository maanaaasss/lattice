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
  private maxTokensPerCall: number;
  private window: WindowEntry[] = [];

  constructor(inner: LLMClient, config: { tpmLimit: number; maxTokensPerCall: number }) {
    this.inner = inner;
    this.tpmLimit = config.tpmLimit;
    this.maxTokensPerCall = config.maxTokensPerCall;
  }

  async complete(systemPrompt: string, userPrompt: string): Promise<string> {
    const cost = estimateTokens(systemPrompt + userPrompt) + this.maxTokensPerCall;

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
