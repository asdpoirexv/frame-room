#!/usr/bin/env node
/**
 * seedcheck — did a repeated generation produce a new asset, or the old one?
 *
 *   node tools/seedcheck.js <archive-export.json>
 *
 * Re-running an identical request and getting an identical result has two
 * explanations that look the same from outside:
 *
 *   deterministic — the model regenerated and produced the same pixels. A NEW
 *                   asset id and URL, so the archive holds two records.
 *   deduplicated  — the server returned the existing asset without generating.
 *                   Same id and URL, so the archive holds one record.
 *
 * Groups records by (prompt, seed, model, quality, duration). Any group with
 * more than one distinct URL is a repeat that produced a new asset — which only
 * happens if the pipeline actually ran again.
 */
const fs = require('fs');
const file = process.argv[2];
if (!file) { console.error('usage: node seedcheck.js <archive-export.json>'); process.exit(1); }

const records = JSON.parse(fs.readFileSync(file, 'utf8')).records ?? {};
const groups = new Map();

for (const [url, r] of Object.entries(records)) {
  if (r.seed == null || !r.prompt) continue; // needs both to be a real repeat
  const key = [r.prompt, r.seed, r.model ?? '', r.quality ?? '', r.duration ?? ''].join('|');
  if (!groups.has(key)) groups.set(key, new Set());
  groups.get(key).add(url);
}

const repeats = [...groups.entries()].filter(([, urls]) => urls.size > 1);
console.log(`records with prompt+seed : ${[...groups.values()].reduce((n, s) => n + s.size, 0)}`);
console.log(`distinct configurations  : ${groups.size}`);
console.log(`run more than once       : ${repeats.length}`);

if (!repeats.length) {
  console.log('\nNo configuration produced two distinct assets. Either you never');
  console.log('repeated one exactly, or the server returns the existing asset');
  console.log('instead of regenerating.');
} else {
  console.log('\nThese ran again and produced a NEW asset each time — so the');
  console.log('pipeline really re-runs rather than deduplicating:\n');
  for (const [key, urls] of repeats.slice(0, 5)) {
    const [prompt, seed] = key.split('|');
    console.log(`  seed ${seed}  "${prompt.slice(0, 40)}"  ->  ${urls.size} assets`);
  }
  if (repeats.length > 5) console.log(`  …and ${repeats.length - 5} more`);
}
