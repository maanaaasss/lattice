import { z } from "zod";

export type NodeType =
  | "Claim" | "Observation" | "Decision" | "Memory"
  | "Value" | "Emotion" | "Event"
  | "Confluence";

export interface Attribution {
  type: "self" | "citation" | "external";
  ref: string | null;
}

export interface SemanticNode {
  id: string;
  type: NodeType;
  subtype?: string;
  text_span: string | null;
  source_document_id: string;
  span_location: { start: number; end: number };
  attribution: Attribution;
  temporal_position: string | null;
  epistemic_confidence: number | null;
  synthetic: boolean;
  segmentation_note?: string;
}

export type EdgeRelation =
  | "supports" | "contradicts" | "undercuts" | "elaborates" | "generalizes"
  | "causes" | "enables" | "establishes" | "extends" | "overrules" | "contributes_to"
  | "precedes" | "revises"
  | "depends_on";

export interface SemanticEdge {
  id: string;
  source_node_id: string;
  target_node_id: string;
  relation: EdgeRelation;
  extraction_confidence: number;
  evidence_span: string;
  interpretation_group?: string;
}

export interface SemanticIR {
  document_id: string;
  nodes: SemanticNode[];
  edges: SemanticEdge[];
  generated_at: string;
  schema_version: "1.0";
}

// Runtime mirror of the TypeScript interfaces above. The two live in the
// same file so neither can change without the other showing up in the diff.

export const NodeTypeSchema = z.enum(["Claim", "Observation", "Decision", "Memory", "Value", "Emotion", "Event", "Confluence"]);

const ATTRIBUTION_TYPES = ["self", "citation", "external"] as const;

function isAttributionType(value: string): value is Attribution["type"] {
  return (ATTRIBUTION_TYPES as readonly string[]).includes(value);
}

const AttributionSchema = z.unknown().optional().transform((v): Attribution => {
  if (v == null || typeof v !== "object") {
    return { type: "self", ref: null };
  }
  const fields = v as Record<string, unknown>;
  if (typeof fields.type !== "string" || !isAttributionType(fields.type)) {
    return { type: "self", ref: null };
  }
  const ref = typeof fields.ref === "string" ? fields.ref : null;
  return { type: fields.type, ref };
});

const SemanticNodeSchema = z.object({
  id: z.string(),
  type: NodeTypeSchema,
  subtype: z.string().optional(),
  text_span: z.string().nullable(),
  source_document_id: z.string(),
  span_location: z.object({ start: z.number(), end: z.number() }),
  attribution: AttributionSchema,
  temporal_position: z.string().nullable(),
  epistemic_confidence: z.number().nullable(),
  synthetic: z.boolean(),
  segmentation_note: z.string().optional(),
});

export const EdgeRelationSchema = z.enum([
  "supports", "contradicts", "undercuts", "elaborates", "generalizes",
  "causes", "enables", "establishes", "extends", "overrules", "contributes_to",
  "precedes", "revises", "depends_on",
]);

const SemanticEdgeSchema = z.object({
  id: z.string(),
  source_node_id: z.string(),
  target_node_id: z.string(),
  relation: EdgeRelationSchema,
  extraction_confidence: z.number(),
  evidence_span: z.string().min(1),
  interpretation_group: z.string().optional(),
});

export const SemanticIRSchema = z.object({
  document_id: z.string(),
  nodes: z.array(SemanticNodeSchema),
  edges: z.array(SemanticEdgeSchema),
  generated_at: z.string(),
  schema_version: z.literal("1.0"),
});

export type DirectionRule = "source-later" | "source-earlier";

export const DIRECTION_RULES: Partial<Record<SemanticEdge["relation"], DirectionRule>> = {
  // Empirically confirmed via repeated live smoke-test runs — see
  // Docs/semantic_ir_schema_v1.md for the evidence behind each entry.
  revises: "source-later",   // 2/3 runs backwards when left to the prompt
  causes: "source-earlier",  // 6/6 causal edges observed backwards
  enables: "source-earlier", // same evidence set as causes
  // establishes/extends are NOT included — same causal family, but
  // their directionality has not been empirically tested. Do not add
  // them speculatively.
};

// Relation families as grouped in Docs/semantic_ir_schema_v1.md. Eval
// reports precision/recall per family, because a miss on `precedes` and a
// miss on `causes` are not the same kind of failure.
export type RelationFamily = "logical" | "causal" | "temporal" | "dependency";

export const RELATION_FAMILIES: Record<EdgeRelation, RelationFamily> = {
  supports: "logical",
  contradicts: "logical",
  undercuts: "logical",
  elaborates: "logical",
  generalizes: "logical",
  causes: "causal",
  enables: "causal",
  establishes: "causal",
  extends: "causal",
  overrules: "causal",
  contributes_to: "causal",
  precedes: "temporal",
  revises: "temporal",
  depends_on: "dependency",
};
