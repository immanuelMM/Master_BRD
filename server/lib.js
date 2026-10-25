// Shared helpers for the BRD analysis request workflow (portal server + tools/requests.js).
// This workflow never reads config.json → systemPath: new-requirement analysis is repo-independent.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {
    return fallback;
  }
}

function settings() {
  const cfg = readJson(path.join(ROOT, 'config.json'), {});
  const a = cfg.analysis || {};
  return {
    brdDir: path.resolve(ROOT, a.brdDir || 'brd-inbox'),
    requestsDir: path.resolve(ROOT, a.requestsDir || 'requests'),
    port: Number(process.env.PORTAL_PORT || a.port || 4180),
    maxUploadBytes: (a.maxUploadMB || 20) * 1024 * 1024,
  };
}

// ---------- Status ----------
// Submission Failed: notification email not sent, request is NOT queued.
// Pending → In Analysis → Completed, or → Failed (BRD unreadable / analysis or result email failed).
const STATUS = {
  SUBMISSION_FAILED: 'Submission Failed',
  PENDING: 'Pending',
  IN_ANALYSIS: 'In Analysis',
  COMPLETED: 'Completed',
  FAILED: 'Failed',
};

// ---------- Request store: requests/<id>/request.json ----------
const ID_RE = /^BRQ-\d{8}-\d{6}-[a-f0-9]{4}$/;

function newId(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const d = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`;
  const t = `${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `BRQ-${d}-${t}-${crypto.randomBytes(2).toString('hex')}`;
}

function requestDir(id) {
  if (!ID_RE.test(id)) throw new Error(`Invalid request id: ${id}`);
  return path.join(settings().requestsDir, id);
}

function loadRequest(id) {
  const r = readJson(path.join(requestDir(id), 'request.json'));
  if (!r) throw new Error(`Request ${id} not found`);
  return r;
}

function saveRequest(req) {
  const dir = requestDir(req.id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'request.json');
  fs.writeFileSync(file + '.tmp', JSON.stringify(req, null, 2));
  fs.renameSync(file + '.tmp', file);
  return req;
}

function setStatus(req, status, note) {
  req.status = status;
  req.history = req.history || [];
  req.history.push({ status, at: new Date().toISOString(), ...(note ? { note } : {}) });
  return saveRequest(req);
}

function listRequests() {
  const dir = settings().requestsDir;
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((d) => ID_RE.test(d))
    .map((d) => readJson(path.join(dir, d, 'request.json')))
    .filter(Boolean)
    .sort((a, b) => String(b.submittedAt).localeCompare(String(a.submittedAt)));
}

// ---------- Validation ----------
const EMAIL_RE = /^[^\s@<>(),;:"[\]\\]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,}$/;
const isEmail = (s) => typeof s === 'string' && s.length <= 254 && EMAIL_RE.test(s.trim());

const BRD_EXT = ['.docx', '.pdf', '.md', '.txt', '.html', '.htm'];

function safeFileName(name) {
  const base = path.basename(String(name || 'brd')).replace(/[^\w.\- ()]+/g, '_').replace(/^\.+/, '').slice(0, 120);
  return base || 'brd';
}

// ---------- BRD links ----------
// Only public http(s) hosts; blocks obvious local/private targets so the portal can't be used to probe the LAN.
function checkUrl(raw) {
  let u;
  try { u = new URL(String(raw).trim()); } catch { throw new Error('The BRD link is not a valid URL.'); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('The BRD link must start with http:// or https://.');
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') ||
      /^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
      h === '::1' || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe80:/.test(h)) {
    throw new Error('The BRD link must point to a public host.');
  }
  return u;
}

// Share links for Google Docs/Drive point at a viewer page; rewrite them to the file itself.
function directDownloadUrl(u) {
  let m;
  if (u.hostname === 'docs.google.com' && (m = u.pathname.match(/^\/document\/d\/([\w-]+)/))) {
    return `https://docs.google.com/document/d/${m[1]}/export?format=docx`;
  }
  if (u.hostname === 'drive.google.com' && (m = u.pathname.match(/^\/file\/d\/([\w-]+)/))) {
    return `https://drive.google.com/uc?export=download&id=${m[1]}`;
  }
  if (/(^|\.)dropbox\.com$/.test(u.hostname)) {
    u.searchParams.set('dl', '1');
  }
  return u.toString();
}

const TYPE_EXT = {
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/pdf': '.pdf',
  'text/markdown': '.md',
  'text/plain': '.txt',
  'text/html': '.html',
};

// Downloads the BRD behind a link. Throws a requester-friendly error if it can't be accessed.
async function downloadBrd(link, maxBytes) {
  const u = checkUrl(link);
  const url = directDownloadUrl(u);
  let res;
  try {
    res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(30000) });
  } catch (e) {
    throw new Error(`The BRD link could not be reached (${e.cause?.code || e.name}).`);
  }
  if (!res.ok) throw new Error(`The BRD link could not be accessed (HTTP ${res.status}). Make sure it is shared so anyone with the link can view it.`);
  const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const len = Number(res.headers.get('content-length') || 0);
  if (len > maxBytes) throw new Error(`The linked BRD is larger than ${Math.round(maxBytes / 1048576)} MB.`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error('The BRD link returned an empty file.');
  if (buf.length > maxBytes) throw new Error(`The linked BRD is larger than ${Math.round(maxBytes / 1048576)} MB.`);

  const disp = res.headers.get('content-disposition') || '';
  const dm = disp.match(/filename\*=UTF-8''([^;]+)|filename="?([^";]+)"?/i);
  let name = dm ? decodeURIComponent(dm[1] || dm[2]) : decodeURIComponent(path.basename(new URL(res.url).pathname)) || 'brd';
  let ext = path.extname(name).toLowerCase();
  if (!BRD_EXT.includes(ext)) {
    ext = TYPE_EXT[type] || (buf.subarray(0, 4).toString('latin1') === '%PDF' ? '.pdf' : buf[0] === 0x50 && buf[1] === 0x4b ? '.docx' : '');
    if (!ext) throw new Error(`The BRD link returned an unsupported file type (${type || 'unknown'}). Supported: ${BRD_EXT.join(', ')}.`);
    name = (path.basename(name, path.extname(name)) || 'brd') + ext;
  }
  return { name: safeFileName(name), buffer: buf, finalUrl: res.url };
}

