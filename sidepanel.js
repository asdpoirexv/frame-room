// sidepanel.js — UI only. It never sees the token; it asks the service worker
// to do things and listens for what comes back.

const $ = (id) => document.getElementById(id);

// Routine recovery steps (direct load failing, then succeeding via blob fetch)
// happen for EVERY video — the CDN blocks direct <video src> loads, so the
// fetch fallback is the normal path, not an error. Logging those at warn/error
// floods the extension Errors tab and makes healthy playback look broken.
// Route them through here (console.debug — hidden from the Errors tab, still in
// the full console when Verbose is on). Genuine dead-ends stay console.error.
const FR_DEBUG = false; // flip to true for verbose recovery tracing
function frDebug(msg) {
  if (FR_DEBUG) console.debug(msg);
}

// Three modes, three endpoints:
//   image   → /image/i2i     (one image → image)
//   animate → /video/i2v     (one image → video)   ← matches the captured call
//   frames  → /video/frames  (first+last → video)
// Model ids, read off the live dropdowns and cross-checked against the
// 4087-record archive, where `model` is what the SERVER echoed back.
const MODELS = {
  image: ['qwen-image', 'seedream-4.0', 'seedream-4.5', 'seedream-5.0-lite', 'seedream-5.0-pro'],
  animate: ['v6', 'pixverse-c1', 'v5.6', 'v5'],
  frames: ['v6', 'pixverse-c1', 'v5.6', 'v5'],
};

// Read off the live dropdowns on 2026-09-02 (NOTES 1.14e). Two corrections to
// what was here before, both checkable: `v4.5` exists nowhere — not the
// dropdown, not the JS bundle, not 4087 archive records, and not PixVerse's own
// CLI. `flux-dev` was also wrong, and both were removed rather than left to fail
// at request time.
//
// Corrected 2026-09-06 against the official CLI (NOTES 1.14j): the claim that
// followed here, that "no Flux model is offered at all", was WRONG. `flux-3.0`
// exists and is a VIDEO model. Dropping `flux-dev` was still right — that id is
// fiction — but absence from one Basic account's dropdown was read as absence
// from the platform, which is the same error NOTES 1.12 warns about for the
// archive. Also missing from the list below: `v5.5` and `wan-3.0`.
//
// The lists above are deliberately the SHORT ones: PixVerse's own models plus
// the Seedream family, which is what these accounts can actually run. The site
// offers a dozen more, every one of them badged PRO+ or Standard+, so putting
// them in the panel on a Basic plan just buys a refusal from the server.
// They're listed here so the next person doesn't have to re-derive them:
//
//   video   seedance-2.5, seedance-2.0-standard (also -fast, -mini),
//           minimax-h3, gemini-omni-flash, happyhorse-1.0,
//           kling-o3-standard (also -pro, -4k), kling-3.0-standard (also -pro, -4k),
//           grok-imagine, grok-imagine-1.5,
//           veo-3.1-lite (also -standard, -fast), sora-2 (also sora-2-pro)
//   image   kling-image-o3, kling-image-v3, wan2.7-image, wan2.7-image-pro,
//           gemini-2.5-flash, gemini-3.0, gemini-3.1-flash, gemini-3.1-flash-lite
//
// PRO+ models also carry much longer max durations than the 5/8/10 this panel
// assumes — 60s for Grok, 120s for most, 200s for Veo 3.1, 300s for Sora 2. Any
// attempt to expose them needs DURATIONS reworked too.

// Which toggles belong to which mode, keyed off the captured payloads:
//   audio, preview_mode, off_peak  -> present in the captured FRAMES request
//   multi_shot                     -> present in the captured I2V request
// An empty list means the mode shows no toggles at all.
const TOGGLE_MODES = {
  't-audio': ['frames'],
  't-preview': ['frames'],
  't-offpeak': ['frames'],
  't-multishot': ['animate'],
};

// i2i offers only 720p/1080p; the video flows expose the lower rungs too.
const QUALITIES = {
  image: ['720p', '1080p'],
  animate: ['360p', '540p', '720p', '1080p'],
  frames: ['360p', '540p', '720p', '1080p'],
};

// Which media type each mode produces — drives reel filtering and rendering.
const OUTPUT = { image: 'image', animate: 'video', frames: 'video' };

// Slots each mode needs filled before Generate enables.
const SLOTS_NEEDED = { image: ['first'], animate: ['first'], frames: ['first', 'last'] };

// The three tabs share one set of DOM controls, so without per-mode storage
// anything typed or picked in one appears in the others — a frame chosen for
// Image showed up as the Animate source, and switching tabs mid-compose
// clobbered whatever was there. An earlier fix did this for the prompt alone;
// every field has the same problem, so the whole form is parked per mode and
// swapped on switch.
const blankForm = () => ({
  prompt: '',
  frames: { first: null, last: null },      // customer_img_path strings
  framePreviews: { first: null, last: null }, // so slot thumbnails restore too
  seed: '',
  count: '1',
  model: null,
  quality: null,
  duration: null,
  ratio: null,
  audio: false,
  preview: false,
  multiShot: 0,
  offPeak: false,
});

const state = {
  mode: 'image',
  frames: { first: null, last: null },
  framePreviews: { first: null, last: null },
  slotBeingPicked: null,
  runningSince: null,
  audio: false,
  preview: false,
  multiShot: 0,
  offPeak: false,
  forms: { image: blankForm(), animate: blankForm(), frames: blankForm() },
};

function captureForm() {
  return {
    prompt: $('prompt').value,
    frames: { ...state.frames },
    framePreviews: { ...state.framePreviews },
    seed: $('seed').value,
    count: $('count').value,
    model: $('model').value,
    quality: $('quality').value,
    duration: $('duration').value,
    ratio: $('ratio').value,
    audio: state.audio,
    preview: state.preview,
    multiShot: state.multiShot ?? 0,
    offPeak: state.offPeak ?? false,
  };
}

// Call AFTER the mode's dropdowns have been rebuilt — setting .value on a
// <select> silently does nothing if the option isn't there yet.
function applyForm(f) {
  $('prompt').value = f.prompt ?? '';
  $('seed').value = f.seed || randomSeed();
  $('count').value = f.count ?? '1';
  if (f.model) $('model').value = f.model;
  if (f.quality) $('quality').value = f.quality;
  if (f.duration) $('duration').value = f.duration;
  if (f.ratio) $('ratio').value = f.ratio;
  setToggle('t-audio', 'audio', Boolean(f.audio));
  setToggle('t-preview', 'preview', Boolean(f.preview));
  setToggle('t-multishot', 'multiShot', Boolean(f.multiShot));
  setToggle('t-offpeak', 'offPeak', Boolean(f.offPeak));

  clearSlot('first');
  clearSlot('last');
  for (const slot of ['first', 'last']) {
    const path = f.frames?.[slot];
    if (!path) continue;
    useFrame(path, f.framePreviews?.[slot] ?? mediaUrlFromPath(path), { slot, verify: false });
  }
}

