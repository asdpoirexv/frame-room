#!/usr/bin/env node
/**
 * scan-local — fold locally downloaded PixVerse files into an archive export.
 *
 *   1. In Browse, use the … menu → export archive.
 *   2. node tools/scan-local.js <folder> <export.json> <out.json>
 *   3. In Browse, use the … menu → import archive, and pick <out.json>.
 *
 * Files that are already in the archive are skipped; only genuinely new ones are
 * added, so running it repeatedly is safe.
 *
 * WHY A SCRIPT AND NOT A FEATURE
 * ------------------------------
 * A browser extension cannot read a folder — it can only see files you hand it
 * through a picker, and it has no way to walk a directory tree. Node can. The
 * export → modify → import round trip already exists and is the natural seam.
 *
 * FILENAME CONVENTIONS
 * --------------------
 * Downloads preserve the storage path in one of two ways, or not at all:
 *
 *   pixverse_mp4_media_web_ori_<name>.mp4   full path, slashes became underscores
 *   pixverse_i2i_ori_<uuid>.jpg             same
 *   <uuid>_seed<n>.mp4                      basename only
 *   <uuid>.jpg                              basename only
 *
 * A bare `<uuid>.jpg` looks ambiguous between `upload/` and `pixverse/i2i/ori/`,
 * but isn't: you don't download a file you uploaded, so anything here is output.
 *
 * The real ambiguity is one level up, and it took a while to see. A UUID
 * filename is not a PixVerse signature — it is what half the world names a
 * generated file. Grok does it too. A downloads folder holds work from several
 * services, and nothing in `<uuid>.jpg` says which one produced it.
 *
 * So the URL is CHECKED before a record is written. That costs a request per
 * candidate file and is the only thing separating "this is yours" from "this
 * merely looks like yours". `--no-verify` skips it; the records it writes are
 * marked `unverified` and should be treated as suspect.
 */

const fs = require('fs');
const path = require('path');

const MEDIA = 'https://media.pixverse.ai';

// Prefixes seen on real downloads, longest first so the more specific wins.
const PREFIXES = [
  ['pixverse_mp4_media_web_ori_', 'pixverse/mp4/media/web/ori/'],
  ['pixverse_webp_media_web_', 'pixverse/webp/media/web/'],
  ['pixverse_video_frame_', 'pixverse/video/frame/'],
  ['pixverse_i2i_ori_', 'pixverse/i2i/ori/'],
  ['upload_', 'upload/'],
];

// Exactly what PixVerse produces, nothing speculative. `.webm` and `.mov` were
// never output formats, and `.webp` especially has no business here — the
// webp URL is the phantom that never exists as a file (see NOTES 1.1), so a
// downloaded .webp is by definition not a PixVerse asset.
// Enough parallelism to make a few thousand checks bearable, low enough to stay
// polite to someone else's CDN.
const VERIFY_CONCURRENCY = 8;

const VIDEO_EXT = new Set(['.mp4']);
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png']);

// PixVerse names every asset with a UUID, optionally suffixed with the seed.
// This is the whole defence against a folder that also holds holiday photos:
// without it `vacation-photo.jpg` becomes a record pointing at
// `pixverse/i2i/ori/vacation-photo.jpg`, a URL that does not exist and never
// will. Being strict here costs nothing — a real asset always matches.
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const ASSET_STEM = new RegExp(`^${UUID}(_seed\\d+)?$`, 'i');

// Windows appends " (1)", " (2)" when a download collides with an existing
// file. Thousands of files means duplicates, and without this every one of them
// fails the stem check and is silently dropped.
const DUPLICATE_SUFFIX = /\s*\(\d+\)$/;

/**
 * Candidate storage paths for a filename, best guess first.
 * Returns [] for anything that doesn't look like a PixVerse asset.
 */
function candidatePaths(filename) {
  const ext = path.extname(filename).toLowerCase();
  const isVideo = VIDEO_EXT.has(ext);
  const isImage = IMAGE_EXT.has(ext);
  if (!isVideo && !isImage) return [];

  // Strip a Windows duplicate marker before anything else, then re-attach the
  // extension: the asset behind "x (1).mp4" is still x.mp4.
  const stem = path.basename(filename, ext).replace(DUPLICATE_SUFFIX, '');

  // Explicit prefix: the path is right there, just underscore-encoded.
  for (const [prefix, dir] of PREFIXES) {
    if (stem.startsWith(prefix)) {
      const rest = stem.slice(prefix.length);
      return ASSET_STEM.test(rest) ? [`${dir}${rest}${ext}`] : [];
    }
  }

  // Basename only. Both kinds live in exactly one place — a downloaded image is
  // an i2i output, since nobody downloads their own upload.
  if (!ASSET_STEM.test(stem)) return []; // not a PixVerse asset
  return isVideo
    ? [`pixverse/mp4/media/web/ori/${stem}${ext}`]
    : [`pixverse/i2i/ori/${stem}${ext}`];
}