// ---------- BRD → text for the analyst (pdf is read natively by the agent) ----------
function brdToText(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.docx') {
    return execFileSync('python', [path.join(ROOT, 'tools', 'docx2txt.py'), file], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  }
  if (ext === '.html' || ext === '.htm') {
    return fs.readFileSync(file, 'utf8')
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
      .replace(/<\/(p|div|h\d|li|tr|br)>|<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/\n{3,}/g, '\n\n');
  }
  if (ext === '.md' || ext === '.txt') return fs.readFileSync(file, 'utf8');
  return null;
}

// ---------- Mail ----------
// Credentials live in mail.config.json (never served by the portal) or env vars.
// provider "emailjs" (default when an emailjs block is present) sends through the EmailJS REST API;
// provider "smtp" sends through nodemailer.
function mailSettings() {
  const f = readJson(path.join(ROOT, 'mail.config.json'), {}) || {};
  const env = process.env;
  const smtp = { ...(f.smtp || {}) };
  if (env.SMTP_HOST) smtp.host = env.SMTP_HOST;
  if (env.SMTP_PORT) smtp.port = Number(env.SMTP_PORT);
  if (env.SMTP_SECURE) smtp.secure = env.SMTP_SECURE === 'true';
  if (env.SMTP_USER || env.SMTP_PASS) smtp.auth = { user: env.SMTP_USER, pass: env.SMTP_PASS };
  const ej = f.emailjs || {};
  const emailjs = {
    serviceId: env.EMAILJS_SERVICE_ID || ej.serviceId,
    templateId: env.EMAILJS_TEMPLATE_ID || ej.templateId,
    publicKey: env.EMAILJS_PUBLIC_KEY || ej.publicKey,
    privateKey: env.EMAILJS_PRIVATE_KEY || ej.privateKey,
    fromName: env.EMAILJS_FROM_NAME || ej.fromName || 'BRD Analysis',
    // Free plan: no attachments and 50 KB per request. Paid plans: raise these.
    attachments: env.EMAILJS_ATTACHMENTS ? env.EMAILJS_ATTACHMENTS === 'true' : ej.attachments === true,
    maxAttachmentKB: Number(env.EMAILJS_MAX_ATTACHMENT_KB || ej.maxAttachmentKB || 500),
    maxRequestKB: Number(env.EMAILJS_MAX_REQUEST_KB || ej.maxRequestKB || 50),
  };
  const provider = env.MAIL_PROVIDER || f.provider || (f.emailjs || env.EMAILJS_SERVICE_ID ? 'emailjs' : 'smtp');
  return { provider, notifyEmail: env.BRD_NOTIFY_EMAIL || f.notifyEmail, from: env.SMTP_FROM || f.from, smtp, emailjs };
}

