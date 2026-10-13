/**
 * Score the pipeline against reviewed gold label files.
 *
 * Usage:
 *   npm run eval                          # all gold/*.gold.json, 1 run each
 *   npm run eval -- --runs 3              # repeat each document for stability
 *   npm run eval -- --gold gold/short.gold.json
 *   npm run eval -- --include-unreviewed  # score drafts too (not a real score)
 *
 * Requires LLM_API_KEY, LLM_BASE_URL, LLM_MODEL in the environment.
 * Writes a machine-readable report to eval/report.json.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { relative, resolve } from "node:path";
import { segmentText } from "../src/segmentation/segment.js";
import { OpenAICompatibleClient, type LLMUsageRecord } from "../src/extraction/llm-client.js";
import { nodeTransport } from "./node-transport.js";
import { RateLimitedClient } from "../src/extraction/rate-limited-client.js";
import { classifySegmentsBatched } from "../src/extraction/classify.js";
import {
  derivePrecedesEdges,
  detectRevisionCandidates,
} from "../src/extraction/relations-rule-based.js";
import { extractRelationsBatched } from "../src/extraction/extract-relations.js";
import { assembleSemanticIR } from "../src/pipeline/assemble.js";
import type { SemanticIR } from "../src/schema.js";
import {
  validateGoldDocument,
  verifySource,
  findSegmentOverlaps,
  type GoldDocument,
} from "../src/eval/gold.js";
import {
  evaluateRun,
  stabilityReport,
  countDirectionCorrections,
  summarize,
  type DocumentMetrics,
  type StabilityReport,
} from "../src/eval/metrics.js";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const GOLD_DIR = resolve(REPO_ROOT, "gold");
const REPORT_DIR = resolve(REPO_ROOT, "eval");

function usage(): never {
  console.error(
    "Usage: npm run eval [-- --runs <n>] [-- --gold <file>]... [-- --include-unreviewed]"
  );
  process.exit(2);
}

interface Options {
  runs: number;
  goldPaths: string[];
  includeUnreviewed: boolean;
}

function parseArgs(argv: string[]): Options {
  let runs = 1;
  let includeUnreviewed = false;
  const goldPaths: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--include-unreviewed") {
      includeUnreviewed = true;
    } else if (arg === "--runs") {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 1) usage();
      runs = value;
    } else if (arg === "--gold") {
      const value = argv[++i];
      if (!value) usage();
      goldPaths.push(value);
    } else {
      console.error(`Unknown argument: ${arg}`);
      usage();
    }
  }

  return { runs, goldPaths, includeUnreviewed };
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

function discoverGoldFiles(explicit: string[]): string[] {
  if (explicit.length > 0) {
    return explicit.map((p) => resolve(process.cwd(), p));
  }
  if (!existsSync(GOLD_DIR)) return [];
  return readdirSync(GOLD_DIR)
    .filter((f) => f.endsWith(".gold.json"))
    .sort()
    .map((f) => resolve(GOLD_DIR, f));
}

interface LoadedGold {
  path: string;
  gold: GoldDocument;
  sourceText: string;
  problems: string[];
}

function loadGold(path: string): LoadedGold | null {
  if (!existsSync(path)) {
    console.error(`Gold file not found: ${path}`);
    return null;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    console.error(`Gold file is not valid JSON: ${path}`);
    console.error(`  ${(err as Error).message}`);
    return null;
  }

  const validated = validateGoldDocument(raw);
  if (!validated.ok || !validated.data) {
    console.error(`Gold file failed schema validation: ${path}`);
    for (const err of validated.errors) console.error(`  ${err}`);
    return null;
  }

  const sourcePath = resolve(REPO_ROOT, validated.data.document);
  if (!existsSync(sourcePath)) {
    console.error(
      `Source file for ${path} not found: ${validated.data.document}`
    );
    return null;
  }
  const sourceText = readFileSync(sourcePath, "utf-8");

  const problems = [
    ...verifySource(validated.data, { sourceText, sha256: sha256(sourceText) }),
    ...findSegmentOverlaps(validated.data.segments),
  ];

  return { path, gold: validated.data, sourceText, problems };
}

interface RunScalars {
  nodeMacroF1: number;
  nodeMicroF1: number;
  nodeAccuracy: number;
  attributionAccuracy: number | null;
  nonSelfAttributionAccuracy: number | null;
  edgePrecisionLlm: number;
  edgeRecallLlm: number;
  edgeF1Llm: number;
  edgeDirectionAccuracy: number | null;
  edgeF1All: number;
  directionCorrections: number;
}

function scalarsOf(metrics: DocumentMetrics, directionCorrections: number): RunScalars {
  return {
    nodeMacroF1: metrics.nodes.macroF1,
    nodeMicroF1: metrics.nodes.microF1,
    nodeAccuracy: metrics.nodes.accuracy,
    attributionAccuracy: metrics.attribution.accuracy,
    nonSelfAttributionAccuracy: metrics.attribution.nonSelfAccuracy,
    edgePrecisionLlm: metrics.edgesLlm.precision,
    edgeRecallLlm: metrics.edgesLlm.recall,
    edgeF1Llm: metrics.edgesLlm.f1,
    edgeDirectionAccuracy: metrics.edgesLlm.direction.accuracy,
    edgeF1All: metrics.edgesAll.f1,
    directionCorrections,
  };
}

const SCALAR_KEYS: Array<keyof RunScalars> = [
  "nodeMacroF1",
  "nodeMicroF1",
  "nodeAccuracy",
  "attributionAccuracy",
  "nonSelfAttributionAccuracy",
  "edgePrecisionLlm",
  "edgeRecallLlm",
  "edgeF1Llm",
  "edgeDirectionAccuracy",
  "edgeF1All",
  "directionCorrections",
];

function summarizeRuns(runs: RunScalars[]): Record<string, ReturnType<typeof summarize>> {
  const out: Record<string, ReturnType<typeof summarize>> = {};
  for (const key of SCALAR_KEYS) {
    out[key] = summarize(runs.map((r) => r[key]));
  }
  return out;
}

interface DocumentResult {
  goldFile: string;
  document: string;
  reviewed: boolean;
  labeledBy: string;
  segments: number;
  goldEdges: number;
  runs: Array<{ metrics: DocumentMetrics; scalars: RunScalars; ir: SemanticIR }>;
  summary: Record<string, ReturnType<typeof summarize>>;
  stability: StabilityReport;
}

async function runOnce(
  gold: GoldDocument,
  sourceText: string,
  rateLimited: RateLimitedClient,
  relationRateLimited: RateLimitedClient
): Promise<{ metrics: DocumentMetrics; scalars: RunScalars; ir: SemanticIR }> {
  const segments = segmentText(sourceText);
  const nodes = await classifySegmentsBatched(segments, "eval", rateLimited);
  const precedesEdges = derivePrecedesEdges(nodes);
  const candidates = detectRevisionCandidates(nodes);
  const llmEdges = await extractRelationsBatched(
    nodes,
    candidates,
    sourceText,
    relationRateLimited,
    10
  );

  const ir = assembleSemanticIR(nodes, precedesEdges, llmEdges, "eval", sourceText);

  const llmEdgesById = new Map(llmEdges.map((e) => [e.id, e]));
  const assembledLlmEdges = ir.edges.filter((e) => llmEdgesById.has(e.id));
  const corrections = countDirectionCorrections(llmEdges, assembledLlmEdges);

  const metrics = evaluateRun(gold, ir);
  return { metrics, scalars: scalarsOf(metrics, corrections), ir };
}

function fmt(value: number | null | undefined, digits = 3): string {
  if (value === null || value === undefined) return "  n/a";
  return value.toFixed(digits);
}

function fmtMeanStd(summary: ReturnType<typeof summarize>): string {
  if (summary.mean === null) return "n/a";
  const spread = summary.std === null ? 0 : summary.std;
  return `${summary.mean.toFixed(3)} ± ${spread.toFixed(3)}`;
}

function aggregate(results: DocumentResult[]): Record<string, ReturnType<typeof summarize>> {
  const out: Record<string, ReturnType<typeof summarize>> = {};
  for (const key of SCALAR_KEYS) {
    out[key] = summarize(results.map((r) => r.summary[key].mean));
  }
  return out;
}

async function main() {
  const required = ["LLM_API_KEY", "LLM_BASE_URL", "LLM_MODEL"] as const;
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    console.error(`Missing required env vars: ${missing.join(", ")}`);
    process.exit(1);
  }

  const opts = parseArgs(process.argv.slice(2));
  const model = process.env.LLM_MODEL!;

  const goldPaths = discoverGoldFiles(opts.goldPaths);
  if (goldPaths.length === 0) {
    console.error(
      `No gold files found. Create one with: npm run gold:label -- <source-file>`
    );
    process.exit(1);
  }

  const loaded: LoadedGold[] = [];
  for (const path of goldPaths) {
    const entry = loadGold(path);
    if (!entry) process.exit(1);

    if (entry.problems.length > 0) {
      console.error(`Source verification failed for ${relative(REPO_ROOT, path)}:`);
      for (const problem of entry.problems) console.error(`  ${problem}`);
      process.exit(1);
    }

    if (!entry.gold.reviewed && !opts.includeUnreviewed) {
      console.warn(
        `Skipping ${relative(REPO_ROOT, path)}: reviewed=false (pass --include-unreviewed to score it anyway)`
      );
      continue;
    }
    loaded.push(entry);
  }

  if (loaded.length === 0) {
    console.error("No reviewable gold files to evaluate.");
    process.exit(1);
  }

  console.log(`Model: ${model}`);
  console.log(`Runs per document: ${opts.runs}`);
  console.log(`Documents: ${loaded.length}\n`);

  const classifyClient = new OpenAICompatibleClient({
    transport: nodeTransport,
    baseUrl: process.env.LLM_BASE_URL!,
    apiKey: process.env.LLM_API_KEY!,
    model,
 });
  const rateLimited = new RateLimitedClient(classifyClient, {
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

  const results: DocumentResult[] = [];

  for (const entry of loaded) {
    const name = relative(REPO_ROOT, entry.path);
    console.log(`--- ${name} ---`);

    const runs: DocumentResult["runs"] = [];
    const irs: SemanticIR[] = [];

    for (let i = 0; i < opts.runs; i++) {
      const run = await runOnce(entry.gold, entry.sourceText, rateLimited, relationRateLimited);
      runs.push(run);
      irs.push(run.ir);
      console.log(
        `  run ${i + 1}/${opts.runs}  nodes ${fmt(run.scalars.nodeMacroF1)}  ` +
          `edges ${fmt(run.scalars.edgeF1Llm)}  attrib ${fmt(run.scalars.attributionAccuracy)}`
      );
    }

    const summary = summarizeRuns(runs.map((r) => r.scalars));
    const stability =
      opts.runs > 1
        ? stabilityReport(irs)
        : {
            runs: 1,
            edgeJaccardMean: null,
            edgeJaccardMin: null,
            nodeTypeAgreement: null,
          };

    results.push({
      goldFile: name,
      document: entry.gold.document,
      reviewed: entry.gold.reviewed,
      labeledBy: entry.gold.labeled_by,
      segments: entry.gold.segments.length,
      goldEdges: entry.gold.edges.length,
      runs,
      summary,
      stability,
    });

    console.log(
      `  macroF1 ${fmtMeanStd(summary.nodeMacroF1)}  ` +
        `edgeF1 ${fmtMeanStd(summary.edgeF1Llm)}  ` +
        `attrib ${fmtMeanStd(summary.attributionAccuracy)}`
    );
    console.log("");
  }

  const aggregateSummary = aggregate(results);

  const usageRecords: LLMUsageRecord[] = [
    ...classifyClient.usageLog,
    ...relationClient.usageLog,
  ];
  const usage = {
    calls: usageRecords.length,
    promptTokens: usageRecords.reduce((s, u) => s + u.promptTokens, 0),
    completionTokens: usageRecords.reduce((s, u) => s + u.completionTokens, 0),
    totalTokens: usageRecords.reduce((s, u) => s + u.totalTokens, 0),
  };

  const report = {
    generated_at: new Date().toISOString(),
    model,
    runs_per_document: opts.runs,
    includes_unreviewed: opts.includeUnreviewed,
    documents: results.map((r) => ({
      goldFile: r.goldFile,
      document: r.document,
      reviewed: r.reviewed,
      labeledBy: r.labeledBy,
      segments: r.segments,
      goldEdges: r.goldEdges,
      summary: r.summary,
      stability: r.stability,
      runs: r.runs.map(({ metrics, scalars }) => ({ metrics, scalars })),
    })),
    aggregate: aggregateSummary,
    usage,
  };

  mkdirSync(REPORT_DIR, { recursive: true });
  const reportPath = resolve(REPORT_DIR, "report.json");
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  const reviewed = results.filter((r) => r.reviewed).length;
  if (reviewed < results.length) {
    console.log(
      `NOTE: ${results.length - reviewed} document(s) are unreviewed drafts. These numbers are not a gold score.\n`
    );
  }

  console.log("═══ Aggregate ═══");
  console.log(`  node macro-F1          ${fmtMeanStd(aggregateSummary.nodeMacroF1)}`);
  console.log(`  node micro-F1          ${fmtMeanStd(aggregateSummary.nodeMicroF1)}`);
  console.log(`  node accuracy          ${fmtMeanStd(aggregateSummary.nodeAccuracy)}`);
  console.log(`  attribution accuracy   ${fmtMeanStd(aggregateSummary.attributionAccuracy)}`);
  console.log(`  attribution (non-self) ${fmtMeanStd(aggregateSummary.nonSelfAttributionAccuracy)}`);
  console.log(`  edge precision (llm)   ${fmtMeanStd(aggregateSummary.edgePrecisionLlm)}`);
  console.log(`  edge recall (llm)      ${fmtMeanStd(aggregateSummary.edgeRecallLlm)}`);
  console.log(`  edge F1 (llm)          ${fmtMeanStd(aggregateSummary.edgeF1Llm)}`);
  console.log(`  edge direction acc.    ${fmtMeanStd(aggregateSummary.edgeDirectionAccuracy)}`);
  console.log(`  direction corrections  ${fmtMeanStd(aggregateSummary.directionCorrections)}`);
  console.log(
    `\n  tokens: ${usage.totalTokens} across ${usage.calls} calls`
  );

  for (const r of results) {
    console.log(
      `\n  ${r.goldFile}  (segments ${r.segments}, gold edges ${r.goldEdges}, reviewed ${r.reviewed})`
    );
    console.log(`    node macro-F1      ${fmtMeanStd(r.summary.nodeMacroF1)}`);
    console.log(`    edge F1 (llm)      ${fmtMeanStd(r.summary.edgeF1Llm)}`);
    console.log(`    attribution        ${fmtMeanStd(r.summary.attributionAccuracy)}`);
    console.log(`    edge jaccard       ${fmt(r.stability.edgeJaccardMean)}`);
    console.log(`    type agreement     ${fmt(r.stability.nodeTypeAgreement)}`);
  }

  console.log(`\nReport written to: ${relative(REPO_ROOT, reportPath)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
