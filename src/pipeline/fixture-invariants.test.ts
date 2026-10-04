import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { SemanticIR } from "../schema.js";
import { checkIRInvariants } from "./invariants.js";

interface Fixture {
  ir: string;
  source: string;
}

const FIXTURES: Fixture[] = [
  {
    ir: "test-fixtures/short-diary.ir.json.md",
    source: "test-documents/short-diary.txt",
  },
  {
    ir: "test-fixtures/medium-diary.ir.json.md",
    source: "test-documents/medium-diary.txt",
  },
  { ir: "test-fixtures/smoke-ir.json", source: "test-documents/short-diary.txt" },
  {
    ir: "test-fixtures/smoke-ir-before.json",
    source: "test-documents/medium-diary.txt",
  },
  {
    ir: "test-fixtures/smoke-ir-run1.json",
    source: "test-documents/medium-diary.txt",
  },
  {
    ir: "test-fixtures/smoke-ir-run3.json",
    source: "test-documents/medium-diary.txt",
  },
  // The 141-segment benchmark IR — largest real document the pipeline has
  // produced, so it exercises the rules at scale rather than on toy inputs.
  {
    ir: "test-fixtures/stress-141.ir.json",
    source: "test-documents/trimmed-diary.txt",
  },
];

function repoPath(relative: string): string {
  return fileURLToPath(new URL(`../../${relative}`, import.meta.url));
}

function loadIR(path: string): SemanticIR {
  const raw = readFileSync(path, "utf8");
  if (path.endsWith(".ir.json.md")) {
    const fenced = raw.match(/```json\n([\s\S]*?)\n```/);
    if (!fenced) {
      throw new Error(`no fenced JSON block found in ${path}`);
    }
    return JSON.parse(fenced[1]) as SemanticIR;
  }
  return JSON.parse(raw) as SemanticIR;
}

describe.each(FIXTURES)("fixture $ir", ({ ir, source }) => {
  const irPath = repoPath(ir);
  const sourceText = readFileSync(repoPath(source), "utf8");
  const parsed = loadIR(irPath);

  it("passes every structural invariant", () => {
    expect(checkIRInvariants(parsed, sourceText)).toEqual([]);
  });

  it("attributes every node to the document it was compiled from", () => {
    expect(parsed.nodes.length).toBeGreaterThan(0);
    for (const node of parsed.nodes) {
      expect(node.source_document_id).toBe(parsed.document_id);
    }
  });
});
