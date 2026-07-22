import type { SemanticNode, SemanticEdge } from "../schema.js";

export interface RevisionCandidate {
  node_id: string;
  matched_marker: string;
}

/**
 * Derive `precedes` edges from document order.
 *
 * Nodes are sorted by span_location.start and consecutive pairs get one edge.
 * evidence_span reuses the source node's own text_span because `precedes` is
 * derived from document position, not textual content — there is no separate
 * justifying span to cite. Reusing real source text (never a fabricated string)
 * preserves the "no fabricated span" invariant honestly.
 */
export function derivePrecedesEdges(nodes: SemanticNode[]): SemanticEdge[] {
  if (nodes.length < 2) return [];

  const sorted = [...nodes].sort(
    (a, b) => a.span_location.start - b.span_location.start
  );

  const edges: SemanticEdge[] = [];

  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];

    if (a.text_span === null) {
      throw new Error(
        `Cannot derive precedes edge: node "${a.id}" has null text_span (synthetic node). ` +
          "precedes edges require real source text for evidence_span."
      );
    }

    edges.push({
      id: `edge-precedes-${a.id}-${b.id}`,
      source_node_id: a.id,
      target_node_id: b.id,
      relation: "precedes",
      extraction_confidence: 1.0,
      evidence_span: a.text_span,
    });
  }

  return edges;
}

const REVISION_PATTERNS: { pattern: RegExp; marker: string }[] = [
  { pattern: /\bonce\b[\s\S]*\bnow\b/i, marker: "once...now" },
  { pattern: /\bused to\b[\s\S]*\bany ?more\b/i, marker: "used to...anymore" },
  {
    pattern: /\bit was not until\b[\s\S]*\bthat\b/i,
    marker: "not until...that",
  },
];

/**
 * Flag nodes whose text matches revision-marker heuristics.
 *
 * Returns candidates only — does NOT resolve them into `revises` edges.
 * Target resolution happens in a later LLM stage.
 */
export function detectRevisionCandidates(
  nodes: SemanticNode[]
): RevisionCandidate[] {
  const results: RevisionCandidate[] = [];

  for (const node of nodes) {
    if (node.text_span === null) continue;

    for (const { pattern, marker } of REVISION_PATTERNS) {
      if (pattern.test(node.text_span)) {
        results.push({ node_id: node.id, matched_marker: marker });
        break; // first match wins — node appears at most once
      }
    }
  }

  return results;
}
