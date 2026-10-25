# Master-BRD — BRD Truth Audit Agent Team

Checks which BRD requirements **really exist** in a system's code. Only proven requirements are recorded; everything else is discarded.

```
 BRD files ──► [brd-reader] ──► data/requirements.json
                                     │
 System code ─► [system-reader] ◄────┘ ──► data/system-evidence.json
                                                  │
               [truth-verifier] ◄─────────────────┘ ──► data/verified.json  (VERIFIED only)
                                                              │
               truth-gate hook  ── re-checks every snippet against the real files,
                                   drops anything unproven, rebuilds graph
                                                              │
                                                    data/graph-data.js ──► brain.html
```

## Use it
1. Edit `config.json`:
   - `brdPath`: folder with your BRD (`.md`, `.txt`, `.pdf`, `.docx`), e.g. `brd`
   - `systemPath`: the system's source folder (relative or absolute), e.g. `C:/Users/me/source/MySystem`
   - `systemName`: the name shown in the graph
2. Open Claude Code in this folder and run **`/brd-audit`**, or **`/brd-audit <BRD file>`** for one BRD
3. Open **`brain.html`** in your browser to see the rotating brain graph

### The knowledge base keeps growing
Audits are cumulative: no run erases earlier results.
- Auditing a **new BRD** adds its requirements.
- Re-running a **BRD you already audited** keeps every requirement found before (with the same ids) and adds any that the earlier reading missed.
- Status and evidence are refreshed only for the requirements the run re-checked. Each status keeps a `history`, so a change between runs (for example IMPLEMENTED → PARTIAL) is reported.

| Where | What |
|---|---|
| `data/requirements.json`, `system-evidence.json`, `verified.json`, `implementation-status.json` | The knowledge base: everything learned so far |
| `data/run/` | Scratch output of the run in progress (`scope.json` names the BRDs) |
| `data/runs/<runId>/` | Every finished run, archived with its `merge-summary.json` |
| `data/kb-log.json` | One line per run: scope, added, re-found, not re-found, status changes |

`node tools/kb-merge.js` does the merge, and `/brd-audit` runs it for you. Add `--dry-run` to preview a merge without changing anything.

## Pieces
| File | Role |
|---|---|
| `.claude/agents/brd-reader.md` | Agent 1: extracts atomic requirements from the BRD |
| `.claude/agents/system-reader.md` | Agent 2: searches the system for candidate evidence per requirement |
| `.claude/agents/truth-verifier.md` | Agent 3: re-reads the code and records only requirements that are truly implemented |
| `.claude/skills/brd-audit/SKILL.md` | `/brd-audit`: runs the 3 agents in order |
| `.claude/hooks/truth-gate.js` | **PostToolUse hook**: when `data/verified.json` or `data/run/verified.json` is written, checks that every snippet exists verbatim in the system files and drops anything unproven |
| `tools/kb-merge.js` | Merges a run (`data/run/`) into the cumulative knowledge base, archives it in `data/runs/` and logs it in `data/kb-log.json` |
| `.claude/hooks/build-graph.js` | Builds `data/graph-data.js` (also runs on **SubagentStop**) |
| `features.html` | Functional reference: every Customizer page and function (picker, builder, cart/MOQ/promo/PDF, sharing, checkout, orders, account), with rules, messages, flags, routes and open questions, traced from the source |
| `assets/nav.js` | Shared top navigation loaded by every page (Brain · BRD viewer · System map · Order flow · Analysis requests). Add new pages to its `PAGES` list |
| `brain.html` | Rotating 3D brain: core = system, lobes = areas, nodes = verified requirements, gold = code files that prove them |