const urlFor = (storagePath) => `${MEDIA}/${storagePath}`;

// Matches the extension's own archive key: decoded, query stripped.
const canonicalUrl = (u) => String(u).replace(/%2F/gi, '/').split(/[?#]/)[0];

function seedFrom(filename) {
  const m = filename.match(/_seed(\d+)/i);
  return m ? Number(m[1]) : null;
}

// Does this object actually exist on the CDN?
//
// A HEAD alone is not enough to conclude absence — object stores can answer HEAD
// differently from GET — so a non-OK HEAD is confirmed with a one-byte ranged
// GET before the file is rejected.
async function exists(url) {
  const probe = async (init) => {
    try {
      return await fetch(url, { redirect: 'follow', ...init });
    } catch {
      return null;
    }
  };
  const head = await probe({ method: 'HEAD' });
  if (head?.ok) return true;
  // A ranged GET is correct HERE and wrong in the extension. This runs in Node,
  // where there is no CORS, so the Range header costs nothing and saves pulling
  // whole files across thousands of checks. In a browser the same header is not
  // CORS-safelisted, forces a preflight this CDN does not answer, and the
  // request fails before it is sent. Do not unify these two.
  const ranged = await probe({ method: 'GET', headers: { Range: 'bytes=0-0' } });
  return Boolean(ranged && (ranged.ok || ranged.status === 206));
}

// Bounded-concurrency map, so a few thousand checks don't run one at a time.
async function mapLimit(list, limit, fn) {
  const out = new Array(list.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, async () => {
    while (cursor < list.length) {
      const i = cursor++;
      out[i] = await fn(list[i], i);
    }
  }));
  return out;
}

// Top level only unless asked. A downloads folder usually has subfolders that
// are somebody else's business.
function listFiles(dir, { recurse = false } = {}) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (recurse) out.push(...listFiles(full, { recurse }));
    } else {
      out.push(full);
    }
  }
  return out;
}

