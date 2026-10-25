#!/usr/bin/env node
// Merges one audit run (data/run/*.json) into the knowledge base (data/*.json).
// The knowledge base only grows: requirements are never removed, a re-run of a BRD adds the
// requirements an earlier reading missed, and every run is archived under data/runs/<runId>/.
// Status and verified entries are replaced only for the requirements the run re-checked;
// each status keeps its history so a change between runs is visible.
// Usage (from the project root): node tools/kb-merge.js [--dry-run]
const fs = require('fs');
const path = require('path');
const { DATA, readJson } = require('../.claude/hooks/lib');
const { build } = require('../.claude/hooks/build-graph');

const RUN = path.join(DATA, 'run');
const RUNS = path.join(DATA, 'runs');
const LOG = path.join(DATA, 'kb-log.json');
const FILES = ['requirements', 'system-evidence', 'verified', 'implementation-status'];
const RANK = { NOT_IMPLEMENTED: 0, PARTIAL: 1, IMPLEMENTED: 2 };
const dry = process.argv.includes('--dry-run');

const textKey = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const idNum = (id) => { const m = /^REQ-(\d+)$/.exec(id || ''); return m ? +m[1] : 0; };
const fileOf = (r) => String((r && r.source && r.source.file) || '').replace(/\\/g, '/');
const uniq = (arr) => [...new Set(arr.filter(Boolean))];

const run = Object.fromEntries(FILES.map((f) => [f, readJson(path.join(RUN, `${f}.json`))]));
if (!run.requirements || !Array.isArray(run.requirements.requirements) || !run.requirements.requirements.length) {
  console.error('kb-merge: data/run/requirements.json is missing or empty, so there is nothing to merge.');
  process.exit(1);
}
const kb = {
  requirements: readJson(path.join(DATA, 'requirements.json'), { brd: [], requirements: [] }),
  'system-evidence': readJson(path.join(DATA, 'system-evidence.json'), { findings: [] }),
  verified: readJson(path.join(DATA, 'verified.json'), { requirements: [] }),
  'implementation-status': readJson(path.join(DATA, 'implementation-status.json'), { requirements: [] }),
};
const scope = readJson(path.join(RUN, 'scope.json'), {});
const runId = scope.runId || new Date().toISOString().replace(/[:.]/g, '-');
const now = new Date().toISOString();

// 1. Requirements: map each run requirement onto an existing one (same id and BRD file, or the same
//    wording in the same BRD file), otherwise add it under a free id.
const kbReqs = kb.requirements.requirements;
const byId = new Map(kbReqs.map((r) => [r.id, r]));
const byText = new Map(kbReqs.map((r) => [`${fileOf(r)}|${textKey(r.description)}`, r]));
let next = Math.max(0, ...kbReqs.map((r) => idNum(r.id))) + 1;
const idMap = {};
const added = [];
const refound = new Set();
for (const r of run.requirements.requirements) {
  const same = byId.get(r.id);
  const target = same && fileOf(same) === fileOf(r) ? same : byText.get(`${fileOf(r)}|${textKey(r.description)}`);
  if (target) {
    idMap[r.id] = target.id;
    refound.add(target.id);
    // Keep the id, title and wording stable; refresh what the latest reading says about it.
    target.category = r.category || target.category;
    if (r.priority && r.priority !== 'Unspecified') target.priority = r.priority;
    target.source = r.source || target.source;
    target.keywords = uniq([...(target.keywords || []), ...(r.keywords || [])]);
    target.lastSeenRun = runId;
    continue;
  }
  let id = r.id;
  if (!idNum(id) || byId.has(id)) id = `REQ-${String(next).padStart(3, '0')}`;
  next = Math.max(next, idNum(id) + 1);
  const entry = { ...r, id, firstSeenRun: runId, lastSeenRun: runId };
  kbReqs.push(entry);
  byId.set(id, entry);
  byText.set(`${fileOf(entry)}|${textKey(entry.description)}`, entry);
  idMap[r.id] = id;
  added.push(id);
}
const mapId = (id) => idMap[id] || id;
const scopeFiles = uniq([...(scope.brd || []), ...run.requirements.requirements.map(fileOf)]);
const notRefound = kbReqs.filter((r) => scopeFiles.includes(fileOf(r)) && !refound.has(r.id) && !added.includes(r.id)).map((r) => r.id);
kb.requirements.brd = uniq([...(kb.requirements.brd || []), ...(run.requirements.brd || []), ...scopeFiles]);
kb.requirements.extractedAt = run.requirements.extractedAt || now;

