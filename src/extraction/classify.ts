import { z, ZodError } from "zod";
import type { RawSegment } from "../segmentation/segment.js";
import type { SemanticNode, NodeType, Attribution } from "../schema.js";
import type { LLMClient } from "./llm-client.js";

export const EXTRACTION_SYSTEM_PROMPT = `You are performing semantic node classification for a text-analysis pipeline. You will receive a JSON array of text segments from a single document, each with an id and its text. Classify EVERY segment into exactly one node type from this fixed list:

- Claim: a truth-apt statement, belief, or assertion
- Observation: a reported fact about oneself or the world, not evaluated for external truth
- Decision: a resolved choice or commitment to act
- Memory: a recalled past experience, first- or second-hand
- Value: a stable disposition or attachment
- Emotion: a felt state
- Event: something that happened, reported as fact

For each segment also determine:
- attribution: if the segment is the author's own first-person statement, output {"type":"self","ref":null}. If it explicitly cites or quotes another named source (a person, document, case, authority), output {"type":"citation","ref":"<the source as named in the text>"}.
- epistemic_confidence: for Observation, Memory, Value, Emotion, and Decision, ALWAYS output null — a first-person report of one's own state is not independently verifiable, the report itself is the ground truth. For Claim and Event ONLY, output a number from 0 to 1 estimating how likely the underlying content is true given the text and its context. This is NOT your confidence in the classification — only your estimate of the claim's truth.
- subtype: an optional short free-text label if a more specific description is meaningful (e.g. "Holding", "Definition"). Omit the field entirely if nothing more specific applies.

Return ONLY valid JSON, no commentary, in exactly this shape:
{"classifications":[{"segment_id":"seg-0","type":"Claim","subtype":"Definition","attribution":{"type":"self","ref":null},"epistemic_confidence":0.8}, ...]}

Every segment_id given to you must appear exactly once in the output. Do not invent segment ids. Do not add fields not listed above.`;

const ClassificationItemSchema = z.object({
  segment_id: z.string(),
  type: z.string(),
  subtype: z.string().nullable().optional(),
  attribution: z.object({
    type: z.string(),
    ref: z.string().nullable().optional().transform((v) => v ?? null),
  }).nullable().optional().transform((v) => v ?? { type: "self", ref: null }),
  epistemic_confidence: z.number().min(0).max(1).nullable().optional().transform((v) => v ?? null),
});

export const ClassificationSchema = z.object({
  classifications: z.array(ClassificationItemSchema),
});

function stripCodeFences(raw: string): string {
  const trimmed = raw.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
  if (fenceMatch) {
    return fenceMatch[1].trim();
  }
  return trimmed;
}

const CLASSIFYABLE_TYPES: NodeType[] = ["Claim", "Observation", "Decision", "Memory", "Value", "Emotion", "Event"];

export async function classifySegments(
  segments: RawSegment[],
  documentId: string,
  client: LLMClient,
  startIndex: number = 0
): Promise<SemanticNode[]> {
  const segmentsWithIds = segments.map((seg, i) => ({
    id: `seg-${startIndex + i}`,
    text: seg.text,
  }));

  const expectedIds = segmentsWithIds.map((s) => s.id);
  const userPrompt = JSON.stringify(segmentsWithIds);

  const rawResponse = await client.complete(EXTRACTION_SYSTEM_PROMPT, userPrompt);
  const stripped = stripCodeFences(rawResponse);
  const parsed = JSON.parse(stripped);

  let validated;
  try {
    validated = ClassificationSchema.parse(parsed);
  } catch (err) {
    if (err instanceof ZodError) {
      const rawTruncated = stripped.length > 3000 ? stripped.slice(0, 3000) + "…[truncated]" : stripped;
      const classifications = Array.isArray(parsed?.classifications) ? parsed.classifications : [];
      const returnedIds = classifications.map((c: { segment_id?: string }) => c.segment_id ?? "(missing)");
      const extraIds = returnedIds.filter((id: string) => !expectedIds.includes(id));
      const missingIds = expectedIds.filter((id: string) => !returnedIds.includes(id));
      throw new Error(
        `Classification schema validation failed.\n` +
        `Batch: seg-${startIndex} to seg-${startIndex + segments.length - 1} (${segments.length} segments expected)\n` +
        `Zod issues:\n${err.message}\n` +
        `Actual classifications array length: ${classifications.length}\n` +
        `Returned segment IDs: ${JSON.stringify(returnedIds)}\n` +
        `Extra IDs (model invented): ${extraIds.length > 0 ? JSON.stringify(extraIds) : "none"}\n` +
        `Missing IDs: ${missingIds.length > 0 ? JSON.stringify(missingIds) : "none"}\n` +
        `Raw LLM response:\n${rawTruncated}`
      );
    }
    throw err;
  }

  const classificationMap = new Map(
    validated.classifications.map((c) => [c.segment_id, c])
  );

  const nodes: SemanticNode[] = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const segId = `seg-${startIndex + i}`;
    const classification = classificationMap.get(segId);
    if (!classification) continue;

    nodes.push({
      id: segId,
      type: classification.type as NodeType,
      subtype: classification.subtype ?? undefined,
      text_span: seg.text,
      source_document_id: documentId,
      span_location: { start: seg.start, end: seg.end },
      attribution: classification.attribution as Attribution,
      temporal_position: null,
      epistemic_confidence: classification.epistemic_confidence,
      synthetic: false,
    });
  }

  return nodes;
}

export async function classifySegmentsBatched(
  segments: RawSegment[],
  documentId: string,
  client: LLMClient,
  batchSize: number = 20
): Promise<SemanticNode[]> {
  if (segments.length <= batchSize) {
    return classifySegments(segments, documentId, client);
  }

  const results: SemanticNode[] = [];
  for (let i = 0; i < segments.length; i += batchSize) {
    const batch = segments.slice(i, i + batchSize);
    const batchNodes = await classifySegments(batch, documentId, client, i);
    results.push(...batchNodes);
  }

  return results;
}
