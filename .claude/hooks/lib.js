// Shared helpers for the BRD audit hooks.
const fs = require('fs');
const path = require('path');

const ROOT = process.env.CLAUDE_PROJECT_DIR || path.resolve(__dirname, '..', '..');
const DATA = path.join(ROOT, 'data');

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {
    return fallback;
  }
}

function loadConfig() {
  const cfg = readJson(path.join(ROOT, 'config.json'), {});
  const systemPath = path.resolve(ROOT, cfg.systemPath || '.');
  return { ...cfg, systemPathAbs: systemPath };
}

// Whitespace-insensitive form used for snippet matching.
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

module.exports = { ROOT, DATA, readJson, loadConfig, norm };
