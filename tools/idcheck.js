/**
 * idcheck — are the long numbers in unresolvable filenames actually asset ids?
 *
 *   node tools/idcheck.js <folder> <archive-export.json>
 *
 * Some downloads arrive named after the prompt rather than the storage path:
 *
 *   (masterpie-11_46_19.mp4
 *   (topshot,z-1077174374628874-04_49_01.mp4
 *
 * There is no UUID in those, so no CDN path can be derived from the name alone
 * and scan-local skips them. The long number might be the asset id, though — and
 * if the archive already holds a record with that id, the file can be matched to
 * a URL that way instead.
 *
 * This only answers the question. It changes nothing.
 */
const fs = require('fs');
const path = require('path');
const [folder, archivePath] = process.argv.slice(2);
if (!folder || !archivePath) {
  console.error('usage: node idcheck.js <folder> <archive.json>');
  process.exit(1);
}
const rec = JSON.parse(fs.readFileSync(archivePath, 'utf8')).records ?? {};
const ids = new Set(Object.values(rec).map((r) => String(r.id)).filter((v) => v && v !== 'null'));

const files = fs.readdirSync(folder, { withFileTypes: true })
  .filter((e) => e.isFile()).map((e) => e.name);

let withNumber = 0, matched = 0;
const samples = [];
for (const name of files) {
  if (/[0-9a-f]{8}-[0-9a-f]{4}-/i.test(name)) continue;      // already resolvable
  const m = name.match(/(\d{12,20})/);                        // a long id, if any
  if (!m) continue;
  withNumber++;
  if (ids.has(m[1])) { matched++; if (samples.length < 5) samples.push(`${name}  ->  id ${m[1]}`); }
}
console.log(`archive ids            : ${ids.size}`);
console.log(`files with a long id   : ${withNumber}`);
console.log(`ids found in archive   : ${matched}`);
if (samples.length) { console.log('\nmatches:'); for (const s of samples) console.log('  ' + s); }
else console.log('\nNo overlap — these ids are not from this archive.');
