#!/usr/bin/env node
// BRD analysis request queue. Used by the /brd-analyze skill; also handy by hand.
//   node tools/requests.js list [--status Pending]
//   node tools/requests.js prepare <id>            Pending → In Analysis, writes requests/<id>/brief.json (+ brd.txt)
//   node tools/requests.js complete <id>           validates analysis.json, renders the report, emails the requester → Completed
//   node tools/requests.js fail <id> "<reason>"    → Failed (never Completed), notifies the designated address
//   node tools/requests.js test-email               sends a test message to notifyEmail (checks the mail setup)
const fs = require('fs');
const path = require('path');
const L = require('../server/lib');

const SEVERITY = ['High', 'Medium', 'Low'];
const READINESS = ['Ready for development', 'Ready with clarifications', 'Not ready'];

function die(msg) {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

// ---------- list ----------
function list(args) {
  const i = args.indexOf('--status');
  const want = i >= 0 ? args.slice(i + 1).join(' ') : null;
  const rows = L.listRequests().filter((r) => !want || r.status.toLowerCase() === want.toLowerCase());
  if (!rows.length) return console.log(want ? `No ${want} requests.` : 'No requests.');
  for (const r of rows) console.log(`${r.id}  ${r.status.padEnd(17)}  ${r.requesterEmail}  ${r.brd ? r.brd.originalName : '-'}`);
}

// ---------- prepare ----------
function prepare(id) {
  const req = L.loadRequest(id);
  if (![L.STATUS.PENDING, L.STATUS.FAILED].includes(req.status)) die(`${id} is ${req.status}; only Pending or Failed requests can be analyzed.`);
  const dir = L.requestDir(id);
  const brdAbs = path.resolve(L.ROOT, req.brd.file);
  if (!fs.existsSync(brdAbs)) return fail(id, `BRD file is missing: ${req.brd.file}`);

  let text = null;
  try {
    text = L.brdToText(brdAbs);
  } catch (e) {
    return fail(id, `Could not read the BRD (${path.basename(brdAbs)}): ${e.message.split('\n')[0]}`);
  }
  if (text !== null && text.replace(/\s/g, '').length < 50) return fail(id, 'The BRD appears to be empty or unreadable (less than 50 characters of text).');
  if (text !== null) fs.writeFileSync(path.join(dir, 'brd.txt'), text);
  for (const f of ['analysis.json', 'report.md', 'report.html']) fs.rmSync(path.join(dir, f), { force: true });

  const rel = (p) => path.relative(L.ROOT, p).replace(/\\/g, '/');
  const brief = {
    requestId: id,
    submittedAt: req.submittedAt,
    requestMessage: req.message,
    brdName: req.brd.originalName,
    brdOriginal: req.brd.file,
    brdText: text !== null ? rel(path.join(dir, 'brd.txt')) : null,
    readWith: text !== null ? 'Read brdText' : 'Read brdOriginal directly (PDF; read in page ranges if over 10 pages)',
    output: rel(path.join(dir, 'analysis.json')),
  };
  fs.writeFileSync(path.join(dir, 'brief.json'), JSON.stringify(brief, null, 2));
  delete req.error;
  L.setStatus(req, L.STATUS.IN_ANALYSIS);
  console.log(JSON.stringify(brief, null, 2));
}

// ---------- analysis.json validation ----------
function validate(a, id) {
  const errs = [];
  const str = (v, k) => { if (typeof v !== 'string' || !v.trim()) errs.push(`${k} must be a non-empty string`); };
  const arr = (k, check) => {
    if (!Array.isArray(a[k])) { errs.push(`${k} must be an array (use [] when there are none)`); return; }
    a[k].forEach((x, i) => check(x || {}, `${k}[${i}]`));
  };
  const item = (sev) => (x, k) => {
    str(x.title, `${k}.title`); str(x.detail, `${k}.detail`);
    if (sev && !SEVERITY.includes(x.severity)) errs.push(`${k}.severity must be one of ${SEVERITY.join('/')}`);
  };
  if (a.requestId !== id) errs.push(`requestId must be "${id}"`);
  str(a.brdTitle, 'brdTitle'); str(a.summary, 'summary'); str(a.requestResponse, 'requestResponse'); str(a.readinessReason, 'readinessReason');
  if (!READINESS.includes(a.readiness)) errs.push(`readiness must be one of: ${READINESS.join(' | ')}`);
  arr('conflicts', item(true));
  arr('ambiguities', item(true));
  arr('missingRequirements', item(true));
  arr('clarificationQuestions', (x, k) => str(x.question, `${k}.question`));
  arr('dependencies', item(false));
  arr('risks', item(true));
  arr('recommendations', item(false));
  arr('nextSteps', (x, k) => str(x, k));
  return errs;
}

// ---------- report rendering ----------
const SEV_COLOR = { High: '#c53030', Medium: '#b7791f', Low: '#2f855a' };

function renderMarkdown(req, a) {
  const refs = (x) => (x.references && x.references.length ? ` _(BRD: ${x.references.join('; ')})_` : '');
  const sec = (title, items, fmt) => [`## ${title}`, '', ...(items.length ? items.map(fmt) : ['_None identified._']), ''];
  const sev = (x) => `- **[${x.severity}] ${x.title}** — ${x.detail}${refs(x)}`;
  return [
    `# BRD Analysis — ${a.brdTitle}`, '',
    `Request ${req.id} · submitted ${req.submittedAt} · analyzed ${a.analyzedAt || new Date().toISOString()}`, '',
    `**Readiness: ${a.readiness}** — ${a.readinessReason}`, '',
    '## Your request', '', req.message.split('\n').map((l) => `> ${l}`).join('\n'), '',
    '## Response to your request', '', a.requestResponse, '',
    '## BRD summary', '', a.summary, '',
    ...sec('Conflicts and inconsistencies', a.conflicts, sev),
    ...sec('Ambiguities', a.ambiguities, sev),
    ...sec('Missing requirements', a.missingRequirements, sev),
    ...sec('Clarification questions', a.clarificationQuestions, (q, i) => `${i + 1}. ${q.question}${q.why ? ` — _${q.why}_` : ''}${refs(q)}`),
    ...sec('Dependencies', a.dependencies, (x) => `- **${x.title}** — ${x.detail}`),
    ...sec('Risks', a.risks, (x) => `- **[${x.severity}] ${x.title}** — ${x.detail}${x.mitigation ? ` **Mitigation:** ${x.mitigation}` : ''}`),
    ...sec('Recommendations', a.recommendations, (x) => `- **${x.title}** — ${x.detail}`),
    ...sec('Suggested next steps', a.nextSteps, (s, i) => `${i + 1}. ${s}`),
    '---', '_This analysis reviews the BRD on its own. It does not check the Customizer code; implementation is validated separately after development._', '',
  ].join('\n');
}

function renderHtml(req, a) {
  const e = L.esc;
  const refs = (x) => (x.references && x.references.length ? `<div style="color:#718096;font-size:12.5px">BRD: ${e(x.references.join('; '))}</div>` : '');
  const badge = (s) => `<span style="display:inline-block;font-size:11px;font-weight:600;color:#fff;background:${SEV_COLOR[s] || '#4a5568'};border-radius:4px;padding:1px 6px;margin-right:6px">${e(s)}</span>`;
  const h2 = (t, n) => `<h2 style="font-size:17px;color:#2f5496;margin:26px 0 8px;border-bottom:1px solid #e2e8f0;padding-bottom:4px">${e(t)}${n != null ? ` <span style="color:#718096;font-weight:400">(${n})</span>` : ''}</h2>`;
  const none = '<p style="color:#718096;font-style:italic">None identified.</p>';
  const items = (list, fmt) => (list.length ? `<ul style="padding-left:20px;margin:0">${list.map((x, i) => `<li style="margin:0 0 10px">${fmt(x, i)}</li>`).join('')}</ul>` : none);
  const sev = (x) => `${badge(x.severity)}<b>${e(x.title)}</b><div>${e(x.detail)}</div>${refs(x)}`;
  const ready = { 'Ready for development': '#2f855a', 'Ready with clarifications': '#b7791f', 'Not ready': '#c53030' }[a.readiness];
  return `<!doctype html><html><head><meta charset="utf-8"><title>BRD Analysis — ${e(a.brdTitle)}</title></head>
<body style="margin:0;background:#f4f6fb"><div style="max-width:760px;margin:0 auto;background:#fff;padding:28px 32px;font:14px/1.55 'Segoe UI',Arial,sans-serif;color:#1d2433">
<h1 style="font-size:22px;color:#1f3864;margin:0 0 4px">BRD Analysis — ${e(a.brdTitle)}</h1>
<div style="color:#718096;font-size:12.5px">Request ${e(req.id)} · submitted ${e(new Date(req.submittedAt).toLocaleString('en-US'))}</div>
<div style="margin:16px 0;padding:12px 14px;border-left:4px solid ${ready};background:#f7fafc"><b style="color:${ready}">${e(a.readiness)}</b><div>${e(a.readinessReason)}</div></div>
<table cellpadding="0" cellspacing="0" style="width:100%;margin:8px 0"><tr>
${[['Conflicts', a.conflicts.length], ['Ambiguities', a.ambiguities.length], ['Missing', a.missingRequirements.length], ['Questions', a.clarificationQuestions.length], ['Risks', a.risks.length]]
  .map(([k, v]) => `<td style="text-align:center;padding:8px;border:1px solid #e2e8f0"><div style="font-size:20px;font-weight:600">${v}</div><div style="color:#718096;font-size:12px">${k}</div></td>`).join('')}
</tr></table>
${h2('Your request')}<div style="white-space:pre-wrap;border-left:3px solid #7cc4ff;padding:6px 12px;background:#f5f8ff">${e(req.message)}</div>
${h2('Response to your request')}<div style="white-space:pre-wrap">${e(a.requestResponse)}</div>
${h2('BRD summary')}<div style="white-space:pre-wrap">${e(a.summary)}</div>
${h2('Conflicts and inconsistencies', a.conflicts.length)}${items(a.conflicts, sev)}
${h2('Ambiguities', a.ambiguities.length)}${items(a.ambiguities, sev)}
${h2('Missing requirements', a.missingRequirements.length)}${items(a.missingRequirements, sev)}
${h2('Clarification questions', a.clarificationQuestions.length)}${a.clarificationQuestions.length ? `<ol style="padding-left:20px;margin:0">${a.clarificationQuestions.map((q) => `<li style="margin:0 0 10px"><b>${e(q.question)}</b>${q.why ? `<div style="color:#4a5568">${e(q.why)}</div>` : ''}${refs(q)}</li>`).join('')}</ol>` : none}
${h2('Dependencies', a.dependencies.length)}${items(a.dependencies, (x) => `<b>${e(x.title)}</b><div>${e(x.detail)}</div>`)}
${h2('Risks', a.risks.length)}${items(a.risks, (x) => `${sev(x)}${x.mitigation ? `<div><b>Mitigation:</b> ${e(x.mitigation)}</div>` : ''}`)}
${h2('Recommendations', a.recommendations.length)}${items(a.recommendations, (x) => `<b>${e(x.title)}</b><div>${e(x.detail)}</div>`)}
${h2('Suggested next steps', a.nextSteps.length)}${a.nextSteps.length ? `<ol style="padding-left:20px;margin:0">${a.nextSteps.map((s) => `<li style="margin:0 0 6px">${e(s)}</li>`).join('')}</ol>` : none}
<p style="margin-top:28px;color:#718096;font-size:12.5px;border-top:1px solid #e2e8f0;padding-top:10px">This analysis reviews the BRD on its own. It does not check the Customizer code; implementation is validated separately after development.</p>
</div></body></html>`;
}

// ---------- complete ----------
async function complete(id) {
  const req = L.loadRequest(id);
  if (![L.STATUS.IN_ANALYSIS, L.STATUS.FAILED].includes(req.status)) die(`${id} is ${req.status}; run prepare first.`);
  const dir = L.requestDir(id);
  const a = L.readJson(path.join(dir, 'analysis.json'));
  if (!a) die(`requests/${id}/analysis.json is missing or not valid JSON. Status left as ${req.status}.`);
  const errs = validate(a, id);
  if (errs.length) die(`analysis.json is incomplete — fix and re-run complete:\n- ${errs.join('\n- ')}`);

  const md = renderMarkdown(req, a);
  const html = renderHtml(req, a);
  fs.writeFileSync(path.join(dir, 'report.md'), md);
  fs.writeFileSync(path.join(dir, 'report.html'), html);

  try {
    await L.sendMail({
      to: req.requesterEmail,
      subject: `BRD analysis results — ${a.brdTitle} (${id})`,
      text: md,
      html,
      attachments: [
        { filename: `BRD-analysis-${id}.html`, path: path.join(dir, 'report.html') },
        { filename: `BRD-analysis-${id}.md`, path: path.join(dir, 'report.md') },
      ],
    });
  } catch (err) {
    req.error = `Analysis finished but the results email to the requester failed: ${err.message}. Re-run: node tools/requests.js complete ${id}`;
    L.setStatus(req, L.STATUS.FAILED, req.error);
    die(req.error);
  }
  delete req.error;
  req.completedAt = new Date().toISOString();
  req.report = { markdown: `requests/${id}/report.md`, html: `requests/${id}/report.html` };
  req.summary = {
    readiness: a.readiness, conflicts: a.conflicts.length, ambiguities: a.ambiguities.length,
    missing: a.missingRequirements.length, questions: a.clarificationQuestions.length, risks: a.risks.length,
  };
  L.setStatus(req, L.STATUS.COMPLETED);
  console.log(`${id} Completed — results emailed to ${req.requesterEmail}. Report: requests/${id}/report.html`);
}

// ---------- fail ----------
async function fail(id, reason) {
  if (!reason) die('Give a reason: fail <id> "<reason>"');
  const req = L.loadRequest(id);
  if (req.status === L.STATUS.COMPLETED) die(`${id} is already Completed.`);
  req.error = reason;
  L.setStatus(req, L.STATUS.FAILED, reason);
  console.error(`${id} Failed — ${reason}`);
  try {
    const m = L.mailSettings();
    await L.sendMail({
      to: m.notifyEmail,
      subject: `BRD analysis FAILED — ${id}`,
      text: `The analysis for request ${id} could not be completed.\n\nReason: ${reason}\nRequester: ${req.requesterEmail}\nBRD: ${req.brd.file}${req.brd.link ? `\nLink: ${req.brd.link}` : ''}\n\nThe request was NOT marked Completed. Fix the issue and run /brd-analyze ${id} again.`,
    });
  } catch (e) {
    console.error(`(could not email the failure notice: ${e.message})`);
  }
  process.exitCode = 1;
}

// ---------- test-email ----------
async function testEmail() {
  const problem = L.mailProblem();
  if (problem) die(problem);
  const m = L.mailSettings();
  await L.sendMail({
    to: m.notifyEmail,
    subject: 'BRD Analysis — test email',
    text: `This is a test from the Master-BRD portal (${m.provider}). If you can read it, email is set up.`,
    html: `<p style="font:14px/1.5 Segoe UI,Arial,sans-serif">This is a test from the Master-BRD portal (<b>${L.esc(m.provider)}</b>). If you can read it, email is set up.</p>`,
  });
  console.log(`Test email sent to ${m.notifyEmail} via ${m.provider}.`);
}

// ---------- main ----------
(async () => {
  const [cmd, id, ...rest] = process.argv.slice(2);
  try {
    if (cmd === 'list') return list(process.argv.slice(3));
    if (cmd === 'test-email') return await testEmail();
    if (!id && cmd) die(`Usage: ${cmd} <request-id>`);
    if (cmd === 'prepare') return prepare(id);
    if (cmd === 'complete') return await complete(id);
    if (cmd === 'fail') return await fail(id, rest.join(' '));
    console.log('Usage: node tools/requests.js list [--status <s>] | prepare <id> | complete <id> | fail <id> "<reason>" | test-email');
  } catch (e) {
    die(e.message);
  }
})();
