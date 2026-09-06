#!/usr/bin/env node
/**
 * har-ingest — turn a DevTools network capture into answers about the API.
 *
 *   1. In Chrome, on app.pixverse.ai: DevTools -> Network -> tick "Preserve log".
 *   2. Do the things you want to understand (see RECIPES below).
 *   3. Right-click the request list -> "Save all as HAR with content".
 *   4. node tools/har-ingest.js <capture.har> [more.har ...] --out capture/
 *
 * WHY A HAR AND NOT MORE webRequest
 * ---------------------------------
 * `chrome.webRequest` — what background.js already uses to lift the token — can
 * see request headers, and it can see request bodies. It CANNOT see response
 * bodies. Not a permissions problem, not a flag: the API has no response-body
 * event at all. Every open question in NOTES is a question about a RESPONSE
 * (what does the STS call return, what models exist, what does an unknown
 * endpoint carry), so the capture path already in the extension can never
 * answer any of them.
 *
 * Two things can read response bodies: `chrome.debugger` (the DevTools protocol,
 * driven from the extension) and DevTools itself. DevTools is already
 * installed, needs no new permission, shows no "is debugging this browser"
 * infobar, and captures EVERY host — including the Aliyun OSS bucket and
 * whatever host mints the STS credentials, neither of which is in
 * host_permissions and neither of which the extension can therefore see. So:
 * HAR first. chrome.debugger only if hands-off continuous capture is wanted.
 *
 * WHAT IT DOES WITH THEM
 * ----------------------
 * Groups entries by `METHOD host/path`, then MERGES the JSON bodies of every
 * sample of an endpoint into one shape: field -> types seen, distinct values
 * seen, and whether it appeared in every sample or only some.
 *
 * That last part is the point. One capture of `/image/i2i` tells you the
 * fields. Forty captures tell you which fields are optional, which are enums,
 * and which vary with the mode — exactly the class of question (`multi_shot`,
 * `model_name_default`) that a single hand-copied fixture left open.
 *
 * It also runs three targeted hunts, because they are the known blockers:
 *   - a response carrying AccessKeySecret / SecurityToken -> unblocks upload
 *   - a response that looks like a model catalogue         -> fixes MODELS
 *   - request headers the site sends that we don't         -> origin/403 risk
 *
 * SECRETS
 * -------
 * A HAR of a signed-in session is a credential file. It contains your JWT in
 * the `token` header, your cookies, and — if you captured an upload — an Aliyun
 * AccessKeySecret. Output is REDACTED by default so the catalogue is safe to
 * keep. `--secrets` turns redaction off, which you need exactly once: to read
 * the AccessKeySecret out of an upload capture. Don't commit that run, and
 * delete the HAR when you're done with it.
 *
 * RECIPES — what to do on the site to answer each open question
 * -------------------------------------------------------------
 *   upload (the big one)  Open the upload dialog and upload one small PNG.
 *                         Start the capture BEFORE opening the dialog — the STS
 *                         call fires early, and missing it is precisely why
 *                         upload is still unbuilt. Then re-run with --secrets.
 *   model list            Hard-reload the create page with the network tab
 *                         open, then open the model dropdown.
 *   model_name_default    Generate once per model at the cheapest settings.
 *                         Confirms v5 / v4.5 / flux-dev / seedream, which are
 *                         guesses in MODEL_DISPLAY_NAME today.
 *   multi_shot            Generate the same prompt in image mode and in animate
 *                         mode, then diff the two payloads.
 *   credits / account     Load the account page.
 *   the long tail         Leave "Preserve log" on for a normal working session
 *                         and save the HAR at the end. Unknown endpoints show
 *                         up on their own.
 */

const fs = require('fs');
const path = require('path');

// Endpoints background.js already speaks. Anything else is a finding.
const KNOWN_ENDPOINTS = new Set([
  '/creative_platform/image/i2i',
  '/creative_platform/video/i2v',
  '/creative_platform/video/frames',
  '/creative_platform/user/credits',
  '/creative_platform/asset/library/list',
]);

