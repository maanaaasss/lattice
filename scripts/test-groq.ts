import { readFileSync } from "node:fs";
import { segmentText } from "../src/segmentation/segment.js";
import { OpenAICompatibleClient } from "../src/extraction/llm-client.js";
import { classifySegments } from "../src/extraction/classify.js";
import {
  derivePrecedesEdges,
  detectRevisionCandidates,
} from "../src/extraction/relations-rule-based.js";
import { extractRelations } from "../src/extraction/extract-relations.js";
import { assembleSemanticIR } from "../src/pipeline/assemble.js";

async function main() {
  const inputText = readFileSync(process.argv[2], "utf-8");

  const apiKey = process.env.LLM_API_KEY!;
  const baseUrl = process.env.LLM_BASE_URL!;
  const model = process.env.LLM_MODEL!;

  const client = new OpenAICompatibleClient({ baseUrl, apiKey, model, maxTokens: 4096 });

  console.log("--- Segmenting ---");
  const segments = segmentText(inputText);
  console.log(`Segments: ${segments.length}`);

  console.log("\n--- Classifying ---");
  const nodes = await classifySegments(segments, "test-doc", client);
  console.log(`Nodes: ${nodes.length}`);

  const byType: Record<string, number> = {};
  for (const n of nodes) byType[n.type] = (byType[n.type] ?? 0) + 1;
  console.log("By type:", byType);

  console.log("\n--- Precedes edges ---");
  const precedesEdges = derivePrecedesEdges(nodes);
  console.log(`Precedes: ${precedesEdges.length}`);

  console.log("\n--- Revision candidates ---");
  const candidates = detectRevisionCandidates(nodes);
  console.log(`Candidates: ${candidates.length}`);

  console.log("\n--- LLM relations ---");
  const llmEdges = await extractRelations(nodes, candidates, inputText, client);
  console.log(`LLM edges: ${llmEdges.length}`);

  const byRel: Record<string, number> = {};
  for (const e of llmEdges) byRel[e.relation] = (byRel[e.relation] ?? 0) + 1;
  console.log("By relation:", byRel);

  console.log("\n--- Assembling ---");
  const ir = assembleSemanticIR(nodes, precedesEdges, llmEdges, "test-doc");
  console.log(`IR nodes: ${ir.nodes.length}, edges: ${ir.edges.length}`);
  console.log("SUCCESS");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
