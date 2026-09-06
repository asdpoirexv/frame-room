#!/usr/bin/env node
/**
 * archive-stats — interrogate the archive as a corpus, not a list of files.
 *
 *   node tools/archive-stats.js <archive-export.json>
 *   node tools/archive-stats.js <archive-export.json> --cross model,quality
 *
 * WHY THIS EXISTS
 * ---------------
 * The archive is the largest body of real API evidence in the project — several
 * thousand records where every field came back from the server. It was built to
 * find files. It also happens to answer questions that were being deferred to
 * "capture more traffic", and it answers some of them better, because a capture
 * gives you one sample of a field and the archive gives you four thousand.
 *
 * The distinction that makes it evidence: a record's `model`, `videoStatus` and
 * `quality` are what the SERVER echoed back, not what we sent. An id present
 * here is an id the API accepts.
 *
 * WHAT IT WON'T TELL YOU
 * ----------------------
 * Absence is not disproof. The archive records what was generated, never what
 * was offered — a model nobody used looks identical to a model that doesn't
 * exist. For anything shaped like "what are the options", the archive can only
 * establish a floor; the site's dropdown, via `tools/har-ingest.js`, is what
 * establishes the ceiling.
 *
 * THE TRUTH TABLE
 * ---------------
 * The last section is the one worth keeping an eye on. It cross-tabs the
 * server's `videoStatus` against `status`, which is our own CDN probe verdict —
 * a claim against the truth. It exists because two separate builds tried to
 * shortcut readiness with `videoStatus` and both were wrong (NOTES 1.3). If a
 * future build is tempted a third time, run this first: status 7 is right about
 * 77% of the time, which is exactly the hit rate that survives casual testing
 * and then hides a few hundred working videos.
 */

const fs = require('fs');

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('-'));
const crossIdx = args.indexOf('--cross');
const customCross = crossIdx >= 0 ? (args[crossIdx + 1] || '').split(',') : null;

if (!file) {
  console.error('usage: node tools/archive-stats.js <archive-export.json> [--cross fieldA,fieldB]');
  console.error('');
  console.error('  Export the archive from Browse (… menu → export archive) first.');
  console.error('  Fields may be top-level (model, quality, mode, kind, status,');
  console.error('  videoStatus, duration) or from the rerun payload, prefixed:');
  console.error('  rerun.panelMode, rerun.multiShot, rerun.audio, rerun.aspectRatio.');
  process.exit(1);
}

let records;
try {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  records = Object.values(parsed.records ?? {});
} catch (e) {
  console.error(`cannot read ${file}: ${e.message}`);
  process.exit(1);
}

if (!records.length) {
  console.error('no records in that export');
  process.exit(1);
}

// `rerun.multiShot` reads through to the nested payload; anything else is
// top-level. Missing is distinct from empty, and both are distinct from a real
// value — an unknown account must stay unknown (NOTES 1.9), and the same
// discipline applies to every other field.
const get = (rec, field) => (field.startsWith('rerun.')
  ? rec.rerun?.[field.slice(6)]
  : rec[field]);

function tally(field, filter = () => true) {
  const m = new Map();
  let missing = 0;
  for (const rec of records) {
    if (!filter(rec)) continue;
    const v = get(rec, field);
    if (v === undefined) { missing++; continue; }
    const k = JSON.stringify(v);
    m.set(k, (m.get(k) || 0) + 1);
  }
  return { counts: [...m].sort((a, b) => b[1] - a[1]), missing };
}

function printTally(title, field, filter) {
  const { counts, missing } = tally(field, filter);
  if (!counts.length && !missing) return;
  console.log(`--- ${title} ---`);
  for (const [k, c] of counts) console.log(String(c).padStart(6), k);
  if (missing) console.log(String(missing).padStart(6), '(field absent)');
  console.log();
}

function printCross(a, b, filter = () => true) {
  const m = new Map();
  for (const rec of records) {
    if (!filter(rec)) continue;
    const x = get(rec, a);
    const y = get(rec, b);
    if (x === undefined || y === undefined || x === '' || y === '') continue;
    const k = `${JSON.stringify(x)} | ${JSON.stringify(y)}`;
    m.set(k, (m.get(k) || 0) + 1);
  }
  if (!m.size) { console.log(`--- ${a} x ${b}: no rows ---\n`); return; }
  console.log(`--- ${a} x ${b} ---`);
  for (const [k, c] of [...m].sort((x, y) => y[1] - x[1])) console.log(String(c).padStart(6), k);
  console.log();
}

console.log(`${records.length} records from ${file}\n`);

if (customCross) {
  const [a, b] = customCross;
  if (!a || !b) { console.error('--cross needs two comma-separated fields'); process.exit(1); }
  printCross(a, b);
  process.exit(0);
}

printTally('model', 'model');
printTally('kind', 'kind');
printTally('mode', 'mode');
printTally('quality', 'quality');
printTally('status (our CDN probe verdict)', 'status');
printTally('rerun.panelMode', 'rerun.panelMode');
printTally('rerun.multiShot', 'rerun.multiShot');

// Which models are real options for which panel — the check on MODELS in
// sidepanel.js. Splits cleanly in every archive seen so far.
printCross('model', 'rerun.panelMode');
printCross('model', 'quality');

// NOTES 1.13: multi_shot is confined to image_text and is rare even there.
printCross('mode', 'rerun.multiShot');

// The one that matters. NOTES 1.3.
console.log('--- videoStatus vs. the CDN probe (videos only) ---');
console.log('The server\'s claim against the truth. A status that mixes ok and gone');
console.log('cannot be used to decide readiness, however convenient it looks.\n');
const videos = records.filter((r) => r.kind === 'video');
const byStatus = new Map();
for (const v of videos) {
  const k = String(v.videoStatus);
  if (!byStatus.has(k)) byStatus.set(k, { ok: 0, gone: 0, pending: 0, other: 0 });
  const row = byStatus.get(k);
  if (row[v.status] !== undefined) row[v.status]++; else row.other++;
}
console.log('  videoStatus        ok      gone   pending');
for (const [k, row] of [...byStatus].sort((a, b) => (b[1].ok + b[1].gone) - (a[1].ok + a[1].gone))) {
  const total = row.ok + row.gone;
  const verdict = total === 0 ? ''
    : row.ok && row.gone ? `  <- MIXED, ${Math.round((row.ok / total) * 100)}% ok. Useless as a signal.`
    : row.gone ? '  <- always gone, in this sample'
    : '  <- always ok, in this sample';
  console.log(
    `  ${k.padEnd(12)}${String(row.ok).padStart(6)}${String(row.gone).padStart(10)}${String(row.pending).padStart(10)}${verdict}`,
  );
}
console.log(`\n  ${videos.length} videos.`);
console.log('  "always ok in this sample" is not a licence to trust it — status 8');
console.log('  appeared only after 1810 videos had been collected, so an allow-list');
console.log('  built on any of this would have been wrong again. Probe.');