// Headers background.js already sends. Anything else the site sends is a
// candidate explanation for the 403-on-origin-check failure mode in the README.
const KNOWN_HEADERS = new Set([
  'token', 'workspace-id', 'x-platform', 'ai-anonymous-id', 'content-type', 'accept',
]);

// Hosts worth cataloguing in full. Everything else is counted and named only,
// so an unfamiliar host — which is how a credential-minting endpoint tends to
// announce itself — still shows up without dragging in the whole page load.
const INTERESTING = /(^|\.)(pixverse\.ai|aliyuncs\.com|aliyun\.com)$/i;

// Noise on any page load. Excluded from the catalogue, still counted.
const BORING_TYPES = /^(image|font|stylesheet|media|other)$/;

// Path segments that are an identity, not a route. Without this every chunk of
// every upload becomes its own "endpoint" — `upload/<uuid1>.png`,
// `upload/<uuid2>.png` — and the shape merge that makes this tool worth running
// never gets more than one sample of anything.
const ID_SEGMENT = [
  [/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.\w+)?$/i, '<uuid>$1'],
  [/^[0-9a-f]{24,}(\.\w+)?$/i, '<hex>$1'],
  [/^\d{6,}$/, '<id>'],
];

function normalizePath(pathname) {
  return pathname.split('/').map((seg) => {
    for (const [re, to] of ID_SEGMENT) if (re.test(seg)) return seg.replace(re, to);
    return seg;
  }).join('/');
}

// `ak`/`sk` are PixVerse's abbreviations for AccessKeyId/AccessKeySecret.
const SECRET_KEYS = /^(accesskeysecret|securitytoken|accesskeyid|ak|sk|token|authorization|cookie|set-cookie|password|refresh_token|access_token|x-oss-security-token)$/i;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;

// ---------- args ----------

const args = process.argv.slice(2);
const files = [];
let outDir = null;
let showSecrets = false;
let maxSamples = 3;

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--out') outDir = args[++i];
  else if (a === '--secrets') showSecrets = true;
  else if (a === '--samples') maxSamples = Number(args[++i]) || 3;
  else if (a.startsWith('-')) { console.error(`unknown flag ${a}`); process.exit(1); }
  else files.push(a);
}

if (!files.length) {
  console.error('usage: node tools/har-ingest.js <capture.har> [more.har ...] [--out dir] [--secrets] [--samples n]');
  console.error('');
  console.error('  In Chrome on app.pixverse.ai: DevTools -> Network -> Preserve log,');
  console.error('  do the thing, then right-click -> "Save all as HAR with content".');
  console.error('  See the header comment in this file for what to do on the site to');
  console.error('  answer each specific open question.');
  process.exit(1);
}

// ---------- redaction ----------

function redactString(s) {
  if (showSecrets || typeof s !== 'string') return s;
  return s.replace(JWT, '<JWT redacted>');
}

function redactValue(key, value) {
  if (showSecrets) return value;
  if (SECRET_KEYS.test(String(key))) {
    return typeof value === 'string' ? `<${key} redacted, ${value.length} chars>` : value;
  }
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map((v) => redactValue(key, v));
  if (value && typeof value === 'object') return redactObject(value);
  return value;
}

function redactObject(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map((v) => redactObject(v));
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k] = redactValue(k, v);
  return out;
}

// ---------- parsing ----------

function parseBody(text, mimeType) {
  if (!text) return { kind: 'empty' };
  const t = text.trim();
  if (!t) return { kind: 'empty' };
  if (t[0] === '{' || t[0] === '[') {
    try { return { kind: 'json', value: JSON.parse(t) }; } catch { /* fall through */ }
  }
  if (t[0] === '<') return { kind: 'xml', value: t };
  if (/urlencoded/.test(mimeType || '')) return { kind: 'form', value: t };
  return { kind: 'text', value: t };
}

function entryBodies(entry) {
  const req = entry.request || {};
  const res = entry.response || {};
  const post = req.postData || {};

  let resText = res.content?.text ?? '';
  if (res.content?.encoding === 'base64' && resText) {
    try { resText = Buffer.from(resText, 'base64').toString('utf8'); } catch { resText = ''; }
  }

  return {
    request: parseBody(post.text ?? '', post.mimeType),
    response: parseBody(resText, res.content?.mimeType),
  };
}