// Never let a message hang forever. MV3 can terminate the service worker
// mid-request, and when that happens sendMessage's promise simply never settles
// — the caller waits indefinitely with no error to show. A picker stuck on
// "Loading…" with no way out was exactly this.
const SEND_TIMEOUT_MS = 45_000;

// Resolves, never rejects.
//
// It used to reject on timeout, which meant every `await send(...)` without its
// own try/catch became an unhandled promise rejection the moment the worker was
// slow — nine of eleven call sites here. And the worker IS legitimately slow
// sometimes: a deep sweep over several thousand records takes a while, and MV3
// can terminate it mid-request, in which case sendMessage's promise never
// settles at all.
//
// Callers already test `res?.ok`, so failing this way degrades where it used to
// throw. The timer is cleared on success so a settled call doesn't hold one for
// another 45 seconds.
function send(msg) {
  return new Promise((resolve) => {
    const timer = setTimeout(
      () => resolve({ ok: false, timedOut: true, error: 'The extension worker did not respond. Try again.' }),
      SEND_TIMEOUT_MS,
    );
    chrome.runtime.sendMessage(msg).then(
      (res) => { clearTimeout(timer); resolve(res); },
      (err) => { clearTimeout(timer); resolve({ ok: false, error: String(err?.message || err) }); },
    );
  });
}

const randomSeed = () => Math.floor(Math.random() * 2_147_483_647);

const MEDIA = 'https://media.pixverse.ai';

// The API returns media URLs with slashes percent-encoded (%2F). Address bars
// decode those on paste; <video>/<img> src does not. Decode before use.
const decodeMediaUrl = (u) => String(u ?? '').replace(/%2F/gi, '/');

// Encode each path segment but keep the slashes — encodeURIComponent on the
// whole path turns "/" into "%2F" and the CDN 404s.
const mediaUrlFromPath = (path) =>
  `${MEDIA}/${String(path).replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/')}`;

