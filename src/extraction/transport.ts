// The HTTP seam between the LLM client and whatever runtime it's running in.
//
// Obsidian's plugin guidelines require requestUrl over fetch inside the app —
// requestUrl bypasses the renderer's CORS checks, so any OpenAI-compatible
// endpoint works, not just ones that send CORS headers. requestUrl only exists
// in Obsidian, and the dev scripts run in Node, so the client takes a
// transport instead of calling a global directly: obsidian-plugin/main.ts
// supplies the requestUrl transport, scripts/node-transport.ts supplies fetch.

export interface HttpRequest {
  method: string;
  headers: Record<string, string>;
  body?: string;
}

export interface HttpResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  json(): Promise<unknown>;
}

export type HttpTransport = (url: string, init: HttpRequest) => Promise<HttpResponse>;