async function main() {
  const flags = process.argv.slice(2).filter((a) => a.startsWith('--'));
  const [folder, exportPath, outPath] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const recurse = flags.includes('--recurse');
  const verify = !flags.includes('--no-verify');
  const prune = flags.includes('--prune');

  if (!folder || !exportPath || !outPath) {
    console.error('usage: node scan-local.js <folder> <export.json> <out.json> [--recurse] [--prune] [--no-verify]');
    console.error('');
    console.error('  --prune      also re-check records a previous scan added and drop dead ones');
    console.error('  --no-verify  skip the CDN check (fast, but writes records that may not exist)');
    process.exit(1);
  }

  const backup = JSON.parse(fs.readFileSync(exportPath, 'utf8'));
  if (backup.format !== 'frame-room/archive') {
    console.error(`${exportPath} is not a Frame Room archive export.`);
    process.exit(1);
  }

  const records = backup.records ?? {};
  const known = new Set(Object.values(records).map((r) => canonicalUrl(r.url ?? '')));
  console.log(`archive: ${Object.keys(records).length} records`);

  // --- prune: re-check what a previous scan added -------------------------
  //
  // Import merges and cannot remove, so a bad record added by an earlier run
  // stays until it is taken out of the export itself. Only records this tool
  // wrote are touched: they carry `localFile`, and everything else came from the
  // API and is not ours to second-guess.
  let pruned = 0;
  if (prune) {
    const mine = Object.entries(records).filter(([, r]) => r.localFile);
    if (mine.length) {
      console.log(`\nre-checking ${mine.length} records added by a previous scan…`);
      const results = await mapLimit(mine, VERIFY_CONCURRENCY,
        async ([key, r]) => [key, await exists(r.url)]);
      for (const [key, ok] of results) {
        if (!ok) { delete records[key]; known.delete(canonicalUrl(key)); pruned++; }
      }
      console.log(`  dropped ${pruned} that no longer resolve`);
    }
  }

  // --- scan the folder -----------------------------------------------------
  const files = listFiles(folder, { recurse });
  console.log(`\nfolder : ${files.length} files${recurse ? ' (including subfolders)' : ' (top level only)'}`);

  let alreadyKnown = 0;
  let notMedia = 0;
  const notAssets = [];
  const pending = []; // { file, name, url, storagePath }

  for (const file of files) {
    const name = path.basename(file);
    const ext = path.extname(name).toLowerCase();
    const candidates = candidatePaths(name);

    if (!candidates.length) {
      // Two very different reasons, and only one is worth your attention: a .txt
      // is noise, but a .mp4 that doesn't look like an asset might be a naming
      // case this tool doesn't know about.
      if (VIDEO_EXT.has(ext) || IMAGE_EXT.has(ext)) notAssets.push(name);
      else notMedia++;
      continue;
    }

    const storagePath = candidates[0];
    const url = urlFor(storagePath);

    if (known.has(canonicalUrl(url))) { alreadyKnown++; continue; }
    pending.push({ file, name, url, storagePath });
  }

  // --- verify before writing anything --------------------------------------
  //
  // A UUID filename is not a PixVerse signature — plenty of services name files
  // that way. Without this check, someone else's generation becomes a record
  // pointing at a URL that will never resolve.
  let checked = [];
  if (verify && pending.length) {
    console.log(`\nchecking ${pending.length} candidates against the CDN…`);
    let done = 0;
    const results = await mapLimit(pending, VERIFY_CONCURRENCY, async (item) => {
      const ok = await exists(item.url);
      done++;
      if (done % 250 === 0) console.log(`  ${done}/${pending.length}`);
      return ok ? item : null;
    });
    checked = results.filter(Boolean);
    console.log(`  ${checked.length} exist, ${pending.length - checked.length} do not`);
  } else {
    checked = pending;
  }

  // --- write ---------------------------------------------------------------
  for (const { file, name, url, storagePath } of checked) {
    const key = canonicalUrl(url);
    const stat = fs.statSync(file);
    const isVideo = VIDEO_EXT.has(path.extname(name).toLowerCase());

    records[key] = {
      kind: isVideo ? 'video' : 'image',
      url,
      path: storagePath,
      // An image is its own poster. A video has none from a filename — Browse
      // grabs a frame from the file itself for those.
      poster: isVideo ? null : url,
      prompt: '',
      model: '',
      quality: '',
      seed: seedFrom(name),
      // The file's mtime is when YOU downloaded it, not when it was generated.
      createdAt: null,
      mode: '',
      accounts: [],
      accountSource: null,
      starred: false,
      status: 'pending',
      firstSeenAt: stat.mtimeMs,
      lastSeenAt: Date.now(),
      // Provenance: identifies a record this tool wrote, which is what makes
      // --prune able to re-check its own work and nothing else.
      localFile: name,
      localScannedAt: new Date().toISOString(),
      ...(verify ? {} : { unverified: true }),
    };
    known.add(key);
  }

  backup.records = records;
  backup.recordCount = Object.keys(records).length;
  backup.exportedAt = new Date().toISOString();
  fs.writeFileSync(outPath, JSON.stringify(backup, null, 2));

  console.log('');
  console.log(`already archived : ${alreadyKnown}`);
  console.log(`added            : ${checked.length}`);
  if (prune) console.log(`pruned           : ${pruned}`);
  if (!verify) console.log(`NOT VERIFIED     : records written without checking the CDN`);
  if (notMedia) console.log(`ignored          : ${notMedia} non-media files`);
  if (notAssets.length) {
    console.log(`not PixVerse     : ${notAssets.length} media files whose names aren't asset ids`);
    for (const n of notAssets.slice(0, 8)) console.log(`    ${n}`);
    if (notAssets.length > 8) console.log(`    …and ${notAssets.length - 8} more`);
  }
  console.log('');
  console.log(`wrote ${outPath} — ${backup.recordCount} records total.`);
  if (pruned) {
    console.log('');
    console.log('IMPORTANT: import MERGES and cannot remove. To apply the pruning you');
    console.log('must purge the archive first (Shift+Backspace in Browse), then import');
    console.log('this file. Everything else in it — stars included — is preserved.');
  }
}

// Only when run directly — requiring this file (the tests do) must not execute
// a scan or print usage.
if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = { candidatePaths, seedFrom, canonicalUrl, urlFor };
