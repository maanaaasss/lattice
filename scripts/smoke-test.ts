/**
 * Smoke test: segmentation + node classification + relation extraction
 * against a real LLM.
 *
 * Usage:
 *   npm run smoke                      # uses embedded default text
 *   npm run smoke -- path/to/file.txt  # uses file contents
 *   npm run smoke:direction            # runs only the directionality check
 *   npm run smoke:causal               # runs only the causal direction check
 *
 * Requires LLM_API_KEY, LLM_BASE_URL, LLM_MODEL in the environment.
 * To load from .env without dotenv:
 *   node --env-file=.env --import tsx scripts/smoke-test.ts
 */

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { segmentText } from "../src/segmentation/segment.js";
import { OpenAICompatibleClient } from "../src/extraction/llm-client.js";
import { RateLimitedClient } from "../src/extraction/rate-limited-client.js";
import { classifySegments, classifySegmentsBatched } from "../src/extraction/classify.js";
import {
  derivePrecedesEdges,
  detectRevisionCandidates,
} from "../src/extraction/relations-rule-based.js";
import { extractRelations } from "../src/extraction/extract-relations.js";
import { assembleSemanticIR } from "../src/pipeline/assemble.js";

const DEFAULT_TEXT =
  'The library opens at nine each morning. Dr. Chen believes early mornings are the best time to study. She decided to arrive an hour before opening to secure a quiet seat. Yesterday, the fire alarm went off during her exam and everyone had to evacuate. It was frustrating, but she stayed calm and finished the test an hour later.';

const DIRECTIONALITY_CHECK_TEXT =
  "I used to think honesty always paid off. Once I trusted everyone " +
  "right away, now I take time before opening up to anyone.";

const CAUSAL_DIRECTION_CHECK_TEXT =
  "The server crashed at midnight. This caused three hours of downtime " +
  "for all users. The team finished the database migration early. " +
  "This enabled us to start testing a week ahead of schedule.";

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

  const directionOnly = process.argv.slice(2).includes("--direction-only");
  const causalDirectionOnly = process.argv.slice(2).includes("--causal-direction-only");
  const client = new OpenAICompatibleClient({ baseUrl, apiKey, model });
  const rateLimitedClient = new RateLimitedClient(client, {
    tpmLimit: 6000,
    maxTokensPerCall: 2048,
  });

  if (directionOnly) {
    await runDirectionalityCheck(client);
    return;
  }

  if (causalDirectionOnly) {
    await runCausalDirectionalityCheck(client);
    return;
  }

  const inputText = process.argv[2]
    ? readFileSync(process.argv[2], "utf-8")
    : DEFAULT_TEXT;

  // ── Segmentation ──
  console.log("--- Segmenting input text ---");
  const segments = segmentText(inputText);
  console.log(`Segments: ${segments.length}`);
  for (const seg of segments) {
    console.log(`  [${seg.start}-${seg.end}] p${seg.paragraph_index}: ${seg.text}`);
  }

  // ── Classification ──
  console.log("\n--- Classifying nodes ---");
  const nodes = await classifySegmentsBatched(segments, "smoke-test-doc", rateLimitedClient);

  console.log(`\nTotal nodes: ${nodes.length}`);

  const byType: Record<string, number> = {};
  for (const node of nodes) {
    byType[node.type] = (byType[node.type] ?? 0) + 1;
  }
  console.log("Nodes per type:", byType);

  console.log("\n--- Full nodes output ---");
  console.log(JSON.stringify(nodes, null, 2));

  // ── Rule-based relation derivation ──
  console.log("\n--- Deriving precedes edges (rule-based) ---");
  const precedesEdges = derivePrecedesEdges(nodes);
  console.log(`Precedes edges: ${precedesEdges.length}`);

  console.log("\n--- Detecting revision candidates ---");
  const revisionCandidates = detectRevisionCandidates(nodes);
  console.log(`Revision candidates: ${revisionCandidates.length}`);
  for (const c of revisionCandidates) {
    console.log(`  ${c.node_id} (marker: "${c.matched_marker}")`);
  }

  // ── LLM relation extraction ──
  console.log("\n--- Extracting relations (LLM) ---");
  const llmEdges = await extractRelations(
    nodes,
    revisionCandidates,
    inputText,
    client
  );
  console.log(`LLM edges: ${llmEdges.length}`);

  const byRelation: Record<string, number> = {};
  for (const edge of llmEdges) {
    byRelation[edge.relation] = (byRelation[edge.relation] ?? 0) + 1;
  }
  console.log("Edges per relation:", byRelation);

  console.log("\n--- Full LLM edges output ---");
  console.log(JSON.stringify(llmEdges, null, 2));

  // ── Assemble final SemanticIR ──
  console.log("\n--- Assembling SemanticIR ---");
  const ir = assembleSemanticIR(nodes, precedesEdges, llmEdges, "smoke-test-doc");
  console.log(`Total nodes: ${ir.nodes.length}`);
  console.log(`Total edges: ${ir.edges.length}`);

  const outDir = resolve(import.meta.dirname, "..", "output");
  mkdirSync(outDir, { recursive: true });
  const outPath = resolve(outDir, "smoke-ir.json");
  writeFileSync(outPath, JSON.stringify(ir, null, 2));
  console.log(`Wrote IR to: ${outPath}`);

  // ── Directionality check (always runs) ──
  await runDirectionalityCheck(client);
}

