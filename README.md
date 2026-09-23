# Lattice

Transform any note into a structured knowledge graph. Lattice segments your text, classifies each segment into typed nodes (Claim, Observation, Decision, Memory, Emotion, Event, Value), and extracts relationships between them — all backed by verbatim evidence spans you can trace back to the source.

Works well with diary entries, meeting notes, and legal or narrative text. Large, heavily-structured technical documents (papers, specs with sections/cross-references) aren't well supported yet — the current pipeline is flat and sentence-level, with no heading-aware chunking. Every node and edge carries a direct reference to the original text it was extracted from.

## What it produces

The output is a `.ir.json.md` file alongside your note, containing:

- **Nodes** — each segment classified by type, with optional subtypes, confidence scores, and exact character offsets into the source text
- **Edges** — both rule-based (`precedes` from document order) and LLM-extracted relationships (`supports`, `contradicts`, `causes`, `elaborates`, `depends_on`, and more)
- **Evidence spans** — LLM-extracted edges include the verbatim text that justifies the relationship. Rule-based `precedes` edges reuse the connected segment's own text, since their justification is document position, not content.

## Setup

1. Manually copy `main.js` and `manifest.json` to your vault's `.obsidian/plugins/semantic-ir-compiler/` directory (Community Plugins submission pending)
2. Open Settings > Lattice and configure:
   - **LLM Base URL** — any OpenAI-compatible API endpoint (e.g. `https://api.groq.com/openai/v1`)
   - **LLM API Key** — your API key
   - **LLM Model** — model identifier (e.g. `openai/gpt-oss-20b`)
3. Open any note and run the command: **"Lattice: Compile current note"**

## Usage

```
Cmd/Ctrl + P → Lattice: Compile current note
```

A `.ir.json.md` file will be created in the same folder as your note, containing the full semantic intermediate representation as a JSON code block.

## How it works

1. **Segmentation** — splits text into sentence-level chunks
2. **Classification** — LLM classifies each chunk into a node type with optional subtype
3. **Rule-based relations** — derives `precedes` edges from document order, detects revision candidates
4. **LLM relation extraction** — identifies semantic relationships between nodes (supports, contradicts, causes, etc.)
5. **Assembly** — builds the final graph with direction correction rules for causal edges and revisions

## Network usage

This plugin makes API calls to an external LLM service that you configure. Your note content is sent to the configured endpoint for classification and relation extraction. No data is sent anywhere else. API keys are stored locally in your vault's plugin settings. Note: if you sync your vault (Obsidian Sync, iCloud, Dropbox, a git repo, etc.), your API key syncs along with it via that tool — Lattice doesn't control or limit this.

## Development

```bash
npm install
npm run build
npm test
```

To run the smoke test with a real LLM:

```bash
cp .env.example .env
# Fill in your API credentials
npm run smoke
```

## License

MIT
