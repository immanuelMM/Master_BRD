#!/usr/bin/env node
// BRD analysis request portal. Serves the project's pages and accepts analysis requests.
//   npm run portal   → http://localhost:4180/analysis.html
// A request is only reported as submitted (status Pending) after the notification email was sent.
const fs = require('fs');
const path = require('path');
const http = require('http');
const L = require('./lib');

const S = L.settings();
const MAX_MESSAGE = 10000;

// ---------- static files (allow-list: never serves config, mail credentials, requests or BRD inbox) ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.css': 'text/css' };
const STATIC_OK = (rel) => /^[\w.-]+\.html$/.test(rel) || /^(data|assets)\/[\w.-]+\.js$/.test(rel) ||
  /^data\/brd-media\/[\w./-]+$/.test(rel) || /^screens\/[\w.-]+$/.test(rel);

function serveStatic(req, res, pathname) {
  const rel = decodeURIComponent(pathname).replace(/^\/+/, '') || 'analysis.html';
  const abs = path.resolve(L.ROOT, rel);
  if (!STATIC_OK(rel) || rel.includes('..') || !abs.startsWith(L.ROOT) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    return send(res, 404, 'Not found', 'text/plain');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(abs).pipe(res);
}

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('The upload is too large.'), { code: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const maskEmail = (e) => String(e).replace(/^(.)[^@]*(@.*)$/, '$1***$2');

// Public view of a request: no full email, no message body, no file paths.
const publicView = (r) => ({
  id: r.id, submittedAt: r.submittedAt, status: r.status, requester: maskEmail(r.requesterEmail),
  brd: r.brd ? { name: r.brd.originalName, source: r.brd.source } : null,
  completedAt: r.completedAt || null,
  error: r.status === L.STATUS.FAILED ? 'The analysis could not be completed. The BRD owner has been notified.'
    : r.status === L.STATUS.SUBMISSION_FAILED ? 'Not submitted: the notification email could not be sent.' : null,
});

// ---------- submission ----------
async function submit(body) {
  const email = String(body.email || '').trim();
  const message = String(body.message || '').trim();
  const link = String(body.link || '').trim();
  const file = body.file && body.file.data ? body.file : null;

  const errors = {};
  if (!L.isEmail(email)) errors.email = 'Enter a valid email address.';
  if (!message) errors.message = 'Describe the analysis you need.';
  else if (message.length > MAX_MESSAGE) errors.message = `Keep the message under ${MAX_MESSAGE} characters.`;
  if (!file && !link) errors.brd = 'Attach the BRD file or provide a link to it.';
  if (file && link) errors.brd = 'Provide either a file or a link, not both.';
  if (file && !L.BRD_EXT.includes(path.extname(String(file.name || '')).toLowerCase())) {
    errors.brd = `Unsupported file type. Use one of: ${L.BRD_EXT.join(', ')}.`;
  }
  if (link && !errors.brd) {
    try { L.checkUrl(link); } catch (e) { errors.brd = e.message; }
  }
  if (Object.keys(errors).length) return { code: 400, body: { ok: false, error: 'Please fix the highlighted fields.', fields: errors } };

  const mailIssue = L.mailProblem();
  if (mailIssue) return { code: 503, body: { ok: false, error: `The request was not sent. ${mailIssue}` } };

  // Process the BRD first: nothing is emailed or queued unless the BRD is saved.
  let brd;
  try {
    if (file) {
      const buffer = Buffer.from(String(file.data), 'base64');
      if (!buffer.length) throw new Error('The attached file is empty.');
      if (buffer.length > S.maxUploadBytes) throw new Error(`The BRD file is larger than ${S.maxUploadBytes / 1048576} MB.`);
      brd = { name: L.safeFileName(file.name), buffer, source: 'upload' };
    } else {
      const d = await L.downloadBrd(link, S.maxUploadBytes);
      brd = { name: d.name, buffer: d.buffer, source: 'link', link, downloadedFrom: d.finalUrl };
    }
  } catch (e) {
    return { code: 422, body: { ok: false, error: `The request was not sent. ${e.message}`, fields: { brd: e.message } } };
  }

  const now = new Date();
  const id = L.newId(now);
  fs.mkdirSync(S.brdDir, { recursive: true });
  const brdFile = path.join(S.brdDir, `${id}__${brd.name}`);
  fs.writeFileSync(brdFile, brd.buffer);

  const record = L.saveRequest({
    id,
    submittedAt: now.toISOString(),
    requesterEmail: email,
    message,
    brd: {
      source: brd.source,
      originalName: brd.name,
      file: path.relative(L.ROOT, brdFile).replace(/\\/g, '/'),
      bytes: brd.buffer.length,
      ...(brd.link ? { link: brd.link, downloadedFrom: brd.downloadedFrom } : {}),
    },
    status: 'Submitting',
    history: [{ status: 'Submitting', at: now.toISOString() }],
  });

  try {
    await L.sendMail(notificationEmail(record, brdFile, now));
  } catch (e) {
    record.error = `Notification email failed: ${e.message}`;
    L.setStatus(record, L.STATUS.SUBMISSION_FAILED, record.error);
    console.error(`[${id}] ${record.error}`);
    return { code: 502, body: { ok: false, error: 'Your request could not be sent because the notification email failed. Please try again later.', id } };
  }

  delete record.error;
  L.setStatus(record, L.STATUS.PENDING);
  console.log(`[${id}] Pending — ${email} — ${brd.name}`);
  return {
    code: 201,
    body: {
      ok: true, id, status: L.STATUS.PENDING,
      message: 'Your BRD analysis request has been sent successfully and is now pending analysis. You will receive the analysis results via email once the analysis is complete.',
    },
  };
}

function notificationEmail(r, brdFile, when) {
  const m = L.mailSettings();
  const stamp = when.toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'long' });
  const linkLine = r.brd.link ? `BRD link: ${r.brd.link}` : 'BRD: attached';
  const text = [
    `New BRD analysis request ${r.id}`, '',
    `Requester: ${r.requesterEmail}`,
    `Submitted: ${stamp} (${r.submittedAt})`,
    linkLine,
    `Saved as: ${r.brd.file}`, '',
    'Analysis request:', r.message, '',
    'To process it, run /brd-analyze in Claude Code from the Master-BRD folder.',
  ].join('\n');
  const html = `<div style="font:14px/1.5 Segoe UI,Arial,sans-serif;color:#1d2433">
    <h2 style="margin:0 0 12px">New BRD analysis request</h2>
    <table cellpadding="6" style="border-collapse:collapse">
      <tr><td><b>Request ID</b></td><td>${L.esc(r.id)}</td></tr>
      <tr><td><b>Requester</b></td><td><a href="mailto:${L.esc(r.requesterEmail)}">${L.esc(r.requesterEmail)}</a></td></tr>
      <tr><td><b>Submitted</b></td><td>${L.esc(stamp)}</td></tr>
      <tr><td><b>BRD</b></td><td>${r.brd.link ? `<a href="${L.esc(r.brd.link)}">${L.esc(r.brd.link)}</a> (downloaded copy attached)` : `${L.esc(r.brd.originalName)} (attached)`}</td></tr>
      <tr><td><b>Saved as</b></td><td><code>${L.esc(r.brd.file)}</code></td></tr>
    </table>
    <h3 style="margin:18px 0 6px">Analysis request</h3>
    <div style="white-space:pre-wrap;border-left:3px solid #7cc4ff;padding:6px 12px;background:#f5f8ff">${L.esc(r.message)}</div>
    <p style="color:#4a5568">To process it, run <code>/brd-analyze</code> in Claude Code from the Master-BRD folder.</p></div>`;
  return {
    to: m.notifyEmail,
    replyTo: r.requesterEmail,
    subject: `BRD analysis request ${r.id} — ${r.brd.originalName}`,
    text, html,
    attachments: [{ filename: r.brd.originalName, path: brdFile }],
  };
}

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  try {
    if (pathname === '/api/config' && req.method === 'GET') {
      return send(res, 200, { emailConfigured: !L.mailProblem(), maxUploadMB: S.maxUploadBytes / 1048576, accept: L.BRD_EXT });
    }
    if (pathname === '/api/requests' && req.method === 'GET') {
      return send(res, 200, { requests: L.listRequests().map(publicView) });
    }
    if (pathname === '/api/requests' && req.method === 'POST') {
      if (!String(req.headers['content-type'] || '').startsWith('application/json')) return send(res, 415, { ok: false, error: 'Expected JSON.' });
      let body;
      try { body = JSON.parse(await readBody(req, Math.ceil(S.maxUploadBytes * 1.4) + 1048576)); }
      catch (e) { return send(res, e.code === 413 ? 413 : 400, { ok: false, error: e.code === 413 ? `The BRD file is larger than ${S.maxUploadBytes / 1048576} MB.` : 'Invalid request body.' }); }
      const r = await submit(body || {});
      return send(res, r.code, r.body);
    }
    if (pathname === '/') { res.writeHead(302, { Location: '/analysis.html' }); return res.end(); }
    if (req.method === 'GET') return serveStatic(req, res, pathname);
    send(res, 405, { ok: false, error: 'Method not allowed' });
  } catch (e) {
    console.error(e);
    send(res, 500, { ok: false, error: 'Unexpected server error. The request was not sent.' });
  }
});

// Local only by default; set PORTAL_HOST=0.0.0.0 to let requesters on the network reach it.
const HOST = process.env.PORTAL_HOST || '127.0.0.1';
server.listen(S.port, HOST, () => {
  console.log(`BRD analysis portal: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${S.port}/analysis.html`);
  const issue = L.mailProblem();
  if (issue) console.warn(`WARNING: ${issue} Submissions will be refused until it is fixed.`);
});
