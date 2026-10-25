#!/usr/bin/env node
// PreToolUse guard for the brd-analyst agent: keeps new-requirement analysis independent of the
// Customizer repository. The analyst may only touch the request queue and the BRD inbox — not the
// system code (config.json → systemPath) and not the audit outputs in data/ or the system pages,
// which contain code from that repository.
//   --enforce : always enforce (used from the agent's own frontmatter hook)
//   otherwise : enforce only when the calling agent is brd-analyst (project-level hook)
const path = require('path');
const { ROOT, readJson } = require('./lib');

const raw = require('fs').readFileSync(0, 'utf8');
let input = {};
try { input = JSON.parse(raw); } catch { process.exit(0); }

const enforce = process.argv.includes('--enforce') || input.agent_type === 'brd-analyst';
// Set ANALYSIS_GUARD_TRACE=<file> to log every decision (for checking the guard is wired up).
if (process.env.ANALYSIS_GUARD_TRACE) {
  require('fs').appendFileSync(process.env.ANALYSIS_GUARD_TRACE,
    JSON.stringify({ at: new Date().toISOString(), enforce, agent_type: input.agent_type || null, tool: input.tool_name, input: input.tool_input }) + '\n');
}
if (!enforce) process.exit(0);

const a = (readJson(path.join(ROOT, 'config.json'), {}) || {}).analysis || {};
const READ_ROOTS = [a.requestsDir || 'requests', a.brdDir || 'brd-inbox'].map((d) => path.resolve(ROOT, d));
const WRITE_ROOTS = [path.resolve(ROOT, a.requestsDir || 'requests')];

const inside = (p, roots) => {
  const abs = path.resolve(ROOT, p).toLowerCase();
  return roots.some((r) => abs === r.toLowerCase() || abs.startsWith(r.toLowerCase() + path.sep));
};
const block = (why) => {
  process.stderr.write(`analysis-guard: blocked. ${why}\nThe BRD analyst works only from the submitted BRD (requests/ and ${a.brdDir || 'brd-inbox'}/). It must not inspect the Customizer repository or the audit data; implementation is validated later by the /brd-audit agents.\n`);
  process.exit(2);
};

const t = input.tool_name;
const ti = input.tool_input || {};
if (t === 'Read') {
  if (!inside(ti.file_path || '', READ_ROOTS)) block(`Read of ${ti.file_path} is outside the request folders.`);
} else if (t === 'Write' || t === 'Edit' || t === 'MultiEdit') {
  if (!inside(ti.file_path || '', WRITE_ROOTS)) block(`Writing ${ti.file_path} is outside requests/.`);
} else if (t === 'Glob' || t === 'Grep') {
  if (!ti.path) block(`${t} needs an explicit path inside requests/ or ${a.brdDir || 'brd-inbox'}/.`);
  if (!inside(ti.path, READ_ROOTS)) block(`${t} on ${ti.path} is outside the request folders.`);
  if (t === 'Glob' && /(^|[\\/])\.\.([\\/]|$)/.test(ti.pattern || '')) block('Glob patterns may not walk up with "..".');
} else if (t) {
  block(`The ${t} tool is not available to the BRD analyst.`);
}
process.exit(0);
