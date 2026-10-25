#!/usr/bin/env node
// Builds data/graph-data.js (loaded by brain.html) from the verified requirements.
// Only verified.json feeds the graph; requirements.json contributes just the total count.
const fs = require('fs');
const path = require('path');
const { DATA, readJson, loadConfig } = require('./lib');

function build() {
  const cfg = loadConfig();
  const extracted = readJson(path.join(DATA, 'requirements.json'), { requirements: [] });
  const verified = readJson(path.join(DATA, 'verified.json'), { requirements: [] });
  const reqs = (verified.requirements || []).filter((r) => r && r.verdict === 'VERIFIED');
  // Where each requirement came from in the BRD (file, section, quote) so brd.html can highlight it.
  // Joined by id AND title, so a renumbered extraction never attaches the wrong BRD passage.
  const sourceById = Object.fromEntries((extracted.requirements || []).map((r) => [`${r.id}|${r.title}`, r.source || null]));

  const categories = new Map();
  const files = new Map();
  for (const r of reqs) {
    const cat = r.category || 'Uncategorized';
    categories.set(cat, (categories.get(cat) || 0) + 1);
    for (const ev of r.evidence || []) {
      if (!files.has(ev.file)) files.set(ev.file, new Set());
      files.get(ev.file).add(r.id);
    }
  }

  const data = {
    meta: {
      systemName: cfg.systemName || path.basename(cfg.systemPathAbs),
      systemPath: cfg.systemPath || '',
      systemBranch: cfg.systemBranch || null,
      brd: extracted.brd || [],
      generatedAt: new Date().toISOString(),
      verifiedAt: verified.verifiedAt || null,
      extractedCount: (extracted.requirements || []).length,
      verifiedCount: reqs.length,
      // Requirements extracted per BRD file (totals only).
      brdTotals: (extracted.requirements || []).reduce((acc, r) => {
        const f = r.source && r.source.file;
        if (f) acc[f] = (acc[f] || 0) + 1;
        return acc;
      }, {}),
    },
    categories: [...categories].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    requirements: reqs.map((r) => ({
      id: r.id, title: r.title, description: r.description, category: r.category || 'Uncategorized',
      priority: r.priority || 'Unspecified', confidence: r.confidence ?? null, reasoning: r.reasoning || '',
      evidence: r.evidence || [],
      source: r.source || sourceById[`${r.id}|${r.title}`] || null,
    })),
    files: [...files].map(([p, ids]) => ({ path: p, reqs: [...ids] })),
    // Totals only (no requirement details) so pages can show "verified of required" per area.
    extractedByCategory: (extracted.requirements || []).reduce((acc, r) => {
      const cat = r.category || 'Uncategorized';
      acc[cat] = (acc[cat] || 0) + 1;
      return acc;
    }, {}),
  };

  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(path.join(DATA, 'graph-data.json'), JSON.stringify(data, null, 2));
  fs.writeFileSync(path.join(DATA, 'graph-data.js'), `window.BRAIN_DATA = ${JSON.stringify(data)};\n`);

  // Builder capability audit (code-derived requirements), already filtered by the truth gate.
  const builder = readJson(path.join(DATA, 'builder-verified.json'), { requirements: [] });
  const caps = (builder.requirements || []).filter((r) => r && r.verdict === 'VERIFIED');
  fs.writeFileSync(path.join(DATA, 'builder-data.js'),
    `window.BUILDER_DATA = ${JSON.stringify({ verifiedAt: builder.verifiedAt || null, requirements: caps })};\n`);
  return data.meta;
}

module.exports = { build };

if (require.main === module) {
  const m = build();
  console.log(`graph built: ${m.verifiedCount} verified of ${m.extractedCount} extracted → data/graph-data.js`);
}
