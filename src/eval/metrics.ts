import type {
  SemanticIR,
  SemanticNode,
  EdgeRelation,
  RelationFamily,
} from "../schema.js";
import { RELATION_FAMILIES } from "../schema.js";
import type { GoldDocument, GoldSegment, GoldEdge } from "./gold.js";

export const NO_PREDICTION = "<none>";
export const NO_GOLD = "<spurious>";

export interface Span {
  start: number;
  end: number;
}

export function spanKey(span: Span): string {
  return `${span.start}:${span.end}`;
}

export function edgeKey(source: Span, target: Span, relation: string): string {
  return `${spanKey(source)}->${spanKey(target)}|${relation}`;
}

export interface Alignment {
  matched: Array<{ goldIndex: number; nodeIndex: number }>;
  missed: number[];
  spurious: number[];
}

/**
 * Segmentation is deterministic, so a gold segment and a predicted node
 * describe the same text only when their spans are byte-identical. Anything
 * else is a segmentation failure, not a classification failure, and is
 * reported as such rather than being fuzzy-matched away.
 */
export function alignNodes(
  gold: GoldSegment[],
  nodes: SemanticNode[]
): Alignment {
  const bySpan = new Map<string, number>();
  nodes.forEach((node, index) => {
    if (node.synthetic) return;
    const key = spanKey(node.span_location);
    if (!bySpan.has(key)) bySpan.set(key, index);
  });

  const matched: Alignment["matched"] = [];
  const missed: number[] = [];
  const used = new Set<number>();

  gold.forEach((segment, goldIndex) => {
    const nodeIndex = bySpan.get(`${segment.start}:${segment.end}`);
    if (nodeIndex === undefined) {
      missed.push(goldIndex);
    } else {
      matched.push({ goldIndex, nodeIndex });
      used.add(nodeIndex);
    }
  });

  const spurious: number[] = [];
  nodes.forEach((node, index) => {
    if (!node.synthetic && !used.has(index)) spurious.push(index);
  });

  return { matched, missed, spurious };
}

export interface PerTypeReport {
  type: string;
  precision: number;
  recall: number;
  f1: number;
  goldSupport: number;
  predictedCount: number;
}

