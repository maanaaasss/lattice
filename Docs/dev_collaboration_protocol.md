# Development Collaboration Protocol — Claude + Coding Agent (opencode / MiMo-V2.5-Pro)

## Roles and the boundary between them
- **Claude (design authority):** owns schema fidelity, breaks work into small verifiable units, writes exact prompts for the coding agent, reviews everything that comes back, flags drift from Schema v1 or from a prompt's stated scope. Claude has **no direct access to the codebase** — every review is only as good as what gets pasted back.
- **You (relay + final decision-maker):** paste Claude's prompts into the coding agent, paste the coding agent's *actual output* — not a summary of it — back to Claude, run Claude's corrective prompts back through the coding agent when something needs fixing.
- **The coding agent (implementation):** has the codebase context Claude lacks; writes the real code.

## Why this needs to be explicit
The single point of failure here is "Claude reviews a description of the code instead of the code." A paraphrase like *"the coding agent added the segmentation function"* isn't checkable. Everything below exists to make sure what comes back is always verifiable, not just reassuring.

## What the coding agent actually is
opencode is a full agentic harness (file I/O, shell execution, its own planning/tool loop) — not an inline-suggestion tool like classic Copilot. MiMo-V2.5-Pro is a frontier open-weight coding/agentic model with a 1M-token context window, capable of sustaining long multi-tool-call tasks on its own. Practically: it can likely take a higher-level task description and work autonomously across multiple files without being spoon-fed each line. The single-unit-of-work scoping rule above still holds regardless — it's there so *I* can verify each round cleanly, not because the agent needs the hand-holding.

## Prompt format Claude will use, every time
1. **Scope to exactly one unit of work** — one function, one type, one pipeline stage. Never a bundle of changes in a single prompt; a bundle is harder to verify and harder to isolate if something's wrong.
2. **Reference Schema v1 by exact field/type name**, quoting the relevant excerpt directly in the prompt — unless the schema is already committed to the repo, in which case the prompt points to the file path instead (see below).
3. **State explicit non-goals** — "do not implement X yet," "do not rename existing fields," "do not add error handling beyond Y."
4. **Ask the coding agent to report back** exactly what it built and where it deviated or made an assumption. That report is part of what you paste back to me — not optional.

## What comes back to me each round
- The actual code or diff, in full
- Any error or test output
- The coding agent's own account of deviations/assumptions, if it gave one

## The review loop
Against whatever comes back, I check three things: does it conform to Schema v1's types and field names; does it do *only* what that specific prompt scoped; did the coding agent quietly expand or narrow the scope. If something's off I'll either write a precise corrective prompt, or flag it to you directly if it looks like a judgment call rather than a mistake worth reversing.

## One practical step before any feature prompt goes out
Schema v1 should become an actual checked-in file in the repo — the TypeScript interfaces from that doc, committed as literally the first thing in the project. That way every later prompt references it by path instead of me re-pasting excerpts each time, and the coding agent is reading the same source of truth I'm reviewing against.

## Still need from you before the first real prompt
- Language/stack for the prototype
- Where the coding agent is running (VS Code the coding agent Chat, the coding agent CLI/agent mode, Workspace)
- Whether extraction should call an LLM API from the start, or start rule-based/heuristic first to prove segmentation and evidence-linking mechanics before adding semantic extraction
