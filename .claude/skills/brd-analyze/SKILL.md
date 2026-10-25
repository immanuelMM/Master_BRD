---
name: brd-analyze
description: Process BRD analysis requests submitted through the portal (analysis.html) — run the brd-analyst agent on each Pending request without touching the Customizer repository, then email the results to the requester and mark the request Completed. Use when the user asks to analyze new BRDs / process pending BRD requests. Optional argument: a request id.
---

This is the **new-requirement analysis** workflow. It is separate from `/brd-audit`: do not read `config.json → systemPath`, `data/`, or the system pages, and do not launch brd-reader, system-reader or truth-verifier here.

1. Pick the requests:
   - If the user passed a request id (`BRQ-…`), use that one.
   - Otherwise run `node tools/requests.js list --status Pending`. If none, say so and stop.
2. For each request, one at a time:
   1. `node tools/requests.js prepare <id>` — moves it to **In Analysis**, extracts the BRD text and writes `requests/<id>/brief.json`. If it fails, it has already marked the request **Failed**; report the reason and continue with the next one.
   2. Launch subagent **brd-analyst** with the prompt: `Analyze request <id>. Read requests/<id>/brief.json.` Wait.
   3. If the analyst replied `CANNOT_ANALYZE: <reason>`, or `requests/<id>/analysis.json` was not written, run `node tools/requests.js fail <id> "<reason>"` and continue.
   4. `node tools/requests.js complete <id>` — validates the analysis, renders `report.md` / `report.html`, emails the results to the requester and only then marks it **Completed**.
      - If it reports validation problems, send them back to brd-analyst (SendMessage, or a new brd-analyst run) to fix `analysis.json`, then run `complete` again. Two failed attempts → `fail`.
      - If the email fails, the request is left **Failed** with the error; report it. Don't mark it completed any other way.
3. Report per request: id, requester, readiness verdict, counts (conflicts / ambiguities / missing / questions / risks), and final status.
4. Remind the user of the next manual steps: develop the change, update the Customizer repository, copy the BRD from `brd-inbox/` into `brd/`, then run `/brd-audit` to validate the implementation.
