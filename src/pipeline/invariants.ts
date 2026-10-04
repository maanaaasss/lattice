import type { SemanticIR, SemanticNode } from "../schema.js";
import { SemanticIRSchema, DIRECTION_RULES } from "../schema.js";

export type ViolationRule =
  | "SCHEMA_INVALID"
  | "SPAN_LOCATION_INVALID"
  | "SPAN_OUT_OF_RANGE"
  | "DUPLICATE_NODE_ID"
  | "DUPLICATE_EDGE_ID"
  | "DANGLING_EDGE_ENDPOINT"
  | "DOCUMENT_ID_MISMATCH"
  | "SELF_LOOP"
  | "TEXT_SPAN_NOT_VERBATIM"
  | "EVIDENCE_NOT_VERBATIM"
  | "PRECEDES_COUNT_INVALID"
  | "PRECEDES_CHAIN_INVALID"
  | "SYNTHETIC_INCONSISTENT"
  | "SYNTHETIC_NO_CONTRIBUTOR"
  | "DIRECTION_RULE_VIOLATION"
  | "CONFIDENCE_OUT_OF_RANGE";

export interface InvariantViolation {
  rule: ViolationRule;
  subjectId: string;
  message: string;
}

/**
 * Structural invariants every complete SemanticIR must satisfy, checked
 * against the source document the IR was compiled from.
 *
 * These encode the guarantees the schema claims to make but that
 * `SemanticIRSchema` alone cannot express: closed enums and required
 * fields are Zod's job, while verbatim offsets, verbatim evidence,
 * referential integrity, and edge direction rules all need the source
 * text or cross-record context.
 *
 * Every rule here exists because a real failure has already happened or
 * has already gone unchecked — see Docs/semantic_ir_schema_v1.md.
 * Loosening a rule is a schema change and needs the same justification
 * CONTRIBUTING.md asks for.
 */
export function checkIRInvariants(
  ir: SemanticIR,
  sourceText: string
): InvariantViolation[] {
  const violations: InvariantViolation[] = [];
  const add = (rule: ViolationRule, subjectId: string, message: string) => {
    violations.push({ rule, subjectId, message });
  };

  const schemaResult = SemanticIRSchema.safeParse(ir);
  if (!schemaResult.success) {
    for (const issue of schemaResult.error.issues) {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      add("SCHEMA_INVALID", path, `${issue.message} at ${path}`);
    }
  }

  const nodes: SemanticNode[] = Array.isArray(ir?.nodes) ? ir.nodes : [];
  const edges = Array.isArray(ir?.edges) ? ir.edges : [];

  const seenNodeIds = new Set<string>();
  const nodesById = new Map<string, SemanticNode>();
  for (const node of nodes) {
    if (seenNodeIds.has(node.id)) {
      add("DUPLICATE_NODE_ID", node.id, `node id "${node.id}" is not unique`);
    }
    seenNodeIds.add(node.id);
    if (!nodesById.has(node.id)) nodesById.set(node.id, node);
  }

  for (const node of nodes) {
    if (node.source_document_id !== ir.document_id) {
      add(
        "DOCUMENT_ID_MISMATCH",
        node.id,
        `source_document_id "${node.source_document_id}" does not match document_id "${ir.document_id}"`
      );
    }
    checkNode(node, sourceText, add);
  }

  const seenEdgeIds = new Set<string>();
  const precedesEdges: SemanticEdgeLike[] = [];
  const inboundContributors = new Map<string, number>();

  for (const edge of edges) {
    if (seenEdgeIds.has(edge.id)) {
      add("DUPLICATE_EDGE_ID", edge.id, `edge id "${edge.id}" is not unique`);
    }
    seenEdgeIds.add(edge.id);

    const src = nodesById.get(edge.source_node_id);
    const tgt = nodesById.get(edge.target_node_id);

    if (!src) {
      add(
        "DANGLING_EDGE_ENDPOINT",
        edge.id,
        `source_node_id "${edge.source_node_id}" does not resolve to a node`
      );
    }
    if (!tgt) {
      add(
        "DANGLING_EDGE_ENDPOINT",
        edge.id,
        `target_node_id "${edge.target_node_id}" does not resolve to a node`
      );
    }
    if (edge.source_node_id === edge.target_node_id) {
      add("SELF_LOOP", edge.id, `edge "${edge.id}" points at its own source`);
    }

    if (
      typeof edge.extraction_confidence !== "number" ||
      !Number.isFinite(edge.extraction_confidence) ||
      edge.extraction_confidence < 0 ||
      edge.extraction_confidence > 1
    ) {
      add(
        "CONFIDENCE_OUT_OF_RANGE",
        edge.id,
        `extraction_confidence ${String(edge.extraction_confidence)} is outside [0, 1]`
      );
    }

    if (!sourceText.includes(edge.evidence_span)) {
      add(
        "EVIDENCE_NOT_VERBATIM",
        edge.id,
        `evidence_span is not a verbatim substring of the source document: ${preview(edge.evidence_span)}`
      );
    }

    if (edge.relation === "precedes") {
      precedesEdges.push(edge);
      if (src && src.text_span !== edge.evidence_span) {
        add(
          "EVIDENCE_NOT_VERBATIM",
          edge.id,
          `precedes evidence_span must equal its source node's text_span`
        );
      }
    }

    if (src && tgt) {
      const rule = DIRECTION_RULES[edge.relation];
      if (rule) {
        const backwards =
          rule === "source-later"
            ? src.span_location.start < tgt.span_location.start
            : src.span_location.start > tgt.span_location.start;
        if (backwards) {
          add(
            "DIRECTION_RULE_VIOLATION",
            edge.id,
            `${edge.relation} requires a "${rule}" source but source starts at ${src.span_location.start} and target at ${tgt.span_location.start}`
          );
        }
      }
    }

    if (tgt && tgt.synthetic && edge.relation === "contributes_to") {
      inboundContributors.set(
        tgt.id,
        (inboundContributors.get(tgt.id) ?? 0) + 1
      );
    }
  }

  for (const node of nodes) {
    if (node.synthetic && (inboundContributors.get(node.id) ?? 0) === 0) {
      add(
        "SYNTHETIC_NO_CONTRIBUTOR",
        node.id,
        `synthetic node "${node.id}" has no inbound contributes_to edge`
      );
    }
  }

  checkPrecedesChain(nodes, precedesEdges, add);

  return violations;
}