function mailProblem() {
  const m = mailSettings();
  if (!isEmail(m.notifyEmail || '')) return 'Email is not configured (notifyEmail is missing or invalid in mail.config.json).';
  if (m.provider === 'emailjs') {
    const missing = ['serviceId', 'templateId', 'publicKey'].filter((k) => !m.emailjs[k]);
    if (missing.length) return `Email is not configured (EmailJS ${missing.join(', ')} missing in mail.config.json).`;
    return null;
  }
  if (!m.smtp.host) return 'Email is not configured (no SMTP host). Copy mail.config.example.json to mail.config.json and fill it in.';
  if (!m.from) return 'Email is not configured (from is missing in mail.config.json).';
  return null;
}

const MIME_BY_EXT = { '.pdf': 'application/pdf', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword', '.md': 'text/markdown', '.txt': 'text/plain', '.html': 'text/html' };

// EmailJS template variables (set these in the template; see README):
//   To Email {{to_email}} · Reply To {{reply_to}} · From Name {{from_name}} · Subject {{subject}} · Content {{{html}}}
//   Optional variable attachment: parameter "attachment", filename {{attachment_name}}.
async function sendWithEmailJs(m, message) {
  const ej = m.emailjs;
  const params = {
    to_email: message.to, reply_to: message.replyTo || m.notifyEmail, from_name: ej.fromName,
    subject: message.subject, html: message.html || `<pre style="white-space:pre-wrap;font:14px/1.5 Segoe UI,Arial,sans-serif">${esc(message.text || '')}</pre>`,
    text: message.text || '',
  };
  const notes = [];
  const att = (message.attachments || [])[0];
  if (att && ej.attachments) {
    const size = fs.statSync(att.path).size;
    if (size <= ej.maxAttachmentKB * 1024) {
      const mime = MIME_BY_EXT[path.extname(att.path).toLowerCase()] || 'application/octet-stream';
      params.attachment = `data:${mime};base64,${fs.readFileSync(att.path).toString('base64')}`;
      params.attachment_name = att.filename;
    } else notes.push(`${att.filename} (${Math.ceil(size / 1024)} KB) is over the ${ej.maxAttachmentKB} KB attachment limit and was not attached.`);
  } else if (att) notes.push(`Attachment not included (EmailJS attachments are off): ${message.attachments.map((a) => a.filename).join(', ')}.`);
  if (notes.length) params.html += `<p style="color:#4a5568;font-size:12px">${notes.map(esc).join('<br>')}</p>`;

  const body = (p) => JSON.stringify({ service_id: ej.serviceId, template_id: ej.templateId, user_id: ej.publicKey, accessToken: ej.privateKey, template_params: p });
  let payload = body(params);
  const limit = ej.maxRequestKB * 1024;
  // Too big for the plan: drop the HTML body and fall back to the plain-text version.
  if (Buffer.byteLength(payload) > limit && message.text) {
    params.html = `<pre style="white-space:pre-wrap;font:14px/1.5 Segoe UI,Arial,sans-serif">${esc(message.text)}</pre>`;
    delete params.text;
    payload = body(params);
  }
  if (Buffer.byteLength(payload) > limit) {
    throw new Error(`Email is ${Math.ceil(Buffer.byteLength(payload) / 1024)} KB, over the EmailJS request limit of ${ej.maxRequestKB} KB (raise maxRequestKB if your plan allows more).`);
  }
  const res = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload, signal: AbortSignal.timeout(30000),
  });
  const reply = await res.text();
  if (!res.ok) throw new Error(`EmailJS ${res.status}: ${reply}`);
  return { provider: 'emailjs', response: reply };
}

let transporter = null;
async function sendMail(message) {
  const problem = mailProblem();
  if (problem) throw new Error(problem);
  const m = mailSettings();
  if (m.provider === 'emailjs') return sendWithEmailJs(m, message);
  if (!transporter) {
    const nodemailer = require('nodemailer');
    transporter = nodemailer.createTransport({ ...m.smtp, connectionTimeout: 20000, greetingTimeout: 20000, socketTimeout: 60000 });
  }
  const info = await transporter.sendMail({ from: m.from, ...message });
  if (info.rejected && info.rejected.length) throw new Error(`Mail server rejected: ${info.rejected.join(', ')}`);
  return info;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

module.exports = {
  ROOT, STATUS, readJson, settings, newId, requestDir, loadRequest, saveRequest, setStatus, listRequests,
  isEmail, BRD_EXT, safeFileName, checkUrl, downloadBrd, brdToText, mailSettings, mailProblem, sendMail, esc,
};
