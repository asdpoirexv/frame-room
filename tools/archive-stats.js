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

// --flagged: review what tripped moderation.
//
// PixVerse's own platform docs say, of a generation's status: "if Status is 7:
// check if your prompt contains prohibited content". So `videoStatus: 7` is not
// a generic failure — it is the content-moderation verdict, and the archive has
// been recording it all along. No extra capture is needed to review this.
//
// Note it does NOT mean the file is missing: most status-7 records still have a
// fetchable file, because the render completes and the flag lands afterwards
// (NOTES 1.3, 1.14l). Flagged and unusable are different things.
//
// This prints your own prompts, on your own machine, so you can see what
// actually tripped it rather than guessing. Nothing is sent anywhere.
if (args.includes('--flagged')) {
  const flagged = records.filter((r) => r.videoStatus === 7 || r.videoStatus === 8);
  const total = records.filter((r) => r.kind === 'video').length;
  console.log(`${flagged.length} flagged of ${total} videos `
    + `(${total ? Math.round((flagged.length / total) * 100) : 0}%)\n`);

  if (!flagged.length) { console.log('Nothing flagged in this archive.'); process.exit(0); }

  // Which settings the flagged ones share. If flagging tracked a setting rather
  // than the prompt, it would show here — and if it does not, that is the
  // answer: it is the text, and no setting change avoids it.
  for (const f of ['model', 'quality', 'mode']) {
    const m = new Map();
    for (const r of flagged) m.set(r[f] ?? '?', (m.get(r[f] ?? '?') ?? 0) + 1);
    console.log(`by ${f}: ` + [...m].sort((a, b) => b[1] - a[1])
      .map(([k, c]) => `${k}=${c}`).join('  '));
  }

  // The words that recur across flagged prompts. Frequency only, no judgement:
  // it is a starting point for your own review, not a classifier.
  const freq = new Map();
  for (const r of flagged) {
    for (const w of String(r.prompt ?? '').toLowerCase().match(/[a-z']{3,}/g) ?? []) {
      freq.set(w, (freq.get(w) ?? 0) + 1);
    }
  }
  const clean = records.filter((r) => r.videoStatus === 1);
  const cleanFreq = new Map();
  for (const r of clean) {
    for (const w of String(r.prompt ?? '').toLowerCase().match(/[a-z']{3,}/g) ?? []) {
      cleanFreq.set(w, (cleanFreq.get(w) ?? 0) + 1);
    }
  }
  // Rates, not raw counts. The flagged set here is several times larger than the
  // clean one, so comparing counts directly makes ordinary words like "camera"
  // and "she" look damning purely because there is more flagged text to count.
  // The first version of this did exactly that and produced a confident, wrong
  // list. Compare per-record rates and require the word to be common enough to
  // mean anything.
  const rateF = (w) => (freq.get(w) ?? 0) / flagged.length;
  const rateC = (w) => (cleanFreq.get(w) ?? 0) / (clean.length || 1);
  const skewed = [...freq.keys()]
    .filter((w) => (freq.get(w) ?? 0) >= 20)
    .map((w) => [w, rateF(w), rateC(w)])
    // Laplace-ish floor so a word absent from a small clean set is not treated
    // as infinitely skewed.
    .map(([w, f, c]) => [w, f, c, f / (c + 1 / (clean.length || 1))])
    .filter(([, , , ratio]) => ratio > 2)
    .sort((a, b) => b[3] - a[3])
    .slice(0, 25);

  console.log(`\nWords over-represented in flagged prompts (rates per record,`);
  console.log(`${flagged.length} flagged vs ${clean.length} clean — a pointer for your`);
  console.log('own review, not a classifier):');
  for (const [w, f, c, ratio] of skewed) {
    console.log(`  ${ratio.toFixed(1).padStart(6)}x   ${f.toFixed(2)}/rec flagged vs ${c.toFixed(2)} clean   ${w}`);
  }

  console.log('\nMost recent flagged prompts:');
  for (const r of flagged.sort((a, b) => madeAtOf(b) - madeAtOf(a)).slice(0, 20)) {
    console.log(`  [${r.status}] ${String(r.prompt ?? '(none)').slice(0, 100)}`);
  }
  process.exit(0);
}

function madeAtOf(r) {
  return (r?.createdAt ? Date.parse(r.createdAt) || 0 : 0) || (r?.firstSeenAt ?? 0);
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
