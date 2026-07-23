export interface RawSegment {
  text: string;
  start: number;
  end: number;
  paragraph_index: number;
}

const ABBREVIATIONS = new Set([
  "Dr.", "Mr.", "Mrs.", "Ms.", "Prof.", "Sr.", "Jr.",
  "U.S.", "U.K.", "U.N.", "E.U.",
  "etc.", "vs.", "approx.",
  "Ph.D.", "M.D.", "B.A.", "M.A.", "J.D.",
  "Inc.", "Ltd.", "Corp.", "Co.",
  "St.", "Ave.", "Blvd.", "Rd.",
  "Jan.", "Feb.", "Mar.", "Apr.", "Aug.", "Sept.", "Oct.", "Nov.", "Dec.",
  "vol.", "est.", "dept.", "univ.",
  "p.m.", "a.m.",
]);

const SENTENCE_BOUNDARY_RE = /[.!?]["'\u201d\u2019]?(?:\s+|$)/g;

const MARKDOWN_PREFIX_RE =
  /^(?:>+\s*|(?:[-*+]\s+(?:\[[ xX]\]\s+)?)|\d+[.)]\s+|#{1,6}\s+)/;

function isAbbreviation(textBefore: string): boolean {
  const words = textBefore.trimEnd().split(/\s+/);
  const lastWord = words[words.length - 1] ?? "";
  if (ABBREVIATIONS.has(lastWord)) return true;
  if (ABBREVIATIONS.has(lastWord + ".")) return true;
  return false;
}

function splitSentences(text: string): string[] {
  const result: string[] = [];
  let last = 0;

  SENTENCE_BOUNDARY_RE.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = SENTENCE_BOUNDARY_RE.exec(text)) !== null) {
    const textBefore = text.slice(0, match.index + 1);

    if (isAbbreviation(textBefore)) {
      continue;
    }

    const splitPoint = match.index + match[0].length;
    result.push(text.slice(last, splitPoint));
    last = splitPoint;
  }

  if (last < text.length) {
    result.push(text.slice(last));
  }

  return result;
}

export function segmentText(rawText: string): RawSegment[] {
  if (!rawText) return [];

  const segments: RawSegment[] = [];
  const paragraphs = rawText.split(/\n{2,}/);

  let globalOffset = 0;

  for (let paraIdx = 0; paraIdx < paragraphs.length; paraIdx++) {
    const para = paragraphs[paraIdx];

    if (paraIdx > 0) {
      const sepMatch = rawText.slice(globalOffset).match(/^\n{2,}/);
      if (sepMatch) {
        globalOffset += sepMatch[0].length;
      }
    }

    const trimmedPara = para.replace(/^\n+/, "");
    const leadingNewlines = para.length - trimmedPara.length;

    const prefixMatch = trimmedPara.match(MARKDOWN_PREFIX_RE);
    const contentPara = prefixMatch
      ? trimmedPara.slice(prefixMatch[0].length)
      : trimmedPara;
    const prefixLen = prefixMatch ? prefixMatch[0].length : 0;

    globalOffset += leadingNewlines + prefixLen;

    const sentences = splitSentences(contentPara);

    let localOffset = 0;
    for (const sentence of sentences) {
      const trimmed = sentence.trim();
      if (!trimmed) {
        localOffset += sentence.length;
        continue;
      }

      const trimStart = sentence.indexOf(trimmed);
      const start = globalOffset + localOffset + trimStart;
      const end = start + trimmed.length;

      segments.push({
        text: trimmed,
        start,
        end,
        paragraph_index: paraIdx,
      });

      localOffset += sentence.length;
    }

    globalOffset += contentPara.length;
  }

  return segments;
}