// ---------- shape merging ----------
//
// The value of many captures over one. Walks every sample of an endpoint and
// records, per JSON path: the types seen, up to a handful of distinct values,
// and how many samples contained it. `seen < total` is an optional field; a
// small closed value set is an enum.

function walk(value, prefix, into) {
  const type = value === null ? 'null'
    : Array.isArray(value) ? 'array'
    : typeof value;

  const slot = into.get(prefix) || { types: new Set(), values: new Set(), seen: 0 };
  slot.types.add(type);
  if (type !== 'object' && type !== 'array' && slot.values.size < 8) {
    const leaf = prefix.split('.').pop();
    slot.values.add(showSecrets ? value : redactValue(leaf, value));
  }
  slot.seen++;
  into.set(prefix, slot);

  if (type === 'object') {
    for (const [k, v] of Object.entries(value)) walk(v, prefix ? `${prefix}.${k}` : k, into);
  } else if (type === 'array' && value.length) {
    // Merge every element into one `[]` path — an array of 50 assets should
    // describe the asset, not produce fifty numbered copies of it.
    for (const v of value.slice(0, 25)) walk(v, `${prefix}[]`, into);
  }
}

function mergeShape(samples) {
  const into = new Map();
  let n = 0;
  for (const s of samples) {
    if (s?.kind !== 'json') continue;
    n++;
    walk(s.value, '', into);
  }
  return { fields: into, sampleCount: n };
}

function renderShape(shape) {
  const { fields, sampleCount } = shape;
  if (!sampleCount) return '(no JSON body)';
  const lines = [];
  for (const p of [...fields.keys()].filter(Boolean).sort()) {
    const slot = fields.get(p);
    // An array-element path is counted once per element, so its "always
    // present" bar is its parent's element count, not the sample count.
    const parent = p.includes('.') ? p.slice(0, p.lastIndexOf('.')) : '';
    const parentSlot = fields.get(parent);
    const total = parent && parentSlot ? parentSlot.seen : sampleCount;
    const optional = slot.seen < total ? ` [${slot.seen}/${total}]` : '';
    const types = [...slot.types].join('|');
    const vals = [...slot.values];
    const sample = vals.length && vals.length < 8
      ? `  = ${vals.map((v) => JSON.stringify(v)).join(' | ').slice(0, 200)}`
      : '';
    lines.push(`${p}: ${types}${optional}${sample}`);
  }
  return lines.join('\n');
}

// ---------- ingest ----------

const endpoints = new Map(); // "METHOD host/path" -> record
const otherHosts = new Map();
const headerNames = new Map();
let totalEntries = 0;
let withResponseBody = 0;

for (const file of files) {
  let har;
  try {
    har = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.error(`cannot read ${file}: ${e.message}`);
    process.exit(1);
  }
  const entries = har?.log?.entries;
  if (!Array.isArray(entries)) {
    console.error(`${file} is not a HAR (no log.entries)`);
    process.exit(1);
  }

  for (const entry of entries) {
    totalEntries++;
    let url;
    try { url = new URL(entry.request.url); } catch { continue; }

    const bucket = BORING_TYPES.test(entry._resourceType || '')
      ? `${url.hostname} (${entry._resourceType})`
      : url.hostname;

    if (!INTERESTING.test(url.hostname) || BORING_TYPES.test(entry._resourceType || '')) {
      otherHosts.set(bucket, (otherHosts.get(bucket) || 0) + 1);
      continue;
    }

    for (const h of entry.request.headers || []) {
      const n = h.name.toLowerCase();
      if (n.startsWith(':')) continue; // HTTP/2 pseudo-headers
      headerNames.set(n, (headerNames.get(n) || 0) + 1);
    }

    const route = normalizePath(url.pathname);
    const key = `${entry.request.method} ${url.hostname}${route}`;
    if (!endpoints.has(key)) {
      endpoints.set(key, {
        method: entry.request.method,
        host: url.hostname,
        path: route,
        entries: [],
        statuses: new Map(),
        queries: new Set(),
      });
    }
    const ep = endpoints.get(key);
    const bodies = entryBodies(entry);
    if (bodies.response.kind !== 'empty') withResponseBody++;
    ep.entries.push({ url: url.href, bodies, status: entry.response?.status });
    ep.statuses.set(entry.response?.status, (ep.statuses.get(entry.response?.status) || 0) + 1);
    if (url.search) ep.queries.add(url.search);
  }
}

