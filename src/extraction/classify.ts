import { z } from "zod";
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
  type: z.enum(["Claim", "Observation", "Decision", "Memory", "Value", "Emotion", "Event"]),
  subtype: z.string().nullable().optional(),
  attribution: z.object({
    type: z.enum(["self", "citation", "external"]),
    ref: z.string().nullable(),
  }),
  epistemic_confidence: z.number().min(0).max(1).nullable(),
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
  client: LLMClient
): Promise<SemanticNode[]> {
  const segmentsWithIds = segments.map((seg, i) => ({
    id: `seg-${i}`,
    text: seg.text,
  }));

  const userPrompt = JSON.stringify(segmentsWithIds);

  const rawResponse = await client.complete(EXTRACTION_SYSTEM_PROMPT, userPrompt);
  const stripped = stripCodeFences(rawResponse);
  const parsed = JSON.parse(stripped);
  const validated = ClassificationSchema.parse(parsed);

  if (validated.classifications.length !== segments.length) {
    throw new Error(
      `Classification count mismatch: expected ${segments.length} classifications, got ${validated.classifications.length}`
    );
  }

  const classificationMap = new Map(
    validated.classifications.map((c) => [c.segment_id, c])
  );

  for (const segWithId of segmentsWithIds) {
    if (!classificationMap.has(segWithId.id)) {
      throw new Error(
        `Missing classification for segment "${segWithId.id}"`
      );
    }
  }

  return segments.map((seg, i): SemanticNode => {
    const segId = `seg-${i}`;
    const classification = classificationMap.get(segId)!;

    return {
      id: segId,
      type: classification.type,
      subtype: classification.subtype ?? undefined,
      text_span: seg.text,
      source_document_id: documentId,
      span_location: { start: seg.start, end: seg.end },
      attribution: classification.attribution as Attribution,
      temporal_position: null,
      epistemic_confidence: classification.epistemic_confidence,
      synthetic: false,
    };
  });
}
