/**
 * Smoke test: segmentation + node classification against a real LLM.
 *
 * Usage:
 *   npm run smoke                      # uses embedded default text
 *   npm run smoke -- path/to/file.txt  # uses file contents
 *
 * Requires LLM_API_KEY, LLM_BASE_URL, LLM_MODEL in the environment.
 * To load from .env without dotenv:
 *   node --env-file=.env --import tsx scripts/smoke-test.ts
 */

import { readFileSync } from "node:fs";
import { segmentText } from "../src/segmentation/segment.js";
import { OpenAICompatibleClient } from "../src/extraction/llm-client.js";
import { classifySegments } from "../src/extraction/classify.js";

const DEFAULT_TEXT =
  'The library opens at nine each morning. Dr. Chen believes early mornings are the best time to study. She decided to arrive an hour before opening to secure a quiet seat. Yesterday, the fire alarm went off during her exam and everyone had to evacuate. It was frustrating, but she stayed calm and finished the test an hour later.';

async function main() {
  const required = ["LLM_API_KEY", "LLM_BASE_URL", "LLM_MODEL"] as const;
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    console.error(`Missing required env vars: ${missing.join(", ")}`);
    process.exit(1);
  }

  const apiKey = process.env.LLM_API_KEY!;
  const baseUrl = process.env.LLM_BASE_URL!;
  const model = process.env.LLM_MODEL!;

  const inputText = process.argv[2]
    ? readFileSync(process.argv[2], "utf-8")
    : DEFAULT_TEXT;

  console.log("--- Segmenting input text ---");
  const segments = segmentText(inputText);
  console.log(`Segments: ${segments.length}`);
  for (const seg of segments) {
    console.log(`  [${seg.start}-${seg.end}] p${seg.paragraph_index}: ${seg.text}`);
  }

  console.log("\n--- Classifying nodes ---");
  const client = new OpenAICompatibleClient({ baseUrl, apiKey, model });
  const nodes = await classifySegments(segments, "smoke-test-doc", client);

  console.log(`\nTotal nodes: ${nodes.length}`);

  const byType: Record<string, number> = {};
  for (const node of nodes) {
    byType[node.type] = (byType[node.type] ?? 0) + 1;
  }
  console.log("Nodes per type:", byType);

  console.log("\n--- Full output ---");
  console.log(JSON.stringify(nodes, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