if (!endpoints.size) {
  console.error(`No pixverse/aliyun requests in ${files.length} file(s) — ${totalEntries} entries seen.`);
  console.error('Was the capture taken on app.pixverse.ai with the Network tab open?');
  process.exit(1);
}

// ---------- hunts ----------

const findings = [];

// 1. STS credentials.
//
// This hunt originally looked for `AccessKeySecret` / `SecurityToken`, the
// Aliyun-standard field names, and it WOULD HAVE MISSED THE REAL ONE. The live
// response from `POST /creative_platform/getUploadToken` is
// `{Resp:{Ak, Sk, Token}}` — abbreviated, non-standard, and invisible to a
// search for the documented spelling. A reminder that a hunt built from what
// the vendor's docs call a thing will miss what the vendor's client calls it.
const STS_SHAPE = /AccessKeySecret|SecurityToken|"Sk"\s*:|"Ak"\s*:|getUploadToken/i;
for (const [key, ep] of endpoints) {
  const hit = ep.entries.some((e) => {
    const raw = e.bodies.response.kind === 'json'
      ? JSON.stringify(e.bodies.response.value)
      : String(e.bodies.response.value || '');
    return STS_SHAPE.test(raw) || STS_SHAPE.test(ep.path);
  });
  if (hit) {
    findings.push({
      kind: 'STS',
      message: `STS credentials in the response of \`${key}\``
        + (showSecrets ? ' — the AccessKeySecret is in the sample file.' : ' — re-run with `--secrets` to read the AccessKeySecret.'),
    });
  }
}

// 2. A model catalogue — MODELS in sidepanel.js is a placeholder.
for (const [key, ep] of endpoints) {
  if (ep.path.includes('library')) continue; // the asset list mentions models too
  const hit = ep.entries.some((e) => {
    if (e.bodies.response.kind !== 'json') return false;
    const raw = JSON.stringify(e.bodies.response.value);
    return /"models?"|"model_name/i.test(raw) && raw.includes('[');
  });
  if (hit) findings.push({ kind: 'MODELS', message: `possible model catalogue in \`${key}\`` });
}

// 3. Headers the site sends that background.js does not.
const unknownHeaders = [...headerNames.entries()]
  .filter(([n]) => !KNOWN_HEADERS.has(n)
    && !/^(sec-|user-agent|referer|origin|host|accept-|connection|content-length|cache-control|pragma|priority|dnt|te$)/.test(n))
  .sort((a, b) => b[1] - a[1]);

// ---------- report ----------

const L = [];
const say = (s = '') => L.push(s);

say('# API capture catalogue');
say();
say(`Source: ${files.map((f) => path.basename(f)).join(', ')}`);
say(`${totalEntries} entries -> ${endpoints.size} endpoints on pixverse/aliyun hosts.`);
say(`${withResponseBody} request(s) carried a response body.`);
if (!withResponseBody) {
  say();
  say('> **No response bodies at all.** The HAR was probably saved with "Copy all as');
  say('> HAR" rather than "Save all as HAR with content". Response bodies are the');
  say('> entire reason for doing this — re-export.');
}
say();

const newEndpoints = [...endpoints.keys()].filter((k) => !KNOWN_ENDPOINTS.has(endpoints.get(k).path));
const knownSeen = [...endpoints.keys()].filter((k) => KNOWN_ENDPOINTS.has(endpoints.get(k).path));