// Accept either a storage path (what the API wants) or a full URL (easy to copy
// off the site). Returns { path, preview }: path is sent, preview is rendered.
function resolveFrameInput(raw) {
  if (/^https?:\/\//i.test(raw)) {
    const decoded = decodeMediaUrl(raw);
    const m = decoded.match(/media\.pixverse\.ai\/(.+)$/i);
    const path = m ? decodeURIComponent(m[1].split(/[?#]/)[0]) : decoded;
    return { path, preview: decoded };
  }
  return { path: raw, preview: mediaUrlFromPath(raw) };
}

// Old job records (pre-0.6) stored `kind`; new ones store `mode`/`output`.
const jobOutput = (j) =>
  j.output ?? ({ image: 'image', video: 'video', animate: 'video', frames: 'video' }[j.mode ?? j.kind] ?? 'image');

// ---------- readout ----------
//
// One line, always true. Before a run it describes what Generate will do;
// during a run it becomes a timecode. This is the only status surface.

let tick = null;

function readout(text, tone = '') {
  $('readout-text').textContent = text;
  $('readout').className = `readout ${tone}`;
}

// Show what a generation will cost, before spending it.
//
// The figure comes from PixVerse's own pricing formulas, evaluated in the
// worker — not from a table copied out by hand, which would silently rot the
// first time they repriced anything.
//
// It is deliberately ALL-OR-NOTHING: if the estimate can't be computed the
// badge is emptied rather than showing a fallback. A wrong credit figure is
// worse than no figure, because you'd only find out by spending.
//
// Requests are sequenced so a slow reply can't overwrite a newer one — the
// parameters change on every keystroke of the seed field.
let costToken = 0;

async function refreshCost() {
  const badge = $('go-cost');
  if (!badge) return;
  const mine = ++costToken;

  const params = {
    mode: state.mode,
    model: $('model').value,
    quality: $('quality').value,
    duration: state.mode === 'image' ? 0 : Number($('duration').value),
    audio: state.mode === 'frames' ? Boolean(state.audio) : false,
    multiShot: state.mode === 'animate' ? Boolean(state.multiShot) : false,
    previewMode: state.mode === 'frames' ? Boolean(state.preview) : false,
    offPeak: state.mode === 'frames' ? Boolean(state.offPeak) : false,
    count: Number($('count').value) || 1,
  };

  const res = await send({ type: 'pricing/estimate', params });
  if (mine !== costToken) return; // a newer request has already answered

  if (!res?.ok || res.credits == null) {
    badge.textContent = '';
    badge.title = '';
    return;
  }

  // "≤" when a discount we can detect but cannot value is running. A discount
  // can only reduce the cost, so the figure is a true upper bound — saying so
  // is the difference between a useful number and a wrong one.
  badge.textContent = res.exact ? ` ⚡${res.credits}` : ` ⚡≤${res.credits}`;
  badge.title = res.exact
    ? ''
    : `Upper bound — a discount is active (${res.reasons.join(', ')}) and PixVerse `
      + 'does not publish what it multiplies by. The real cost is at most this.';

  // Affordability. Checked against the upper bound, which is the right side to
  // be wrong on: it may say you can't afford something you narrowly can, and it
  // will never let you fire a job that bounces.
  if (res.balance != null && res.credits > res.balance) {
    $('go').disabled = true;
    readout(`needs ⚡${res.credits}, you have ⚡${res.balance}`, 'is-bad');
  }
}

function idleReadout() {
  const missing = SLOTS_NEEDED[state.mode].filter((k) => !state.frames[k]);

  if (missing.length) {
    const what = missing.length === 2
      ? 'both frames'
      : `a ${missing[0] === 'last' ? 'last' : 'source'} frame`;
    readout(`idle · pick ${what}`);
    $('go').disabled = true;
    return;
  }

  const bits = state.mode === 'image'
    ? [$('model').value, $('quality').value, $('ratio').value]
    : [$('model').value, $('quality').value, `${$('duration').value}s`];

  // Only frames carries audio/preview — the i2v capture had neither field.
  if (state.mode === 'frames') {
    if (state.audio) bits.push('audio');
    if (state.preview) bits.push('preview');
  }
  if (state.mode === 'animate' && state.multiShot) bits.push('multi-shot');
  if (state.mode === 'frames' && state.offPeak) bits.push('off-peak');

  readout(`ready · ${bits.join(' · ')} · seed ${$('seed').value} · ×${$('count').value}`);
  $('go').disabled = false;
  refreshCost();
}

function runningReadout() {
  const secs = Math.floor((Date.now() - state.runningSince) / 1000);
  const mm = String(Math.floor(secs / 60)).padStart(2, '0');
  const ss = String(secs % 60).padStart(2, '0');
  readout(`rendering · ${mm}:${ss} · ${$('model').value} · seed ${$('seed').value}`, 'is-running');
}

// ---------- mode ----------

function setMode(mode, { reload = true } = {}) {
  // Park the outgoing tab's whole form before switching away from it.
  if (state.mode && state.mode !== mode) state.forms[state.mode] = captureForm();
  state.mode = mode;

  document.querySelectorAll('.mode').forEach((b) =>
    b.classList.toggle('is-on', b.dataset.mode === mode));

  // Second slot is for the last frame — frames mode only.
  document.querySelector('[data-slot="last"]').classList.toggle('is-hidden', mode !== 'frames');
  document.querySelector('[data-slot="first"] .slot-hint').textContent =
    mode === 'frames' ? 'First frame' : 'Source';

  $('ratio-field').classList.toggle('is-hidden', mode !== 'image');
  $('duration-field').classList.toggle('is-hidden', mode === 'image');
  // Per-toggle, not per-row. The row used to be shown only for frames, which
  // was fine while it held audio and preview — both frames-only — and became a
  // bug the moment multi-shot was added, because multi_shot applies ONLY to
  // animate. The control existed, was wired end to end, and was invisible in the
  // one mode where it did anything.
  //
  // Which toggle belongs to which mode is decided by the CAPTURED PAYLOADS, not
  // by what the site's own composer shows. `off_peak` and `audio` appear in the
  // captured frames request; neither appears in the captured i2v request, and
  // sending a field we have never seen on the wire is how this project has
  // broken requests before.
  for (const [id, modes] of Object.entries(TOGGLE_MODES)) {
    $(id).classList.toggle('is-hidden', !modes.includes(mode));
  }
  $('video-toggles').classList.toggle(
    'is-hidden',
    !Object.values(TOGGLE_MODES).some((modes) => modes.includes(mode)),
  );

  $('model').innerHTML = MODELS[mode].map((m) => `<option>${m}</option>`).join('');
  $('quality').innerHTML = QUALITIES[mode]
    .map((q) => `<option${q === '1080p' ? ' selected' : ''}>${q}</option>`)
    .join('');

  // Dropdowns exist now, so the stored values will stick.
  applyForm(state.forms[mode]);

  idleReadout();
  if (reload) loadReel();
}

// ---------- frame picker ----------

// How many tiles to add per page. The whole library is fetched once — it is
// mostly the local archive, so a second round trip buys nothing — but rendering
// several thousand <img> elements at once does not end well. Paged instead.
const PICKER_PAGE = 60;
let pickerItems = [];   // every usable item from the last fetch
let pickerShown = 0;    // how many are currently in the DOM

async function openPicker(slot) {
  state.slotBeingPicked = slot;
  $('picker').classList.remove('is-hidden');
  $('tiles').innerHTML = '<li class="empty">Loading…</li>';
  $('tiles-more').classList.add('is-hidden');
  pickerItems = [];
  pickerShown = 0;

  // send() resolves with { ok: false } rather than rejecting, so the timeout
  // path lands in the same branch as any other failure.
  const res = await send({ type: 'library/list', tab: 'image', limit: 60, max: 5000 });
  if (!res?.ok) {
    $('tiles').innerHTML = `<li class="empty">${res?.error ?? 'Could not reach the library.'} Paste a path below meanwhile.</li>`;
    return;
  }

  // Resolve every item up front so paging is pure DOM work afterwards.
  const skipped = [];
  for (const item of res.items) {
    const src = decodeMediaUrl(item.url ?? item.image_url ?? item.img_url ?? '');
    // image_path (generated) and path (uploaded) are both real, verified fields;
    // they only matter if the URL isn't on the media host.
    const path = pathFromMediaUrl(src) ?? item.image_path ?? item.path ?? item.img_path ?? null;
    if (!path || !src) { skipped.push(item); continue; }
    pickerItems.push({ src, path });
  }

  $('tiles').innerHTML = '';

  if (!pickerItems.length) {
    if (!res.items.length) {
      $('tiles').innerHTML = '<li class="empty">The library returned no images. Paste a path or URL below.</li>';
    } else {
      // Items came back but none were readable — a field-shape problem, not an
      // empty library. These used to print the same sentence, which made the
      // difference impossible to report.
      $('tiles').innerHTML =
        `<li class="empty">${res.items.length} item(s) returned, none with a usable image URL. `
        + `See the console for the raw shape, or paste a path below.</li>`;
      console.warn('[FrameRoom] library items the picker could not read. First one:',
        JSON.stringify(skipped[0], null, 2));
    }
    return;
  }

  showMoreTiles();
}

function showMoreTiles() {
  const frag = document.createDocumentFragment();
  const upto = Math.min(pickerShown + PICKER_PAGE, pickerItems.length);

  for (let i = pickerShown; i < upto; i++) {
    const { src, path } = pickerItems[i];
    const li = document.createElement('li');
    const img = document.createElement('img');
    // Thumbnail for the tile; picking still hands over the full image.
    img.src = thumbUrl(src);
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.addEventListener('error', () => {
      if (img.dataset.full) return; // already fell back once
      img.dataset.full = '1';
      img.src = src;
    });
    img.addEventListener('click', () => useFrame(path, src));
    li.append(img);
    frag.append(li);
  }

  $('tiles').append(frag);
  pickerShown = upto;

  const remaining = pickerItems.length - pickerShown;
  const more = $('tiles-more');
  more.textContent = `Load ${Math.min(PICKER_PAGE, remaining)} more · ${remaining} left`;
  more.classList.toggle('is-hidden', remaining === 0);
}

$('tiles-more').addEventListener('click', showMoreTiles);

// The media host is Aliyun OSS and resizes on request. The picker can show
// hundreds of images at thumbnail size; fetching the originals to do that is a
// few MB each for no visible gain.
//
// Display only — never stored, never sent in a payload. It is a query string,
// which canonicalUrl strips, so identity is unaffected.
const THUMB_STYLE = 'style/cover-webp-small';

function thumbUrl(url) {
  if (!url || /\.mp4(?:$|[?#])/i.test(url)) return url;
  if (url.includes('x-oss-process')) return url;
  return `${url}${url.includes('?') ? '&' : '?'}x-oss-process=${THUMB_STYLE}`;
}

// Storage path from a media URL — the inverse of mediaUrlFromPath. Works for
// uploads (upload/<uuid>.png) and generations (pixverse/i2i/ori/<uuid>.jpg)
// without depending on field names never verified against a real payload.
function pathFromMediaUrl(u) {
  const decoded = decodeMediaUrl(String(u ?? ''));
  const prefix = `${MEDIA}/`;
  if (!decoded.startsWith(prefix)) return null;
  const rest = decoded.slice(prefix.length).split(/[?#]/)[0];
  return rest || null;
}

function useFrame(path, previewSrc, { slot = state.slotBeingPicked || 'first', verify = true } = {}) {
  const el = document.querySelector(`[data-slot="${slot}"]`);

  const commit = (src) => {
    state.frames[slot] = path;
    state.framePreviews[slot] = src ?? null;
    state.forms[state.mode] = captureForm();
    el.classList.add('is-set');
    if (src) el.style.backgroundImage = `url("${src}")`;
    $('picker').classList.add('is-hidden');
    idleReadout();
  };

  if (!previewSrc) return commit(null);

  // Rerun passes verify:false — the path came from a generation that actually
  // ran, so it's valid for the API even if the CDN won't serve us a preview.
  if (!verify) return commit(previewSrc);

  // Load the image before trusting it. A bad path or hotlink-blocked URL fails
  // here instead of silently sitting empty, and we say which it was.
  const probe = new Image();
  probe.onload = () => commit(previewSrc);
  probe.onerror = () => {
    el.style.backgroundImage = '';
    el.classList.remove('is-set');
    state.frames[slot] = null;
    $('picker').classList.add('is-hidden');
    readout("that image wouldn't load · check the path", 'is-bad');
    $('go').disabled = true;
  };
  probe.src = previewSrc;
}

function clearSlot(slot) {
  state.frames[slot] = null;
  state.framePreviews[slot] = null;
  const el = document.querySelector(`[data-slot="${slot}"]`);
  el.classList.remove('is-set');
  el.style.backgroundImage = '';
}

// Load a past render's settings back into the form. Deliberately does NOT
// submit — you get the exact setup to tweak and fire yourself. The seed comes
// back too, so an untouched rerun reproduces the original; hit reroll for a
// variation.
function rerun({ mode, params, prompt }) {
  if (!params) return;

  // Reloading the reel is only needed if the mode changed (it filters by output
  // type). Skipping it otherwise keeps the tile you just clicked alive.
  setMode(mode, { reload: mode !== state.mode });

  $('prompt').value = prompt ?? '';
  if (params.model) $('model').value = params.model;
  if (params.quality) $('quality').value = params.quality;
  if (params.seed != null) $('seed').value = params.seed;
  if (params.count != null) $('count').value = String(params.count);

  if (mode === 'image') {
    if (params.aspectRatio) $('ratio').value = params.aspectRatio;
  } else if (params.duration != null) {
    $('duration').value = String(params.duration);
  }

  // Toggles only exist for frames; reset them otherwise so state can't leak
  // across a mode switch.
  setToggle('t-audio', 'audio', mode === 'frames' && Boolean(params.audio));
  setToggle('t-preview', 'preview', mode === 'frames' && Boolean(params.previewMode));
  setToggle('t-offpeak', 'offPeak', mode === 'frames' && Boolean(params.offPeak));

  // Multi-shot only exists on animate. Reset on every load so a value from one
  // rerun can't leak into an unrelated fresh generation.
  setToggle('t-multishot', 'multiShot', mode === 'animate' && Boolean(params.multiShot));
  state.forms[mode] = captureForm(); // rerun targets this mode specifically

  clearSlot('first');
  clearSlot('last');

  const first = params.imagePath ?? params.firstPath;
  if (first) useFrame(first, mediaUrlFromPath(first), { slot: 'first', verify: false });
  if (params.lastPath) {
    useFrame(params.lastPath, mediaUrlFromPath(params.lastPath), { slot: 'last', verify: false });
  }

  idleReadout();
}

// ---------- rerun from browse ----------

// The browse page stashes a flat rerun payload; adapt it to rerun()'s shape and
// apply it. If the generation belongs to a different account than the active
// one, offer to switch first — the source frames live on that account's
// storage, and generating under the wrong account would fail or bill the wrong
// balance.
async function applyPendingRerun() {
  const res = await send({ type: 'rerun/take' });
  const p = res?.rerun;
  if (!p) return;

  // Nothing to check here. Source paths are portable across accounts — an image
  // generated under one works as a source under another, no re-upload — and
  // credits come from whichever account is active, which is the point of running
  // several. Earlier versions blocked on a confirm() offering to switch, then
  // downgraded it to a note; both were solving a problem that doesn't exist, and
  // the note cost an auth/status round-trip on every rerun to say so.

  rerun({
    mode: p.mode,
    prompt: p.prompt,
    params: {
      model: p.model,
      quality: p.quality,
      seed: p.seed,
      duration: p.duration,
      aspectRatio: p.aspectRatio,
      audio: p.audio,
      previewMode: p.previewMode,
      multiShot: p.multiShot,
      firstPath: p.firstPath,
      lastPath: p.lastPath,
    },
  });

  readout('loaded from browse · tweak and generate');
}

// Pick up a pending rerun on load, and whenever the panel regains focus (the
// user may stash one from the browse tab while the panel is already open).
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) applyPendingRerun();
});

function buildParams(seed, count) {
  const prompt = $('prompt').value;
  const model = $('model').value;
  const quality = $('quality').value;

  if (state.mode === 'image') {
    return {
      imagePath: state.frames.first,
      prompt, model, count, seed, quality,
      aspectRatio: $('ratio').value,
      creditChange: 1, // server-authoritative; value is ignored server-side
    };
  }

  if (state.mode === 'animate') {
    // Exact field set from the captured /video/i2v call.
    return {
      imagePath: state.frames.first,
      prompt, model, count, quality,
      duration: Number($('duration').value),
      seed,
      // The API wants 0/1; the toggle holds a boolean. Number() bridges both,
      // and also the legacy 0/1 that older parked forms may still carry.
      multiShot: Number(state.multiShot) || 0,
      creditChange: 1, // server-authoritative
    };
  }

  // frames
  return {
    firstPath: state.frames.first,
    lastPath: state.frames.last,
    prompt, model, count, quality,
    duration: Number($('duration').value),
    seed,
    audio: state.audio ? 1 : 0,
    previewMode: state.preview ? 1 : 0,
    offPeak: state.offPeak ? 1 : 0,
  };
}

async function generate() {
  const seed = Number($('seed').value) || randomSeed();
  const count = Number($('count').value);
  const params = buildParams(seed, count);

  const res = await send({
    type: 'job/submit',
    job: { mode: state.mode, prompt: $('prompt').value, params },
  });

  if (!res?.ok) {
    readout(res?.error ?? 'Could not start the render.', 'is-bad');
    return;
  }

  // The job record exists by now, so a plain reel refresh renders its
  // placeholder — no separate DOM-only path to fall out of sync.
  loadReel();

  // Go stays enabled. The worker limits concurrency per account and queues the
  // rest, so blocking the button here just prevented the parallel work it
  // already supports — including submitting under one account, switching, and
  // submitting under another.
  state.runningSince = Date.now();
  runningReadout();
  clearInterval(tick);
  tick = setInterval(runningReadout, 1000);
}

// A placeholder shown from submit until the finished media lands. Keyed by job
// id so job/update events can find and update it, and so loadReel() can drop it.
// Build a placeholder from a job record. Derived, not stashed: the reel is
// rebuilt from scratch on every mode switch, so a tile that only existed in the
// DOM vanished the moment you left the tab and came back.
function buildPendingTile(job) {
  const li = document.createElement('li');
  li.className = 'tile is-pending';
  li.dataset.pendingId = job.id ?? 'pending';
  li.innerHTML = `
    <div class="pending-body">
      <div class="spinner"></div>
      <div class="pending-label"></div>
      <div class="pending-prompt"></div>
    </div>`;
  li.querySelector('.pending-prompt').textContent = job.prompt || '';
  li.querySelector('.pending-label').textContent = pendingLabel(job);

  // Rerun while it renders. The job record holds mode and params from the
  // moment it was submitted, so nothing has to wait for the render, which is
  // the point when you want the same generation under a second account.
  //
  // OPEN appears as soon as the poller has seen an asset row. That happens well
  // before the job is declared done, and when the readiness probe gets it wrong
  // (it has) this link is the only route to a render that actually finished.
  if (job.params || job.seenUrls?.length) {
    const bar = document.createElement('div');
    bar.className = 'tile-url';
    addPendingOpen(bar, job);
    const again = document.createElement('button');
    again.type = 'button';
    again.className = 'tile-copy';
    again.textContent = 'rerun';
    again.title = 'Load these settings into the form — switch account first to run it elsewhere';
    again.addEventListener('click', () => {
      rerun({ mode: job.mode, params: job.params, prompt: job.prompt });
      again.textContent = 'loaded';
      setTimeout(() => { again.textContent = 'rerun'; }, 1200);
    });
    if (job.params) bar.append(again);
    li.append(bar);
  }

  return li;
}

// The URL arrives mid-render, so this is called both when the tile is built and
// again on every job/update until one shows up.
function addPendingOpen(bar, job) {
  const url = job.seenUrls?.[0];
  if (!url || bar.querySelector('.tile-open')) return;
  const open = document.createElement('a');
  open.href = url;
  open.target = '_blank';
  open.rel = 'noopener';
  open.className = 'tile-open';
  open.textContent = 'open';
  open.title = `${url}\n\nThe file is listed but not yet confirmed by the readiness check.`;
  bar.prepend(open);
}

// The job goes straight to 'running' on submit — there is no separate 'queued'
// state — and a queue position, when the backend reports one, arrives during
// the poll while state is already 'running'. So key the label on the queue
// field, not the state.
function pendingLabel(job) {
  const n = job.queue?.queued;
  if (n) return `queued · ${n} ahead`;
  return job.state === 'running' ? 'rendering…' : 'starting…';
}

// Update a pending tile's label from a job record's state/queue. Note the job
// goes straight to 'running' on submit — there's no separate 'queued' state —
// and queue position (if the backend reports one) arrives during the poll while
// state is already 'running'. So key the label on the queue field, not state.
function updatePendingTile(job) {
  const li = $('reel').querySelector(`.tile.is-pending[data-pending-id="${job.id}"]`);
  if (!li) return;
  li.querySelector('.pending-label').textContent = pendingLabel(job);

  // A URL can appear at any point during the render, so keep checking.
  const bar = li.querySelector('.tile-url');
  if (bar) addPendingOpen(bar, job);
}

// A failed job's placeholder shouldn't spin forever. Mark it, and let the next
// reel load (or a retry) clear it.
function markPendingFailed(job) {
  const reel = $('reel');
  const li = reel.querySelector(`.tile.is-pending[data-pending-id="${job.id}"]`);
  if (!li) return;
  li.classList.remove('is-pending');
  li.classList.add('is-failed');
  li.innerHTML = '<div class="pending-body"><div class="pending-label">render failed</div></div>';
}

// ---------- reel ----------

// How many past renders to keep on screen. Older ones aren't deleted — the
// worker still holds the last 60 job records — they're just not rendered, which
// also avoids spinning up video elements nobody's looking at.
const REEL_LIMIT = 6;

// Object URLs we mint for rescued videos — revoked on the next reel load so
// they don't pile up in memory.
let objectUrls = [];
function revokeObjectUrls() {
  for (const u of objectUrls) URL.revokeObjectURL(u);
  objectUrls = [];
}

// Show a short failure note on a tile WITHOUT removing anything — the media
// element dims and the open/copy URL controls stay usable.
function showTileNote(li, detail) {
  li.querySelector('video, img')?.classList.add('is-broken');
  let note = li.querySelector('.tile-note');
  if (!note) {
    note = document.createElement('span');
    note.className = 'tile-note';
    li.insertBefore(note, li.querySelector('.tile-url'));
  }
  note.textContent = detail;
}

// media.pixverse.ai is inconsistent about how objects are addressed: some sit
// at a real path (pixverse/mp4/...) and some at a key whose separators are
// literally %2F. Critically, Chrome's address bar does NOT decode %2F when you
// navigate — so a URL that "worked when pasted in a tab" may have been the
// encoded spelling all along. Rather than bet on either, try both.
function mediaCandidates(url) {
  const raw = String(url);
  const decoded = raw.replace(/%2F/gi, '/');
  const m = decoded.match(/^(https?:\/\/[^/]+)\/(.+)$/);
  const encoded = m ? `${m[1]}/${m[2].split('/').map(encodeURIComponent).join('%2F')}` : null;
  return [...new Set([raw, decoded, encoded].filter(Boolean))];
}

// A direct <video src> load can fail even when the file is fine: CSP, CDN
// hotlink protection, or the wrong URL spelling all surface identically as
// MEDIA_ERR_SRC_NOT_SUPPORTED (code 4).
//
// The panel holds host_permissions for media.pixverse.ai, so fetch() here is
// CORS-exempt. Pull the bytes ourselves and hand the element a blob it can't
// refuse — trying each URL spelling until one answers.
//
// Everything logged here is a plain string: chrome://extensions renders a
// logged object as "[object Object]", which hides the very status we need.
async function rescueVideo(media, url, li, attempt = 0) {
  const candidates = mediaCandidates(url);
  const failures = [];

  for (const candidate of candidates) {
    try {
      const res = await fetch(candidate, { cache: 'no-store' });
      if (!res.ok) {
        failures.push(`HTTP ${res.status}`);
        frDebug(`[FrameRoom] media fetch: HTTP ${res.status} — ${candidate}`);
        continue;
      }

      const blob = await res.blob();
      const objUrl = URL.createObjectURL(blob);
      objectUrls.push(objUrl);
      media.classList.remove('is-broken');
      li.querySelector('.tile-note')?.remove();
      media.src = objUrl;
      media.load?.(); // <img> has neither load() nor play()
      media.play?.().catch(() => {});
      frDebug(`[FrameRoom] recovered via blob (${blob.type || 'unknown type'}, ${blob.size} bytes) — ${candidate}`);
      return;
    } catch (err) {
      const msg = err?.message || 'fetch threw';
      failures.push(msg);
      frDebug(`[FrameRoom] media fetch threw: ${msg} — ${candidate}`);
    }
  }

  // A 404 usually means "not written yet" rather than "wrong URL": both the
  // asset row and its URL exist from the moment a job is submitted, the render
  // may queue first, and the site's progress bar lies about completion. So keep
  // checking for a while before calling it dead — the old behaviour probed once
  // at render time and froze that result, which is why finished videos sat
  // showing HTTP 404 while OPEN worked fine.
  const RETRIES = [8_000, 20_000, 45_000, 90_000];
  if (attempt < RETRIES.length) {
    const wait = RETRIES[attempt];
    showTileNote(li, `not ready · retrying in ${Math.round(wait / 1000)}s`);
    setTimeout(() => {
      if (!li.isConnected) return; // tile was re-rendered; drop this timer
      rescueVideo(media, url, li, attempt + 1);
    }, wait);
    return;
  }

  showTileNote(li, `${failures[0] ?? 'unavailable'} · try OPEN`);
  console.error(`[FrameRoom] gave up after ${attempt} retries for ${url} — ${failures.join(' | ')}`);
}

async function loadReel() {
  const { jobs = [] } = await send({ type: 'job/list' });
  const want = OUTPUT[state.mode]; // show renders whose media type matches
  const done = jobs.filter((j) => jobOutput(j) === want && j.state === 'done');
  // In-flight jobs for this mode render as placeholders, from the same source
  // of truth as everything else.
  const pending = jobs.filter((j) => jobOutput(j) === want && (j.state === 'queued' || j.state === 'running'));
  const reel = $('reel');

  if (!done.length && !pending.length) {
    reel.innerHTML = '<li class="empty">Nothing rendered yet.</li>';
    $('renders-label').textContent = 'Renders';
    return;
  }

  // Flatten job → results into one newest-first list. Jobs arrive newest-first
  // (the worker unshifts new records), so order carries through.
  const all = [];
  for (const job of done) {
    const isVideo = jobOutput(job) === 'video';
    for (const r of job.results) {
      if (!r.url) continue; // no resolvable URL (webp not written yet) — skip
      all.push({
        url: decodeMediaUrl(r.url), // records before 0.14 stored the %2F form
        prompt: job.prompt,
        isVideo,
        mode: job.mode ?? job.kind, // old records used `kind`
        params: job.params ?? null, // absent on records made before 0.10
      });
    }
  }

  // The limit is on the reel, not on the finished half of it. Placeholders were
  // prepended on top of a full six, so anything in flight made it seven.
  //
  // In-flight work takes the slots it needs and finished renders fill the rest:
  // a placeholder is the thing you are actually waiting on.
  const shownPending = pending.slice(0, REEL_LIMIT);
  const shown = all.slice(0, Math.max(0, REEL_LIMIT - shownPending.length));

  // Say so when there are more, otherwise it looks like renders went missing.
  const total = all.length + pending.length;
  const showing = shown.length + shownPending.length;
  $('renders-label').textContent = total > showing
    ? `Renders · ${showing} of ${total}`
    : 'Renders';

  reel.innerHTML = '';
  revokeObjectUrls(); // previous tiles are gone; release their blobs

  // In-flight first — newest work at the top, same as the job list order.
  for (const job of shownPending) reel.append(buildPendingTile(job));
  for (const { url, prompt, isVideo, mode, params } of shown) {
    const li = document.createElement('li');
    li.className = 'tile';

    // The media element (video or image).
    let media;
    if (isVideo) {
      media = document.createElement('video');
      media.src = url;
      media.muted = true;
      media.autoplay = true;
      media.loop = true;
      media.playsInline = true;
      media.preload = 'metadata';
      media.addEventListener('error', () => {
        const code = media.error?.code;
        const name = { 1: 'aborted', 2: 'network', 3: 'decode', 4: 'unsupported/blocked' }[code] ?? 'unknown';
        frDebug(`[FrameRoom] direct load failed (code ${code} — ${name}), trying fetch: ${media.src}`);
        // Don't give up here — fetch the bytes and retry via a blob URL.
        rescueVideo(media, url, li);
      }, { once: true });
      media.play?.().catch(() => { /* the error handler above does the recovery */ });
    } else {
      media = document.createElement('img');
      media.src = url;
      media.alt = '';
      // Images get the same treatment as video: a 404 here usually means the
      // render has not been written yet, not that the URL is wrong. Without
      // this the tile kept a broken glyph forever.
      media.addEventListener('error', () => {
        frDebug(`[FrameRoom] image load failed, retrying: ${media.src}`);
        rescueVideo(media, url, li);
      }, { once: true });
    }
    media.title = prompt;
    li.append(media);

    // URL / action controls — ALWAYS present, even if the media never paints.
    const bar = document.createElement('div');
    bar.className = 'tile-url';

    if (url) {
      const open = document.createElement('a');
      open.href = url;
      open.target = '_blank';
      open.rel = 'noopener';
      open.className = 'tile-open';
      open.textContent = 'open';
      open.title = url;
      bar.append(open);
    }

    // Rerun needs the stored params; records made before 0.10 don't have them.
    if (params) {
      const again = document.createElement('button');
      again.type = 'button';
      again.className = 'tile-copy';
      again.textContent = 'rerun';
      again.title = 'Load these settings into the form (does not generate)';
      again.addEventListener('click', () => {
        rerun({ mode, params, prompt });
        again.textContent = 'loaded';
        setTimeout(() => { again.textContent = 'rerun'; }, 1200);
      });
      bar.append(again);
    }

    // An i2i result already contains both ends of a transition: the image it was
    // made FROM and the image it became. Loading them by hand means switching
    // tab, opening the picker twice, and finding the original again among
    // thousands — for information the record already has.
    const sourcePath = params?.imagePath;
    if (!isVideo && sourcePath && url) {
      const outPath = pathFromMediaUrl(url);
      if (outPath) {
        const toVideo = document.createElement('button');
        toVideo.type = 'button';
        toVideo.className = 'tile-copy';
        toVideo.textContent = '→ frames';
        toVideo.title = 'Frames mode, source as first frame and this result as last';
        toVideo.addEventListener('click', () => {
          setMode('frames');
          useFrame(sourcePath, mediaUrlFromPath(sourcePath), { slot: 'first', verify: false });
          useFrame(outPath, url, { slot: 'last', verify: false });
          $('prompt').value = prompt ?? '';
          state.forms.frames = captureForm();
          readout('first + last set · add a prompt and generate');
          toVideo.textContent = 'loaded';
          setTimeout(() => { toVideo.textContent = '→ frames'; }, 1200);
        });
        bar.append(toVideo);
      }
    }

    if (bar.children.length) li.append(bar);

    reel.append(li);
  }
}

// ---------- events ----------

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'auth/state') paintLink(msg);

  // A token renewed itself in the background. Repaint the header, or it keeps
  // showing the old expiry — and an expiry that never moves is exactly how you
  // would fail to notice that renewal had quietly stopped working.
  if (msg.type === 'auth/renewed') {
    send({ type: 'auth/status' }).then(paintLink);
    readout(`Renewed ${msg.username}`);
  }

  if (msg.type === 'credits/stale') loadCredits();

  // A rerun was just stashed from the browse tab — apply it now rather than
  // waiting for the panel to be re-focused.
  if (msg.type === 'rerun/ready') applyPendingRerun();

  if (msg.type === 'job/update') {
    if (msg.job.state === 'queued' || msg.job.state === 'running') {
      updatePendingTile(msg.job);
    }
    if (msg.job.state === 'done') {
      clearInterval(tick);
      idleReadout();
      loadReel(); // replaces the pending tile with the finished media
    }
    if (msg.job.state === 'failed') {
      clearInterval(tick);
      readout(msg.job.error, 'is-bad');
      markPendingFailed(msg.job);
    }
  }
});

function paintLink({ linked, username, expiresAt }) {
  const dot = $('link-dot');
  const label = $('link-label');

  if (!linked) {
    dot.className = 'dot is-dead';
    label.textContent = 'not linked';
    $('credit-total').textContent = '—';
    return;
  }

  const days = expiresAt ? Math.floor((expiresAt - Date.now()) / 86_400_000) : null;
  dot.className = 'dot is-live';
  label.textContent = days != null && days < 7
    ? `${username ?? 'linked'} · ${days}d left`
    : (username ?? 'linked');

  loadCredits(); // linked → we can pull a balance
}

// The header total is the spendable sum (daily + monthly + package). The hover
// tooltip breaks out each bucket, plus renewal_credits (added at renewal, not
// part of the current spendable balance).
async function loadCredits() {
  const res = await send({ type: 'credits/get' });
  if (!res?.ok) {
    $('credit-total').textContent = '—';
    $('credit-chip').title = res?.error ?? 'Could not read credits.';
    return;
  }

  const { total, breakdown } = res.credits;
  $('credit-total').textContent = total;
  $('credit-chip').classList.toggle('is-low', total < 20);
  $('credit-chip').title =
    `daily ${breakdown.daily} · monthly ${breakdown.monthly} · package ${breakdown.package}` +
    `\nrenewal ${breakdown.renewal} (added at renewal, not spendable now)`;
}

document.querySelectorAll('.mode').forEach((b) =>
  b.addEventListener('click', () => setMode(b.dataset.mode)));

document.querySelectorAll('.slot').forEach((b) =>
  b.addEventListener('click', () => openPicker(b.dataset.slot)));

$('picker-close').addEventListener('click', () => $('picker').classList.add('is-hidden'));

$('manual-use').addEventListener('click', () => {
  const raw = $('manual-path').value.trim();
  if (!raw) return;
  const { path, preview } = resolveFrameInput(raw);
  useFrame(path, preview);
});

// Upload a local image and use it as the current slot's source.
//
// The File itself cannot be sent to the worker — structured clone drops it — so
// it is read here into a data URL and rebuilt into a Blob on the other side.
// That does mean the bytes pass through a string, which is why the size cap
// below is deliberate rather than incidental: a very large image would produce
// a base64 payload a third larger again for no benefit, and PixVerse sources
// are screenshots and stills, not RAW files.
const UPLOAD_MAX_BYTES = 20 * 1024 * 1024;

// PixVerse rejects any image with a side over 4000px, and it does so at
// REGISTRATION — after the bytes have already been pushed to OSS. So the whole
// upload completes, then fails with "incorrect image width or height", which is
// both slow and baffling. Found by bisecting the live API: 4000 passes, 4001
// fails, per-side rather than by area.
//
// Downscaling to fit is the right answer rather than refusing the file. The cap
// is far above anything PixVerse generates (1080p), so a source larger than this
// carries no usable detail into the result — and the alternative is telling
// someone their perfectly ordinary phone photo is unacceptable. It is said out
// loud in the status line rather than done silently.
const MAX_IMAGE_SIDE = 4000;

function readAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error('Could not read the file'));
    r.readAsDataURL(file);
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Not a readable image'));
    img.src = src;
  });
}

