#!/usr/bin/env node
// PostToolUse hook (Write|Edit|MultiEdit).
// When data/verified.json is written, re-checks every evidence snippet against the
// real system files and drops anything that cannot be proven. Only true data survives.
// Then rebuilds the brain graph data. Run manually with: node .claude/hooks/truth-gate.js --all
const fs = require('fs');
const path = require('path');
const { DATA, readJson, loadConfig, norm } = require('./lib');
const { build } = require('./build-graph');

// Every file listed here is gated: only requirements whose snippets exist in the system survive.
// verified.part-N.json are written by parallel verifiers before being merged into verified.json.
const GATED_RE = /^(builder-)?verified(\.part-\d+)?\.json$/;
const gatedFiles = () => (fs.existsSync(DATA) ? fs.readdirSync(DATA).filter((f) => GATED_RE.test(f)) : []);
// Implementation status (IMPLEMENTED / PARTIAL / NOT_IMPLEMENTED) for every requirement: snippets are
// checked the same way, but items are downgraded rather than removed.
const STATUS_RE = /^implementation-status(\.part-\d+)?\.json$/;
const statusFiles = () => (fs.existsSync(DATA) ? fs.readdirSync(DATA).filter((f) => STATUS_RE.test(f)) : []);
const MIN_CONFIDENCE = 0.7;

function readStdin() {
  if (process.argv.includes('--all') || process.stdin.isTTY) return Promise.resolve('');
  return new Promise((resolve) => {
    let buf = '';
    process.stdin.on('data', (d) => (buf += d)).on('end', () => resolve(buf));
  });
}

// Returns the 1-based line where the snippet starts, or 0 if it is not in the file.
function findSnippet(content, snippet) {
  const target = norm(snippet);
  if (target.length < 10) return 0;
  const lines = content.split(/\r?\n/);
  const firstLine = norm(snippet.split(/\r?\n/).find((l) => l.trim()) || '');
  for (let i = 0; i < lines.length; i++) {
    if (!norm(lines[i]).includes(firstLine)) continue;
    const window = norm(lines.slice(i, i + snippet.split(/\r?\n/).length + 2).join('\n'));
    if (window.includes(target)) return i + 1;
  }
  return 0;
}

function gate(VERIFIED) {
  const cfg = loadConfig();
  const doc = readJson(VERIFIED);
  if (!doc || !Array.isArray(doc.requirements)) {
    return { dropped: ['verified.json is not valid JSON with a "requirements" array'], kept: 0 };
  }
  const dropped = [];
  const kept = [];
  const cache = new Map();

  for (const req of doc.requirements) {
    const tag = req && req.id ? req.id : '(no id)';
    if (!req || req.verdict !== 'VERIFIED') { dropped.push(`${tag}: verdict is not VERIFIED`); continue; }
    if (typeof req.confidence === 'number' && req.confidence < MIN_CONFIDENCE) {
      dropped.push(`${tag}: confidence ${req.confidence} < ${MIN_CONFIDENCE}`); continue;
    }
    const proven = [];
    for (const ev of req.evidence || []) {
      const abs = path.resolve(cfg.systemPathAbs, ev.file || '');
      const rel = path.relative(cfg.systemPathAbs, abs);
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) { dropped.push(`${tag}: ${ev.file} is outside systemPath`); continue; }
      if (!cache.has(abs)) cache.set(abs, fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null);
      const content = cache.get(abs);
      if (content == null) { dropped.push(`${tag}: file not found ${ev.file}`); continue; }
      const line = findSnippet(content, ev.snippet);
      if (!line) { dropped.push(`${tag}: snippet not found in ${ev.file}: "${String(ev.snippet).slice(0, 60)}"`); continue; }
      proven.push({ ...ev, file: ev.file.replace(/\\/g, '/'), line });
    }
    if (!proven.length) { dropped.push(`${tag}: no provable evidence — removed`); continue; }
    kept.push({ ...req, evidence: proven });
  }

  // Rewrite with only the proven entries (fs writes do not re-trigger hooks).
  const changed = JSON.stringify(kept) !== JSON.stringify(doc.requirements);
  if (changed) fs.writeFileSync(VERIFIED, JSON.stringify({ ...doc, requirements: kept }, null, 2));
  return { dropped, kept: kept.length };
}