interface SemanticEdgeLike {
  id: string;
  source_node_id: string;
  target_node_id: string;
  relation: string;
}

function checkNode(
  node: SemanticNode,
  sourceText: string,
  add: (rule: ViolationRule, subjectId: string, message: string) => void
): void {
  const span = node.span_location;
  const start = span?.start;
  const end = span?.end;

  if (
    typeof start !== "number" ||
    typeof end !== "number" ||
    !Number.isInteger(start) ||
    !Number.isInteger(end)
  ) {
    add(
      "SPAN_LOCATION_INVALID",
      node.id,
      `span_location must be integers, got ${JSON.stringify(span)}`
    );
  } else if (start < 0 || end > sourceText.length) {
    add(
      "SPAN_OUT_OF_RANGE",
      node.id,
      `span [${start}, ${end}] is outside the source document (length ${sourceText.length})`
    );
  } else if (node.synthetic) {
    // Synthetic nodes carry no source text, so an empty span is legal;
    // a non-empty one would imply text they do not have.
    if (start !== end) {
      add(
        "SPAN_OUT_OF_RANGE",
        node.id,
        `synthetic node span [${start}, ${end}] must be empty`
      );
    }
  } else {
    if (start >= end) {
      add(
        "SPAN_OUT_OF_RANGE",
        node.id,
        `span [${start}, ${end}] must satisfy start < end for a non-synthetic node`
      );
    } else if (sourceText.slice(start, end) !== node.text_span) {
      add(
        "TEXT_SPAN_NOT_VERBATIM",
        node.id,
        `text_span does not equal sourceText[${start}, ${end}]: ${preview(node.text_span)}`
      );
    }
  }

  if (node.synthetic && node.text_span !== null) {
    add(
      "SYNTHETIC_INCONSISTENT",
      node.id,
      `synthetic node must have text_span null, got ${preview(node.text_span)}`
    );
  }
  if (!node.synthetic && node.text_span === null) {
    add(
      "SYNTHETIC_INCONSISTENT",
      node.id,
      `non-synthetic node must have a text_span, got null`
    );
  }

  const confidence = node.epistemic_confidence;
  if (
    confidence !== null &&
    (typeof confidence !== "number" ||
      !Number.isFinite(confidence) ||
      confidence < 0 ||
      confidence > 1)
  ) {
    add(
      "CONFIDENCE_OUT_OF_RANGE",
      node.id,
      `epistemic_confidence ${String(confidence)} must be null or within [0, 1]`
    );
  }
}

/**
 * `derivePrecedesEdges` builds one edge per consecutive pair in document
 * order, so an IR over m non-synthetic nodes must carry exactly m-1 of
 * them, and they must trace that exact chain. Anything else means the
 * edges were filtered, reordered, or fabricated somewhere downstream.
 */
function checkPrecedesChain(
  nodes: SemanticNode[],
  precedesEdges: SemanticEdgeLike[],
  add: (rule: ViolationRule, subjectId: string, message: string) => void
): void {
  const chain = nodes
    .filter((n) => !n.synthetic && typeof n.span_location?.start === "number")
    .sort((a, b) => a.span_location.start - b.span_location.start);

  if (chain.length < 2) return;

  const expected = chain.length - 1;
  if (precedesEdges.length !== expected) {
    add(
      "PRECEDES_COUNT_INVALID",
      "(document)",
      `expected ${expected} precedes edges for ${chain.length} nodes, found ${precedesEdges.length}`
    );
  }

  const expectedPairs = new Set<string>();
  for (let i = 0; i < chain.length - 1; i++) {
    expectedPairs.add(`${chain[i].id}->${chain[i + 1].id}`);
  }
  for (const edge of precedesEdges) {
    const pair = `${edge.source_node_id}->${edge.target_node_id}`;
    if (!expectedPairs.has(pair)) {
      add(
        "PRECEDES_CHAIN_INVALID",
        edge.id,
        `precedes edge ${pair} is not a consecutive pair in document order`
      );
    }
  }
}

function preview(value: string | null | undefined): string {
  if (value == null) return String(value);
  const flat = value.replace(/\s+/g, " ");
  return flat.length > 80 ? `"${flat.slice(0, 80)}…"` : `"${flat}"`;
}

export function formatViolations(violations: InvariantViolation[]): string {
  return violations
    .map((v) => `  [${v.rule}] ${v.subjectId}: ${v.message}`)
    .join("\n");
}

export function assertIRInvariants(ir: SemanticIR, sourceText: string): void {
  const violations = checkIRInvariants(ir, sourceText);
  if (violations.length > 0) {
    throw new Error(
      `Semantic IR failed ${violations.length} invariant check(s):\n${formatViolations(violations)}`
    );
  }
}