// Returns { dataUrl, width, height, scaledFrom } — scaledFrom set only when the
// image had to be resampled.
async function prepareUpload(file) {
  const original = await readAsDataURL(file);
  const img = await loadImage(original);
  const longest = Math.max(img.width, img.height);
  if (longest <= MAX_IMAGE_SIDE) {
    return { dataUrl: original, width: img.width, height: img.height, scaledFrom: null };
  }

  const scale = MAX_IMAGE_SIDE / longest;
  const width = Math.round(img.width * scale);
  const height = Math.round(img.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').drawImage(img, 0, 0, width, height);

  // PNG only for PNG sources — re-encoding a photo as PNG would balloon it, and
  // the bytes travel to the worker as base64.
  const type = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
  return {
    dataUrl: canvas.toDataURL(type, 0.92),
    width,
    height,
    scaledFrom: `${img.width}×${img.height}`,
  };
}

$('upload-file').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const msg = $('upload-msg');
  const input = e.target;

  if (file.size > UPLOAD_MAX_BYTES) {
    msg.textContent = `Too large (${Math.round(file.size / 1e6)} MB). Limit is 20 MB.`;
    input.value = '';
    return;
  }

  input.disabled = true;
  msg.textContent = `Uploading ${file.name}…`;

  try {
    const prepared = await prepareUpload(file);
    if (prepared.scaledFrom) {
      msg.textContent = `Resizing ${prepared.scaledFrom} → ${prepared.width}×${prepared.height}…`;
    }

    const res = await send({
      type: 'upload/image',
      dataUrl: prepared.dataUrl,
      fileName: file.name,
    });
    if (!res?.ok) throw new Error(res?.error ?? 'Upload failed');

    // The registered `path` is exactly what customer_img_path(s) wants, so the
    // uploaded image drops straight into the slot the picker was opened for.
    useFrame(res.result.path, mediaUrlFromPath(res.result.path), { verify: false });
    msg.textContent = prepared.scaledFrom
      ? `Uploaded ${res.result.width}×${res.result.height} (resized from ${prepared.scaledFrom})`
      : `Uploaded ${res.result.width}×${res.result.height}`;
    $('picker').classList.add('is-hidden');
  } catch (err) {
    msg.textContent = String(err.message || err);
  } finally {
    input.disabled = false;
    input.value = ''; // so re-picking the same file fires change again
  }
});

