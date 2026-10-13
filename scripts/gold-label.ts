/**
 * Draft a gold label file for one source document.
 *
 * The draft is machine-generated: it runs the normal pipeline (segment →
 * classify → extract → assemble) and records the result as labels with
 * `reviewed: false`. A draft is not an evaluation — it only makes the human
 * review step cheap, because the reviewer corrects a plausible answer instead
 * of starting from a blank file.
 *
 * Usage:
 *   npm run gold:label -- path/to/source.txt
 *   npm run gold:label -- path/to/source.txt --out gold/custom.gold.json
 *   npm run gold:label -- path/to/source.txt --force   # replace an unreviewed draft
 *
 * Requires LLM_API_KEY, LLM_BASE_URL, LLM_MODEL in the environment.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, relative, resolve } from "node:path";
import { segmentText } from "../src/segmentation/segment.js";
import { OpenAICompatibleClient } from "../src/extraction/llm-client.js";
import { nodeTransport } from "./node-transport.js";
import { RateLimitedClient } from "../src/extraction/rate-limited-client.js";
import { classifySegmentsBatched } from "../src/extraction/classify.js";
import {
  derivePrecedesEdges,
  detectRevisionCandidates,
} from "../src/extraction/relations-rule-based.js";
import { extractRelationsBatched } from "../src/extraction/extract-relations.js";
import { assembleSemanticIR } from "../src/pipeline/assemble.js";
import {
  validateGoldDocument,
  verifySource,
  findSegmentOverlaps,
  type GoldDocument,
  type GoldSegment,
  type GoldEdge,
} from "../src/eval/gold.js";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const GOLD_DIR = resolve(REPO_ROOT, "gold");

function usage(): never {
  console.error(
    "Usage: npm run gold:label -- <source-file> [--out <path>] [--force]"
  );
  process.exit(2);
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

function parseArgs(argv: string[]): {
  sourcePath: string;
  outPath?: string;
  force: boolean;
} {
  const positionals: string[] = [];
  let outPath: string | undefined;
  let force = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--force") {
      force = true;
    } else if (arg === "--out") {
      const value = argv[++i];
      if (!value) usage();
      outPath = value;
    } else if (arg.startsWith("--")) {
      console.error(`Unknown flag: ${arg}`);
      usage();
    } else {
      positionals.push(arg);
    }
  }

  if (positionals.length !== 1) usage();
  return { sourcePath: positionals[0], outPath, force };
}

function defaultOutPath(sourcePath: string): string {
  const name = basename(sourcePath, extname(sourcePath));
  return resolve(GOLD_DIR, `${name}.gold.json`);
}

function refuseExisting(path: string, force: boolean): void {
  if (!existsSync(path)) return;

  let reviewed: boolean | undefined;
  try {
    const parsed = validateGoldDocument(JSON.parse(readFileSync(path, "utf-8")));
    reviewed = parsed.ok ? parsed.data?.reviewed : undefined;
  } catch {
    reviewed = undefined;
  }

  if (reviewed === true) {
    console.error(
      `Refusing to overwrite ${path}: it is marked reviewed. Human labels are never replaced.`
    );
    process.exit(1);
  }

  if (!force) {
    console.error(
      `${path} already exists and is not reviewed. Pass --force to replace the draft.`
    );
    process.exit(1);
  }

  console.log(`Replacing unreviewed draft: ${path}`);
}

async function main() {
  const required = ["LLM_API_KEY", "LLM_BASE_URL", "LLM_MODEL"] as const;
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    console.error(`Missing required env vars: ${missing.join(", ")}`);
    process.exit(1);
  }

  const { sourcePath, outPath, force } = parseArgs(process.argv.slice(2));
  const model = process.env.LLM_MODEL!;

  const absSource = resolve(process.cwd(), sourcePath);
  if (!existsSync(absSource)) {
    console.error(`Source file not found: ${absSource}`);
    process.exit(1);
  }

  const out = outPath ? resolve(process.cwd(), outPath) : defaultOutPath(sourcePath);
  refuseExisting(out, force);

  const sourceText = readFileSync(absSource, "utf-8");
  const digest = sha256(sourceText);

  console.log(`Source:  ${relative(REPO_ROOT, absSource)}`);
  console.log(`SHA-256: ${digest}`);
  console.log(`Model:   ${model}`);

  const client = new OpenAICompatibleClient({
    transport: nodeTransport,
    baseUrl: process.env.LLM_BASE_URL!,
    apiKey: process.env.LLM_API_KEY!,
    model,
 });
  const rateLimited = new RateLimitedClient(client, {
    tpmLimit: 8000,
    reservedCompletionTokens: 3000,
  });
  const relationClient = new OpenAICompatibleClient({
    transport: nodeTransport,
    baseUrl: process.env.LLM_BASE_URL!,
    apiKey: process.env.LLM_API_KEY!,
    model,
    maxTokens: 8192,
 });
  const relationRateLimited = new RateLimitedClient(relationClient, {
    tpmLimit: 8000,
    reservedCompletionTokens: 6000,
  });

  const segments = segmentText(sourceText);
  console.log(`Segments: ${segments.length}`);
  if (segments.length === 0) {
    console.error("Source produced no segments — nothing to label.");
    process.exit(1);
  }

  const nodes = await classifySegmentsBatched(segments, "gold-draft", rateLimited);
  const precedesEdges = derivePrecedesEdges(nodes);
  const candidates = detectRevisionCandidates(nodes);
  const llmEdges = await extractRelationsBatched(
    nodes,
    candidates,
    sourceText,
    relationRateLimited,
    10
  );

  const ir = assembleSemanticIR(nodes, precedesEdges, llmEdges, "gold-draft", sourceText);

  const nodeById = new Map(ir.nodes.map((n) => [n.id, n]));

  const goldSegments: GoldSegment[] = ir.nodes
    .filter((n) => !n.synthetic)
    .sort((a, b) => a.span_location.start - b.span_location.start)
    .map((n) => ({
      start: n.span_location.start,
      end: n.span_location.end,
      type: n.type,
      ...(n.attribution
        ? { attribution: { type: n.attribution.type, ref: n.attribution.ref } }
        : {}),
    }));

  const goldEdges: GoldEdge[] = ir.edges.map((e) => {
    const src = nodeById.get(e.source_node_id);
    const tgt = nodeById.get(e.target_node_id);
    if (!src || !tgt) {
      throw new Error(
        `Assembled edge ${e.id} references a missing node — invariant gate should have caught this`
      );
    }
    return {
      source: { start: src.span_location.start, end: src.span_location.end },
      target: { start: tgt.span_location.start, end: tgt.span_location.end },
      relation: e.relation,
    };
  });

  const document = relative(REPO_ROOT, absSource);
  const draft: GoldDocument = {
    document,
    document_sha256: digest,
    labeled_by: `draft:${model}`,
    reviewed: false,
    created_at: new Date().toISOString(),
    segments: goldSegments,
    edges: goldEdges,
    notes:
      "Machine-generated draft. Every segment and edge needs human review before it is used as a gold standard.",
  };

  const validation = validateGoldDocument(draft);
  if (!validation.ok || !validation.data) {
    console.error("Draft failed gold schema validation:");
    for (const err of validation.errors) console.error(`  ${err}`);
    process.exit(1);
  }

  const problems = [
    ...verifySource(validation.data, { sourceText, sha256: digest }),
    ...findSegmentOverlaps(validation.data.segments),
  ];
  if (problems.length > 0) {
    console.error("Draft failed source verification:");
    for (const problem of problems) console.error(`  ${problem}`);
    process.exit(1);
  }

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(draft, null, 2)}\n`);

  const typeCounts: Record<string, number> = {};
  for (const s of draft.segments) typeCounts[s.type] = (typeCounts[s.type] ?? 0) + 1;
  const relationCounts: Record<string, number> = {};
  for (const e of draft.edges) relationCounts[e.relation] = (relationCounts[e.relation] ?? 0) + 1;

  console.log(`\nWrote draft to: ${relative(REPO_ROOT, out)}`);
  console.log(`  segments: ${draft.segments.length}`, typeCounts);
  console.log(`  edges:    ${draft.edges.length}`, relationCounts);
  console.log(
    "  reviewed: false — edit the file and set reviewed: true before using it for scoring."
  );

  const tokens =
    client.usageLog.reduce((sum, u) => sum + u.totalTokens, 0) +
    relationClient.usageLog.reduce((sum, u) => sum + u.totalTokens, 0);
  console.log(`  tokens used: ${tokens}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
