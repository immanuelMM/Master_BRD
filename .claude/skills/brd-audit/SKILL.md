---
name: brd-audit
description: Run the BRD audit agent team — BRD Reader → System Reader → Truth Verifier — and refresh the brain graph (brain.html). Use when the user asks to audit, verify or check the BRD against the system.
---

Run the three-agent pipeline in order. Each step depends on the previous one's file, so run them sequentially, not in parallel.

Agent teams are enabled (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` in `.claude/settings.json`). Create an agent team with three teammates, **brd-reader**, **system-reader** and **truth-verifier**, each following its definition in `.claude/agents/`. Make the tasks depend on each other: system-reader waits for brd-reader, and truth-verifier waits for system-reader. If agent teams are unavailable, run the same three as subagents.

1. If the user passed a BRD path or system path as arguments, update `brdPath` / `systemPath` in `config.json` first.
2. Delete stale outputs: `data/requirements.json`, `data/system-evidence.json`, `data/verified.json`, `data/implementation-status.json` (if present).
3. Launch subagent **brd-reader**. Wait. Confirm `data/requirements.json` exists and has requirements; stop and report if it is empty.
4. Launch subagent **system-reader**. Wait. Confirm `data/system-evidence.json` exists.
5. Launch subagent **truth-verifier**. Wait. The `truth-gate` hook will re-check every snippet in `data/verified.json` and drop anything not found in the real code. It also checks `data/implementation-status.json` and downgrades any IMPLEMENTED/PARTIAL item it cannot prove.
6. Run `node .claude/hooks/build-graph.js` to make sure the graph is current.
7. Report to the user: total extracted, total verified, verified per category, and tell them to open `brain.html`.
   The graph and `verified.json` hold only verified data.
8. **Implementation validation** (from `data/implementation-status.json`): per BRD file, give the IMPLEMENTED / PARTIAL / NOT_IMPLEMENTED counts and an overall verdict for that BRD — *fully implemented* (all IMPLEMENTED), *partially implemented*, or *not implemented* (none IMPLEMENTED or PARTIAL). When the user is validating a specific (new) BRD, list each of its PARTIAL and NOT_IMPLEMENTED requirements with its gaps, and the file:line evidence for each IMPLEMENTED/PARTIAL one.
