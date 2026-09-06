#!/usr/bin/env node
/**
 * Frame Room — verification suite.
 *
 *   node test/verify.js
 *
 * No dependencies, no test framework. Run it after touching background.js.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every payload this extension sends was wrong at some point, and each was only
 * caught by diffing against a real captured request. Those captures live in
 * test/fixtures/ — they are the single most valuable artifact in the project,
 * because they cost DevTools work to obtain and they are the only ground truth
 * about an undocumented API. Losing them means re-capturing everything.
 *
 * HOW IT WORKS
 * ------------
 * background.js is an MV3 service worker: it registers chrome.* listeners at
 * import time, so it cannot simply be require()d in node. Rather than copy the
 * logic here — where it would silently drift from the real implementation and
 * happily pass while production broke — the harness extracts the named pure
 * functions from the source text and evaluates them.
 *
 * The trade-off is deliberate: if a function is renamed or removed the harness
 * fails loudly (which is correct — the tests were verifying something that no
 * longer exists) rather than quietly testing a stale copy.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
const fixture = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8'));

// ---------- harness ----------

let pass = 0;
let fail = 0;
const failures = [];

function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    failures.push(`${name}\n       expected ${e}\n       actual   ${a}`);
    console.log(`  FAIL ${name}`);
    console.log(`       expected ${e}`);
    console.log(`       actual   ${a}`);
  }
}

function ok(name, cond) {
  check(name, Boolean(cond), true);
}

function section(title) {
  console.log(`\n${title}`);
}

// ---------- does it even parse? ----------
//
// This suite pulls named functions out of background.js by brace matching and
// evaluates them one at a time, which means a syntax error ANYWHERE ELSE in the
// file sails straight through with 468 green ticks. The extension would then
// fail to load at all — the loudest possible failure, caught by the quietest
// possible test — and nothing here would have said a word.
//
// So: parse every shipped file, whole, before testing any of its parts.
//
// AS A MODULE, which is the correction that matters. The first version of this
// used `new vm.Script`, which parses the CLASSIC SCRIPT grammar. All three
// shipped files are loaded as modules — background.js via
// `"type": "module"` in the manifest, the other two via
// `<script type="module">` — and the two grammars are not the same language.
// Modules are always strict, so `with`, octal literals and duplicate parameter
// names are syntax errors in one and legal in the other, and `import`/`export`
// only parse as a module at all.
//
// A guard written to catch "the extension will not load" was therefore checking
// a grammar the extension never uses. It could pass on a file Chrome refuses.
// Spawning node with --input-type=module is the only way to get the real parse
// without a dependency or an experimental flag.
section('Files parse');
{
  const { execFileSync } = require('child_process');
  for (const f of ['background.js', 'sidepanel.js', 'browse.js']) {
    let err = null;
    try {
      execFileSync(process.execPath, ['--input-type=module', '--check'], {
        input: fs.readFileSync(path.join(ROOT, f), 'utf8'),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      // Keep the first few lines: node prints the offending line and a caret.
      err = String(e.stderr || e.message).trim().split('\n').slice(0, 4).join(' | ');
    }
    check(`${f} parses as a module`, err, null);
  }
}

/** Pull a named function's source out of background.js by brace matching. */
function extractFn(name) {
  const re = new RegExp(`^(?:async\\s+)?function\\s+${name}\\s*\\(`, 'm');
  const start = SRC.search(re);
  if (start < 0) throw new Error(`function not found in background.js: ${name}`);
  // Skip the parameter list before hunting for the body. A destructured
  // parameter — `function f({ a, b })` — puts a `{` before the body, and taking
  // that one as the start returns the signature and nothing else. The function
  // then appears to contain none of its own code, and every assertion about its
  // contents fails for a reason that has nothing to do with the code.
  let p = SRC.indexOf('(', start);
  let parens = 0;
  for (; p < SRC.length; p++) {
    if (SRC[p] === '(') parens++;
    else if (SRC[p] === ')' && --parens === 0) break;
  }

  let depth = 0;
  let seen = false;
  for (let i = SRC.indexOf('{', p); i < SRC.length; i++) {
    if (SRC[i] === '{') { depth++; seen = true; }
    else if (SRC[i] === '}') {
      depth--;
      if (seen && depth === 0) return SRC.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated function: ${name}`);
}

/** Pull a top-level `const NAME = ...;` declaration out by brace/bracket matching. */
function extractConst(name) {
  const re = new RegExp(`^const\\s+${name}\\s*=`, 'm');
  const start = SRC.search(re);
  if (start < 0) throw new Error(`const not found in background.js: ${name}`);
  let depth = 0;
  for (let i = start; i < SRC.length; i++) {
    const c = SRC[i];
    if (c === '{' || c === '[' || c === '(') depth++;
    else if (c === '}' || c === ']' || c === ')') depth--;
    else if (c === ';' && depth === 0) return SRC.slice(start, i + 1);
  }
  throw new Error(`unterminated const: ${name}`);
}

const CONSTS = ['API', 'MEDIA', 'MODEL_DISPLAY_NAME', 'ID_KEYS'];
const FNS = [
  'decodeMediaUrl', 'mediaUrl', 'mediaUrlPacked', 'isPlaceholderUrl',
  'mp4FromWebp', 'videoUrlFor', 'posterFor', 'accountOf', 'panelModeFor',
  'slimVideo', 'archiveKeyFor', 'canonicalUrl', 'assetId', 'modelDisplayName',
  'inputImagesFrom', 'slimImage', 'originFromPath', 'earliest',
];

const sandbox = {};
const source = [
  ...CONSTS.map(extractConst),
  ...FNS.map(extractFn),
  `module.exports = { ${[...CONSTS, ...FNS].join(', ')} };`,
].join('\n\n');

let lib;
try {
  const mod = { exports: {} };
  new Function('module', 'exports', source)(mod, mod.exports);
  lib = mod.exports;
} catch (err) {
  console.error('Could not load functions from background.js:', err.message);
  process.exit(1);
}

const {
  MEDIA, decodeMediaUrl, mediaUrl, mediaUrlPacked, isPlaceholderUrl,
  mp4FromWebp, videoUrlFor, posterFor, accountOf, panelModeFor,
  slimVideo, archiveKeyFor, modelDisplayName, canonicalUrl, inputImagesFrom, slimImage, earliest,
} = lib;

// ---------- 1. URL handling ----------
//
// %2F cuts both ways: decode it for playback, send it in payloads. Getting
// either direction wrong is a silent failure.

section('URL handling');
{
  const packed = 'https://media.pixverse.ai/upload%2Fabc-123.jpg';
  check('decodeMediaUrl unpacks %2F', decodeMediaUrl(packed), 'https://media.pixverse.ai/upload/abc-123.jpg');
  check('mediaUrl keeps real slashes', mediaUrl('upload/abc-123.jpg'), `${MEDIA}/upload/abc-123.jpg`);
  check('mediaUrlPacked encodes slashes', mediaUrlPacked('upload/abc-123.jpg'), packed);
  check('mediaUrlPacked is extension-agnostic', mediaUrlPacked('pixverse/i2i/ori/x.png'), `${MEDIA}/pixverse%2Fi2i%2Fori%2Fx.png`);
}

// ---------- 2. Placeholders ----------
//
// Every placeholder shares the basename "default", so one slipping through
// collapses unrelated records into a single archive entry.

section('Placeholder rejection');
{
  ok('rejects placeholder mp4', isPlaceholderUrl('https://media.pixverse.ai/pixverse-preview%2Fmp4%2Fmedia%2Fdefault.mp4'));
  ok('rejects placeholder jpg', isPlaceholderUrl('https://media.pixverse.ai/pixverse%2Fjpg%2Fmedia%2Fdefault.jpg'));
  ok('accepts a real mp4', !isPlaceholderUrl('https://media.pixverse.ai/pixverse/mp4/media/web/ori/abc_seed1.mp4'));
  // The reason the index is a full URL: two different placeholders shared the
  // stem `default` and collapsed into one archive entry.
  ok('different placeholders get different keys',
    archiveKeyFor({ url: 'https://media.pixverse.ai/pixverse-preview%2Fmp4%2Fmedia%2Fdefault.mp4' })
    !== archiveKeyFor({ url: 'https://media.pixverse.ai/pixverse%2Fjpg%2Fmedia%2Fdefault.jpg' }));
}

// ---------- 3. webp is a filename carrier ----------

section('mp4 derivation from webp');
{
  const rec = fixture('asset-transition-placeholder.json');
  check('derives the confirmed-working mp4', mp4FromWebp(rec.webp_url), rec._confirmed_working_mp4);
  check('placeholder url does not defeat it', videoUrlFor(rec), rec._confirmed_working_mp4);
  const derived = mp4FromWebp(rec.webp_url);
  const packedSpelling = derived.replace(/\//g, (m, i) => (i > 'https://media.pixverse.ai'.length ? '%2F' : m));
  check('key survives either URL spelling',
    archiveKeyFor({ url: packedSpelling }), archiveKeyFor({ url: derived }));
  check('key is the canonical url', archiveKeyFor({ url: derived }), derived);
}

// ---------- 4. video_status is not evidence ----------

section('video_status is ignored');
{
  const failedLooking = fixture('asset-transition-placeholder.json'); // status 7
  const working = fixture('asset-image-text.json');                   // status 1
  check('status 7 record still yields a URL', Boolean(videoUrlFor(failedLooking)), true);
  check('status 1 record still yields a URL', Boolean(videoUrlFor(working)), true);
  ok('statuses observed on working videos differ', failedLooking.video_status !== working.video_status);
}

// ---------- 5. Per-record account attribution ----------

section('Account attribution');
{
  check('reads nick_name', accountOf(fixture('asset-image-text.json')), 'asdpoirexv180');
  check('reads transition record', accountOf(fixture('asset-transition-placeholder.json')), 'asdpoirexv185');
  check('falls back to email local-part', accountOf({ email: 'someone@example.com' }), 'someone');
  check('falls back to account_id', accountOf({ account_id: 12345 }), '12345');
  check('unknown stays null', accountOf({}), null);
}

// ---------- 6. Mode detection and source extraction ----------
//
// image_text stores its source under the SINGULAR customer_img_path. Reading
// only the plural array made these look frameless and hid the rerun button.

section('Mode detection and source frames');
{
  const imageText = fixture('asset-image-text.json');
  const transition = fixture('asset-transition-placeholder.json');

  check('image_text is animate', panelModeFor(imageText), 'animate');
  check('transition is frames', panelModeFor(transition), 'frames');
  check('two images imply frames', panelModeFor({ customer_paths: { customer_img_paths: ['a', 'b'] } }), 'frames');

  const slimIT = slimVideo(imageText);
  check('image_text yields a source frame', slimIT.rerun.firstPath, 'upload/480ff44d-5fdf-4f0d-8786-4530da29a1ef.jpg');
  check('image_text has no last frame', slimIT.rerun.lastPath, null);
  check('image_text carries multi_shot', slimIT.rerun.multiShot, 1);

  const slimTr = slimVideo(transition);
  check('transition yields both frames', [slimTr.rerun.firstPath, slimTr.rerun.lastPath], [
    'pixverse/i2i/ori/b73b87bb-7fea-4426-b864-ce688664e0d0.jpg',
    'pixverse/i2i/ori/6ea8c6f5-a18a-4bd2-a826-c2e786bb85af.jpg',
  ]);
}

// ---------- 7. Posters ----------

section('Posters');
{
  check('image_text uses the nested singular url', posterFor(fixture('asset-image-text.json')),
    'https://media.pixverse.ai/upload/480ff44d-5fdf-4f0d-8786-4530da29a1ef.jpg');
  check('transition uses the first frame url', posterFor(fixture('asset-transition-placeholder.json')),
    'https://media.pixverse.ai/pixverse/i2i/ori/b73b87bb-7fea-4426-b864-ce688664e0d0.jpg');
  check('placeholder first_frame is not a poster', posterFor({ customer_paths: {}, first_frame: 'https://media.pixverse.ai/pixverse%2Fjpg%2Fmedia%2Fdefault.jpg' }), null);
}

// ---------- 8. model_name_default is a lookup, not a formula ----------

section('Model display names');
{
  check('v6 (verified)', modelDisplayName('v6'), 'PixVerse V6');
  check('qwen-image (verified)', modelDisplayName('qwen-image'), 'Qwen-image');
  ok('qwen is not given the PixVerse prefix', !modelDisplayName('qwen-image').startsWith('PixVerse'));
  check('unknown v-model follows the PixVerse pattern', modelDisplayName('v9'), 'PixVerse V9');
}

// ---------- 9. Generate payloads match real captures ----------
//
// The whole point. These caught: a missing customer_img_url, plain slashes
// where %2F was required, a missing model_name_default on all three calls, and
// a model_name_default formula that was wrong for every non-PixVerse model.

section('Generate payloads vs captured requests');

function comparePayload(label, built, captured) {
  const expected = { ...captured };
  delete expected._note;
  const bk = Object.keys(built).sort();
  const ck = Object.keys(expected).sort();
  check(`${label}: field set`, bk, ck);
  for (const k of ck) check(`${label}: ${k}`, built[k], expected[k]);
}

{
  const cap = fixture('i2i-request.json');
  comparePayload('i2i', {
    customer_img_paths: ['upload/6b043fa4-281c-427d-a4e0-b0c2ac06c9d6.png'],
    prompt: 'she smiles.',
    model: 'qwen-image',
    create_count: 1,
    seed: 467293524,
    quality: '1080p',
    aspect_ratio: '4:5',
    credit_change: 10,
    model_name_default: modelDisplayName('qwen-image'),
  }, cap);
}

{
  const cap = fixture('i2v-request.json');
  const imagePath = 'upload/480ff44d-5fdf-4f0d-8786-4530da29a1ef.jpg';
  comparePayload('i2v', {
    customer_img_path: imagePath,
    prompt: 'she smiles',
    model: 'v6',
    create_count: 1,
    customer_img_url: mediaUrlPacked(imagePath),
    multi_shot: 1,
    quality: '360p',
    duration: 5,
    seed: 305684821,
    credit_change: 20,
    model_name_default: modelDisplayName('v6'),
  }, cap);
}

{
  const cap = fixture('frames-request.json');
  const first = 'upload/b97e3238-9364-4636-b2ac-65db9a79e1f1.png';
  const last = 'pixverse/i2i/ori/c24284fb-aab0-46e1-bcd9-ccb1b765be81.jpg';
  comparePayload('frames', {
    customer_img_paths: [first, last],
    prompt: 'she smiles',
    model: 'v6',
    create_count: 1,
    customer_img_urls: [mediaUrlPacked(first), mediaUrlPacked(last)],
    prompts: ['she smiles'],
    durations: [5],
    preview_mode: 0,
    quality: '360p',
    duration: 5,
    off_peak: 0,
    seed: 301402947,
    audio: 0,
    model_name_default: modelDisplayName('v6'),
  }, cap);
}

// ---------- 10. Pagination stop conditions ----------
//
// Ignoring the cursor caused both silent truncation and a possible request loop.

section('Pagination');
{
  const env = fixture('list-envelopes.json');
  const step = (resp, webOffset, added) => {
    const hasMore = Boolean(resp.web_has_more ?? resp.has_more);
    const next = resp.web_next_offset ?? resp.next_offset ?? null;
    if (!hasMore) return 'stop:server';
    if (next == null || next === webOffset) return 'stop:stalled';
    if (!added) return 'stop:empty';
    return `continue:${next}`;
  };
  check('more pages continues at the cursor', step(env.more_pages, 0, 2), 'continue:50');
  check('last page stops', step(env.last_page, 0, 17), 'stop:server');
  check('stalled cursor stops', step(env.stalled, 50, 5), 'stop:stalled');
  check('page that adds nothing stops', step(env.more_pages, 0, 0), 'stop:empty');
}

// ---------- 11. Archive account-tag semantics ----------
//
// Three separate bugs lived here: tags accumulating into a set that could never
// drop a wrong entry, and local job records re-applying stale tags to records a
// migration had just cleared (counts visibly moved on every account switch).

section('Archive account tags');
{
  // Mirrors archiveMerge's tag rule. Kept in step by the invariant test below.
  const tagOf = (prev, r) => {
    const fromLibrary = r.source === 'library' || r.source === 'both';
    return fromLibrary && r.account ? [r.account] : (prev?.accounts ?? []);
  };

  check('library sighting sets the tag', tagOf(undefined, { account: '185', source: 'library' }), ['185']);
  check('library sighting replaces a wrong tag', tagOf({ accounts: ['190'] }, { account: '185', source: 'library' }), ['185']);
  check('local job cannot set a tag', tagOf({ accounts: [] }, { account: '190', source: 'local' }), []);
  check('local job cannot overwrite a library tag', tagOf({ accounts: ['185'] }, { account: '190', source: 'local' }), ['185']);

  // The reported symptom: switching accounts moved the numbers.
  let rec = { accounts: ['185'] };
  for (let i = 0; i < 10; i++) rec = { accounts: tagOf(rec, { account: '190', source: 'local' }) };
  check('ten account switches do not drift', rec.accounts, ['185']);

  // A record can never claim two owners.
  const many = [
    tagOf(undefined, { account: 'a', source: 'library' }),
    tagOf({ accounts: ['a'] }, { account: 'b', source: 'library' }),
    tagOf({ accounts: ['a'] }, { account: 'b', source: 'local' }),
  ];
  ok('no record ever holds two tags', many.every((t) => t.length <= 1));
}

// ---------- 12. Reconciliation ----------
//
// Replacement alone cannot fix a wrong tag: a record wrongly tagged X belongs to
// Y, so X's library never returns it. After a deep sweep, absence is proof.

section('Reconciliation after a deep sweep');
{
  const reconcile = (archive, apiItems) => {
    const names = new Set(apiItems.map((r) => r.account).filter(Boolean));
    if (names.size !== 1) return 0;
    const account = [...names][0];
    const present = new Set(apiItems.map((r) => r.key));
    let cleared = 0;
    for (const [key, rec] of Object.entries(archive)) {
      if (!rec.accounts?.includes(account) || present.has(key)) continue;
      rec.accounts = rec.accounts.filter((a) => a !== account);
      cleared++;
    }
    return cleared;
  };

  const archive = {
    real0: { accounts: ['a190'] },
    real1: { accounts: ['a190'] },
    stray: { accounts: ['a190'] }, // single WRONG tag — collapsing can't catch this
    other: { accounts: ['a183'] },
  };
  const cleared = reconcile(archive, [{ key: 'real0', account: 'a190' }, { key: 'real1', account: 'a190' }]);
  check('strips the tag from records not in the sweep', cleared, 1);
  check('leaves genuine records tagged', Object.values(archive).filter((r) => r.accounts.includes('a190')).length, 2);
  check('leaves other accounts alone', archive.other.accounts, ['a183']);

  const before = JSON.stringify(archive);
  check('empty sweep changes nothing', reconcile(archive, []), 0);
  check('mixed-account sweep changes nothing', reconcile(archive, [{ key: 'x', account: 'p' }, { key: 'y', account: 'q' }]), 0);
  check('archive untouched by ambiguous sweeps', JSON.stringify(archive), before);
}

// ---------- 13. Source-of-truth invariants ----------
//
// These guard the rules themselves, not just behaviour — if someone reintroduces
// a fallback or a formula, this fails.

section('Invariants');
{
  ok('archiveMerge has no local-account fallback',
    !/r\.account\s*&&\s*!\(prev\?\.accounts/.test(SRC));
  ok('no model_name_default formula remains',
    !/model_name_default:\s*`PixVerse \$\{/.test(SRC));
  ok('video_status is not used to decide existence',
    !/FAILED_VIDEO_STATUS|video_status\s*===\s*7/.test(SRC));
  ok('generate payloads use the packed URL builder',
    /customer_img_url:\s*mediaUrlPacked/.test(SRC) && /customer_img_urls:\s*\[mediaUrlPacked/.test(SRC));
  ok('archive version is ahead of the last migration step',
    (() => {
      const v = Number(/const ARCHIVE_VERSION = (\d+)/.exec(SRC)?.[1]);
      const steps = [...SRC.matchAll(/from < (\d+)/g)].map((m) => Number(m[1]));
      return v >= Math.max(...steps);
    })());
}

// ---------- 14. Sweep completeness ----------
//
// Reconciliation argues from absence, so it is only valid against a sweep that
// actually finished. A sweep that stopped on the record cap or on a run of empty
// windows has not seen everything, and treating it as complete strips valid tags.

section('Sweep completeness');
{
  const gate = (stoppedBy) => stoppedBy === 'floor';
  ok('reaching the floor is complete', gate('floor'));
  ok('hitting the record cap is NOT complete', !gate('max'));
  ok('stopping on empty windows is NOT complete', !gate('gap'));
  ok('a shallow fetch is NOT complete', !gate('shallow'));

  ok('reconciliation is gated on completeness',
    /deep && !apiError && sweepComplete/.test(SRC));
  ok('a truncated sweep is not banked as swept',
    /if \(deep && account && sweep\.complete\) await markAccountSwept/.test(SRC));
}

// ---------- 15. Drift detection ----------

section('Drift detection');
{
  const countTags = (map) => {
    const out = {};
    for (const rec of Object.values(map)) for (const a of rec.accounts ?? []) out[a] = (out[a] ?? 0) + 1;
    out['(untagged)'] = Object.values(map).filter((r) => !(r.accounts?.length)).length;
    return out;
  };
  const diff = (prev, now) => {
    const changes = [];
    for (const k of new Set([...Object.keys(prev), ...Object.keys(now)])) {
      const from = prev[k] ?? 0; const to = now[k] ?? 0;
      if (from !== to) changes.push({ account: k, from, to, delta: to - from });
    }
    return changes;
  };

  const before = countTags({ a: { accounts: ['x'] }, b: { accounts: ['x'] }, c: { accounts: [] } });
  check('counts tags and untagged', before, { x: 2, '(untagged)': 1 });

  const stable = diff(before, countTags({ a: { accounts: ['x'] }, b: { accounts: ['x'] }, c: { accounts: [] } }));
  check('no change means no event', stable, []);

  // The exact reported symptom: an untagged record silently gains a tag.
  const after = countTags({ a: { accounts: ['x'] }, b: { accounts: ['x'] }, c: { accounts: ['y'] } });
  check('a silent re-tag is detected', diff(before, after).sort((p, q) => p.account.localeCompare(q.account)),
    [{ account: '(untagged)', from: 1, to: 0, delta: -1 }, { account: 'y', from: 0, to: 1, delta: 1 }]);

  ok('drift is recorded on every load', /recordAccountDrift\(map, \{/.test(SRC));
  ok('drift log is included in the diagnostic', /driftEvents:/.test(SRC));
  ok('purge clears the drift log', /DRIFT_KEY\]\)/.test(SRC) || /SWEPT_KEY, DRIFT_KEY/.test(SRC));
}

// ---------- 16. Asset sources ----------
//
// asset_source separates uploads (0) from generations (1). Hardcoding 1 was
// right for video and made every uploaded image invisible to the frame picker.

section('Asset sources');
{
  const up = fixture('asset-uploaded-image.json');
  check('uploads are asset_source 0', up.asset_source, 0);
  check('the query that found it used source 0', up._request_that_returned_it.asset_source, 0);
  check('the same query with source 1 found nothing', up._request_that_returned_nothing.asset_source, 1);

  ok('asset_source is a parameter, not hardcoded', /asset_source: assetSource/.test(SRC));
  ok('no hardcoded asset_source remains', !/asset_source: 1,/.test(SRC));
  ok('the picker queries both sources', /for \(const assetSource of \[0, 1\]\)/.test(SRC));

  // An uploaded record must be usable by the picker: preview and path agree.
  const pathFromMediaUrl = (u) => {
    const d = decodeMediaUrl(String(u ?? ''));
    const pre = `${MEDIA}/`;
    if (!d.startsWith(pre)) return null;
    return d.slice(pre.length).split(/[?#]/)[0] || null;
  };
  check('path derived from url matches the record', pathFromMediaUrl(up.url), up.path);
  ok('uploads carry no customer_paths', up.customer_paths === undefined);

  // Generated images are a third shape again: no `url`, no `path`.
  const gen = fixture('asset-generated-image.json');
  check('generated images are asset_source 1', gen.asset_source, 1);
  ok('generated images have no `url` field', gen.url === undefined);
  ok('generated images have no `path` field', gen.path === undefined);

  // What the picker actually computes, for both shapes.
  const pick = (item) => {
    const src = decodeMediaUrl(item.url ?? item.image_url ?? item.img_url ?? '');
    const path = pathFromMediaUrl(src) ?? item.image_path ?? item.path ?? item.img_path ?? null;
    return { src, path };
  };

  const g = pick(gen);
  check('generated: preview is the output image', g.src, decodeMediaUrl(gen.image_url));
  check('generated: path is the output, not the input', g.path, gen.image_path);
  ok('generated: path is NOT the source upload', g.path !== gen.customer_img_paths[0]);

  const u = pick(up);
  check('uploaded: preview resolves', u.src, decodeMediaUrl(up.url));
  check('uploaded: path resolves', u.path, up.path);

  // The invariant that matters: the tile you click is the image you get.
  for (const [label, item] of [['generated', gen], ['uploaded', up]]) {
    const { src, path } = pick(item);
    check(`${label}: preview and path agree`, pathFromMediaUrl(src), path);
  }
}

// ---------- 17. Images in the archive ----------
//
// Images have no equivalent of the video webp filename-carrier. What they do
// have is a storage path alongside the URL, so a missing URL is rebuilt from the
// path rather than lost — a record is only unrecoverable when BOTH are absent.

section('Image archiving');
{
  const slimImage = (it) => {
    const rawUrl = it.image_url || it.url || it.img_url || null;
    const path = it.image_path || it.path || it.img_path || null;
    let url = rawUrl && !isPlaceholderUrl(rawUrl) ? decodeMediaUrl(rawUrl) : null;
    if (!url && path) url = mediaUrl(path);
    if (!url) return null;
    return { kind: 'image', url, path };
  };

  const gen = fixture('asset-generated-image.json');
  const up = fixture('asset-uploaded-image.json');

  check('generated image resolves', slimImage(gen).url, decodeMediaUrl(gen.image_url));
  check('uploaded image resolves', slimImage(up).url, decodeMediaUrl(up.url));

  // The failure the webp trick protects video from.
  check('url rebuilt from path when the server omits it',
    slimImage({ image_path: gen.image_path }).url, mediaUrl(gen.image_path));
  check('placeholder url falls back to the path',
    slimImage({ image_url: 'https://media.pixverse.ai/pixverse%2Fjpg%2Fmedia%2Fdefault.jpg', image_path: gen.image_path }).url,
    mediaUrl(gen.image_path));
  check('no url and no path is unrecoverable', slimImage({ prompt: 'x' }), null);

  // Archive keys: images must produce one, videos must be unchanged.
  ok('generated image gets an archive key', Boolean(archiveKeyFor(slimImage(gen))));
  ok('uploaded image gets an archive key', Boolean(archiveKeyFor(slimImage(up))));
  ok('image and video keys do not collide',
    archiveKeyFor(slimImage(gen)) !== archiveKeyFor(slimImage(up)));

  ok('images are swept across both asset sources', /listAllImages/.test(SRC));
  ok('records carry their kind', /kind: 'image'/.test(SRC) && /kind: 'video'/.test(SRC));
}

// ---------- 18. Picker dedupe across sources ----------
//
// The picker now merges live API rows with archive records. Those arrive in
// three different field shapes, so identity has to survive all of them — and
// the same asset must not appear twice because one spelling used %2F.

section('Picker dedupe');
{
  const pickerKey = (it) => {
    const url = it.image_url || it.url || it.img_url || null;
    if (url) return canonicalUrl(url);
    const path = it.image_path || it.path || it.img_path || null;
    return path ? `path:${path}` : null;
  };

  const gen = fixture('asset-generated-image.json');
  const up = fixture('asset-uploaded-image.json');

  // Same asset, three shapes: live generated row, live uploaded row, archive record.
  const archivedGen = { kind: 'image', url: decodeMediaUrl(gen.image_url), path: gen.image_path };
  check('archive record keys same as its live row', pickerKey(archivedGen), pickerKey(gen));

  const archivedUp = { kind: 'image', url: decodeMediaUrl(up.url), path: up.path };
  check('uploaded archive record keys same as its live row', pickerKey(archivedUp), pickerKey(up));

  // %2F vs plain slashes must not split one asset in two.
  ok('encoding does not split identity',
    pickerKey({ url: gen.image_url }) === pickerKey({ url: decodeMediaUrl(gen.image_url) }));

  // A query string must not either.
  ok('query strings do not split identity',
    pickerKey({ url: `${up.url}?x-oss-process=style/cover` }) === pickerKey(up));

  // Full merge: live rows then archive, deduped.
  const seen = new Set();
  const out = [];
  for (const it of [gen, up, archivedGen, archivedUp, { url: gen.image_url }]) {
    const k = pickerKey(it);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  check('five inputs, two distinct assets', out.length, 2);

  check('a record with neither url nor path is unkeyable', pickerKey({ prompt: 'x' }), null);

  ok('picker reads the archive', /rec\.kind !== 'image'/.test(SRC));
  ok('picker results are bounded', /out\.slice\(0, max\)/.test(SRC));
}

// ---------- 19. Browse render structure ----------
//
// An image card returns early from the render loop. Anything it touches must be
// initialised BEFORE that branch — a const declared after it throws a
// ReferenceError from the temporal dead zone, and because the loop body is a
// forEach callback nothing catches it: the whole feed renders blank.

section('Browse render structure');
{
  const browse = fs.readFileSync(path.join(ROOT, 'browse.js'), 'utf8');

  ok('badge and star are built by hoisted functions',
    /function buildBadge\(/.test(browse) && /function buildStar\(/.test(browse));

  // Both must be assigned before the early return, not after it.
  // Anchor on the REEL renderer specifically — renderGrid also has an
  // items.forEach, and slicing from the first one tested the wrong function.
  const loop = browse.slice(browse.indexOf('function render() {'));
  const iBadge = loop.indexOf('const badge = buildBadge');
  const iStar = loop.indexOf('const star = buildStar');
  const iBranch = loop.indexOf("item.kind === 'image'");
  ok('badge is initialised before the image branch', iBadge > -1 && iBadge < iBranch);
  ok('star is initialised before the image branch', iStar > -1 && iStar < iBranch);

  ok('the filter handler is assigned, not stacked',
    /accountsEl\.onchange =/.test(browse) && !/accountsEl\.addEventListener\('change'/.test(browse));
  ok('the visible selection is restored after a rebuild',
    /accountsEl\.value = accountFilter/.test(browse));
}

// ---------- 20. Browse filters compose ----------
//
// Three independent filters (kind, account, starred) over one archive. Records
// predating the kind tag must read as video — that is all the archive held.

section('Browse filters');
{
  const apply = (all, kind, acct, starred) => {
    let l = all;
    if (kind !== 'all') l = l.filter((i) => (i.kind === 'image' ? 'image' : 'video') === kind);
    if (acct === '__none__') l = l.filter((i) => !(i.accounts ?? []).length);
    else if (acct !== 'all') l = l.filter((i) => (i.accounts ?? []).includes(acct));
    if (starred) l = l.filter((i) => i.starred);
    return l.length;
  };

  const all = [
    { kind: 'video', accounts: ['a'], starred: true },
    { kind: 'video', accounts: ['a'], starred: false },
    { kind: 'image', accounts: ['a'], starred: true },
    { kind: 'image', accounts: ['b'], starred: false },
    { accounts: [], starred: false }, // pre-kind record, untagged
  ];

  check('unfiltered', apply(all, 'all', 'all', false), 5);
  check('videos include untagged legacy records', apply(all, 'video', 'all', false), 3);
  check('images', apply(all, 'image', 'all', false), 2);
  check('kind + account', apply(all, 'video', 'a', false), 2);
  check('kind + starred', apply(all, 'image', 'all', true), 1);
  check('all three, empty result', apply(all, 'video', 'b', true), 0);
  check('unattributed bucket still works', apply(all, 'all', '__none__', false), 1);

  const browse = fs.readFileSync(path.join(ROOT, 'browse.js'), 'utf8');
  ok('kind filter hides itself when only one kind is present',
    /if \(!counts\.video \|\| !counts\.image\) return/.test(browse));
  ok('kind filter uses an assigned handler', /kindsEl\.onchange =/.test(browse));
  ok('kind selection is restored after a rebuild', /kindsEl\.value = kindFilter/.test(browse));
}

// ---------- 21. Blank-URL image records ----------
//
// Some generated images come back with image_url AND image_path empty on a later
// listing, though the URL was present during generation. Discarding those lost
// the generation outright, so they are kept on their asset id and folded into
// the real entry when a URL finally shows up — in either arrival order.

section('Blank-URL image records');
{
  const blankFix = fixture('asset-image-blank-url.json');
  check('the captured record really is blank', [blankFix.image_url, blankFix.image_path], ['', '']);
  ok('but it still has an id', Boolean(blankFix.asset_id));

  const keyFor = (r) => archiveKeyFor(r);
  const merge = (map, records) => {
    const byId = new Map();
    for (const [k, v] of Object.entries(map)) if (v?.id != null) byId.set(String(v.id), k);
    for (const r of records) {
      let key = keyFor(r);
      if (!key) continue;
      if (key.startsWith('id:') && r.id != null && byId.has(String(r.id))) key = byId.get(String(r.id));
      if (!key.startsWith('id:') && r.id && map[`id:${r.id}`]) {
        const orphan = map[`id:${r.id}`];
        delete map[`id:${r.id}`];
        byId.delete(String(r.id));
        map[key] = { ...orphan, ...(map[key] ?? {}) };
      }
      if (r.id != null) byId.set(String(r.id), key);
      map[key] = { ...map[key], ...r, url: r.url || map[key]?.url || null, starred: map[key]?.starred || r.starred || false };
    }
    return map;
  };

  const id = blankFix.asset_id;
  const withUrl = { id, url: 'https://media.pixverse.ai/pixverse/i2i/ori/abc123.jpg' };
  const blank = { id, url: null };

  check('capture then blank stays one entry', Object.keys(merge({}, [withUrl, blank])).length, 1);
  check('blank then capture stays one entry', Object.keys(merge({}, [blank, withUrl])).length, 1);
  check('blank only is kept, not dropped', Object.keys(merge({}, [blank])).length, 1);
  check('distinct generations stay distinct', Object.keys(merge({}, [withUrl, { id: 999, url: null }])).length, 2);

  const after = merge({}, [withUrl, blank]);
  check('a blank sighting cannot erase a known url', after[Object.keys(after)[0]].url, withUrl.url);

  const starred = merge({ [`id:${id}`]: { id, url: null, starred: true } }, [withUrl]);
  ok('a star survives the fold', Object.values(starred)[0].starred === true);

  // Was pinned to a comment string that has since been rewritten. Assert the
  // behaviour instead: a job archives what the poller sees, as it sees it.
  ok('assets are archived at generation time',
    /const captureRows = async \(rows\)/.test(SRC) && /auth, captureRows\)/.test(SRC));
  ok('the merge indexes by asset id', /const byId = new Map\(\)/.test(SRC));
}

// ---------- 22. Source frames are archived too ----------
//
// Every generation carries the image(s) it was made from, with a path and a URL.
// Those inputs are images in their own right and drop out of the library like
// anything else, so they are archived alongside the outputs.

section('Input images');
{
  const tr = inputImagesFrom(fixture('asset-transition-placeholder.json'));
  // Listed under BOTH customer_img_paths[] and first/last frame — dedupe or
  // every frames generation archives its inputs twice.
  check('frames yields two inputs, deduped', tr.length, 2);
  check('first frame path', tr[0].path, 'pixverse/i2i/ori/b73b87bb-7fea-4426-b864-ce688664e0d0.jpg');
  check('last frame path', tr[1].path, 'pixverse/i2i/ori/6ea8c6f5-a18a-4bd2-a826-c2e786bb85af.jpg');

  check('image_text yields its singular source', inputImagesFrom(fixture('asset-image-text.json')).length, 1);
  check('i2i yields its source', inputImagesFrom(fixture('asset-generated-image.json')).length, 1);
  check('an upload has no input', inputImagesFrom(fixture('asset-uploaded-image.json')).length, 0);

  // The point of the whole thing: the output went blank, the input did not.
  const blank = inputImagesFrom(fixture('asset-image-blank-url.json'));
  check('a blank-output record still yields its input', blank.length, 1);
  check('input path intact', blank[0].path, 'upload/61f12c2f-2070-4187-a4a9-a4058e47d1a2.png');

  // Derived records must not carry an account — one step removed from a payload
  // that names an owner, and guessed attribution is what broke the tags before.
  ok('derived records are not library-sourced', tr.every((i) => i.source === 'derived'));
  ok('derived records claim no account', tr.every((i) => i.account === undefined));

  // Archive keys: an input already known as a library asset must collide, not
  // duplicate.
  const gen = fixture('asset-generated-image.json');
  const asInput = inputImagesFrom({ customer_img_paths: [gen.image_path], customer_img_urls: [gen.image_url] })[0];
  check('an input keys the same as its library record',
    archiveKeyFor(asInput), archiveKeyFor({ url: gen.image_url }));

  ok('inputs are stripped from parents before archiving', /inputs, \.\.\.rest/.test(SRC));
  ok('generation-time capture keeps inputs', /the frames it was made from/.test(SRC));
}

// ---------- 23. %2F discipline, end to end ----------
//
// PixVerse percent-encodes slashes. The rule has two halves and getting either
// backwards is a silent failure:
//   STORED / DISPLAYED  -> decoded. <video src> and <img src> do not decode %2F.
//   SENT IN A PAYLOAD   -> encoded. That is the form their own client sends.
// Archive keys must be stable across both spellings or one asset files twice.

section('%2F discipline');
{
  const encoded = (u) => /%2F/i.test(String(u ?? ''));

  // Every fixture URL arrives encoded — if not, this section proves nothing.
  const fixtures = ['asset-image-text.json', 'asset-generated-image.json',
    'asset-uploaded-image.json', 'asset-transition-placeholder.json'].map(fixture);
  ok('fixtures really do carry %2F',
    fixtures.some((f) => encoded(f.image_url || f.url || f.webp_url)));

  // --- stored records must be decoded ---
  const stored = [];
  stored.push(slimVideo(fixture('asset-transition-placeholder.json')));
  stored.push(slimImage(fixture('asset-image-text.json')));
  stored.push(slimImage(fixture('asset-generated-image.json')));
  stored.push(slimImage(fixture('asset-uploaded-image.json')));
  for (const rec of stored.filter(Boolean)) {
    ok(`stored url is decoded (${rec.kind})`, !encoded(rec.url));
    ok(`stored poster is decoded (${rec.kind})`, !encoded(rec.poster));
  }

  // Derived inputs come straight off customer_img_urls, which are encoded.
  const derived = stored.filter(Boolean).flatMap((r) => r.inputs ?? []);
  ok('some inputs were extracted', derived.length > 0);
  ok('every derived input url is decoded', derived.every((i) => !encoded(i.url)));
  ok('derived paths are raw storage paths', derived.every((i) => !encoded(i.path)));

  // --- archive keys must survive either spelling ---
  const gen = fixture('asset-generated-image.json');
  check('key from encoded == key from decoded',
    archiveKeyFor({ url: gen.image_url }), archiveKeyFor({ url: decodeMediaUrl(gen.image_url) }));
  check('canonical url collapses both spellings',
    canonicalUrl(gen.image_url), canonicalUrl(decodeMediaUrl(gen.image_url)));
  ok('canonical url is itself decoded', !encoded(canonicalUrl(gen.image_url)));

  // --- payloads must be encoded ---
  const path = 'upload/480ff44d-5fdf-4f0d-8786-4530da29a1ef.jpg';
  ok('mediaUrlPacked encodes', encoded(mediaUrlPacked(path)));
  ok('mediaUrl does NOT encode', !encoded(mediaUrl(path)));
  check('packed matches the captured i2v payload',
    mediaUrlPacked(path), fixture('i2v-request.json').customer_img_url);

  // --- round trip: encoded -> stored(decoded) -> path -> packed == original ---
  const rec = slimImage(gen);
  const backToPath = decodeMediaUrl(rec.url).replace(`${MEDIA}/`, '');
  check('round trip returns the original encoded url',
    mediaUrlPacked(backToPath), gen.image_url);

  // --- a decoded url must never reach a payload builder unencoded ---
  ok('frames payload packs both source urls',
    /customer_img_urls: \[mediaUrlPacked\(firstPath\), mediaUrlPacked\(lastPath\)\]/.test(SRC));
  ok('i2v payload packs its source url', /customer_img_url: mediaUrlPacked\(imagePath\)/.test(SRC));
}

// ---------- 24. Archive index is the canonical URL ----------
//
// The index used to be the filename stem, which collides: every placeholder
// shares `default`, so unrelated records collapsed into one entry and
// overwrote each other. A full canonical URL cannot collide.

section('Archive index');
{
  const gen = fixture('asset-generated-image.json');

  check('the key IS the canonical url',
    archiveKeyFor({ url: gen.image_url }), decodeMediaUrl(gen.image_url));
  ok('the key carries no %2F', !/%2F/i.test(archiveKeyFor({ url: gen.image_url })));
  check('query strings are stripped',
    archiveKeyFor({ url: `${gen.image_url}?x-oss-process=style/cover` }),
    archiveKeyFor({ url: gen.image_url }));

  // Same stem, different prefixes — the collision the old scheme allowed.
  const a = archiveKeyFor({ url: 'https://media.pixverse.ai/upload%2Fshared.jpg' });
  const b = archiveKeyFor({ url: 'https://media.pixverse.ai/pixverse%2Fi2i%2Fori%2Fshared.jpg' });
  ok('same stem under different prefixes stays distinct', a !== b);

  check('no url falls back to the asset id', archiveKeyFor({ id: 123 }), 'id:123');
  check('no url and no id is unkeyable', archiveKeyFor({}), null);

  // v9 migration: re-key, merging on collision rather than last-write-wins.
  const rekey = (map) => {
    const out = {};
    for (const [oldKey, rec] of Object.entries(map)) {
      const newKey = archiveKeyFor(rec) ?? oldKey;
      const clash = out[newKey];
      out[newKey] = clash
        ? {
            ...clash, ...rec,
            url: rec.url || clash.url || null,
            starred: clash.starred || rec.starred || false,
            status: clash.status === 'ok' || rec.status === 'ok' ? 'ok' : (rec.status ?? clash.status),
            accounts: [...new Set([...(clash.accounts ?? []), ...(rec.accounts ?? [])])],
          }
        : rec;
    }
    return out;
  };

  const before = {
    abc123: { url: 'https://media.pixverse.ai/pixverse%2Fi2i%2Fori%2Fabc123.jpg', starred: true, accounts: ['a'] },
    'id:99': { id: 99, url: null, starred: false },
  };
  const after = rekey(before);
  check('url-keyed entry is re-keyed', Object.keys(after).includes('https://media.pixverse.ai/pixverse/i2i/ori/abc123.jpg'), true);
  check('id-keyed entry keeps its key', Object.keys(after).includes('id:99'), true);
  ok('the star survives the re-key', after['https://media.pixverse.ai/pixverse/i2i/ori/abc123.jpg'].starred);

  // Two old entries that had collided on `default` now separate cleanly.
  const collided = {
    default: { url: 'https://media.pixverse.ai/pixverse-preview%2Fmp4%2Fmedia%2Fdefault.mp4', starred: true },
  };
  check('a formerly-collided entry re-keys to its real url',
    Object.keys(rekey(collided))[0], 'https://media.pixverse.ai/pixverse-preview/mp4/media/default.mp4');

  // If two entries DO map to one key, merge rather than drop.
  const dupes = {
    k1: { url: 'https://media.pixverse.ai/x%2Fy.jpg', starred: true, status: 'pending', accounts: ['a'] },
    k2: { url: 'https://media.pixverse.ai/x/y.jpg', starred: false, status: 'ok', accounts: ['b'] },
  };
  const merged = rekey(dupes);
  check('two spellings collapse to one entry', Object.keys(merged).length, 1);
  const only = Object.values(merged)[0];
  ok('the star is kept', only.starred === true);
  check('verified status wins', only.status, 'ok');
  check('accounts are unioned', only.accounts.sort(), ['a', 'b']);

  ok('the migration is wired', /if \(from < 9\)/.test(SRC));
  ok('basenameOf is gone', !/function basenameOf/.test(SRC));
}

// ---------- 25. Uploaded vs generated ----------
//
// asset_source says it on a live record (0 uploaded, 1 generated), but a
// referenced source frame carries no asset_source at all — there the storage
// prefix is the only signal. Both are derived at read time so archives written
// before origin was recorded still filter correctly.

section('Origin (uploaded vs generated)');
{
  const originOf = (item) => {
    if (item.origin) return item.origin;
    const s = String(item.path || item.url || '');
    if (/(^|\/)upload\//i.test(s)) return 'uploaded';
    if (/(^|\/)pixverse\//i.test(s)) return 'generated';
    return null;
  };

  check('uploaded record', originOf(slimImage(fixture('asset-uploaded-image.json'))), 'uploaded');
  check('generated record', originOf(slimImage(fixture('asset-generated-image.json'))), 'generated');

  // asset_source wins over the prefix when both are present.
  check('asset_source 0 beats the prefix',
    slimImage({ asset_source: 0, url: 'https://media.pixverse.ai/pixverse%2Fi2i%2Fori%2Fx.jpg' }).origin,
    'uploaded');

  // A referenced source frame has no asset_source — prefix only.
  const inputs = inputImagesFrom(fixture('asset-generated-image.json'));
  check('derived input from an upload', inputs[0].origin, 'uploaded');
  const frameInputs = inputImagesFrom(fixture('asset-transition-placeholder.json'));
  ok('derived inputs from i2i output read as generated',
    frameInputs.every((i) => i.origin === 'generated'));

  // Legacy records: no origin field, still classified.
  check('legacy record via path', originOf({ path: 'upload/x.jpg' }), 'uploaded');
  check('legacy record via url',
    originOf({ url: 'https://media.pixverse.ai/pixverse/i2i/ori/y.jpg' }), 'generated');
  check('unclassifiable stays null', originOf({}), null);

  // Composition with the other three axes.
  const all = [
    { kind: 'video', accounts: ['a'], starred: true },
    { kind: 'image', path: 'upload/x.jpg', accounts: ['a'], starred: false },
    { kind: 'image', path: 'pixverse/i2i/ori/y.jpg', accounts: ['a'], starred: true },
    { kind: 'image', path: 'pixverse/i2i/ori/z.jpg', accounts: ['b'], starred: false },
  ];
  const apply = (origin, kind, acct, star) => {
    let l = all;
    if (origin !== 'all') l = l.filter((i) => i.kind === 'image' && originOf(i) === origin);
    if (kind !== 'all') l = l.filter((i) => (i.kind === 'image' ? 'image' : 'video') === kind);
    if (acct !== 'all') l = l.filter((i) => (i.accounts ?? []).includes(acct));
    if (star) l = l.filter((i) => i.starred);
    return l.length;
  };
  check('uploaded only', apply('uploaded', 'all', 'all', false), 1);
  check('generated only', apply('generated', 'all', 'all', false), 2);
  check('an origin filter excludes videos', apply('uploaded', 'all', 'all', false), 1);
  check('generated + account', apply('generated', 'all', 'a', false), 1);
  check('all four axes together', apply('generated', 'image', 'a', true), 1);

  const browse = fs.readFileSync(path.join(ROOT, 'browse.js'), 'utf8');
  ok('origin filter hides itself when only one origin is present',
    /if \(!counts\.uploaded \|\| !counts\.generated\) return/.test(browse));
  ok('origin filter uses an assigned handler', /originsEl\.onchange =/.test(browse));
  ok('origin selection is restored after a rebuild', /originsEl\.value = originFilter/.test(browse));
}

// ---------- 26. Browse sort orders ----------
//
// createdAt (when the generation was made) and firstSeenAt (when this archive
// first saw it) diverge, because a deep sweep discovers years-old generations
// today. That divergence is the whole reason "recently archived" is a distinct
// option rather than a synonym for "newest".

section('Sort orders');
{
  const madeAt = (v) => (v?.createdAt ? Date.parse(v.createdAt) || 0 : 0) || (v?.firstSeenAt ?? 0);
  const foundAt = (v) => v?.firstSeenAt ?? madeAt(v);
  const SORTS = {
    newest: (a, b) => madeAt(b) - madeAt(a),
    oldest: (a, b) => madeAt(a) - madeAt(b),
    found: (a, b) => foundAt(b) - foundAt(a),
    shuffle: (a, b) => (a._shuffle ?? 0) - (b._shuffle ?? 0),
  };

  const items = [
    { n: 'oldGenFoundToday', createdAt: '2026-01-05T00:00:00Z', firstSeenAt: Date.parse('2026-07-23') },
    { n: 'newGen', createdAt: '2026-07-20T00:00:00Z', firstSeenAt: Date.parse('2026-07-20') },
    { n: 'midGen', createdAt: '2026-04-10T00:00:00Z', firstSeenAt: Date.parse('2026-04-10') },
    { n: 'noCreatedAt', firstSeenAt: Date.parse('2026-06-01') },
  ];
  const run = (m) => [...items].sort(SORTS[m]).map((i) => i.n);

  check('newest first', run('newest')[0], 'newGen');
  check('oldest first', run('oldest')[0], 'oldGenFoundToday');
  check('oldest is newest reversed', run('oldest'), [...run('newest')].reverse());

  // The case that makes this option worth having.
  check('recently archived surfaces a just-discovered old generation', run('found')[0], 'oldGenFoundToday');
  ok('recently archived differs from newest',
    JSON.stringify(run('found')) !== JSON.stringify(run('newest')));

  // A record with no createdAt must not sort to an arbitrary end.
  ok('a record without createdAt still places by firstSeenAt',
    run('newest').indexOf('noCreatedAt') > 0 && run('newest').indexOf('noCreatedAt') < 3);

  items.forEach((i) => { i._shuffle = Math.random(); });
  check('shuffle is stable within a session', [...items].sort(SORTS.shuffle).map((i) => i.n),
    [...items].sort(SORTS.shuffle).map((i) => i.n));

  const browse = fs.readFileSync(path.join(ROOT, 'browse.js'), 'utf8');
  ok('sorting happens after filtering', /items = \[\.\.\.list\]\.sort/.test(browse));
  ok('sorting copies rather than mutating the shared list', /\[\.\.\.list\]\.sort/.test(browse));
  ok('an unknown sort falls back to newest', /SORTS\[sortMode\] \?\? SORTS\.newest/.test(browse));
  ok('the sort handler is assigned, not stacked', /sortEl\.onchange =/.test(browse));
}

// ---------- 26. Backup and restore ----------
//
// A restore must never lose what is already there — two archives of the same
// accounts overlap heavily, so import merges rather than replaces.

section('Backup / restore');
{
  const importInto = (map, records) => {
    let added = 0, merged = 0, skipped = 0;
    for (const incoming of Object.values(records)) {
      const key = archiveKeyFor(incoming);
      if (!key) { skipped++; continue; }
      const prev = map[key];
      if (!prev) {
        map[key] = {
          ...incoming,
          accounts: incoming.accounts ?? [],
          starred: Boolean(incoming.starred),
          firstSeenAt: incoming.firstSeenAt ?? Date.now(),
        };
        added++;
        continue;
      }
      map[key] = {
        ...prev, ...incoming,
        url: prev.url || incoming.url || null,
        prompt: prev.prompt || incoming.prompt || '',
        accounts: [...new Set([...(prev.accounts ?? []), ...(incoming.accounts ?? [])])],
        starred: Boolean(prev.starred || incoming.starred),
        status: prev.status === 'ok' || incoming.status === 'ok' ? 'ok' : (prev.status ?? incoming.status),
        firstSeenAt: earliest(prev.firstSeenAt, incoming.firstSeenAt),
      };
      merged++;
    }
    return { added, merged, skipped };
  };

  const U = 'https://media.pixverse.ai/pixverse/i2i/ori/a.jpg';
  const V = 'https://media.pixverse.ai/upload/b.jpg';

  const live = { [U]: { url: U, prompt: 'kept', starred: true, status: 'ok', accounts: ['a'], firstSeenAt: 500 } };
  const backup = {
    x: { url: U, prompt: '', starred: false, status: 'pending', accounts: ['b'], firstSeenAt: 100 },
    y: { url: V, prompt: 'only in backup', starred: false },
  };
  const r = importInto(live, backup);

  check('one added, one merged', [r.added, r.merged], [1, 1]);
  ok('a star in the live archive survives', live[U].starred);
  check('a blank field does not overwrite', live[U].prompt, 'kept');
  check('a verified status is not downgraded', live[U].status, 'ok');
  check('accounts are unioned', live[U].accounts.sort(), ['a', 'b']);
  check('the earliest sighting wins', live[U].firstSeenAt, 100);
  ok('a record only in the backup is added', Boolean(live[V]));

  // Re-importing must not duplicate or corrupt.
  const snapshot = JSON.stringify({ u: live[U], v: live[V] });
  const r2 = importInto(live, backup);
  check('re-import adds nothing', r2.added, 0);
  check('re-import changes nothing meaningful', JSON.stringify({ u: live[U], v: live[V] }), snapshot);

  // The bug this caught: Math.min of two absent values is Infinity, which is
  // truthy, so `|| Date.now()` never fires and the record serialises to null.
  ok('a record with no timestamps gets a real one',
    Number.isFinite(earliest(undefined, undefined)));

  // A backup written before the index changed still restores.
  const fresh = {};
  importInto(fresh, { 'a-legacy-stem': { url: U, prompt: 'legacy' } });
  check('legacy keys are re-derived, not trusted', Object.keys(fresh)[0], U);

  check('a record with neither url nor id is skipped',
    importInto({}, { z: { prompt: 'no url' } }).skipped, 1);

  ok('the vault is never exported', !/VAULT_KEY/.test(SRC.slice(SRC.indexOf('async function exportArchive'), SRC.indexOf('async function importArchive'))));
  ok('import validates the format', /Not a Frame Room archive backup/.test(SRC));
  ok('import refuses a newer format version', /Backup is from a newer version/.test(SRC));
}

// ---------- 27. The picker cannot hang ----------
//
// With a large library the picker sat on "Loading…" indefinitely: two sequential
// library calls with no timeout, whole archive records shipped across the
// message boundary, and a send() that never settles if the MV3 worker is
// terminated mid-request.

section('Picker resilience');
{
  ok('live sources are fetched in parallel',
    /Promise\.all\(\[0, 1\]\.map\(\(assetSource\) => withTimeout\(/.test(SRC));
  ok('live sources are bounded by a timeout', /PICKER_TIMEOUT_MS/.test(SRC));
  ok('a stalled source falls back to an empty list',
    /withTimeout\(promise, ms, fallback\)/.test(SRC));
  ok('the archive is read after the live sources, so it always contributes',
    SRC.indexOf('const map = await readArchive();', SRC.indexOf('async function listPickerAssets'))
      > SRC.indexOf('const sources = await Promise.all'));
  ok('the picker payload is slimmed to url/path/at',
    /out\.push\(\{\s*url:[\s\S]{0,200}?path:[\s\S]{0,120}?at:/.test(SRC));

  // send() must RESOLVE on every path. Rejecting made every `await send(...)`
  // without its own try/catch an unhandled rejection the moment the worker was
  // slow — nine of eleven call sites in the panel. The worker is legitimately
  // slow sometimes: a deep sweep over thousands of records takes a while.
  for (const f of ['sidepanel.js', 'browse.js']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    ok(`${f}: send() has a timeout`, /SEND_TIMEOUT_MS/.test(src));
    ok(`${f}: send() reports a timeout`, /did not respond/.test(src));

    const fn = src.slice(src.indexOf('function send(msg)'), src.indexOf('function send(msg)') + 900);
    ok(`${f}: send() never rejects`, !/reject/.test(fn));
    ok(`${f}: a timeout resolves with ok:false`, /resolve\(\{ ok: false, timedOut: true/.test(fn));
    ok(`${f}: a transport error resolves too`, /\(err\) => \{ clearTimeout\(timer\); resolve\(\{ ok: false/.test(fn));
    ok(`${f}: the timer is cleared on reply`, /clearTimeout\(timer\); resolve\(res\)/.test(fn));
  }

  // send() no longer rejects, so there is nothing to catch — what matters is
  // that the failure object reaches the same branch as any other failure.
  const panel = fs.readFileSync(path.join(ROOT, 'sidepanel.js'), 'utf8');
  ok('the picker handles a failed send', /if \(!res\?\.ok\) \{[\s\S]{0,200}?Paste a path below/.test(panel));

  // The fallback must be reachable on BOTH failure modes — a rejection and a
  // stall — or a dead source still blocks. Checked structurally; the runtime
  // behaviour is Promise.race semantics and not this suite's business.
  const fn = SRC.slice(SRC.indexOf('function withTimeout'), SRC.indexOf('async function listPickerAssets'));
  ok('a rejecting source falls back', /promise\.catch\(\(\) => fallback\)/.test(fn));
  ok('a stalled source falls back', /setTimeout\(\(\) => resolve\(fallback\), ms\)/.test(fn));
}

// ---------- 28. Gallery view and header ----------
//
// Grids must not introduce video elements — the reel's one-video-alive rule is
// what keeps a thousand-item feed from exhausting decoders.

section('Gallery view');
{
  const browse = fs.readFileSync(path.join(ROOT, 'browse.js'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'browse.css'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'browse.html'), 'utf8');

  // Reel and grid share one chunked path; the builder is chosen per chunk.
  // This replaced `if (viewMode !== 'reel') return renderGrid();`, a line that
  // survived the refactor while the function it called did not. It parsed
  // cleanly and would have thrown the moment a grid was opened — the tests
  // asserted the CALL existed rather than that the grid rendered, so they were
  // green on code that could not run.
  ok('one render path chooses a builder per chunk',
    /viewMode === 'reel' \? buildReelCard\(items\[i\], i\) : buildGridTile\(items\[i\], i\)/.test(browse));
  ok('no renderGrid remains to call', !/renderGrid/.test(browse));
  ok('the reel observer is not built for a grid',
    /observer = viewMode === 'reel' \? makeCardObserver\(\) : null/.test(browse));

  // The invariant that matters.
  const grid = browse.slice(browse.indexOf('function buildGridTile'), browse.indexOf('function buildBadge'));
  ok('grid tiles create no video element', !/createElement\('video'\)/.test(grid));
  ok('grid tiles attach no observer', !/observeCards\(\)/.test(grid));
  ok('grid tiles are lazy', /loading = 'lazy'/.test(grid));
  // This test previously asserted the opposite — that a grid tile carried the
  // reel's .card class, which is how it shipped inheriting
  // `height: calc(100vh - var(--bar-h))` and rendering one tile per viewport.
  // The requirement is that cleanup finds the tile, not that it borrows a class.
  ok('grid tiles do NOT borrow the reel card class', !/'gtile card'/.test(grid));
  ok('teardown removes grid tiles as well as reel cards',
    /querySelectorAll\('\.card, \.gtile'\)/.test(browse));
  ok('chunks collect their own nodes', /cards\.push\(\.\.\.fresh\)/.test(browse));

  // Chunked rendering. Both paths used to build a node per record across the
  // whole filtered list — four thousand nodes, rebuilt on every filter change,
  // which is what made browsing slow and what would have made a search box
  // unusable, since each keystroke is a filter change.
  ok('a chunk size is defined', /RENDER_CHUNK = \d+/.test(browse));
  ok('a chunk renders a bounded slice',
    /Math\.min\(renderedCount \+ RENDER_CHUNK, items\.length\)/.test(browse));
  // The sentinel must stay last in the feed or it never intersects again and
  // scrolling silently stops loading.
  ok('new nodes go in before the sentinel', /insertBefore\(frag, sentinel\)/.test(browse));
  ok('the sentinel is removed once everything is rendered',
    /renderedCount >= items\.length[\s\S]{0,160}sentinel = null/.test(browse));

  // The reel is index-addressed, so anything jumping to an index has to build
  // up to it first. Without this the reel stops at the end of chunk one.
  // Same brace-matching as extractFn, against browse.js rather than
  // background.js — including the skip past a parameter list, so a destructured
  // parameter cannot be mistaken for the function body.
  const extractBrowseFn = (name) => {
    const start = browse.search(new RegExp(`^(?:async\\s+)?function\\s+${name}\\s*\\(`, 'm'));
    if (start < 0) throw new Error(`not found in browse.js: ${name}`);
    let p = browse.indexOf('(', start);
    for (let parens = 0; p < browse.length; p++) {
      if (browse[p] === '(') parens++;
      else if (browse[p] === ')' && --parens === 0) break;
    }
    let depth = 0;
    let seen = false;
    for (let i = browse.indexOf('{', p); i < browse.length; i++) {
      if (browse[i] === '{') { depth++; seen = true; }
      else if (browse[i] === '}' && seen && --depth === 0) return browse.slice(start, i + 1);
    }
    throw new Error(`unterminated: ${name}`);
  };

  const scrollFn = extractBrowseFn('scrollToCard');
  ok('scrollToCard builds up to the index first', /ensureRendered\(clamped\)/.test(scrollFn));
  ok('a grid tile opening the reel builds up to its index',
    /ensureRendered\(i\)[\s\S]{0,40}scrollToCard\(i\)/.test(browse));
  ok('ensureRendered cannot spin forever', /guard\+\+ < 1000/.test(browse));

  // Filter changes tear down; the chunk cursor and sentinel must reset with it,
  // or the next render appends after a stale sentinel and shows nothing.
  const td = extractBrowseFn('teardown');
  ok('teardown resets the chunk cursor', /renderedCount = 0/.test(td));
  ok('teardown drops the sentinel and its observer',
    /sentinelObserver = null/.test(td) && /sentinel = null/.test(td));

  // Search and the new filters.
  ok('a search input exists', /id="search"/.test(html));
  ok('search filters on prompt text',
    /\(i\.prompt \|\| ''\)\.toLowerCase\(\)\.includes\(searchTerm\)/.test(browse));
  ok('search is debounced', /searchTimer/.test(browse));
  ok('search counts towards the filter badge', /Boolean\(searchTerm\)/.test(browse));
  ok('clear all resets the search box', /searchEl\.value = ''/.test(browse));
  ok('a model filter exists', /id="models"/.test(html) && /modelFilter/.test(browse));
  ok('a period filter exists', /id="period"/.test(html) && /periodDays/.test(browse));
  ok('the period filter dates by madeAt, not discovery',
    /madeAt\(i\) >= cutoff/.test(browse));

  // Back. Opening a tile used to be a one-way door: the only exit was the view
  // dropdown, which resets scrollTop to 0, so every look at a single item cost
  // you your place in a four thousand tile grid.
  ok('a back control exists', /id="back"/.test(html));
  ok('opening a tile records where it came from',
    /returnTo = \{ mode: viewMode, url: item\.url \}/.test(browse));
  // By URL, not index: an index is a position in the current filtered list, so
  // a stored one silently points at a different record once the list changes.
  ok('the return point is stored by identity, not position',
    /items\.findIndex\(\(i\) => i\.url === url\)/.test(browse));
  ok('Escape goes back', /e\.key === 'Escape'[\s\S]{0,60}goBack\(\)/.test(browse));
  ok('returning is instant, not a smooth scroll through thousands of tiles',
    /scrollToCard\(idx, 'auto'\)/.test(browse));
  ok('scrollToCard takes a behaviour', /function scrollToCard\(index, behavior = 'smooth'\)/.test(browse));
  // A stale back button is worse than none: it would take you somewhere that no
  // longer means anything.
  const gb = extractBrowseFn('goBack');
  ok('the return point is consumed on use', /returnTo = null/.test(gb));
  ok('changing view by hand clears it',
    /getElementById\('view'\)\.addEventListener\('change'[\s\S]{0,320}returnTo = null/.test(browse));
  ok('changing filters clears it',
    /paintFilterCount\(\);[\s\S]{0,120}returnTo = null/.test(browse));
  ok('the button hides when there is nowhere to go',
    /classList\.toggle\('is-hidden', !returnTo\)/.test(browse));
  ok('clicking a tile returns to the reel', /viewMode = 'reel';/.test(grid));
  ok('starring a tile does not open it', /e\.target\.closest\('\.star'\)/.test(grid));

  // Hover preview. One video may exist — the tile under the pointer — which is
  // the same one-alive rule the reel enforces, driven by the pointer.
  const hover = browse.slice(browse.indexOf('function stopHoverPreview'), browse.indexOf('// ---------- chunked rendering'));
  ok('a settle delay guards against scrubbing', /HOVER_DELAY_MS/.test(browse));
  ok('a staleness token guards a late fetch', /token !== hoverToken/.test(hover));
  ok('entering a tile stops the previous preview first',
    /mouseenter[\s\S]{0,120}stopHoverPreview\(\)/.test(browse));
  ok('leaving a tile stops the preview', /'mouseleave', stopHoverPreview/.test(browse));
  ok('stopping frees the decoder', /video\.load\(\); \/\/ what actually frees the decoder/.test(hover));
  ok('stopping revokes the blob', /URL\.revokeObjectURL\(tile\.dataset\.blob\)/.test(hover));
  ok('a discarded fetch revokes its blob too',
    /if \(objUrl\) URL\.revokeObjectURL\(objUrl\)/.test(hover));
  ok('teardown kills a live preview', /stopHoverPreview\(\); \/\/ a grid preview outlives/.test(browse));
  ok('images are never wired for hover', /item\.kind === 'image' \|\| !item\.url/.test(browse));

  // A CSS-only disable is worse than none: the fetch still runs and the result
  // is thrown away. Any size restriction has to stop the fetch, not hide it.
  ok('no grid size hides the preview instead of skipping it',
    !/\.gtile-video \{ display: none/.test(css));
  ok('the spinner keyframe is defined in this document', /@keyframes fr-spin/.test(css));

  // Class-name drift between JS and CSS: the size class was built one way and
  // compared another, so no size class was ever applied and the grid collapsed
  // to a single column. Assert every class the JS can emit is styled.
  const emitted = ['sm', 'md', 'lg'].map((m) => `is-${m}`);
  for (const cls of emitted) {
    ok(`css defines .${cls}, which the js emits`, new RegExp(`\\.feed\\.is-grid\\.${cls}\\s*\\{`).test(css));
  }
  ok('the size class is derived from the mode, not compared to a class list',
    /feed\.classList\.toggle\(`is-\$\{m\}`, viewMode === m\)/.test(browse));
  ok('the grid has default columns if no size class lands',
    /\.feed\.is-grid \{[\s\S]{0,400}?grid-template-columns/.test(css));

  ok('three grid sizes exist',
    /\.is-sm \{/.test(css) && /\.is-md \{/.test(css) && /\.is-lg \{/.test(css));
  ok('grid disables scroll snapping', /scroll-snap-type: none/.test(css));
  // The actual cause of the one-tile-per-screen bug: an explicit height beats
  // aspect-ratio, so the tile must not pick one up from anywhere.
  // aspect-ratio is inert on a stretched grid item — the row sizes it instead,
  // and a lazy <img> with no intrinsic size yet collapses the tile to nothing.
  // Extract the rule bodies rather than guessing a character distance — comments
  // inside a rule push the property past any fixed window.
  // Comments stripped: these rules explain themselves at length, and a property
  // name mentioned in prose otherwise reads as a declaration.
  const ruleBody = (sel) => {
    const at = css.indexOf(`${sel} {`);
    if (at < 0) return '';
    return css.slice(at, css.indexOf('\n}', at)).replace(/\/\*[\s\S]*?\*\//g, '');
  };
  ok('an unloaded image contributes no layout',
    /position: absolute/.test(ruleBody('.gtile img')));

  // Tile height is STATED, not derived. aspect-ratio cannot size a grid item
  // whose width comes from a 1fr track and whose children are all absolutely
  // positioned — the auto row is computed from intrinsic content, which is
  // zero, and the tile collapses. Three fixes tried to make aspect-ratio work
  // before this. Every size class must therefore carry a row height.
  for (const size of ['is-sm', 'is-md', 'is-lg']) {
    ok(`.${size} states a row height`,
      /grid-auto-rows:\s*\d+px/.test(ruleBody(`.feed.is-grid.${size}`)));
  }
  ok('the default grid states a row height too',
    /grid-auto-rows:\s*\d+px/.test(css.slice(css.indexOf('.feed.is-grid { grid-auto-rows'))));
  ok('the tile fills its row', /height: 100%/.test(ruleBody('.gtile')));
  ok('the tile no longer relies on aspect-ratio', !/aspect-ratio/.test(ruleBody('.gtile')));

  ok('keyboard nav is reel-only', /if \(viewMode !== 'reel'\) return;/.test(browse));

  // Header: filters and backup actions collapsed behind two buttons.
  ok('filters live in a popover', /id="filters-menu"/.test(html));
  ok('backup actions live in a popover', /id="more-menu"/.test(html));
  ok('the filter count is surfaced', /id="filters-count"/.test(html) && /function paintFilterCount/.test(browse));
  ok('a clear-all exists', /id="filters-clear"/.test(html));
  ok('opening one popover closes the others', /for \(const m of document\.querySelectorAll\('\.pop-menu'\)\)/.test(browse));

  // Active-filter count drives the badge.
  const countActive = (starred, kind, origin, account) =>
    [starred, kind !== 'all', origin !== 'all', account !== 'all'].filter(Boolean).length;
  check('no filters active', countActive(false, 'all', 'all', 'all'), 0);
  check('two filters active', countActive(true, 'image', 'all', 'all'), 2);
  check('all four active', countActive(true, 'image', 'uploaded', 'acct'), 4);
}

// ---------- 29. Local file scanner ----------
//
// Downloads preserve the storage path in one of two ways, and sometimes not at
// all. Real filenames, all four shapes.

section('Local file scanner');
{
  const { candidatePaths, seedFrom, canonicalUrl: toolCanonical, urlFor } =
    require(path.join(ROOT, 'tools', 'scan-local.js'));

  check('full video path, underscore-encoded',
    candidatePaths('pixverse_mp4_media_web_ori_6a83dc0a-661d-4558-abc1-fc59995af118_seed154109893.mp4'),
    ['pixverse/mp4/media/web/ori/6a83dc0a-661d-4558-abc1-fc59995af118_seed154109893.mp4']);

  check('full i2i path, underscore-encoded',
    candidatePaths('pixverse_i2i_ori_93447bc6-3055-4c7d-8ef3-34a6d3607a38.jpg'),
    ['pixverse/i2i/ori/93447bc6-3055-4c7d-8ef3-34a6d3607a38.jpg']);

  check('basename-only video resolves to the one place videos live',
    candidatePaths('9315fb4e-e692-45ca-bc08-7cb7f0b1661f_seed1565430209.mp4'),
    ['pixverse/mp4/media/web/ori/9315fb4e-e692-45ca-bc08-7cb7f0b1661f_seed1565430209.mp4']);

  // Looks ambiguous, isn't: you don't download a file you uploaded, so anything
  // in a downloads folder is output. An earlier version probed the CDN to tell
  // upload/ from pixverse/i2i/ori/ — machinery for a case that doesn't arise.
  check('a bare image name resolves to the i2i output path',
    candidatePaths('24dea804-a9a9-49a1-b9e7-e86da2d318d9.jpg'),
    ['pixverse/i2i/ori/24dea804-a9a9-49a1-b9e7-e86da2d318d9.jpg']);
  // Real asset names — the placeholders this used to check ('a.jpg') are now
  // correctly rejected, since they carry no UUID.
  const U1 = '24dea804-a9a9-49a1-b9e7-e86da2d318d9';
  ok('every recognised filename yields exactly one path',
    [`${U1}.jpg`, `${U1}_seed12.mp4`, `pixverse_i2i_ori_${U1}.jpg`,
     `pixverse_mp4_media_web_ori_${U1}_seed12.mp4`, `upload_${U1}.png`]
      .every((n) => candidatePaths(n).length === 1));

  // Only what PixVerse actually produces. A downloaded .webp is by definition
  // not an asset — the webp URL never exists as a file.
  const U2 = '24dea804-a9a9-49a1-b9e7-e86da2d318d9';
  for (const ext of ['.jpg', '.jpeg', '.png']) {
    check(`${ext} is accepted`, candidatePaths(`${U2}${ext}`).length, 1);
  }
  check('.mp4 is accepted', candidatePaths(`${U2}_seed12.mp4`).length, 1);
  for (const ext of ['.webp', '.webm', '.mov', '.gif']) {
    check(`${ext} is not an asset format`, candidatePaths(`${U2}${ext}`), []);
  }

  check('non-media is ignored', candidatePaths('notes.txt'), []);
  check('Thumbs.db is ignored', candidatePaths('Thumbs.db'), []);

  // The folder holds thousands of files from everywhere. Without a strict stem
  // check, every holiday photo becomes a record pointing at a URL that does not
  // exist — PixVerse names every asset with a UUID, so require one.
  for (const junk of ['vacation-photo.jpg', 'IMG_20240712_103245.jpg',
    'Screenshot 2026-01-02.png', 'meme.mp4', 'logo.png',
    '24dea804-a9a9-49a1.jpg']) {
    check(`rejected: ${junk}`, candidatePaths(junk), []);
  }

  // Windows appends " (1)" on a colliding download. Thousands of files means
  // duplicates, and without stripping it every one fails the stem check.
  check('a Windows duplicate resolves to the original asset',
    candidatePaths('9315fb4e-e692-45ca-bc08-7cb7f0b1661f_seed1565430209 (1).mp4'),
    ['pixverse/mp4/media/web/ori/9315fb4e-e692-45ca-bc08-7cb7f0b1661f_seed1565430209.mp4']);
  check('a duplicate keys the same as the original',
    candidatePaths('24dea804-a9a9-49a1-b9e7-e86da2d318d9 (3).jpg')[0],
    candidatePaths('24dea804-a9a9-49a1-b9e7-e86da2d318d9.jpg')[0]);

  const tool0 = fs.readFileSync(path.join(ROOT, 'tools', 'scan-local.js'), 'utf8');
  ok('subfolders are skipped unless asked for', /recurse = false/.test(tool0));

  // A UUID filename is not a PixVerse signature — other services name files the
  // same way. Without checking the CDN, someone else's generation becomes a
  // record pointing at a URL that will never resolve.
  ok('the CDN is checked before a record is written', /async function exists\(url\)/.test(tool0));
  ok('verification is on by default', /const verify = !flags\.includes\('--no-verify'\)/.test(tool0));
  ok('a non-OK HEAD is confirmed with a ranged GET', /Range: 'bytes=0-0'/.test(tool0));
  ok('checks run with bounded concurrency', /VERIFY_CONCURRENCY/.test(tool0));
  ok('skipping verification marks the records', /unverified: true/.test(tool0));

  // Import merges and cannot remove, so a bad record from an earlier run stays
  // until it is taken out of the export itself.
  ok('prune re-checks only records this tool wrote', /\.filter\(\(\[, r\]\) => r\.localFile\)/.test(tool0));
  ok('prune deletes what no longer resolves', /delete records\[key\]/.test(tool0));
  ok('prune explains that a purge is required', /import MERGES and cannot remove/.test(tool0));
  ok('media that is not an asset is reported separately',
    /not PixVerse/.test(tool0));

  check('seed is recovered', seedFrom('x_seed1565430209.mp4'), 1565430209);
  check('no seed is null', seedFrom('plain.jpg'), null);

  // A basename-only download must collide with the same asset already archived
  // under its full path — otherwise every re-scan duplicates the library.
  const fromBasename = urlFor(candidatePaths('9315fb4e-e692-45ca-bc08-7cb7f0b1661f_seed1565430209.mp4')[0]);
  const alreadyStored = 'https://media.pixverse.ai/pixverse/mp4/media/web/ori/9315fb4e-e692-45ca-bc08-7cb7f0b1661f_seed1565430209.mp4';
  check('a rescanned file matches its existing record',
    toolCanonical(fromBasename), toolCanonical(alreadyStored));

  // The tool's key must agree with the extension's, or imports fork records.
  check('tool and extension agree on the archive key',
    toolCanonical(alreadyStored), archiveKeyFor({ url: alreadyStored }));

  // This once asserted the opposite — that the tool needed no network. That held
  // only while the sole question was upload/ vs i2i/. Once it became "is this
  // file even PixVerse's", the filename stopped being able to answer and the
  // CDN became the only source of truth.
  const tool = fs.readFileSync(path.join(ROOT, 'tools', 'scan-local.js'), 'utf8');
  ok('the tool checks the CDN', /await fetch\(url/.test(tool));
}

// ---------- 30. Thumbnails ----------
//
// The media host is Aliyun OSS and resizes on request via x-oss-process. Grids
// and the picker show hundreds of images at thumbnail size; fetching originals
// to do that is megabytes each for no visible gain.

section('Thumbnails');
{
  const browse = fs.readFileSync(path.join(ROOT, 'browse.js'), 'utf8');
  const panel = fs.readFileSync(path.join(ROOT, 'sidepanel.js'), 'utf8');

  // Mirrors the shipped helper.
  const STYLES = { sm: 'style/cover-webp-small', md: 'style/cover-webp', lg: 'style/cover-webp' };
  const thumbUrl = (url, style = STYLES.sm) => {
    if (!url || /\.mp4(?:$|[?#])/i.test(url)) return url;
    if (url.includes('x-oss-process')) return url;
    return `${url}${url.includes('?') ? '&' : '?'}x-oss-process=${style}`;
  };

  check('the real URL from the wild is reproduced',
    thumbUrl('https://media.pixverse.ai/upload%2F01547ef4-d059-4776-9a89-b108ba1cb9e8.png'),
    'https://media.pixverse.ai/upload%2F01547ef4-d059-4776-9a89-b108ba1cb9e8.png?x-oss-process=style/cover-webp-small');

  ok('i2i outputs are thumbed too',
    thumbUrl('https://media.pixverse.ai/pixverse/i2i/ori/a.jpg').includes('x-oss-process'));
  check('an mp4 is left alone — an image processor has nothing to do with video',
    thumbUrl('https://media.pixverse.ai/pixverse/mp4/media/web/ori/x_seed1.mp4'),
    'https://media.pixverse.ai/pixverse/mp4/media/web/ori/x_seed1.mp4');
  ok('applying it twice adds one parameter',
    (thumbUrl(thumbUrl('https://media.pixverse.ai/upload/a.png')).match(/x-oss-process/g) || []).length === 1);

  // The critical invariant: a thumbnail is a query string, and canonicalUrl
  // strips those — so displaying one cannot fork an archive record.
  const full = 'https://media.pixverse.ai/pixverse/i2i/ori/a.jpg';
  check('a thumbnail keys the same as its original',
    archiveKeyFor({ url: thumbUrl(full) }), archiveKeyFor({ url: full }));

  // The larger grids need the larger style — `-small` is soft at 300px+.
  const frame = 'https://media.pixverse.ai/pixverse%2Fvideo%2Fframe%2F5dd85ef4-b944-49a3-a466-bf3e7b174cbb.jpg';
  check('the large-thumbnail URL from the wild is reproduced',
    thumbUrl(frame, STYLES.md), `${frame}?x-oss-process=style/cover-webp`);
  check('small grid asks for the small style', thumbUrl(frame, STYLES.sm).split('x-oss-process=')[1], 'style/cover-webp-small');
  for (const size of ['md', 'lg']) {
    check(`${size} grid asks for the larger style`, thumbUrl(frame, STYLES[size]).split('x-oss-process=')[1], 'style/cover-webp');
  }

  ok('grid tiles request a thumbnail sized for the current grid',
    /img\.src = thumbUrl\(poster, THUMB_STYLES\[viewMode\] \?\? THUMB_STYLES\.md\)/.test(browse));
  ok('every grid mode has a style', /sm:[\s\S]{0,80}md:[\s\S]{0,80}lg:/.test(browse));
  ok('the picker requests thumbnails', /img\.src = thumbUrl\(src\)/.test(panel));
  ok('the picker still hands over the full image', /useFrame\(path, src\)/.test(panel));
  ok('both fall back to the original once if the processor refuses',
    /img\.dataset\.full/.test(browse) && /img\.dataset\.full/.test(panel));

  // The reel is where you actually look at something — it must not be thumbed.
  const reel = browse.slice(browse.indexOf('function render() {'));
  ok('the reel does not use thumbnails', !/thumbUrl/.test(reel));

  // Videos with no stored poster get a frame grabbed from the file itself.
  // Records imported from local files have none — a filename says nothing about
  // a still frame — and neither do videos whose own poster never resolved.
  const W = { sm: 220, md: 400, lg: 600 };
  const videoPoster = (url, w = W.md) => {
    if (!url || !/\.mp4(?:$|[?#])/i.test(url)) return null;
    if (url.includes('x-oss-process')) return url;
    return `${url}?x-oss-process=video/snapshot,t_1000,f_jpg,w_${w},h_0,m_fast`;
  };
  const vid = 'https://media.pixverse.ai/pixverse/mp4/media/web/ori/a_seed1.mp4';

  ok('a snapshot is requested at a bounded width',
    videoPoster(vid).includes('w_400'));
  check('an image gets no snapshot', videoPoster('https://media.pixverse.ai/upload/a.jpg'), null);
  ok('the snapshot keeps the aspect ratio', videoPoster(vid).includes('h_0'));
  ok('applying it twice adds one parameter',
    (videoPoster(videoPoster(vid)).match(/x-oss-process/g) || []).length === 1);
  for (const size of ['sm', 'md', 'lg']) {
    ok(`${size} asks for its own width`, videoPoster(vid, W[size]).includes(`w_${W[size]}`));
  }

  // The two transforms must compose: a snapshot already carries x-oss-process,
  // so thumbUrl must leave it alone rather than appending a second one.
  check('thumbUrl leaves a snapshot untouched', thumbUrl(videoPoster(vid)), videoPoster(vid));

  // Same invariant as thumbnails: a query string cannot fork a record.
  check('a snapshot keys the same as the video',
    archiveKeyFor({ url: videoPoster(vid) }), archiveKeyFor({ url: vid }));

  ok('the grid falls back to a snapshot for posterless videos',
    /item\.kind !== 'image' \? videoPoster\(item\.url/.test(browse));
}

// ---------- 31. Picker paging ----------
//
// The whole library is fetched once — it is mostly the local archive, so a
// second round trip buys nothing — but rendering several thousand <img>
// elements at once does not end well.

section('Picker paging');
{
  const panel = fs.readFileSync(path.join(ROOT, 'sidepanel.js'), 'utf8');

  ok('a page size is defined', /const PICKER_PAGE = \d+/.test(panel));
  ok('items are resolved once, up front', /pickerItems\.push\(\{ src, path \}\)/.test(panel));
  ok('paging appends rather than re-rendering', /\$\('tiles'\)\.append\(frag\)/.test(panel));
  ok('the button is wired', /\$\('tiles-more'\)\.addEventListener\('click', showMoreTiles\)/.test(panel));
  ok('opening the picker resets the page', /pickerShown = 0;/.test(panel));

  // Paging arithmetic: every item is reachable, no page overruns, the button
  // disappears exactly at the end.
  const PAGE = 60;
  const pageThrough = (total) => {
    let shown = 0;
    const added = [];
    while (shown < total) {
      const upto = Math.min(shown + PAGE, total);
      added.push(upto - shown);
      shown = upto;
    }
    return { shown, added, hiddenAtEnd: total - shown === 0 };
  };

  for (const total of [0, 1, 60, 61, 150, 3778]) {
    const r = pageThrough(total);
    check(`${total} items are all reachable`, r.shown, total);
    ok(`${total} items: no page exceeds the page size`, r.added.every((n) => n <= PAGE));
    ok(`${total} items: the button ends hidden`, r.hiddenAtEnd);
  }

  check('3778 items page in 63 steps', pageThrough(3778).added.length, 63);
}

// ---------- 32. i2i → frames handoff ----------
//
// The workflow is: generate an i2i, then make a video that transitions from the
// original into the result. That record already holds both ends — its input and
// its output — so picking them by hand is re-supplying what is already known.

section('i2i to frames handoff');
{
  const panel = fs.readFileSync(path.join(ROOT, 'sidepanel.js'), 'utf8');
  const browse = fs.readFileSync(path.join(ROOT, 'browse.js'), 'utf8');

  ok('the panel offers it on completed image tiles',
    /!isVideo && sourcePath && url/.test(panel));
  ok('the source becomes the first frame',
    /useFrame\(sourcePath, mediaUrlFromPath\(sourcePath\), \{ slot: 'first'/.test(panel));
  ok('the result becomes the last frame',
    /useFrame\(outPath, url, \{ slot: 'last'/.test(panel));
  ok('it switches to frames mode first', /setMode\('frames'\);[\s\S]{0,120}slot: 'first'/.test(panel));
  ok('the loaded form is parked for that tab', /state\.forms\.frames = captureForm\(\)/.test(panel));

  ok('browse offers it on image records', /item\.kind === 'image' && item\.rerun\?\.firstPath/.test(browse));
  ok('browse stashes a frames composition', /mode: 'frames',/.test(browse));
  ok('a degenerate transition is not offered', /outPath !== item\.rerun\.firstPath/.test(browse));

  // browse.js has no MEDIA constant; inventing one would be a second source of
  // truth for something background.js owns.
  ok('the path helper matches the host rather than assuming it',
    /match\(\/\^https\?:\\\/\\\/\[\^\/\]\+/.test(browse));

  const pathFromMediaUrl = (u) => {
    const m = decodeMediaUrl(String(u ?? '')).match(/^https?:\/\/[^/]+\/(.+)$/i);
    return m ? m[1].split(/[?#]/)[0] || null : null;
  };
  check('an encoded url yields its storage path',
    pathFromMediaUrl('https://media.pixverse.ai/pixverse%2Fi2i%2Fori%2Fabc.jpg'),
    'pixverse/i2i/ori/abc.jpg');
  check('a thumbnail query is stripped',
    pathFromMediaUrl('https://media.pixverse.ai/upload/x.png?x-oss-process=style/cover-webp'),
    'upload/x.png');
  check('a non-url yields nothing', pathFromMediaUrl('not-a-url'), null);
}

// ---------- 33. Reel limit ----------
//
// REEL_LIMIT caps the reel, not the finished half of it. Placeholders used to be
// prepended on top of a full six, so anything in flight made it seven.

section('Reel limit');
{
  const panel = fs.readFileSync(path.join(ROOT, 'sidepanel.js'), 'utf8');
  ok('in-flight tiles are capped too', /pending\.slice\(0, REEL_LIMIT\)/.test(panel));
  ok('finished tiles take what is left',
    /all\.slice\(0, Math\.max\(0, REEL_LIMIT - shownPending\.length\)\)/.test(panel));
  ok('the rendered list is the capped one', /for \(const job of shownPending\)/.test(panel));
  ok('the count reflects both kinds', /const total = all\.length \+ pending\.length/.test(panel));

  const LIMIT = 6;
  const reel = (doneN, pendingN) => {
    const sp = Math.min(pendingN, LIMIT);
    const sd = Math.min(doneN, Math.max(0, LIMIT - sp));
    return sd + sp;
  };

  for (const [done, pending] of [[143, 0], [143, 1], [143, 2], [143, 6], [143, 9], [3, 1], [0, 1], [0, 0], [5, 0]]) {
    ok(`${done} done + ${pending} pending never exceeds ${LIMIT}`, reel(done, pending) <= LIMIT);
  }
  check('a full reel with one in flight is still 6', reel(143, 1), 6);
  check('in-flight work displaces a finished tile', reel(143, 2), 6);
  check('a short reel is not padded', reel(3, 1), 4);
}

// ---------- 34. A job never discards what it saw ----------
//
// Archiving used to happen only after a job completed, so a job that timed out
// threw away rows the poller had already read — the URL was in hand and lost.
// Readiness decides when a job is done, never whether a record is kept.

section('Capture on sight');
{
  ok('the poller hands rows over before judging readiness',
    /if \(fresh\.length\) await onSeen\?\.\(fresh\)/.test(SRC));
  ok('the hand-over happens before the expected-count check',
    SRC.indexOf('await onSeen?.(fresh)') < SRC.indexOf('if (fresh.length < expected) continue;'));
  ok('the job wires its capture into the poller', /auth, captureRows\)/.test(SRC));
  // Was a grep for a comment phrase, which broke the moment the archiving was
  // extracted into archiveAssetRows — a rename failing a test that had nothing
  // to do with renames. Assert the actual invariant instead: the archiver
  // swallows its own errors and never rethrows, so a failed archive write
  // cannot fail a real generation.
  {
    const fn = extractFn('archiveAssetRows');
    ok('the archiver catches its own errors', /catch\s*\(/.test(fn));
    ok('and never rethrows', !/\bthrow\b/.test(fn));
    ok('the job archives through it', /await archiveAssetRows\(rows, tab\)/.test(SRC));
    ok('and so does the resume path', /archiveAssetRows\(rows, tab\)[\s\S]{0,40}\}/.test(SRC));
  }

  // The declaration must precede its use: a const referenced earlier in the
  // same block is a temporal dead zone error, and this one would have thrown on
  // every single generation.
  const runBody = SRC.slice(SRC.indexOf('async function run({ record, job })'));
  ok('captureRows is declared before it is passed',
    runBody.indexOf('const captureRows') < runBody.indexOf('auth, captureRows)'));

  // A probe that fails on a file that exists must not destroy the generation.
  ok('a timeout reports rows that had usable URLs',
    /if \(seenWithUrls\.length >= expected\) \{[\s\S]{0,200}?return seenWithUrls;/.test(SRC));
  ok('a genuine no-show still throws', /throw new Error\('TIMED_OUT'\);/.test(SRC));

  // Behaviour, exercised.
  const simulate = ({ rowsAppear, probeWorks, expected = 1 }) => {
    const archived = [];
    let seenWithUrls = [];
    for (let tick = 0; tick < 5; tick++) {
      const fresh = tick >= rowsAppear ? [{ id: 'new1', url: 'https://media/x.jpg' }] : [];
      for (const r of fresh) if (!archived.includes(r.id)) archived.push(r.id);
      const withUrls = fresh.filter((r) => r.url);
      if (withUrls.length >= seenWithUrls.length) seenWithUrls = withUrls;
      if (fresh.length < expected) continue;
      if (probeWorks && withUrls.length >= expected) return { result: 'done', archived };
    }
    if (seenWithUrls.length >= expected) return { result: 'unverified', archived };
    return { result: 'failed', archived };
  };

  check('a working probe completes the job', simulate({ rowsAppear: 1, probeWorks: true }).result, 'done');
  check('a false-negative probe still archives',
    simulate({ rowsAppear: 1, probeWorks: false }).archived.length, 1);
  check('a false-negative probe does not report failure',
    simulate({ rowsAppear: 1, probeWorks: false }).result, 'unverified');
  check('a generation that never appears still fails',
    simulate({ rowsAppear: 99, probeWorks: false }).result, 'failed');
  check('nothing is archived when nothing appeared',
    simulate({ rowsAppear: 99, probeWorks: false }).archived.length, 0);
}

// ---------- 35. OPEN on a rendering tile ----------
//
// The poller sees an asset row, URL included, well before it declares the job
// done. That URL used to stop at the worker. When the readiness probe gets it
// wrong, the link is the only route to a render that actually finished.

section('Open while rendering');
{
  const panel = fs.readFileSync(path.join(ROOT, 'sidepanel.js'), 'utf8');

  ok('the worker records URLs on the job as they are seen', /record\.seenUrls = merged/.test(SRC));
  ok('recording a URL broadcasts an update',
    /record\.seenUrls = merged;[\s\S]{0,120}?await saveJob\(record\)/.test(SRC));
  ok('an unchanged set does not re-save',
    /if \(merged\.length !== \(record\.seenUrls \?\? \[\]\)\.length\)/.test(SRC));
  ok('URL capture cannot break the job', /seen-url capture failed/.test(SRC));

  ok('the tile offers open once a URL exists', /const url = job\.seenUrls\?\.\[0\]/.test(panel));
  ok('the action bar appears for a URL alone', /job\.params \|\| job\.seenUrls\?\.length/.test(panel));
  ok('live updates add it when it arrives', /if \(bar\) addPendingOpen\(bar, job\)/.test(panel));
  ok('the link says the file is not yet confirmed', /not yet confirmed by the readiness check/.test(panel));

  // Behaviour: appears exactly once, only after a URL is known.
  const addOpen = (bar, job) => {
    const url = job.seenUrls?.[0];
    if (!url || bar.includes('open')) return bar;
    return ['open', ...bar];
  };
  check('nothing at submit', addOpen([], { params: {} }), []);
  check('added when a URL arrives', addOpen([], { seenUrls: ['u'] }), ['open']);
  check('not added twice', addOpen(addOpen([], { seenUrls: ['u'] }), { seenUrls: ['u'] }), ['open']);
}

// ---------- 36. The existence probe ----------
//
// The probe confirmed a non-OK HEAD with a one-byte ranged GET. `Range` is not a
// CORS-safelisted request header, so a browser forces a preflight this CDN does
// not answer and the request fails before it is sent. Both attempts then failed
// for unrelated reasons and existing files were reported missing.

section('Existence probe');
{
  const probeFn = SRC.slice(SRC.indexOf('async function mediaExists'), SRC.indexOf('async function mediaExists') + 1600);

  ok('the probe sends no custom headers', !/Range: 'bytes=0-0'/.test(probeFn));
  ok('it falls back to a plain GET', /await probe\(\{ method: 'GET' \}\)/.test(probeFn));
  ok('the body is cancelled rather than downloaded', /res\.body\?\.cancel\(\)/.test(probeFn));
  ok('a HEAD alone still cannot conclude absence', /if \(head\?\.ok\) return true/.test(probeFn));

  // The shape must match the fetch that demonstrably works elsewhere.
  for (const f of ['sidepanel.js', 'browse.js']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    ok(`${f}: the blob rescue sends no custom headers`,
      /await fetch\(candidate, \{ cache: 'no-store' \}\)/.test(src));
  }

  // The Node tool keeps the ranged GET on purpose: no CORS there, and it avoids
  // pulling whole files across thousands of checks.
  const tool = fs.readFileSync(path.join(ROOT, 'tools', 'scan-local.js'), 'utf8');
  ok('the Node tool still uses a ranged GET', /Range: 'bytes=0-0'/.test(tool));
  ok('and says why the two differ', /Do not unify these two/.test(tool));

  // Verdicts produced by the broken probe are reset rather than trusted.
  ok('unreachable verdicts are revalidated', /if \(from < 11\)/.test(SRC));
  ok('the reset clears the check timestamp',
    /if \(from < 11\)[\s\S]{0,400}?lastCheckedAt = 0/.test(SRC));
}

// ---------- self re-authentication ----------
//
// The renewal path cannot be exercised the way the rest of this suite works —
// it is not a pure function of its arguments, it talks to chrome.storage and to
// the network. So it gets a real harness: fake storage backed by plain objects,
// a fake fetch that scripts its replies and counts calls.
//
// Worth testing here rather than by hand in a browser, because the interesting
// cases are the ones a manual test will never produce on purpose: two jobs
// failing on the same dead token at the same instant, a login that itself gets
// rejected, an account forgotten while it still has a password on disk. Waiting
// a month for a real token to expire is not a test strategy.
section('Self re-authentication');
{
  const REAUTH_FNS = [
    'decodeJwt', 'buildAuth', 'readVault', 'vaultUpsert', 'listVaultAccounts',
    'readPasswords', 'savePassword', 'forgetPassword', 'accountsWithPassword',
    'apiLogin', 'adoptFreshToken', 'accountHasLiveTab', 'isEvictionError',
    'reauthAccount', 'readAuth', 'vaultForget',
  ];
  const REAUTH_CONSTS = [
    'API', 'VAULT_KEY', 'OVERRIDE_KEY', 'PASSWORDS_KEY', 'reauthInFlight',
    'MIN_LOGIN_INTERVAL_MS', 'lastLoginAt', 'EVICTED_RE',
  ];

  // A JWT the real decodeJwt will accept: header.payload.signature, base64url.
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const jwt = (username, expiresAtMs) =>
    `x.${b64({ Username: username, ExpireTime: Math.floor(expiresAtMs / 1000) })}.sig`;

  const DAY = 86_400_000;

  function harness() {
    const local = {};
    const session = {};
    const store = (bag) => ({
      get: async (k) => (typeof k === 'string' ? { [k]: bag[k] } : { ...bag }),
      set: async (o) => { Object.assign(bag, o); },
      remove: async (k) => { delete bag[k]; },
    });

    const calls = { login: 0, bodies: [] };
    let reply = null; // set per test

    const fakeFetch = async (url, init) => {
      if (String(url).endsWith('/login')) {
        calls.login++;
        calls.bodies.push(JSON.parse(init.body));
        return { json: async () => reply };
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    // The live-tab token capture. Seeded per test to model "the site is signed
    // in as this account right now".
    const tokensByTab = new Map();

    const sandbox = {
      chrome: { storage: { local: store(local), session: store(session) } },
      fetch: fakeFetch,
      tokensByTab,
      // Not under test; stubbed so the graph closes.
      hydrateTokens: async () => {},
      broadcast: () => {},
      publishActiveAuth: async () => {},
      console,
    };

    const src = [
      ...REAUTH_CONSTS.map(extractConst),
      ...REAUTH_FNS.map(extractFn),
      `module.exports = { ${REAUTH_FNS.join(', ')}, reauthInFlight };`,
    ].join('\n\n');

    const mod = { exports: {} };
    const keys = Object.keys(sandbox);
    new Function(...keys, 'module', 'exports', src)(
      ...keys.map((k) => sandbox[k]), mod, mod.exports,
    );
    return {
      lib: mod.exports,
      local,
      session,
      calls,
      tokensByTab,
      setReply: (r) => { reply = r; },
    };
  }

  const okLogin = (username, expMs) => ({
    ErrCode: 0,
    ErrMsg: 'Success',
    Resp: { Result: { AccountId: 1, Username: username, Token: jwt(username, expMs), DeleteAt: 0 } },
  });

  // --- apiLogin ---
  (async () => {
    const h = harness();
    h.setReply(okLogin('acc', Date.now() + 30 * DAY));
    const r = await h.lib.apiLogin('acc', 'pw');
    ok('apiLogin returns the Result', Boolean(r.Token));
    ok('apiLogin sends Username/Password', h.calls.bodies[0].Username === 'acc' && h.calls.bodies[0].Password === 'pw');

    // The real failure shape: HTTP 200, non-zero ErrCode (NOTES 1.14f).
    const h2 = harness();
    h2.setReply({ ErrCode: 500200, ErrMsg: 'User does not exist.', Resp: {} });
    let threw = null;
    try { await h2.lib.apiLogin('nope', 'pw'); } catch (e) { threw = e.message; }
    check('a 200 with ErrCode 500200 is a failure', threw, 'User does not exist.');

    // --- password storage ---
    const h3 = harness();
    await h3.lib.savePassword('acc', 'pw');
    ok('savePassword stores under its own key', Boolean(h3.local.accountPasswords?.acc));
    ok('passwords are NOT in the token vault', h3.local.accountVault === undefined);
    ok('accountsWithPassword names it', (await h3.lib.accountsWithPassword()).has('acc'));
    await h3.lib.forgetPassword('acc');
    ok('forgetPassword removes it', !(await h3.lib.accountsWithPassword()).has('acc'));

    // --- no password means no renewal, and that is not an error ---
    const h4 = harness();
    check('reauth without a stored password returns null', await h4.lib.reauthAccount('acc'), null);
    check('and makes no login call', h4.calls.login, 0);

    // --- renewal ---
    const h5 = harness();
    await h5.lib.savePassword('acc', 'pw');
    h5.setReply(okLogin('acc', Date.now() + 30 * DAY));
    const fresh = await h5.lib.reauthAccount('acc');
    ok('renewal returns fresh auth', Boolean(fresh?.token));
    check('renewal names the account', fresh.username, 'acc');
    // The bug NOTES 2.2 warns about: a new token must never inherit an old
    // session's anon-id. A headless renewal has no way to learn the new one.
    check('renewal sets anonId to null', fresh.anonId, null);
    ok('renewal writes the token to the vault', h5.local.accountVault.acc.token === fresh.token);
    check('renewal made exactly one login call', h5.calls.login, 1);

    // --- single flight ---
    const h6 = harness();
    await h6.lib.savePassword('acc', 'pw');
    h6.setReply(okLogin('acc', Date.now() + 30 * DAY));
    const [a, b] = await Promise.all([h6.lib.reauthAccount('acc'), h6.lib.reauthAccount('acc')]);
    check('concurrent renewals collapse to one login', h6.calls.login, 1);
    ok('both callers get the same token', a.token === b.token);
    // The latch must RELEASE, or the account could never renew again. Asserted
    // directly rather than by firing a second login: since the rate limit went
    // in, an immediate re-login is refused by design, so counting logins would
    // now measure the rate limit rather than the latch.
    check('the single-flight latch is released', h6.lib.reauthInFlight.size, 0);

    // --- the active override follows the new token ---
    const h7 = harness();
    await h7.lib.savePassword('acc', 'pw');
    h7.session.authOverride = { username: 'acc', token: 'dead' };
    h7.setReply(okLogin('acc', Date.now() + 30 * DAY));
    const r7 = await h7.lib.reauthAccount('acc');
    ok('an active override is re-pointed at the new token',
      h7.session.authOverride.token === r7.token);

    // --- readAuth ---
    const h8 = harness();
    h8.session.auth = { token: 'old', username: 'acc', expiresAt: Date.now() - DAY };
    await h8.lib.savePassword('acc', 'pw');
    h8.setReply(okLogin('acc', Date.now() + 30 * DAY));
    const got = await h8.lib.readAuth();
    ok('readAuth renews an expired token instead of throwing', got.token !== 'old');

    const h9 = harness();
    h9.session.auth = { token: 'old', username: 'acc', expiresAt: Date.now() - DAY };
    let msg = null;
    try { await h9.lib.readAuth(); } catch (e) { msg = e.message; }
    check('an expired token with no password still throws', msg, 'TOKEN_EXPIRED');
    check('and does not attempt a login', h9.calls.login, 0);

    const h10 = harness();
    h10.session.auth = { token: 'live', username: 'acc', expiresAt: Date.now() + DAY };
    await h10.lib.savePassword('acc', 'pw');
    const live = await h10.lib.readAuth();
    check('a live token is returned untouched', live.token, 'live');
    check('and triggers no login', h10.calls.login, 0);

    // --- forgetting must take the password with it ---
    const h11 = harness();
    await h11.lib.savePassword('acc', 'pw');
    h11.local.accountVault = { acc: { username: 'acc', token: 't' } };
    await h11.lib.vaultForget('acc');
    ok('forgetting an account drops its password too',
      !(await h11.lib.accountsWithPassword()).has('acc'));

    // --- the switcher list ---
    const h12 = harness();
    const past = Date.now() - DAY;
    h12.local.accountVault = {
      dead: { username: 'dead', token: 't', expiresAt: past, updatedAt: 1 },
      deadWithPw: { username: 'deadWithPw', token: 't', expiresAt: past, updatedAt: 2 },
    };
    await h12.lib.savePassword('deadWithPw', 'pw');
    const listed = await h12.lib.listVaultAccounts();
    const names = listed.map((x) => x.username);
    ok('an expired account with a password is listed', names.includes('deadWithPw'));
    ok('an expired account without one is still hidden', !names.includes('dead'));
    ok('canRenew is flagged', listed.find((x) => x.username === 'deadWithPw').canRenew === true);
    ok('no password is ever returned to the panel',
      !JSON.stringify(listed).includes('pw'));

    // ---------- the session war ----------
    //
    // PixVerse is single-session per account: a successful /login invalidates
    // whatever session that account already had. The first version of this
    // feature did not know that, so the extension and the browser tab evicted
    // each other in a loop, and the user saw "account has been logged in
    // elsewhere" over and over. Only accounts with a stored password could
    // suffer it, because only those can log in unattended.
    //
    // Every check below exists to keep a login from happening when there is
    // somebody to evict.
    section('Single-session eviction');
    {
      const live = () => ({ username: 'acc', token: 'LIVE', expiresAt: Date.now() + DAY });

      ok('the eviction message is recognised',
        harness().lib.isEvictionError('account has been logged in elsewhere'));
      ok('an ordinary auth failure is not mistaken for one',
        !harness().lib.isEvictionError('Token is invalid'));

      // A tab has a newer token: adopt it, do not log in.
      const h = harness();
      await h.lib.savePassword('acc', 'pw');
      h.tokensByTab.set(1, live());
      const adopted = await h.lib.reauthAccount('acc', { staleToken: 'DEAD' });
      check('a live tab token is adopted instead of logging in', adopted.token, 'LIVE');
      check('and no login is fired', h.calls.login, 0);

      // Both ends hold the same dead token: stand down and let the site recover.
      const h2 = harness();
      await h2.lib.savePassword('acc', 'pw');
      h2.tokensByTab.set(1, { username: 'acc', token: 'DEAD', expiresAt: Date.now() + DAY });
      check('no login while a tab holds the same dead token',
        await h2.lib.reauthAccount('acc', { staleToken: 'DEAD' }), null);
      check('still no login fired', h2.calls.login, 0);

      // Nobody to evict: logging in is allowed.
      const h3 = harness();
      await h3.lib.savePassword('acc', 'pw');
      h3.setReply(okLogin('acc', Date.now() + 30 * DAY));
      const first = await h3.lib.reauthAccount('acc', { staleToken: 'DEAD' });
      ok('with no tab open, renewal still works', Boolean(first?.token));
      check('exactly one login', h3.calls.login, 1);

      // Asking again while the vault still holds a good token adopts it rather
      // than logging in. (A first draft of this test asserted null here and
      // "failed" — adoption short-circuiting is the correct answer, and it also
      // meant the rate limit below was never being reached.)
      const again = await h3.lib.reauthAccount('acc', { staleToken: 'DEAD' });
      check('a repeat request reuses the vault token', again.token, first.token);
      check('without a second login', h3.calls.login, 1);

      // Now force past adoption: the caller says the vault's own token is the
      // one that just failed, and no tab is open. Only the rate limit is left.
      check('a second login inside the interval is refused',
        await h3.lib.reauthAccount('acc', { staleToken: first.token }), null);
      check('and really did not call /login again', h3.calls.login, 1);

      // An expired token must never be adopted: it would satisfy the caller and
      // fail on the very next request.
      const h4 = harness();
      h4.tokensByTab.set(1, { username: 'acc', token: 'OLD', expiresAt: Date.now() - DAY });
      check('an expired tab token is not adopted',
        await h4.lib.adoptFreshToken('acc', 'DEAD'), null);

      // The stale token itself is never handed back as if it were fresh.
      const h5 = harness();
      h5.tokensByTab.set(1, live());
      check('the failed token is not re-adopted',
        await h5.lib.adoptFreshToken('acc', 'LIVE'), null);

      // The eviction path in apiFetch must adopt, never log in.
      ok('apiFetch adopts rather than renews on an eviction',
        /isEvictionError\(raw\.ErrMsg\)[\s\S]{0,80}adoptFreshToken/.test(SRC));
    }

    // ---------- OSS request signing ----------
    //
    // Locked down because the failure is silent and remote: get the canonical
    // string wrong by one character and OSS answers `SignatureDoesNotMatch`
    // with no hint, at runtime, on a real upload. Nothing local would notice.
    //
    // The specific trap, and the one this got wrong on the first attempt: the
    // Date line holds the **x-oss-date value**, not an empty string. A browser
    // cannot set the `Date` header at all, so "Date is absent, therefore the
    // line is blank" is the natural and wrong conclusion. OSS substitutes
    // x-oss-date into that position and signs it.
    section('OSS request signing');
    {
      const sent = {};
      const sandbox = {
        fetch: async (url, init) => {
          sent.url = url;
          sent.headers = init.headers;
          sent.body = init.body;
          return { ok: true, headers: { get: () => '"etag"' }, text: async () => '' };
        },
        crypto: globalThis.crypto,
        btoa: globalThis.btoa,
        TextEncoder: globalThis.TextEncoder,
      };
      const src = [
        extractConst('OSS_HOST'), extractConst('OSS_BUCKET'),
        extractFn('hmacSha1Base64'), extractFn('ossPut'),
        'module.exports = { ossPut, hmacSha1Base64, OSS_HOST, OSS_BUCKET };',
      ].join('\n\n');
      const mod = { exports: {} };
      const keys = Object.keys(sandbox);
      new Function(...keys, 'module', 'exports', src)(...keys.map((k) => sandbox[k]), mod, mod.exports);
      const u = mod.exports;

      const cred = { Ak: 'STS.AK', Sk: 'SECRET', Token: 'TOK' };
      const key = 'upload/abc.jpg';
      await u.ossPut(cred, key, 'bytes', 'image/jpeg');

      ok('PUTs to the bucket at the object key', sent.url === `${u.OSS_HOST}/${key}`);
      ok('sends x-oss-forbid-overwrite', sent.headers['x-oss-forbid-overwrite'] === 'true');
      ok('sends the STS token as a header', sent.headers['x-oss-security-token'] === 'TOK');

      // Rebuild the string the server would sign, from the date actually sent.
      const date = sent.headers['x-oss-date'];
      const canon = ['x-oss-date:' + date, 'x-oss-forbid-overwrite:true', 'x-oss-security-token:TOK']
        .map((l) => l + '\n').join('');
      const correct = ['PUT', '', 'image/jpeg', date, canon + `/${u.OSS_BUCKET}/${key}`].join('\n');
      const blankDate = ['PUT', '', 'image/jpeg', '', canon + `/${u.OSS_BUCKET}/${key}`].join('\n');

      const expected = `OSS STS.AK:${await u.hmacSha1Base64('SECRET', correct)}`;
      const wrong = `OSS STS.AK:${await u.hmacSha1Base64('SECRET', blankDate)}`;

      check('the Authorization header matches the canonical string', sent.headers.Authorization, expected);
      // Without this the test above could pass for the wrong reason.
      ok('and a blank Date line would NOT match', sent.headers.Authorization !== wrong);

      // Cross-check the crypto.subtle implementation against Node's own HMAC,
      // so a broken crypto path is caught here rather than being misdiagnosed
      // as a canonicalisation bug. An independent implementation beats a
      // hand-copied test vector.
      const nodeHmac = require('crypto')
        .createHmac('sha1', 'SECRET').update(correct).digest('base64');
      check('hmacSha1Base64 agrees with node:crypto',
        await u.hmacSha1Base64('SECRET', correct), nodeHmac);
    }

    // ---------- data URL decoding ----------
    //
    // Regression guard with a story. The first version used
    // `await (await fetch(dataUrl)).blob()`, which Chrome refuses: the MV3
    // service worker is bound by the extension's CSP, and `connect-src` has no
    // `data:` — so a URL carrying its own bytes, making no network request, is
    // blocked as a connection. It fails only at runtime, in the worker, on a
    // real upload. Hence a test.
    section('Data URL decoding');
    {
      const mod = { exports: {} };
      const src = `${extractFn('blobFromDataUrl')}\nmodule.exports = { blobFromDataUrl };`;
      new Function('atob', 'Blob', 'Uint8Array', 'module', 'exports', src)(
        globalThis.atob, globalThis.Blob, Uint8Array, mod, mod.exports,
      );

      const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x10]);
      const b64 = Buffer.from(bytes).toString('base64');
      const blob = mod.exports.blobFromDataUrl(`data:image/png;base64,${b64}`);

      check('the MIME type survives', blob.type, 'image/png');
      check('the byte count survives', blob.size, bytes.length);
      const round = new Uint8Array(await blob.arrayBuffer());
      ok('the bytes round-trip exactly', round.every((b, i) => b === bytes[i]));
      ok('it never calls fetch', !/fetch\s*\(/.test(extractFn('blobFromDataUrl')));

      let threw = null;
      try { mod.exports.blobFromDataUrl('not-a-data-url'); } catch (e) { threw = e.message; }
      check('a malformed data URL is rejected', threw, 'Malformed data URL');
    }

    // ---------- surviving worker death ----------
    //
    // The recovery layer can't be exercised end-to-end here (it needs a real
    // worker termination), so these pin the properties that make it safe. Each
    // one is a way it could silently do harm rather than nothing.
    section('Job resumption');
    {
      const panel = SRC;
      ok('the snapshot is persisted, not just held in a local',
        /record\.knownIds = \[\.\.\.knownIds\]/.test(panel));
      ok('and the deadline with it', /record\.pollUntil = Date\.now\(\)/.test(panel));
      ok('the live poll derives its timeout from the persisted deadline',
        /const timeout = Math\.max\(0, record\.pollUntil - Date\.now\(\)\)/.test(panel));

      // Double-polling one job would double-archive and could double-report.
      ok('a job with a live in-memory loop is skipped',
        /if \(runningJobIds\.has\(record\.id\)\) continue/.test(panel));
      ok('and one already being resumed is skipped',
        /if \(resuming\.has\(record\.id\)\) continue/.test(panel));
      ok('the live loop registers itself', /runningJobIds\.add\(record\.id\)/.test(panel));
      ok('and deregisters in a finally', /finally \{\s*runningJobIds\.delete\(record\.id\)/.test(panel));

      // Resuming forever is worse than settling honestly.
      ok('a job past its deadline is settled, not polled',
        /now >= record\.pollUntil/.test(panel));
      ok('a record with no snapshot is settled rather than resumed',
        /!record\.knownIds \|\| !record\.pollUntil/.test(panel));
      ok('only running jobs are considered',
        /if \(record\.state !== 'running'\) continue/.test(panel));

      ok('the alarm is registered', /chrome\.alarms\.create\(JOB_ALARM/.test(panel));
      ok('and listened for', /alarm\.name === JOB_ALARM/.test(panel));
      ok('a restarted worker checks immediately rather than waiting a period',
        /onStartup[\s\S]{0,80}resumeOrphanedJobs\(\)/.test(panel));

      const mf = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
      ok('the alarms permission is declared', mf.permissions.includes('alarms'));
    }

    // ---------- pricing DSL ----------
    //
    // Both traps in this evaluator produce a WRONG NUMBER rather than an error,
    // which is the worst failure mode available: you'd discover it by spending
    // credits. So both get pinned.
    //
    //   1. A binary node has no `type`, only `operator`/`params`.
    //   2. `audio`/`multishot` compare against boolean `true`. Passing 1 matches
    //      nothing and falls through to the default — pricing as if the option
    //      were off, which is exactly what it looked like the first time.
    section('Pricing DSL');
    {
      const mod = { exports: {} };
      const src = [
        extractConst('PRICING_OPS'), extractFn('evalPricing'),
        'module.exports = { evalPricing };',
      ].join('\n\n');
      new Function('module', 'exports', src)(mod, mod.exports);
      const { evalPricing: E } = mod.exports;

      const lit = (value) => ({ type: 'literal', value });
      const v = (name) => ({ type: 'variable', name });

      check('literal', E(lit(7), {}), 7);
      check('variable', E(v('duration'), { duration: 5 }), 5);
      // A binary node deliberately has NO type field.
      check('binary without a type field',
        E({ operator: '*', params: [lit(6), lit(7)] }, {}), 42);
      check('operators reduce across every param',
        E({ operator: '+', params: [lit(1), lit(2), lit(3)] }, {}), 6);
      check('ceil', E({ name: 'ceil', params: [lit(37.5)] }, {}), 38);

      const audioSwitch = {
        switchOn: v('audio'),
        cases: [{ compareValue: true, type: '=', value: lit(1.25) }],
        default: lit(1),
      };
      check('audio true hits the multiplier', E(audioSwitch, { audio: true }), 1.25);
      check('audio false falls to the default', E(audioSwitch, { audio: false }), 1);
      // The trap, stated as a test: 1 is NOT true here.
      check('audio 1 does NOT match the boolean case', E(audioSwitch, { audio: 1 }), 1);

      check('a > case matches in order',
        E({ switchOn: v('n'), cases: [
          { compareValue: 5, type: '>', value: lit('big') },
          { compareValue: 0, type: '>', value: lit('small') },
        ], default: lit('zero') }, { n: 3 }), 'small');

      // Failing loudly beats pricing something wrongly.
      let threw = null;
      try { E(v('nope'), {}); } catch (e) { threw = e.message; }
      ok('a missing variable throws rather than becoming NaN', /no value for nope/.test(threw));
      threw = null;
      try { E({ switchOn: lit(1), cases: [{ compareValue: 1, type: '~', value: lit(1) }] }, {}); } catch (e) { threw = e.message; }
      ok('an unknown comparator throws', /unknown comparator/.test(threw));

      // The real i2v shape, reduced: ceil(base * qualityMult * audioMult) * count.
      const tree = {
        operator: '*',
        params: [
          { name: 'ceil', params: [{ operator: '*', params: [
            lit(30),
            { switchOn: v('quality'), cases: [{ compareValue: '1080p', type: '=', value: lit(2) }], default: lit(1) },
            { switchOn: v('audio'), cases: [{ compareValue: true, type: '=', value: lit(1.25) }], default: lit(1) },
          ] }] },
          v('create_count'),
        ],
      };
      check('reproduces the site figure (540p, audio on)',
        E(tree, { quality: '540p', audio: true, create_count: 1 }), 38);
      check('and the same job x3', E(tree, { quality: '540p', audio: true, create_count: 3 }), 114);
      check('1080p without audio', E(tree, { quality: '1080p', audio: false, create_count: 1 }), 60);

      // Panel modes must map onto formula keys that exist.
      const map = extractConst('PRICING_FORMULA');
      ok('image maps to i2i', /image:\s*'i2i'/.test(map));
      ok('animate maps to i2v', /animate:\s*'i2v'/.test(map));
      ok('frames maps to transition', /frames:\s*'transition'/.test(map));
      const panelSrc = fs.readFileSync(path.join(ROOT, 'sidepanel.js'), 'utf8');
      ok('the panel sends booleans for audio/multiShot',
        /audio: state\.mode === 'frames' \? Boolean/.test(panelSrc));

      // Discounts. The multipliers are unknowable, so the contract is: exact
      // when none is running, an explicit upper bound when one is. A silently
      // wrong exact figure is the failure being designed out.
      const ad = extractFn('activeDiscounts');
      ok('V6 promotions are detected', /is_v6_discount/.test(ad));
      ok('generic promotions are detected', /promotion_discounts/.test(ad));
      ok('marketing-hub promotions are detected', /marketing_hub_discount_info/.test(ad));
      const est = extractFn('estimateCost');
      ok('preview mode counts as an unvalued discount', /if \(previewMode\) reasons\.push/.test(est));
      ok('exactness is derived from the reasons, not assumed',
        /exact: reasons\.length === 0/.test(est));
      ok('the panel marks an inexact figure with a bound',
        /⚡≤\$\{res\.credits\}/.test(panelSrc));
      ok('and explains why in the tooltip', /Upper bound — a discount is active/.test(panelSrc));

      // Affordability guard.
      ok('the balance rides along with the estimate', /balance = \(await fetchCredits\(\)\)\.total/.test(SRC));
      ok('generation is blocked when the cost exceeds the balance',
        /res\.credits > res\.balance[\s\S]{0,60}\$\('go'\)\.disabled = true/.test(panelSrc));
    }

    // ---------- the 4000px ceiling ----------
    //
    // Established by bisecting the live API: 4000 registers, 4001 answers
    // ErrCode 400 "incorrect image width or height", per-side rather than by
    // area. It is enforced at REGISTRATION, so without a client-side check the
    // whole file goes to OSS first and only then fails.
    section('Image size ceiling');
    {
      const panel = fs.readFileSync(path.join(ROOT, 'sidepanel.js'), 'utf8');
      check('the panel and the worker agree on the limit',
        /MAX_IMAGE_SIDE = (\d+)/.exec(panel)?.[1],
        /MAX_IMAGE_SIDE = (\d+)/.exec(SRC)?.[1]);
      check('and the limit is the observed one', /MAX_IMAGE_SIDE = (\d+)/.exec(SRC)?.[1], '4000');
      ok('the panel downscales rather than refusing',
        /scaledFrom/.test(panel) && /drawImage/.test(panel));
      ok('a resize is reported, not silent', /resized from/.test(panel));
      // The re-encode can change the format, so the object key and Content-Type
      // must follow the bytes rather than the filename.
      ok('the worker types the upload from the blob, not the filename',
        /const contentType = blob\.type \|\|/.test(SRC));
      ok('and derives the extension from that MIME type', /MIME_EXT\[contentType\]/.test(SRC));
    }
  })().catch((e) => {
    fail++;
    failures.push(`self re-auth harness threw: ${e.stack}`);
    console.log(`  FAIL harness threw: ${e.message}`);
  }).finally(summary);
}

// ---------- summary ----------
//
// A function rather than a trailing block: the self re-auth section is async
// (it awaits a fake network), so the totals must not be printed until it has
// finished. Every other section is synchronous and has already run by now.

function summary() {
  console.log(`\n${'-'.repeat(58)}`);
  if (fail) {
    console.log(`${pass} passed, ${fail} FAILED\n`);
    for (const f of failures) console.log(`  ${f}\n`);
    process.exit(1);
  }
  console.log(`${pass} passed, 0 failed`);

  // The README quotes this suite's size, and a quoted number with nothing
  // checking it rots silently. It already had: the file claimed 92 while the
  // suite ran 468, and the correction to 499 was stale again within days.
  //
  // sidepanel.js states the principle for the version string — "a version string
  // in two places is a version string that will disagree with itself" — and
  // reads it from the manifest rather than repeating it. The same rule applies
  // here; prose cannot read a variable, so the build fails instead.
  //
  // Deliberately NOT one of the counted checks: it would change the number it is
  // checking, and a test whose own existence alters its subject is a bad test.
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const claimed = Number(/(\d+) checks against/.exec(readme)?.[1]);
  const actual = pass + fail;
  if (claimed !== actual) {
    console.log(`\nREADME says "${claimed} checks"; this suite has ${actual}.`);
    console.log('Update the README, or the next person will trust a stale number.');
    process.exit(1);
  }
}