$('reroll').addEventListener('click', () => {
  $('seed').value = randomSeed();
  idleReadout();
});

['model', 'quality', 'ratio', 'duration', 'count', 'seed'].forEach((id) =>
  $(id).addEventListener('change', idleReadout));

// Set a toggle to an explicit value — used by both the click handler and rerun.
function setToggle(id, key, on) {
  state[key] = on;
  const btn = $(id);
  btn.setAttribute('aria-pressed', String(on));
  btn.querySelector('.toggle-state').textContent = on ? 'on' : 'off';
}

function bindToggle(id, key) {
  $(id).addEventListener('click', () => {
    setToggle(id, key, !state[key]);
    idleReadout();
  });
}
bindToggle('t-audio', 'audio');
bindToggle('t-preview', 'preview');
bindToggle('t-offpeak', 'offPeak');
// Multi-shot: "generate multi-shot video with model-native capabilities" — the
// site's own wording. It was previously reachable only by rerunning an old job
// that happened to carry it, since nothing ever set it for a fresh generation.
bindToggle('t-multishot', 'multiShot');

$('go').addEventListener('click', generate);

$('browse').addEventListener('click', () =>
  chrome.tabs.create({ url: chrome.runtime.getURL('browse.html') }));

// ---------- account switcher ----------