// 2. Evidence: merge candidates per requirement, newest first, no duplicates.
const findings = new Map((kb['system-evidence'].findings || []).map((f) => [f.reqId, f]));
for (const f of (run['system-evidence'] && run['system-evidence'].findings) || []) {
  const reqId = mapId(f.reqId);
  const old = findings.get(reqId);
  const seen = new Set();
  const candidates = [...(f.candidates || []), ...((old && old.candidates) || [])].filter((c) => {
    const k = `${c.file}|${textKey(c.snippet)}`;
    return !seen.has(k) && seen.add(k);
  });
  findings.set(reqId, { reqId, candidates });
}
kb['system-evidence'] = { ...kb['system-evidence'], ...(run['system-evidence'] || {}), findings: [...findings.values()] };

// 3. Implementation status: the run's verdict replaces the old one for the requirements it re-checked.
const describe = (id, item) => {
  const req = byId.get(id) || {};
  return { ...item, id, title: req.title || item.title, description: req.description || item.description, category: req.category || item.category, source: req.source || item.source };
};
const statuses = new Map((kb['implementation-status'].requirements || []).map((s) => [s.id, s]));
const changes = [];
const runStatuses = (run['implementation-status'] && run['implementation-status'].requirements) || [];
for (const s of runStatuses) {
  const id = mapId(s.id);
  const old = statuses.get(id);
  const history = [...((old && old.history) || (old ? [{ run: 'before-history', status: old.status }] : [])), { run: runId, status: s.status }];
  if (old && old.status !== s.status) changes.push({ id, from: old.status, to: s.status, kind: RANK[s.status] > RANK[old.status] ? 'upgrade' : 'downgrade' });
  statuses.set(id, { ...describe(id, s), lastCheckedRun: runId, history });
}
kb['implementation-status'] = { ...kb['implementation-status'], ...(run['implementation-status'] || {}), requirements: [...statuses.values()] };

// 4. Verified: drop the old entries the run re-checked, add what the run verified.
const checked = new Set([...runStatuses.map((s) => mapId(s.id)), ...(((run.verified && run.verified.requirements) || []).map((v) => mapId(v.id)))]);
const keepVerified = (kb.verified.requirements || []).filter((v) => !checked.has(v.id));
const runVerified = ((run.verified && run.verified.requirements) || []).map((v) => {
  const id = mapId(v.id);
  const req = byId.get(id) || {};
  return { ...v, id, title: req.title || v.title, description: req.description || v.description, category: req.category || v.category, priority: req.priority || v.priority, verifiedRun: runId };
});
kb.verified = { ...kb.verified, ...(run.verified || {}), requirements: [...keepVerified, ...runVerified] };

// 5. Summary per BRD in scope (from the merged knowledge base).
const perBrd = {};
for (const s of statuses.values()) {
  const f = fileOf(s) || fileOf(byId.get(s.id));
  if (!scopeFiles.includes(f)) continue;
  perBrd[f] = perBrd[f] || { IMPLEMENTED: 0, PARTIAL: 0, NOT_IMPLEMENTED: 0 };
  perBrd[f][s.status] = (perBrd[f][s.status] || 0) + 1;
}
const summary = {
  runId, mergedAt: now, scope: scopeFiles,
  runRequirements: run.requirements.requirements.length,
  added, refound: [...refound], notRefound, changes, idMap, perBrd,
  totals: { requirements: kbReqs.length, verified: kb.verified.requirements.length },
};

if (dry) { console.log(JSON.stringify(summary, null, 2)); process.exit(0); }

for (const f of FILES) fs.writeFileSync(path.join(DATA, `${f}.json`), JSON.stringify(kb[f], null, 2));
const archive = path.join(RUNS, runId);
fs.mkdirSync(archive, { recursive: true });
for (const f of fs.readdirSync(RUN)) fs.copyFileSync(path.join(RUN, f), path.join(archive, f));
fs.writeFileSync(path.join(archive, 'merge-summary.json'), JSON.stringify(summary, null, 2));
fs.rmSync(RUN, { recursive: true, force: true });
const log = readJson(LOG, { runs: [] });
log.runs.push({ runId, mergedAt: now, scope: scopeFiles, added: added.length, refound: refound.size, notRefound: notRefound.length, changes: changes.length });
fs.writeFileSync(LOG, JSON.stringify(log, null, 2));
const meta = build();

console.log(`kb-merge: run ${runId} → ${added.length} new, ${refound.size} re-found, ${notRefound.length} kept from earlier runs but not re-found this time.`);
for (const c of changes) console.log(`  ${c.kind}: ${c.id} ${c.from} → ${c.to}`);
for (const [f, c] of Object.entries(perBrd)) console.log(`  ${f}: ${c.IMPLEMENTED} implemented, ${c.PARTIAL} partial, ${c.NOT_IMPLEMENTED} not implemented`);
console.log(`knowledge base: ${meta.extractedCount} requirements, ${meta.verifiedCount} verified. Run archived in data/runs/${runId}/`);
