# Lattice

Lattice takes plain text and turns it into a structured graph of ideas and how they connect.

Give it a diary entry, meeting notes, a legal document, or any other text, and it breaks the content into meaningful pieces, figures out what each piece represents, and links everything together. Every node in the graph keeps a reference to the original text, so you can always trace information back to where it came from.

It also comes with an Obsidian plugin, so you can run it directly inside your notes.

## Current status

The project is still a work in progress.

**Working**

- Splits text into meaningful chunks
- Classifies each chunk and builds a graph
- Includes tests and smoke tests
- Obsidian plugin can send text to an LLM and generate graph data
- Has a rate-limited LLM client with a rule-based fallback for extracting relationships

**Still improving**

- Compound sentences can be difficult to classify (for example, "I was happy but exhausted")
- Only processes one document at a time
- Causal relationships are sometimes missing or point in the wrong direction
- Commands and instructions don't fit the current categories very well
- Scientific and technical writing may need additional relation types

## Quick start

```bash
npm install
npm run build
npm test
```

To test it with a real LLM:

```bash
npm run smoke
```