const acctMenu = () => $('acct-menu');

// Inline password entry, dropped in under the account row it belongs to.
//
// Deliberately not window.prompt(): a prompt gives no way to say what the
// password is about to be used for, and this is the one control in the panel
// whose consequences are worth spelling out on the spot. It is also the reason
// the warning line is here rather than buried in the README.
//
// The value goes straight to the service worker in one message and is never
// held in panel state, so it lives in this DOM node and nowhere else.
function showPasswordForm(row, username) {
  const existing = row.parentElement.querySelector('.acct-pwform');
  if (existing) existing.remove();

  const form = document.createElement('form');
  form.className = 'acct-pwform';

  const warn = document.createElement('div');
  warn.className = 'acct-pwwarn';
  warn.textContent = 'Stored in plaintext on this machine. A stolen password '
    + 'outlives every token rotation — only do this on a machine you trust.';

  const input = document.createElement('input');
  input.type = 'password';
  input.className = 'acct-pwinput';
  input.placeholder = `Password for ${username}`;
  input.autocomplete = 'off';

  const go = document.createElement('button');
  go.type = 'submit';
  go.className = 'acct-pwgo';
  go.textContent = 'Verify & save';

  const msg = document.createElement('div');
  msg.className = 'acct-pwmsg';

  form.append(warn, input, go, msg);
  row.after(form);
  input.focus();

  form.addEventListener('click', (e) => e.stopPropagation());
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!input.value) return;
    go.disabled = true;
    msg.textContent = 'Signing in…';
    // The worker logs in before storing anything, so a typo is caught now
    // rather than in a month when the renewal silently fails.
    const res = await send({ type: 'vault/savePassword', username, password: input.value });
    input.value = '';
    if (res?.ok) {
      msg.textContent = 'Saved. This account will renew itself.';
      setTimeout(() => { toggleAcctMenu(); toggleAcctMenu(); }, 700);
    } else {
      go.disabled = false;
      msg.textContent = res?.error ?? 'Could not sign in';
      msg.classList.add('is-bad');
    }
  });
}

