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
