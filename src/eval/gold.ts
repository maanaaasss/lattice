import { z } from "zod";
import type { NodeType, EdgeRelation } from "../schema.js";
import { NodeTypeSchema, EdgeRelationSchema } from "../schema.js";

export const SpanSchema = z.object({
  start: z.number().int().nonnegative(),
  end: z.number().int().positive(),
});

export const AttributionTypeSchema = z.enum(["self", "citation", "external"]);

export const GoldSegmentSchema = z.object({
  start: z.number().int().nonnegative(),
  end: z.number().int().positive(),
  type: NodeTypeSchema,
  subtype: z.string().optional(),
  attribution: z
    .object({
      type: AttributionTypeSchema,
      ref: z.string().nullable().optional(),
    })
    .optional(),
  notes: z.string().optional(),
});

export const GoldEdgeSchema = z.object({
  source: SpanSchema,
  target: SpanSchema,
  relation: EdgeRelationSchema,
  notes: z.string().optional(),
});

export const GoldDocumentSchema = z.object({
  document: z.string().min(1),
  document_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  labeled_by: z.string().min(1),
  reviewed: z.boolean(),
  reviewed_by: z.string().optional(),
  created_at: z.string().min(1),
  segments: z.array(GoldSegmentSchema).min(1),
  edges: z.array(GoldEdgeSchema),
  notes: z.string().optional(),
});

export type GoldSegment = z.infer<typeof GoldSegmentSchema>;
export type GoldEdge = z.infer<typeof GoldEdgeSchema>;
export type GoldDocument = z.infer<typeof GoldDocumentSchema>;

export interface SourceCheck {
  sourceText: string;
  sha256: string;
}

/**
 * A gold file only means anything if it was labeled against the exact bytes
 * being evaluated, so the digest is checked rather than trusted. Spans are
 * offsets into that byte sequence — a silently edited source would silently
 * invalidate every label.
 */
export function verifySource(
  gold: GoldDocument,
  source: SourceCheck
): string[] {
  const problems: string[] = [];
  if (source.sha256 !== gold.document_sha256) {
    problems.push(
      `document_sha256 mismatch: gold was labeled against ${gold.document_sha256}, current source is ${source.sha256}`
    );
  }
  // The furthest-reaching segment, not the last in array order — a hand-edited
  // file may be unsorted, and an out-of-range span must not slip through just
  // because a later entry happens to be in bounds.
  let furthest: GoldSegment | null = null;
  for (const segment of gold.segments) {
    if (furthest === null || segment.end > furthest.end) furthest = segment;
  }
  if (furthest && furthest.end > source.sourceText.length) {
    problems.push(
      `segment [${furthest.start}, ${furthest.end}) ends past the source, which is only ${source.sourceText.length} characters`
    );
  }
  return problems;
}

export function validateGoldDocument(raw: unknown): {
  ok: boolean;
  data?: GoldDocument;
  errors: string[];
} {
  const result = GoldDocumentSchema.safeParse(raw);
  if (!result.success) {
    return {
      ok: false,
      errors: result.error.issues.map(
        (issue) =>
          `${issue.path.length > 0 ? issue.path.join(".") : "(root)"}: ${issue.message}`
      ),
    };
  }
  return { ok: true, data: result.data, errors: [] };
}

/** Segment ids the gold file does not cover — always a labeling gap, never a pipeline result. */
export function findSegmentOverlaps(segments: GoldSegment[]): string[] {
  const problems: string[] = [];
  const sorted = [...segments].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].start < sorted[i - 1].end) {
      problems.push(
        `segments overlap: [${sorted[i - 1].start}, ${sorted[i - 1].end}) and [${sorted[i].start}, ${sorted[i].end})`
      );
    }
  }
  for (const segment of sorted) {
    if (segment.end <= segment.start) {
      problems.push(`segment [${segment.start}, ${segment.end}) is empty`);
    }
  }
  return problems;
}

export type { NodeType, EdgeRelation };