Manual re-check at any time (e.g. after the system's code changes): `node .claude/hooks/truth-gate.js --all`. Requirements whose code has since disappeared are dropped.

Each audit also writes `data/implementation-status.json`, which gives every requirement a status of **IMPLEMENTED / PARTIAL / NOT_IMPLEMENTED** with gaps and file:line evidence. The truth gate checks those snippets too, and downgrades any claim it can't prove. `/brd-audit` reports these statuses per BRD.

## New-requirement analysis (separate workflow)
This analyzes new BRDs **before** development. It never looks at the Customizer repository.

```
 requester ─► analysis.html (portal) ─► BRD saved to brd-inbox/, request emailed to you ─► status Pending
                                                                                              │
 you run /brd-analyze ─► [brd-analyst] reads ONLY requests/ + brd-inbox/ (analysis-guard hook) ─► analysis.json
                                                                                              │
              tools/requests.js complete ─► report.md/.html emailed to the requester ─► status Completed
                                                                                              │
 you develop + manually update the Customizer repo ─► copy BRD to brd/ ─► /brd-audit ─► implementation status
```

### Setup (once)
1. `npm install`
2. Set up email with [EmailJS](https://dashboard.emailjs.com/):
   1. **Email Services** → Add New Service (e.g. Gmail or Outlook) and connect your mailbox. Copy the **Service ID**.
   2. **Email Templates** → Create New Template. Fill these fields with the variables exactly as shown:
      - To Email: `{{to_email}}`
      - From Name: `{{from_name}}`
      - Reply To: `{{reply_to}}`
      - Subject: `{{subject}}`
      - Content: switch the editor to code view and enter `{{{html}}}`. The triple braces keep the HTML formatting.
      - Optional, paid plans only: on the **Attachments** tab, add a **Variable Attachment** with parameter name `attachment` and filename `{{attachment_name}}`.

      Save it and copy the **Template ID**.
   3. **Account** → **General**: copy the **Public Key** and **Private Key**. Then open **Account** → **Security** and turn on **"Allow EmailJS API for non-browser applications"**. The portal sends from Node, so without this setting EmailJS answers 403. Also turn on **"Use Private Key"**.
   4. Copy `mail.config.example.json` to `mail.config.json`. Fill in `notifyEmail` (the address that receives new requests) and the four EmailJS values. Leave `attachments` set to `false` on the Free plan: it allows no attachments and caps each request at 50 KB.
      - On Personal, Professional or Business, set `attachments: true`, and set `maxAttachmentKB` and `maxRequestKB` to your plan's limits.
      - If a results email is too large, the portal sends the plain-text report instead. If even that is too large, the request is marked **Failed** with the size in the error.
      - Environment variables also work: `EMAILJS_SERVICE_ID`, `EMAILJS_TEMPLATE_ID`, `EMAILJS_PUBLIC_KEY`, `EMAILJS_PRIVATE_KEY`, `BRD_NOTIFY_EMAIL`.
   5. To use SMTP instead, set `"provider": "smtp"` and fill in the `smtp` block and `from`.
   6. Check the setup with `node tools/requests.js test-email`, which sends one test message to `notifyEmail`.
3. Run `npm run portal` and open http://localhost:4180/analysis.html. The portal listens on this machine only. To let others on your network submit requests, start it with `PORTAL_HOST=0.0.0.0`.

### Statuses
| Status | Meaning |
|---|---|
| Submission Failed | The notification email couldn't be sent. The requester sees an error, not a confirmation, and the request is not queued. |
| Pending | The notification email was sent and the request is waiting for `/brd-analyze`. |
| In Analysis | `prepare` has run and the analyst is working on it. |
| Completed | The results email reached the requester. |
| Failed | The BRD couldn't be read, the analysis couldn't finish, or the results email failed. It is never marked Completed. You are emailed. Re-run with `/brd-analyze <id>`. |

### Pieces
| File | Role |
|---|---|
| `analysis.html` | Request form (email, message, BRD file or link) and status list |
| `server/portal.js` | Serves the pages, validates the request, downloads linked BRDs, saves them to `brd-inbox/` and emails you. It confirms only after that email is sent. |
| `tools/requests.js` | Queue: `list`, `prepare`, `complete` (validates, renders, emails the requester), `fail` |
| `.claude/agents/brd-analyst.md` | Finds conflicts, ambiguities, missing requirements, dependencies, risks, recommendations and questions |
| `.claude/skills/brd-analyze/SKILL.md` | `/brd-analyze [id]` processes Pending requests from start to finish |
| `.claude/hooks/analysis-guard.js` | PreToolUse guard. The analyst may only read `requests/` and `brd-inbox/`, and write only to `requests/`. No Bash, no system code, no `data/`. |

Request records live in `requests/<id>/`: `request.json`, `brief.json`, `brd.txt`, `analysis.json` and `report.*`.

`examples/` holds a small demo BRD and system. In the demo, 3 of the 11 requirements are deliberately not met (a 2FA stub, a 48h cancel window where the BRD says 24h, and SMS code that is commented out).
