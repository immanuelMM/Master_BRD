---
name: brd-audit
description: Run the BRD audit agent team — BRD Reader → System Reader → Truth Verifier — and refresh the brain graph (brain.html). Use when the user asks to audit, verify or check the BRD against the system.
---

The audit builds a **cumulative knowledge base**. It never erases earlier results:
- `data/requirements.json`, `data/system-evidence.json`, `data/verified.json` and `data/implementation-status.json` hold everything learned from every BRD so far. **Never delete or overwrite them.**
- Each run writes to `data/run/`. Then `tools/kb-merge.js` merges the run into the knowledge base:
  - New BRD: its requirements are added.
  - Re-run of a known BRD: requirements found again keep their ids, the ones an earlier reading missed are added, and the ones not found again stay.
  - Status and verified entries are replaced only for the requirements the run re-checked. Each status keeps its history.
  - The run is archived in `data/runs/<runId>/`, and logged in `data/kb-log.json`.

Run the three-agent pipeline in order. Each step depends on the previous one's file, so run them sequentially, not in parallel.

Agent teams are enabled (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` in `.claude/settings.json`). Create an agent team with three teammates, **brd-reader**, **system-reader** and **truth-verifier**, each following its definition in `.claude/agents/`. Make the tasks depend on each other: system-reader waits for brd-reader, and truth-verifier waits for system-reader. If agent teams are unavailable, run the same three as subagents.

1. **Scope.** Leave `brdPath` in `config.json` pointing at the BRD folder (`brd`).
   - If the user passed a system path, update `systemPath`.
   - If the user named BRD file(s), resolve them. Copy any file that is outside `brdPath` into it, and note that it is new.
   - Write `data/run/scope.json`:
     ```json
     { "runId": "<YYYY-MM-DD>-<short-slug>", "brd": ["brd/<file>", ...] }
     ```
     Without named files, list every BRD under `brdPath`. If a run with the same id already exists in `data/runs/`, add `-2`, `-3`, and so on.
2. **Clear only the scratch folder.** Delete every file in `data/run/` except `scope.json`. A finished run has already been merged and archived. If `data/run/` holds a run that was never merged (no folder for its runId in `data/runs/`), ask the user before deleting it.
3. Launch **brd-reader**. Wait. Confirm `data/run/requirements.json` exists and has requirements. If it is empty, stop and report.
4. Launch **system-reader**. Wait. Confirm `data/run/system-evidence.json` exists.
5. Launch **truth-verifier**. Wait. The `truth-gate` hook re-checks every snippet in `data/run/verified.json` and drops anything not found in the real code. It also checks `data/run/implementation-status.json`, and downgrades any IMPLEMENTED/PARTIAL item it cannot prove.
6. **Merge.** Run these in order:
   - `node tools/kb-merge.js`, which merges, archives, clears `data/run/` and rebuilds the graph.
   - `node .claude/hooks/truth-gate.js --all`.
   - If a BRD file was added to `brdPath` in step 1, run `python tools/brd2html.py` so the BRD viewer shows it.
7. **Report** from the merge output and `data/runs/<runId>/merge-summary.json`:
   - This run: requirements read, new requirements added (ids), requirements re-found, requirements kept from earlier runs but not re-found, and any status upgrades or downgrades. List each downgrade so the user can review it.
   - Knowledge base: total requirements, total verified, and verified per category.
   - Tell the user to open `brain.html`.

   The graph and `verified.json` hold only verified data.
8. **Implementation validation** comes from `data/implementation-status.json`.
   - For each BRD file in scope, give the IMPLEMENTED / PARTIAL / NOT_IMPLEMENTED counts and an overall verdict:
     - *fully implemented*: all IMPLEMENTED;
     - *partially implemented*: some IMPLEMENTED or PARTIAL;
     - *not implemented*: none IMPLEMENTED or PARTIAL.
   - When the user is validating a specific BRD, list each of its PARTIAL and NOT_IMPLEMENTED requirements with its gaps, and give the file:line evidence for each IMPLEMENTED/PARTIAL one.