async function runDirectionalityCheck(client: OpenAICompatibleClient) {
  console.log("\n========================================");
  console.log("--- REVISION DIRECTIONALITY CHECK ---");
  console.log("========================================");
  console.log(`Input text: "${DIRECTIONALITY_CHECK_TEXT}"`);

  const dirSegments = segmentText(DIRECTIONALITY_CHECK_TEXT);
  const dirNodes = await classifySegments(dirSegments, "direction-check-doc", client);
  const dirCandidates = detectRevisionCandidates(dirNodes);
  const dirEdges = await extractRelations(
    dirNodes,
    dirCandidates,
    DIRECTIONALITY_CHECK_TEXT,
    client
  );

  const revisesEdges = dirEdges.filter((e) => e.relation === "revises");

  if (revisesEdges.length === 0) {
    console.log(
      "\nWARNING: Zero revises edges found despite revision candidates being present."
    );
    console.log(
      "  The model received the revision hint(s) but did not produce a revises edge."
    );
    console.log(`  Candidates passed: ${dirCandidates.length}`);
    for (const c of dirCandidates) {
      const n = dirNodes.find((n) => n.id === c.node_id);
      console.log(`    ${c.node_id} (marker: "${c.matched_marker}") — "${n?.text_span}"`);
    }
    console.log("  All returned edges:");
    for (const e of dirEdges) {
      const src = dirNodes.find((n) => n.id === e.source_node_id);
      const tgt = dirNodes.find((n) => n.id === e.target_node_id);
      console.log(`    ${e.source_node_id} → ${e.target_node_id} (${e.relation})`);
      console.log(`      source text: "${src?.text_span}"`);
      console.log(`      target text: "${tgt?.text_span}"`);
    }
  } else {
    for (const edge of revisesEdges) {
      const srcNode = dirNodes.find((n) => n.id === edge.source_node_id);
      const tgtNode = dirNodes.find((n) => n.id === edge.target_node_id);

      console.log(`\nrevises edge: ${edge.source_node_id} → ${edge.target_node_id}`);
      console.log(`  source (${edge.source_node_id}): "${srcNode?.text_span}"`);
      console.log(`  target (${edge.target_node_id}): "${tgtNode?.text_span}"`);

      if (!srcNode || !tgtNode) {
        console.log("  DIRECTION UNKNOWN — could not look up node(s)");
        continue;
      }

      if (srcNode.span_location.start > tgtNode.span_location.start) {
        console.log("  DIRECTION CORRECT");
      } else {
        console.log("  DIRECTION BACKWARDS");
      }
    }
  }
}

async function runCausalDirectionalityCheck(client: OpenAICompatibleClient) {
  console.log("\n========================================");
  console.log("--- CAUSAL DIRECTIONALITY CHECK ---");
  console.log("========================================");
  console.log(`Input text: "${CAUSAL_DIRECTION_CHECK_TEXT}"`);

  const dirSegments = segmentText(CAUSAL_DIRECTION_CHECK_TEXT);
  const dirNodes = await classifySegments(dirSegments, "causal-check-doc", client);
  const dirCandidates = detectRevisionCandidates(dirNodes);
  const dirEdges = await extractRelations(
    dirNodes,
    dirCandidates,
    CAUSAL_DIRECTION_CHECK_TEXT,
    client
  );

  const causalEdges = dirEdges.filter(
    (e) => e.relation === "causes" || e.relation === "enables"
  );

  if (causalEdges.length === 0) {
    console.log(
      "\nWARNING: Zero causes/enables edges found."
    );
    console.log(
      "  The model did not produce any causal edges from this input."
    );
    console.log("  All returned edges:");
    for (const e of dirEdges) {
      const src = dirNodes.find((n) => n.id === e.source_node_id);
      const tgt = dirNodes.find((n) => n.id === e.target_node_id);
      console.log(`    ${e.source_node_id} → ${e.target_node_id} (${e.relation})`);
      console.log(`      source text: "${src?.text_span}"`);
      console.log(`      target text: "${tgt?.text_span}"`);
    }
  } else {
    for (const edge of causalEdges) {
      const srcNode = dirNodes.find((n) => n.id === edge.source_node_id);
      const tgtNode = dirNodes.find((n) => n.id === edge.target_node_id);

      console.log(`\n${edge.relation} edge: ${edge.source_node_id} → ${edge.target_node_id}`);
      console.log(`  source (${edge.source_node_id}): "${srcNode?.text_span}"`);
      console.log(`  target (${edge.target_node_id}): "${tgtNode?.text_span}"`);

      if (!srcNode || !tgtNode) {
        console.log("  DIRECTION UNKNOWN — could not look up node(s)");
        continue;
      }

      if (srcNode.span_location.start < tgtNode.span_location.start) {
        console.log("  DIRECTION CORRECT");
      } else {
        console.log("  DIRECTION BACKWARDS");
      }
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