export interface ClassificationReport {
  perType: PerTypeReport[];
  macroF1: number;
  microF1: number;
  accuracy: number;
  goldTotal: number;
  matched: number;
  missed: number;
  spurious: number;
  confusion: Array<{ gold: string; predicted: string; count: number }>;
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function f1Of(precision: number, recall: number): number {
  if (precision + recall === 0) return 0;
  return (2 * precision * recall) / (precision + recall);
}

function splitCountKey(key: string): { gold: string; predicted: string } {
  const separator = key.indexOf(" ");
  return {
    gold: key.slice(0, separator),
    predicted: key.slice(separator + 1),
  };
}

export function classificationReport(
  gold: GoldSegment[],
  nodes: SemanticNode[]
): ClassificationReport {
  const alignment = alignNodes(gold, nodes);

  const predictedForGold: Array<string | undefined> = new Array(gold.length);
  for (const { goldIndex, nodeIndex } of alignment.matched) {
    predictedForGold[goldIndex] = nodes[nodeIndex].type;
  }

  const counts = new Map<string, number>();
  const bump = (goldType: string, predictedType: string) => {
    const key = `${goldType} ${predictedType}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  };

  gold.forEach((segment, index) => {
    bump(segment.type, predictedForGold[index] ?? NO_PREDICTION);
  });
  for (const nodeIndex of alignment.spurious) {
    bump(NO_GOLD, nodes[nodeIndex].type);
  }

  // Labels are the union of gold types and predicted types, matching the
  // standard multi-class convention: inventing a type nobody labeled is an
  // error and must register as a zero-precision class, not vanish. The two
  // sentinel values are excluded — <none> means an abstention (already a
  // false negative for its gold class) and <spurious> is not a class.
  const labels: string[] = [];
  const seen = new Set<string>();
  for (const segment of gold) {
    if (!seen.has(segment.type)) {
      seen.add(segment.type);
      labels.push(segment.type);
    }
  }
  for (const key of counts.keys()) {
    const { predicted } = splitCountKey(key);
    if (predicted === NO_PREDICTION || seen.has(predicted)) continue;
    seen.add(predicted);
    labels.push(predicted);
  }

  const perType: PerTypeReport[] = [];
  let sumTp = 0;
  let sumFp = 0;
  let sumFn = 0;

  for (const type of labels) {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    for (const [key, count] of counts) {
      const pair = splitCountKey(key);
      if (pair.gold === type && pair.predicted === type) tp += count;
      else if (pair.predicted === type) fp += count;
      else if (pair.gold === type) fn += count;
    }
    const precision = ratio(tp, tp + fp);
    const recall = ratio(tp, tp + fn);
    perType.push({
      type,
      precision,
      recall,
      f1: f1Of(precision, recall),
      goldSupport: tp + fn,
      predictedCount: tp + fp,
    });
    sumTp += tp;
    sumFp += fp;
    sumFn += fn;
  }

  const macroF1 =
    perType.length === 0 ? 0 : perType.reduce((sum, r) => sum + r.f1, 0) / perType.length;

  const microF1 = f1Of(ratio(sumTp, sumTp + sumFp), ratio(sumTp, sumTp + sumFn));

  return {
    perType,
    macroF1,
    microF1,
    accuracy: ratio(sumTp, gold.length),
    goldTotal: gold.length,
    matched: alignment.matched.length,
    missed: alignment.missed.length,
    spurious: alignment.spurious.length,
    confusion: [...counts.entries()]
      .map(([key, count]) => ({ ...splitCountKey(key), count }))
      .sort((a, b) => b.count - a.count),
  };
}

export interface AttributionReport {
  labeled: number;
  aligned: number;
  correct: number;
  accuracy: number | null;
  nonSelfLabeled: number;
  nonSelfAligned: number;
  nonSelfCorrect: number;
  nonSelfAccuracy: number | null;
  mismatches: Array<{
    start: number;
    end: number;
    gold: string;
    predicted: string;
  }>;
}

/**
 * Attribution accuracy is reported twice because the aggregate number hides
 * the known failure: on mostly-first-person text nearly every span is
 * legitimately `self`, so a model that always answers `self` still scores
 * near 1.0. The non-self subset is where the miss shows.
 */
export function attributionReport(
  gold: GoldSegment[],
  nodes: SemanticNode[]
): AttributionReport {
  const alignment = alignNodes(gold, nodes);
  const nodeForGold = new Map(
    alignment.matched.map((m) => [m.goldIndex, m.nodeIndex])
  );

  let labeled = 0;
  let aligned = 0;
  let correct = 0;
  let nonSelfLabeled = 0;
  let nonSelfAligned = 0;
  let nonSelfCorrect = 0;
  const mismatches: AttributionReport["mismatches"] = [];

  gold.forEach((segment, index) => {
    if (!segment.attribution) return;
    labeled++;
    const goldType = segment.attribution.type;
    const isNonSelf = goldType !== "self";
    if (isNonSelf) nonSelfLabeled++;

    const nodeIndex = nodeForGold.get(index);
    if (nodeIndex === undefined) return;
    aligned++;
    if (isNonSelf) nonSelfAligned++;

    const predicted = nodes[nodeIndex].attribution?.type ?? "self";
    if (predicted === goldType) {
      correct++;
      if (isNonSelf) nonSelfCorrect++;
    } else {
      mismatches.push({
        start: segment.start,
        end: segment.end,
        gold: goldType,
        predicted,
      });
    }
  });

  return {
    labeled,
    aligned,
    correct,
    accuracy: aligned === 0 ? null : ratio(correct, aligned),
    nonSelfLabeled,
    nonSelfAligned,
    nonSelfCorrect,
    nonSelfAccuracy: nonSelfAligned === 0 ? null : ratio(nonSelfCorrect, nonSelfAligned),
    mismatches,
  };
}

export type EdgeScope = "all" | "llm";

export interface FamilyReport {
  family: RelationFamily;
  goldTotal: number;
  predictedTotal: number;
  precision: number;
  recall: number;
  f1: number;
}

export interface EdgeReport {
  scope: EdgeScope;
  goldTotal: number;
  predictedTotal: number;
  tp: number;
  fp: number;
  fn: number;
  precision: number;
  recall: number;
  f1: number;
  byFamily: FamilyReport[];
  macroF1ByFamily: number;
  direction: { exact: number; reversed: number; accuracy: number | null };
}

export function edgeReport(
  gold: GoldEdge[],
  ir: SemanticIR,
  scope: EdgeScope = "llm"
): EdgeReport {
  const nodeById = new Map(ir.nodes.map((n) => [n.id, n]));

  // Scope governs both sides. Filtering only the prediction side would make
  // every out-of-scope gold edge an automatic false negative.
  const goldInScope =
    scope === "llm" ? gold.filter((e) => e.relation !== "precedes") : gold;

  const goldKeys = new Set(
    goldInScope.map((e) => edgeKey(e.source, e.target, e.relation))
  );

  const predicted: Array<{
    key: string;
    relation: EdgeRelation;
    source: Span;
    target: Span;
  }> = [];
  const seen = new Set<string>();

  for (const edge of ir.edges) {
    if (scope === "llm" && edge.relation === "precedes") continue;
    const src = nodeById.get(edge.source_node_id);
    const tgt = nodeById.get(edge.target_node_id);
    if (!src || !tgt) continue;
    const key = edgeKey(src.span_location, tgt.span_location, edge.relation);
    if (seen.has(key)) continue;
    seen.add(key);
    predicted.push({
      key,
      relation: edge.relation,
      source: src.span_location,
      target: tgt.span_location,
    });
  }

  let tp = 0;
  for (const edge of predicted) if (goldKeys.has(edge.key)) tp++;
  const predictedTotal = seen.size;
  const fp = predictedTotal - tp;
  const fn = Math.max(0, goldKeys.size - tp);

  let exact = 0;
  let reversed = 0;
  for (const edge of predicted) {
    if (goldKeys.has(edge.key)) {
      exact++;
      continue;
    }
    if (goldKeys.has(edgeKey(edge.target, edge.source, edge.relation))) reversed++;
  }

  const families = new Set<RelationFamily>(
    goldInScope.map((e) => RELATION_FAMILIES[e.relation])
  );
  for (const edge of predicted) families.add(RELATION_FAMILIES[edge.relation]);

  const byFamily: FamilyReport[] = [...families].sort().map((family) => {
    const goldInFamily = goldInScope.filter(
      (e) => RELATION_FAMILIES[e.relation] === family
    );
    const goldKeysInFamily = new Set(
      goldInFamily.map((e) => edgeKey(e.source, e.target, e.relation))
    );
    const predictedInFamily = predicted.filter(
      (e) => RELATION_FAMILIES[e.relation] === family
    );
    let familyTp = 0;
    for (const edge of predictedInFamily) {
      if (goldKeysInFamily.has(edge.key)) familyTp++;
    }
    const precision = ratio(familyTp, predictedInFamily.length);
    // Denominator is the deduplicated count, matching goldTotal below —
    // counting a duplicated gold label twice would report recall against a
    // total the report itself does not show.
    const recall = ratio(familyTp, goldKeysInFamily.size);
    return {
      family,
      goldTotal: goldKeysInFamily.size,
      predictedTotal: predictedInFamily.length,
      precision,
      recall,
      f1: f1Of(precision, recall),
    };
  });

  const scoredFamilies = byFamily.filter((f) => f.goldTotal > 0);
  const macroF1ByFamily =
    scoredFamilies.length === 0
      ? 0
      : scoredFamilies.reduce((sum, f) => sum + f.f1, 0) / scoredFamilies.length;

  const precision = ratio(tp, predictedTotal);
  const recall = ratio(tp, goldKeys.size);

  return {
    scope,
    goldTotal: goldKeys.size,
    predictedTotal,
    tp,
    fp,
    fn,
    precision,
    recall,
    f1: f1Of(precision, recall),
    byFamily,
    macroF1ByFamily,
    direction: {
      exact,
      reversed,
      accuracy: exact + reversed === 0 ? null : ratio(exact, exact + reversed),
    },
  };
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const key of a) if (b.has(key)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

export function irEdgeKeys(ir: SemanticIR): Set<string> {
  const nodeById = new Map(ir.nodes.map((n) => [n.id, n]));
  const keys = new Set<string>();
  for (const edge of ir.edges) {
    const src = nodeById.get(edge.source_node_id);
    const tgt = nodeById.get(edge.target_node_id);
    if (!src || !tgt) continue;
    keys.add(edgeKey(src.span_location, tgt.span_location, edge.relation));
  }
  return keys;
}

export interface StabilityReport {
  runs: number;
  edgeJaccardMean: number | null;
  edgeJaccardMin: number | null;
  nodeTypeAgreement: number | null;
}

export function stabilityReport(runs: SemanticIR[]): StabilityReport {
  if (runs.length < 2) {
    return {
      runs: runs.length,
      edgeJaccardMean: null,
      edgeJaccardMin: null,
      nodeTypeAgreement: null,
    };
  }

  const edgeSets = runs.map(irEdgeKeys);
  const jaccards: number[] = [];
  for (let i = 0; i < edgeSets.length; i++) {
    for (let j = i + 1; j < edgeSets.length; j++) {
      jaccards.push(jaccard(edgeSets[i], edgeSets[j]));
    }
  }

  const spanToTypes = runs.map((ir) => {
    const map = new Map<string, string>();
    for (const node of ir.nodes) {
      if (node.synthetic) continue;
      map.set(spanKey(node.span_location), node.type);
    }
    return map;
  });

  const commonSpans = [...spanToTypes[0].keys()].filter((span) =>
    spanToTypes.every((map) => map.has(span))
  );
  let agreeing = 0;
  for (const span of commonSpans) {
    const first = spanToTypes[0].get(span);
    if (spanToTypes.every((map) => map.get(span) === first)) agreeing++;
  }

  return {
    runs: runs.length,
    edgeJaccardMean: mean(jaccards),
    edgeJaccardMin: Math.min(...jaccards),
    nodeTypeAgreement: ratio(agreeing, commonSpans.length),
  };
}

export function countDirectionCorrections(
  before: SemanticIR["edges"],
  after: SemanticIR["edges"]
): number {
  const afterById = new Map(after.map((edge) => [edge.id, edge]));
  let corrected = 0;
  for (const edge of before) {
    const counterpart = afterById.get(edge.id);
    if (counterpart && counterpart.source_node_id !== edge.source_node_id) corrected++;
  }
  return corrected;
}

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

export function std(values: number[]): number {
  if (values.length < 2) return 0;
  const average = mean(values);
  const variance =
    values.reduce((sum, v) => sum + (v - average) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

export function summarize(values: Array<number | null>): {
  mean: number | null;
  std: number | null;
  min: number | null;
  max: number | null;
} {
  const present = values.filter((v): v is number => v !== null);
  if (present.length === 0) return { mean: null, std: null, min: null, max: null };
  return {
    mean: mean(present),
    std: present.length < 2 ? 0 : std(present),
    min: Math.min(...present),
    max: Math.max(...present),
  };
}

export interface DocumentMetrics {
  nodes: ClassificationReport;
  attribution: AttributionReport;
  edgesLlm: EdgeReport;
  edgesAll: EdgeReport;
}

export function evaluateRun(
  gold: GoldDocument,
  ir: SemanticIR
): DocumentMetrics {
  return {
    nodes: classificationReport(gold.segments, ir.nodes),
    attribution: attributionReport(gold.segments, ir.nodes),
    edgesLlm: edgeReport(gold.edges, ir, "llm"),
    edgesAll: edgeReport(gold.edges, ir, "all"),
  };
}
