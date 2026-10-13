import type { HttpTransport } from "../src/extraction/transport.js";

// Node-side transport for the dev scripts (smoke test, eval, gold labeling).
// The plugin itself uses Obsidian's requestUrl — see obsidian-plugin/main.ts.
export const nodeTransport: HttpTransport = async (url, init) => {
  const response = await fetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
  });
  return {
    ok: response.ok,
    status: response.status,
    headers: response.headers,
    text: () => response.text(),
    json: () => response.json(),
  };
};