function gateStatus(FILE) {
  const cfg = loadConfig();
  const doc = readJson(FILE);
  if (!doc || !Array.isArray(doc.requirements)) return { dropped: ['not valid JSON with a "requirements" array'], kept: 0 };
  const dropped = [];
  const cache = new Map();
  const out = doc.requirements.map((req) => {
    const tag = req && req.id ? req.id : '(no id)';
    const proven = [];
    for (const ev of req.evidence || []) {
      const abs = path.resolve(cfg.systemPathAbs, ev.file || '');
      const rel = path.relative(cfg.systemPathAbs, abs);
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) { dropped.push(`${tag}: ${ev.file} is outside systemPath`); continue; }
      if (!cache.has(abs)) cache.set(abs, fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null);
      const content = cache.get(abs);
      const line = content == null ? 0 : findSnippet(content, ev.snippet);
      if (!line) { dropped.push(`${tag}: snippet not proven in ${ev.file}: "${String(ev.snippet).slice(0, 60)}"`); continue; }
      proven.push({ ...ev, file: ev.file.replace(/\\/g, '/'), line });
    }
    let status = ['IMPLEMENTED', 'PARTIAL', 'NOT_IMPLEMENTED'].includes(req.status) ? req.status : 'NOT_IMPLEMENTED';
    const gaps = [...(req.gaps || [])];
    if (status !== 'NOT_IMPLEMENTED' && !proven.length) {
      dropped.push(`${tag}: ${status} without provable evidence — downgraded to NOT_IMPLEMENTED`);
      gaps.push('No code evidence could be proven against the repository.');
      status = 'NOT_IMPLEMENTED';
    }
    return { ...req, status, gaps, evidence: proven };
  });
  if (JSON.stringify(out) !== JSON.stringify(doc.requirements)) fs.writeFileSync(FILE, JSON.stringify({ ...doc, requirements: out }, null, 2));
  return { dropped, kept: out.length };
}

(async () => {
  const raw = await readStdin();
  let file = '';
  try { file = (JSON.parse(raw).tool_input || {}).file_path || ''; } catch {}
  const all = !raw;
  const target = path.basename(file);

  if (!all && !GATED_RE.test(target) && !STATUS_RE.test(target) && !/^(requirements|system-evidence)\.json$/.test(target)) process.exit(0);
  if (!all && path.basename(path.dirname(path.resolve(file))) !== 'data') process.exit(0);

  let result = null;
  for (const name of gatedFiles()) {
    const file = path.join(DATA, name);
    if (!(all || target === name) || !fs.existsSync(file)) continue;
    const r = gate(file);
    r.dropped = r.dropped.map((d) => `${name}: ${d}`);
    result = result ? { kept: result.kept + r.kept, dropped: result.dropped.concat(r.dropped) } : r;
  }
  for (const name of statusFiles()) {
    const file = path.join(DATA, name);
    if (!(all || target === name)) continue;
    const r = gateStatus(file);
    if (r.dropped.length) result = { kept: (result ? result.kept : 0) + r.kept, dropped: (result ? result.dropped : []).concat(r.dropped.map((d) => `${name}: ${d}`)) };
  }
  const stats = build();

  if (result && result.dropped.length) {
    // Exit 2 → stderr is fed back to Claude so the verifier can fix bad snippets.
    process.stderr.write(
      `truth-gate: kept ${result.kept}, dropped ${result.dropped.length} unproven item(s):\n- ` +
        result.dropped.join('\n- ') +
        '\nOnly entries whose snippets exist verbatim in the system were kept. Re-read the files and rewrite if a real requirement was dropped.\n'
    );
    process.exit(2);
  }
  if (all) console.log(`truth-gate: kept ${result ? result.kept : 0}; graph has ${stats.verifiedCount} verified requirement(s).`);
  process.exit(0);
})();