say('## Findings');
say();
if (!findings.length && !unknownHeaders.length) say('Nothing flagged.');
for (const f of findings) say(`- **${f.kind}** — ${f.message}`);
if (unknownHeaders.length) {
  say(`- **HEADERS** — sent by the site, not by background.js: ${unknownHeaders.map(([n, c]) => `\`${n}\` (${c})`).join(', ')}`);
}
say();

say(`## New endpoints (${newEndpoints.length})`);
say();
say('Not in background.js. These are the reason for capturing.');
say();
for (const key of newEndpoints.sort()) say(`- \`${key}\` — ${endpoints.get(key).entries.length}x`);
say();

say(`## Known endpoints (${knownSeen.length})`);
say();
for (const key of knownSeen.sort()) say(`- \`${key}\` — ${endpoints.get(key).entries.length}x`);
say();

say('## Shapes');
say();
say('`[n/m]` means the field was present in n of m samples — anything short of the');
say('full count is optional. A short list after `=` is every distinct value seen,');
say('which is how an enum announces itself.');
say();

for (const key of [...endpoints.keys()].sort()) {
  const ep = endpoints.get(key);
  const statuses = [...ep.statuses.entries()].map(([s, c]) => `${s}x${c}`).join(' ');
  say(`### \`${key}\``);
  say();
  say(`${ep.entries.length} sample${ep.entries.length === 1 ? '' : 's'}, status ${statuses}${KNOWN_ENDPOINTS.has(ep.path) ? '' : '  **(new)**'}`);
  if (ep.queries.size) {
    say();
    say('Query strings seen:');
    for (const q of [...ep.queries].slice(0, 6)) say(`- \`${redactString(q)}\``);
  }
  say();
  say('**Request**');
  say('```');
  say(renderShape(mergeShape(ep.entries.map((e) => e.bodies.request))));
  say('```');
  say('**Response**');
  say('```');
  say(renderShape(mergeShape(ep.entries.map((e) => e.bodies.response))));
  say('```');

  const xml = ep.entries.find((e) => e.bodies.response.kind === 'xml');
  if (xml) {
    say('**Response (XML)**');
    say('```xml');
    say(redactString(xml.bodies.response.value).slice(0, 800));
    say('```');
  }
  say();
}

if (otherHosts.size) {
  say('## Other hosts');
  say();
  say('Counted, not catalogued. Scan for anything unexpected — an unfamiliar host is');
  say('how a credential-minting endpoint tends to announce itself.');
  say();
  for (const [h, c] of [...otherHosts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40)) {
    say(`- ${h} — ${c}`);
  }
  say();
}

const report = L.join('\n');

if (outDir) {
  fs.mkdirSync(path.join(outDir, 'samples'), { recursive: true });
  fs.writeFileSync(path.join(outDir, 'catalogue.md'), report);

  // One sample file per endpoint: the raw material for a curated test fixture.
  // Deliberately NOT written straight into test/fixtures — those are hand-picked
  // and annotated, and a dump of everything would drown them.
  for (const [key, ep] of endpoints) {
    const name = key.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
    const samples = ep.entries.slice(0, maxSamples).map((e) => ({
      url: redactString(e.url),
      status: e.status,
      request: e.bodies.request.kind === 'json'
        ? redactObject(e.bodies.request.value)
        : redactString(e.bodies.request.value ?? '') || null,
      response: e.bodies.response.kind === 'json'
        ? redactObject(e.bodies.response.value)
        : redactString(e.bodies.response.value ?? '') || null,
    }));
    fs.writeFileSync(
      path.join(outDir, 'samples', `${name}.json`),
      JSON.stringify({
        _note: `Captured from ${key}. ${showSecrets ? 'CONTAINS LIVE SECRETS — do not commit.' : 'Redacted.'}`,
        endpoint: key,
        samples,
      }, null, 2),
    );
  }

  console.log(report);
  console.log(`\nWritten: ${path.join(outDir, 'catalogue.md')} + ${endpoints.size} sample files.`);
  if (showSecrets) console.log('WARNING: --secrets was set. This output contains live credentials. Do not commit it.');
} else {
  console.log(report);
  console.log('\n(no --out given, nothing written)');
}