async function toggleAcctMenu() {
  const menu = acctMenu();
  if (!menu.classList.contains('is-hidden')) {
    menu.classList.add('is-hidden');
    return;
  }

  menu.innerHTML = '<div class="acct-loading">Loading accounts…</div>';
  menu.classList.remove('is-hidden');

  const [status, vault] = await Promise.all([
    send({ type: 'auth/status' }),
    send({ type: 'vault/list' }),
  ]);
  const current = status?.username ?? null;
  const accounts = vault?.ok ? vault.accounts : [];

  menu.innerHTML = '';

  if (accounts.length) {
    for (const a of accounts) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'acct-row' + (a.username === current ? ' is-current' : '');

      const dot = document.createElement('span');
      dot.className = 'acct-dot';
      const name = document.createElement('span');
      name.className = 'acct-name';
      name.textContent = a.username;
      const meta = document.createElement('span');
      meta.className = 'acct-meta';
      if (a.expiresAt) {
        const days = Math.floor((a.expiresAt - Date.now()) / 86_400_000);
        // An expired account with a saved password isn't dead, it's one login
        // away — say "renew", not "expired", or the row reads as a dead end.
        meta.textContent = days < 0
          ? (a.canRenew ? 'renew' : 'expired')
          : `${days}d`;
      }
      if (a.canRenew) {
        meta.classList.add('acct-renewable');
        meta.title = 'Password saved — this account renews itself when the token expires';
      }

      row.append(dot, name, meta);
      row.addEventListener('click', async () => {
        if (a.username === current) { menu.classList.add('is-hidden'); return; }
        row.classList.add('is-switching');
        const res = await send({ type: 'vault/use', username: a.username });
        menu.classList.add('is-hidden');
        if (res?.ok) {
          send({ type: 'auth/status' }).then(paintLink);
          loadCredits();
        } else {
          readout(res?.error ?? 'Could not switch account', 'is-bad');
        }
      });

      // key (⚿) — save or drop the password that lets this account self-renew.
      const key = document.createElement('span');
      key.className = 'acct-key' + (a.canRenew ? ' is-on' : '');
      key.textContent = '⚿';
      key.title = a.canRenew
        ? 'Password saved on this machine — click to remove it'
        : 'Save this account’s password so it can renew itself';
      key.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (a.canRenew) {
          await send({ type: 'vault/forgetPassword', username: a.username });
          toggleAcctMenu();
          toggleAcctMenu();
          return;
        }
        showPasswordForm(row, a.username);
      });
      row.append(key);

      // forget (×)
      const forget = document.createElement('span');
      forget.className = 'acct-forget';
      forget.textContent = '×';
      forget.title = 'Forget this account';
      forget.addEventListener('click', async (e) => {
        e.stopPropagation();
        await send({ type: 'vault/forget', username: a.username });
        toggleAcctMenu(); // close
        toggleAcctMenu(); // reopen refreshed
      });
      row.append(forget);

      menu.append(row);
    }
    const sep = document.createElement('div');
    sep.className = 'acct-sep';
    menu.append(sep);
  } else {
    const empty = document.createElement('div');
    empty.className = 'acct-empty';
    empty.textContent = 'No saved accounts yet. Sign in to PixVerse and they appear here.';
    menu.append(empty);
  }

  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'acct-action';
  open.textContent = '+ Open PixVerse to add / switch';
  open.addEventListener('click', () => {
    menu.classList.add('is-hidden');
    chrome.tabs.create({ url: 'https://app.pixverse.ai/' });
  });
  menu.append(open);
}

$('link').addEventListener('click', (e) => {
  e.stopPropagation();
  toggleAcctMenu();
});

// Close the menu when clicking elsewhere.
document.addEventListener('click', (e) => {
  const menu = acctMenu();
  if (!menu.classList.contains('is-hidden') && !e.target.closest('.acct')) {
    menu.classList.add('is-hidden');
  }
});

// ---------- boot ----------

// Read from the manifest, never hardcode — a version string in two places is a
// version string that will disagree with itself.
$('version').textContent = `v${chrome.runtime.getManifest().version}`;

for (const id of ['prompt', 'seed', 'count', 'model', 'quality', 'duration', 'ratio']) {
  $(id)?.addEventListener('input', () => { state.forms[state.mode] = captureForm(); });
  $(id)?.addEventListener('change', () => { state.forms[state.mode] = captureForm(); });
}

$('seed').value = randomSeed();
setMode('image');
send({ type: 'auth/status' }).then(paintLink);
applyPendingRerun(); // a rerun may have been stashed from the browse tab
