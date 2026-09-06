// browse.js — full-library reels feed.
//
// MEMORY MODEL (the whole design constraint):
// A <video> holds decoded frames and network buffers for as long as it has a
// src. A few hundred of them with src set will eat gigabytes and stall the tab.
// So:
//   - every card renders only a lightweight <img> poster (the animated webp)
//   - <video> elements carry NO src until their card becomes the focused one
//   - when a card loses focus we pause, strip the src, and call load(), which
//     is what actually releases the buffer — removeAttribute alone does not
//   - exactly one card holds a src at a time
// The animated webp poster is why this still feels alive while scrolling: you
// get motion on every card without a single extra video decoder.

const feed = document.getElementById('feed');

// Routine recovery logging (see sidepanel.js for the rationale) — the blob
// fetch fallback runs for every video, so keep its steps out of the Errors tab.
const FR_DEBUG = false;
function frDebug(msg) {
  if (FR_DEBUG) console.debug(msg);
}
const counterEl = document.getElementById('counter');
const sourceEl = document.getElementById('source');
const accountsEl = document.getElementById('accounts');
const kindsEl = document.getElementById('kinds');
const originsEl = document.getElementById('origins');
const sortEl = document.getElementById('sort');
const modelsEl = document.getElementById('models');
const periodEl = document.getElementById('period');
const searchEl = document.getElementById('search');

// When a generation was made. createdAt is what the API reports; firstSeenAt is
// when this archive first laid eyes on it — they diverge, because a deep sweep
// discovers years-old generations today.
const madeAt = (v) => (v?.createdAt ? Date.parse(v.createdAt) || 0 : 0) || (v?.firstSeenAt ?? 0);
const foundAt = (v) => v?.firstSeenAt ?? madeAt(v);

const SORTS = {
  newest: (a, b) => madeAt(b) - madeAt(a),
  oldest: (a, b) => madeAt(a) - madeAt(b),
  found: (a, b) => foundAt(b) - foundAt(a),
  // Stable within a session: each record gets one random value at load, so
  // re-filtering or starring doesn't reshuffle the feed under you.
  shuffle: (a, b) => (a._shuffle ?? 0) - (b._shuffle ?? 0),
};

sortEl.onchange = () => {
  sortMode = sortEl.value;
  applyFilter();
};

// Uploaded media lives under upload/, generated output under pixverse/…. Derived
// at read time from whatever the record has, so archives written before origin
// was recorded still filter correctly — no migration needed.
// The media host is Aliyun OSS, which resizes on request via x-oss-process.
// The site's own thumbnails use this: a few kB instead of a few MB. At several
// thousand tiles that is the difference between a grid that loads and one that
// doesn't.
//
// Deliberately NOT stored on the record. It is a display concern, it is a query
// string (which canonicalUrl strips, so archive keys are unaffected), and
// changing the style later shouldn't need a migration.
//
// Videos are excluded — an image processor has nothing to do with an mp4. A
// video's poster is a still, so that gets thumbed like any other image.
// Two styles are known to work; there may be others. `-small` is soft above
// roughly 200px, so the larger grids ask for the bigger one — still a fraction
// of the original.
const THUMB_STYLES = {
  sm: 'style/cover-webp-small', // 110px columns, 190px rows
  md: 'style/cover-webp',       // 190px columns, 300px rows
  lg: 'style/cover-webp',       // 300px columns, 440px rows
};

// Aliyun can also grab a frame out of an mp4, which gives a poster to videos
// that have none — records imported from local files (a filename says nothing
// about a still frame) and any whose own poster never resolved.
//
// Width matters: without w_ the snapshot comes back at full video resolution,
// which is worse than no poster at all on a wall of tiles. h_0 keeps the aspect
// ratio. m_fast takes the nearest keyframe rather than decoding to an exact
// timestamp — much cheaper and, one second in, indistinguishable.
//
// Derived at display time, never stored: it is a query string, canonicalUrl
// strips those, so it cannot fork an archive record.
const SNAPSHOT_WIDTH = { sm: 220, md: 400, lg: 600 };

function videoPoster(url, width = SNAPSHOT_WIDTH.md) {
  if (!url || !/\.mp4(?:$|[?#])/i.test(url)) return null;
  if (url.includes('x-oss-process')) return url;
  return `${url}?x-oss-process=video/snapshot,t_1000,f_jpg,w_${width},h_0,m_fast`;
}

function thumbUrl(url, style = THUMB_STYLES.sm) {
  if (!url || /\.mp4(?:$|[?#])/i.test(url)) return url;
  if (url.includes('x-oss-process')) return url;
  return `${url}${url.includes('?') ? '&' : '?'}x-oss-process=${style}`;
}

function originOf(item) {
  if (item.origin) return item.origin;
  const s = String(item.path || item.url || '');
  if (/(^|\/)upload\//i.test(s)) return 'uploaded';
  if (/(^|\/)pixverse\//i.test(s)) return 'generated';
  return null;
}
const starFilterEl = document.getElementById('starfilter');

starFilterEl.addEventListener('click', () => {
  starredOnly = !starredOnly;
  starFilterEl.classList.toggle('is-on', starredOnly);
  starFilterEl.textContent = starredOnly ? '★ starred' : '☆ starred';
  applyFilter();
});
const stateEl = document.getElementById('state');

let allItems = [];   // everything from the archive
let items = [];      // what's currently rendered (after account filter)
let cards = [];
let activeIndex = -1;
let paused = false;
let counts = null;
let apiError = null;
let accountFilter = 'all';
let kindFilter = 'all';
let originFilter = 'all';
let sortMode = 'newest';
let viewMode = 'reel'; // 'reel' | 'sm' | 'md' | 'lg'
let starredOnly = false;
let modelFilter = 'all';
let periodDays = 'all';
let searchTerm = '';
let observer = null;
let verify = null;

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

// media.pixverse.ai addresses some objects at a real path and some at a key
// whose separators are literally %2F. Chrome's address bar doesn't decode %2F,
// so "it worked when I pasted it" doesn't tell us which spelling is correct.
// Try each in turn.
function mediaCandidates(url) {
  const raw = String(url);
  const decoded = raw.replace(/%2F/gi, '/');
  const m = decoded.match(/^(https?:\/\/[^/]+)\/(.+)$/);
  const encoded = m ? `${m[1]}/${m[2].split('/').map(encodeURIComponent).join('%2F')}` : null;
  return [...new Set([raw, decoded, encoded].filter(Boolean))];
}

function setState(text, bad = false) {
  stateEl.textContent = text;
  stateEl.className = `state${bad ? ' is-bad' : ''}`;
  stateEl.style.display = text ? '' : 'none';
}

// ---------- load ----------

async function load() {
  // send() resolves with { ok: false } on timeout or transport failure, so every
  // failure lands here rather than as an unhandled rejection.
  const res = await send({ type: 'library/all', max: 1000 });

  if (!res?.ok) {
    setState(res?.error ?? 'Could not load your library.', true);
    return;
  }

  allItems = res.items ?? [];
  for (const it of allItems) it._shuffle = Math.random();
  counts = res.counts ?? null;
  apiError = res.apiError ?? null;
  verify = res.verify ?? null;

  if (!allItems.length) {
    setState(
      apiError
        ? `No videos to show. The library call failed: ${apiError}`
        : 'No finished videos in your library yet.',
      Boolean(apiError),
    );
    return;
  }

  setState(''); // hide, but keep it in the DOM for empty-filter states
  buildAccountFilter();
  buildKindFilter();
  buildOriginFilter();
  buildModelFilter();
  applyFilter();
  paintSourceNote();
}

// Accounts come from the archive records themselves, so the list covers every
// login whose library has ever been seen — not just the one signed in now.
// Model is on every card already (buildMeta prints it); it just wasn't
// selectable. The value set is small and closed — archive-stats put it at seven
// across four thousand records — so a plain dropdown is the whole feature.
function buildModelFilter() {
  const names = [...new Set(allItems.map((i) => i.model).filter(Boolean))].sort();
  if (names.length < 2) return; // nothing to choose between

  modelsEl.innerHTML = '';
  const opts = [['all', `All models (${allItems.length})`]];
  for (const n of names) {
    opts.push([n, `${n} (${allItems.filter((i) => i.model === n).length})`]);
  }
  for (const [value, label] of opts) {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = label;
    modelsEl.append(o);
  }
  modelsEl.classList.remove('is-hidden');
  modelsEl.onchange = () => { modelFilter = modelsEl.value; applyFilter(); };
}

function buildAccountFilter() {
  const names = [...new Set(allItems.flatMap((i) => i.accounts ?? []))].sort();
  const untagged = allItems.filter((i) => !(i.accounts ?? []).length).length;

  // Nothing to choose between.
  if (names.length < 2 && !(names.length === 1 && untagged)) return;

  accountsEl.innerHTML = '';
  const opts = [['all', `All accounts (${allItems.length})`]];
  for (const n of names) {
    const count = allItems.filter((i) => (i.accounts ?? []).includes(n)).length;
    opts.push([n, `${n} (${count})`]);
  }
  // Records we can't attribute yet — mostly ones generated through the panel
  // before per-job attribution, or whose library hasn't been browsed since.
  // They stay reachable rather than being stranded outside every filter.
  if (untagged) opts.push(['__none__', `unattributed (${untagged})`]);

  for (const [value, label] of opts) {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = label;
    accountsEl.append(o);
  }
  accountsEl.classList.remove('is-hidden');
  // Assigned, not added: this runs on every load, and addEventListener would
  // stack a fresh handler each time so one change fired applyFilter N times.
  accountsEl.onchange = () => {
    accountFilter = accountsEl.value;
    applyFilter();
  };
  // Keep the visible selection in step with the filter actually in force —
  // rebuilding the options resets the <select> to its first entry, which is how
  // the dropdown ended up naming one account while the feed showed another's
  // count.
  if ([...accountsEl.options].some((o) => o.value === accountFilter)) {
    accountsEl.value = accountFilter;
  } else {
    accountFilter = 'all';
    accountsEl.value = 'all';
  }
}

// Videos and images live in one archive, so the feed mixes them. Same shape as
// the account filter: hidden when there is nothing to choose between, selection
// restored after a rebuild (a <select> silently resets to its first option).
function buildKindFilter() {
  const counts = { video: 0, image: 0 };
  for (const i of allItems) counts[i.kind === 'image' ? 'image' : 'video']++;
  if (!counts.video || !counts.image) return; // only one kind present

  kindsEl.innerHTML = '';
  const opts = [
    ['all', `All media (${allItems.length})`],
    ['video', `Videos (${counts.video})`],
    ['image', `Images (${counts.image})`],
  ];
  for (const [value, label] of opts) {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = label;
    kindsEl.append(o);
  }
  kindsEl.classList.remove('is-hidden');
  kindsEl.onchange = () => {
    kindFilter = kindsEl.value;
    applyFilter();
  };
  if ([...kindsEl.options].some((o) => o.value === kindFilter)) {
    kindsEl.value = kindFilter;
  } else {
    kindFilter = 'all';
    kindsEl.value = 'all';
  }
}

// Only images have an origin — a video is neither uploaded nor generated in this
// sense — so picking one implicitly narrows to images.
function buildOriginFilter() {
  const counts = { uploaded: 0, generated: 0 };
  for (const i of allItems) {
    if (i.kind !== 'image') continue;
    const o = originOf(i);
    if (o) counts[o]++;
  }
  if (!counts.uploaded || !counts.generated) return; // nothing to choose between

  originsEl.innerHTML = '';
  const opts = [
    ['all', 'Uploaded + generated'],
    ['uploaded', `Uploaded (${counts.uploaded})`],
    ['generated', `Generated (${counts.generated})`],
  ];
  for (const [value, label] of opts) {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = label;
    originsEl.append(o);
  }
  originsEl.classList.remove('is-hidden');
  originsEl.onchange = () => {
    originFilter = originsEl.value;
    applyFilter();
  };
  if ([...originsEl.options].some((o) => o.value === originFilter)) {
    originsEl.value = originFilter;
  } else {
    originFilter = 'all';
    originsEl.value = 'all';
  }
}

function applyFilter() {
  let list = allItems;

  if (originFilter !== 'all') {
    list = list.filter((i) => i.kind === 'image' && originOf(i) === originFilter);
  }

  if (kindFilter !== 'all') {
    // Records predating the kind tag are videos — that is all the archive held.
    list = list.filter((i) => (i.kind === 'image' ? 'image' : 'video') === kindFilter);
  }

  if (accountFilter === '__none__') {
    list = list.filter((i) => !(i.accounts ?? []).length);
  } else if (accountFilter !== 'all') {
    list = list.filter((i) => (i.accounts ?? []).includes(accountFilter));
  }

  if (starredOnly) {
    list = list.filter((i) => i.starred);
  }

  if (modelFilter !== 'all') {
    list = list.filter((i) => i.model === modelFilter);
  }

  // Dated by madeAt, which prefers createdAt and falls back to firstSeenAt, so a
  // record the archive found late still sits at the date it was generated.
  if (periodDays !== 'all') {
    const cutoff = Date.now() - Number(periodDays) * 86_400_000;
    list = list.filter((i) => madeAt(i) >= cutoff);
  }

  // Prompt search. Case-insensitive substring, deliberately not fuzzy: these are
  // your own prompts and you are usually looking for a phrase you remember
  // writing. Uploads carry no prompt, so a search necessarily excludes them.
  if (searchTerm) {
    list = list.filter((i) => (i.prompt || '').toLowerCase().includes(searchTerm));
  }

  // Sort after filtering, on a copy — allItems is shared and the archive's own
  // order shouldn't depend on what the feed is currently showing.
  items = [...list].sort(SORTS[sortMode] ?? SORTS.newest);

  paintFilterCount();

  // The grid you would go back to no longer exists in the form you left it.
  returnTo = null;
  paintBack();

  teardown();
  if (!items.length && starredOnly) {
    setState('Nothing starred in this view yet. Tap ☆ on any card to star it.');
  } else if (!items.length) {
    setState('Nothing matches these filters.');
  } else {
    setState('');
    render();
  }
  feed.scrollTop = 0;
}

// Re-rendering has to release what the old cards were holding, or filtering
// repeatedly would leak a video decoder and a blob each time.
function teardown() {
  stopHoverPreview(); // a grid preview outlives its tile otherwise
  if (activeIndex >= 0) detach(activeIndex);
  observer?.disconnect();
  observer = null;
  for (const card of cards) {
    if (card.dataset.blob) URL.revokeObjectURL(card.dataset.blob);
  }
  activeIndex = -1;
  cards = [];
  renderedCount = 0;
  sentinelObserver?.disconnect();
  sentinelObserver = null;
  sentinel?.remove();
  sentinel = null;
  feed.querySelectorAll('.card, .gtile').forEach((c) => c.remove());
}

// The feed merges two sources — the API library and this extension's own job
// records. Say so, so a count that differs from the website isn't a mystery.
// Press D to dump archive diagnostics to the console and clipboard. Counts hide
// the account-tag bugs; provenance shows them.
document.addEventListener('keydown', async (e) => {
  if (e.key !== 'd' && e.key !== 'D') return;
  if (e.target.matches('input, textarea, select')) return;
  const res = await send({ type: 'debug/archive' });
  if (!res?.ok) { console.error('[FrameRoom] diagnostic failed:', res?.error); return; }
  const text = JSON.stringify(res.dump, null, 2);
  console.log('[FrameRoom] archive diagnostic\n' + text);
  try {
    await navigator.clipboard.writeText(text);
    setState('Diagnostic copied to clipboard - paste it to share.');
    setTimeout(() => setState(''), 2500);
  } catch {
    setState('Diagnostic printed to console (clipboard blocked).');
    setTimeout(() => setState(''), 2500);
  }
});

// Shift+Backspace purges the archive (not the credential vault) after a
// confirm. The tags and everything else rebuild from library data on reload.
document.addEventListener('keydown', async (e) => {
  if (!(e.shiftKey && (e.key === 'Backspace' || e.key === 'Delete'))) return;
  if (e.target.matches('input, textarea, select')) return;
  e.preventDefault();
  if (!confirm('Purge the local archive and re-scan from PixVerse? Your saved accounts stay signed in. This cannot be undone.')) return;
  const res = await send({ type: 'debug/purge' });
  if (res?.ok) {
    setState('Archive purged. Reloading...');
    setTimeout(() => location.reload(), 800);
  } else {
    setState('Purge failed: ' + (res?.error ?? 'unknown'), true);
  }
});

// ---------- backup / restore ----------
//
// The archive holds every generation's prompt, seed, model and account —
// including ones the platform has forgotten — and the media files carry none of
// that. It's the part worth being able to move between machines.

document.getElementById('export').addEventListener('click', async () => {
  const res = await send({ type: 'backup/export' });
  if (!res?.ok) { setState(`Export failed: ${res?.error ?? 'unknown'}`, true); return; }

  const stamp = new Date().toISOString().slice(0, 10);
  const blob = new Blob([JSON.stringify(res.data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `frame-room-archive-${stamp}.json`;
  a.click();
  URL.revokeObjectURL(url);

  setState(`Exported ${res.data.recordCount} records.`);
  setTimeout(() => setState(''), 2500);
});

document.getElementById('import').addEventListener('click', () => {
  document.getElementById('import-file').click();
});

document.getElementById('import-file').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = ''; // so re-picking the same file fires again
  if (!file) return;

  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    setState('That file is not valid JSON.', true);
    return;
  }

  setState('Merging backup…');
  const res = await send({ type: 'backup/import', data });
  if (!res?.ok) { setState(`Import failed: ${res?.error ?? 'unknown'}`, true); return; }

  // Merged, not replaced — nothing already present is lost.
  setState(`Restored: ${res.added} new, ${res.merged} already present. Reloading…`);
  setTimeout(() => location.reload(), 1200);
});

// ---------- header controls ----------

// ---------- back ----------
//
// Clicking a grid tile opens the reel at that item, and there was no way out
// except the view dropdown, which resets scrollTop to 0. On a four thousand tile
// grid that means finding your place again by hand every time you look at
// something. The tile click was a one-way door.
//
// The return point remembers the item's URL rather than its index. Indexes are
// positions in the current filtered list, so anything that changes the list
// makes a stored index point at a different record — which is worse than no back
// button, because it silently takes you to the wrong place.
let returnTo = null; // { mode, url }
const backEl = document.getElementById('back');

function paintBack() {
  backEl.classList.toggle('is-hidden', !returnTo);
}

function goBack() {
  if (!returnTo) return;
  const { mode, url } = returnTo;
  returnTo = null;
  viewMode = mode;
  document.getElementById('view').value = mode;
  teardown();
  render();
  paintBack();

  // Find it again by identity. If it has been filtered out since, the grid is
  // still the right place to land; only the scroll target is lost.
  const idx = items.findIndex((i) => i.url === url);
  if (idx >= 0) scrollToCard(idx, 'auto');
}

backEl.addEventListener('click', goBack);

document.getElementById('view').addEventListener('change', (e) => {
  // Choosing a view by hand is a deliberate navigation, so it discards the
  // return point rather than leaving a back button pointing somewhere stale.
  returnTo = null;
  paintBack();
  viewMode = e.target.value;
  teardown();
  render();
  feed.scrollTop = 0;
});

// Popovers. Collapsing the filters hides whether any are on, so the button
// carries a count; without it a filtered-looking feed has no visible cause.
function wirePopover(btnId, menuId) {
  const btn = document.getElementById(btnId);
  const menu = document.getElementById(menuId);
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const opening = menu.classList.contains('is-hidden');
    for (const m of document.querySelectorAll('.pop-menu')) m.classList.add('is-hidden');
    menu.classList.toggle('is-hidden', !opening);
  });
  menu.addEventListener('click', (e) => e.stopPropagation());
}

wirePopover('filters-btn', 'filters-menu');
wirePopover('more-btn', 'more-menu');

document.addEventListener('click', () => {
  for (const m of document.querySelectorAll('.pop-menu')) m.classList.add('is-hidden');
});

function paintFilterCount() {
  const active = [
    starredOnly,
    kindFilter !== 'all',
    originFilter !== 'all',
    accountFilter !== 'all',
    modelFilter !== 'all',
    periodDays !== 'all',
    Boolean(searchTerm),
  ].filter(Boolean).length;
  const el = document.getElementById('filters-count');
  el.textContent = String(active);
  el.classList.toggle('is-hidden', active === 0);
}

document.getElementById('filters-clear').addEventListener('click', () => {
  starredOnly = false;
  kindFilter = 'all';
  originFilter = 'all';
  accountFilter = 'all';
  modelFilter = 'all';
  periodDays = 'all';
  searchTerm = '';
  searchEl.value = '';
  periodEl.value = 'all';
  starFilterEl.classList.remove('is-on');
  starFilterEl.textContent = '\u2606 starred';
  for (const el of [kindsEl, originsEl, accountsEl, modelsEl]) {
    if ([...el.options].some((o) => o.value === 'all')) el.value = 'all';
  }
  applyFilter();
});

periodEl.addEventListener('change', () => {
  periodDays = periodEl.value;
  applyFilter();
});

// Debounced, because every keystroke is a full filter-and-rebuild. Chunked
// rendering made that cheap enough to be viable at all; the debounce keeps it
// from running on every character regardless.
let searchTimer = null;
searchEl.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    searchTerm = searchEl.value.trim().toLowerCase();
    applyFilter();
  }, 180);
});

// The reel's keyboard nav swallows j/k/space, which makes a search box unusable.
// The existing handler already bails on input/textarea/select, and `search` is
// an input, so this is covered — but Escape should hand focus back rather than
// leaving you trapped in the field.
searchEl.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { searchEl.blur(); feed.focus(); }
});

function paintSourceNote() {
  if (!counts) return;
  const bits = [];
  if (counts.archive) bits.push(`${counts.archive} archived`);
  if (counts.added) bits.push(`+${counts.added} new`);
  if (counts.deepSwept) bits.push('full history scanned');
  if (counts.accounts?.length > 1) bits.push(`${counts.accounts.length} accounts`);
  if (counts.pending) bits.push(`${counts.pending} unconfirmed`);
  if (counts.unreachable) bits.push(`${counts.unreachable} unreachable`);
  if (verify?.revived) bits.push(`${verify.revived} recovered`);
  // A truncated sweep can't support reconciliation — say so rather than letting
  // it look like a complete picture.
  if (counts.sweepStoppedBy && counts.sweepStoppedBy !== 'floor' && counts.sweepStoppedBy !== 'shallow') {
    bits.push(`partial scan (${counts.sweepStoppedBy})`);
  }
  // Counts moving after a sweep of this account is expected. Moving on a plain
  // reload is the bug — say so out loud instead of waiting to be noticed.
  if (counts.drift && !counts.driftExplained) {
    bits.push(`counts drifted unexpectedly - press D`);
  }
  if (counts.reconciled) {
    bits.push(`${counts.reconciled} mistagged fixed`);
  }
  if (apiError) bits.push('library call failed — archive only');
  sourceEl.textContent = bits.join(' · ');
  sourceEl.classList.toggle('is-bad', Boolean(apiError));
}

// ---------- render ----------

// Badge and star are built up front so an image card — which has no <video> and
// returns early — can use them too. They used to be declared below that branch,
// which meant the image path referenced them before initialisation and threw a
// ReferenceError, killing the whole feed render for any account holding images.
// ---------- grid hover preview ----------
//
// Hover-to-play does not break the one-video-alive rule: only one tile can be
// hovered, so at most one <video> exists in the grid at any moment. It is the
// same discipline as the reel, driven by the pointer instead of by scroll.
//
// Two things make it safe rather than a fetch storm:
//
//   DELAY   — dragging the pointer across a grid crosses dozens of tiles. Each
//             would otherwise start fetching a whole video file. Nothing begins
//             until the pointer has settled.
//   TOKEN   — a fetch can land after the pointer has moved on. Without a
//             staleness check the video attaches to a tile you already left and
//             plays invisibly, holding a decoder and its blob forever.

const HOVER_DELAY_MS = 220;
let hoverTimer = null;
let hoverTile = null;
let hoverToken = 0;

function stopHoverPreview() {
  clearTimeout(hoverTimer);
  hoverTimer = null;
  hoverToken++; // invalidates any fetch still in flight

  const tile = hoverTile;
  hoverTile = null;
  if (!tile) return;

  tile.classList.remove('is-loading', 'is-playing');
  const video = tile.querySelector('video');
  if (video) {
    video.pause();
    video.removeAttribute('src');
    video.load(); // what actually frees the decoder
    video.remove();
  }
  if (tile.dataset.blob) {
    URL.revokeObjectURL(tile.dataset.blob);
    delete tile.dataset.blob;
  }
}

async function startHoverPreview(tile, item) {
  const token = ++hoverToken;
  hoverTile = tile;
  tile.classList.add('is-loading');

  // Straight to the blob fetch: a direct <video src> to this CDN is always
  // refused, so trying it first would only cost a failed load per hover.
  let objUrl = null;
  for (const candidate of mediaCandidates(item.url)) {
    try {
      const res = await fetch(candidate, { cache: 'no-store' });
      if (!res.ok) continue;
      const blob = await res.blob();
      if (token !== hoverToken) return; // pointer left mid-fetch
      objUrl = URL.createObjectURL(blob);
      break;
    } catch { /* try the next spelling */ }
  }

  if (token !== hoverToken) {
    if (objUrl) URL.revokeObjectURL(objUrl);
    return;
  }

  tile.classList.remove('is-loading');
  if (!objUrl) return; // nothing playable; the poster stays

  const video = document.createElement('video');
  video.muted = true;
  video.loop = true;
  video.playsInline = true;
  video.className = 'gtile-video';
  video.addEventListener('playing', () => tile.classList.add('is-playing'));
  video.src = objUrl;
  tile.dataset.blob = objUrl;
  tile.append(video);
  video.play().catch(() => {});
}

function wireHoverPreview(tile, item) {
  if (item.kind === 'image' || !item.url) return; // nothing to play

  tile.addEventListener('mouseenter', () => {
    stopHoverPreview(); // whatever was playing gives up its decoder first
    hoverTimer = setTimeout(() => startHoverPreview(tile, item), HOVER_DELAY_MS);
  });
  tile.addEventListener('mouseleave', stopHoverPreview);
}

// Grid view. Posters only in the DOM — a <video> exists solely for the tile
// under the pointer, so a thousand tiles cost a thousand lazy <img>s rather
// than a thousand decoders.
// ---------- chunked rendering ----------
//
// Both render paths used to build a node for EVERY filtered record, so an
// archive of four thousand meant four thousand DOM nodes plus, in the grid, four
// thousand sets of hover listeners — rebuilt from scratch on every filter
// change. Lazy images spare the network; they do nothing for layout or memory.
// That is why browsing was slow, and it is why a search box would have been
// unusable: each keystroke is a filter change.
//
// Nodes are now built a chunk at a time, with a sentinel at the end of the feed
// that pulls the next chunk in as it comes into view. First paint and every
// filter change became O(chunk) instead of O(archive).
//
// The catch, and the reason this is not just a loop with a limit: the reel is
// index-addressed. `scrollToCard(n)`, the keyboard nav and the grid's
// click-to-open all reach for `cards[n]`, which may not exist yet. Anything
// jumping to an index must call `ensureRendered` first.
const RENDER_CHUNK = 60;
let renderedCount = 0;
let sentinel = null;
let sentinelObserver = null;

function ensureSentinel() {
  sentinel?.remove();
  sentinelObserver?.disconnect();
  sentinel = document.createElement('div');
  sentinel.className = 'feed-sentinel';
  feed.append(sentinel);
  // rootMargin pulls the next chunk in before the sentinel is actually visible,
  // so scrolling does not stall at the seam.
  sentinelObserver = new IntersectionObserver(
    (entries) => { if (entries.some((e) => e.isIntersecting)) renderChunk(); },
    { root: feed, rootMargin: '800px' },
  );
  sentinelObserver.observe(sentinel);
}

function renderChunk() {
  if (renderedCount >= items.length) return;
  const end = Math.min(renderedCount + RENDER_CHUNK, items.length);
  const frag = document.createDocumentFragment();
  const fresh = [];

  for (let i = renderedCount; i < end; i++) {
    const node = viewMode === 'reel' ? buildReelCard(items[i], i) : buildGridTile(items[i], i);
    fresh.push(node);
    frag.append(node);
  }

  // Before the sentinel, or the sentinel stops being the last thing in the feed
  // and never intersects again.
  feed.insertBefore(frag, sentinel);
  cards.push(...fresh);
  if (viewMode === 'reel' && observer) for (const c of fresh) observer.observe(c);
  renderedCount = end;

  if (renderedCount >= items.length) {
    sentinelObserver?.disconnect();
    sentinel?.remove();
    sentinel = null;
  }
}

// Render forward until `index` exists. Used by anything that addresses a card by
// number rather than by scrolling to it.
function ensureRendered(index) {
  let guard = 0;
  while (renderedCount <= index && renderedCount < items.length && guard++ < 1000) renderChunk();
}

function buildGridTile(item, i) {
    const tile = document.createElement('article');
    // NOT .card. Borrowing that class so teardown would find it also inherited
    // the reel's `height: calc(100vh - var(--bar-h))`, and an explicit height
    // beats aspect-ratio — every tile rendered a full viewport tall. The
    // cleanup queries both classes instead.
    tile.className = 'gtile';
    tile.dataset.index = String(i);

    // A video with no stored poster gets one from the file itself.
    const poster = item.poster
      || (item.kind !== 'image' ? videoPoster(item.url, SNAPSHOT_WIDTH[viewMode] ?? SNAPSHOT_WIDTH.md) : null);

    if (poster) {
      const img = document.createElement('img');
      // Thumbnail sized for the current grid; falls back to the full image once
      // if the processor refuses this object, so an unsupported path degrades
      // rather than showing a hole.
      // A snapshot URL is already sized and already carries x-oss-process, so
      // thumbUrl leaves it alone.
      img.src = thumbUrl(poster, THUMB_STYLES[viewMode] ?? THUMB_STYLES.md);
      img.loading = 'lazy';
      img.decoding = 'async';
      img.alt = '';
      img.addEventListener('error', () => {
        if (img.dataset.full) return;
        img.dataset.full = '1';
        img.src = poster;
      });
      tile.append(img);
    } else {
      // A video whose poster never resolved. Say so rather than showing a hole.
      const empty = document.createElement('div');
      empty.className = 'gtile-empty';
      empty.textContent = item.prompt || 'no preview';
      tile.append(empty);
    }

    const kind = document.createElement('span');
    kind.className = 'gtile-kind';
    kind.textContent = item.kind === 'image' ? 'img' : 'vid';
    tile.append(kind);

    tile.append(buildStar(item));

    if (item.prompt) {
      const cap = document.createElement('div');
      cap.className = 'gtile-caption';
      cap.textContent = item.prompt;
      tile.append(cap);
    }

    wireHoverPreview(tile, item);

    // Open in the reel at this item — the grid is for finding, the reel for
    // watching.
    tile.addEventListener('click', (e) => {
      if (e.target.closest('.star')) return; // starring is not opening
      // Remember the grid we are leaving so Esc / the back button can return
      // to it, at this tile rather than at the top.
      returnTo = { mode: viewMode, url: item.url };
      viewMode = 'reel';
      document.getElementById('view').value = 'reel';
      teardown();
      render();
      paintBack();
      // The reel starts one chunk deep, so a tile from further down the grid has
      // no card to scroll to until the intervening chunks exist.
      ensureRendered(i);
      scrollToCard(i);
    });

  return tile;
}

function buildBadge(i, total) {
  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.textContent = `${i + 1} / ${total}`;
  return badge;
}

function buildStar(item) {
  // Star toggle — persists on the archive record, so it survives reloads and
  // account switches. Optimistic: flip the UI immediately, revert if the
  // write fails.
  const star = document.createElement('button');
  star.type = 'button';
  star.className = 'star';
  star.textContent = item.starred ? '★' : '☆';
  star.classList.toggle('is-on', Boolean(item.starred));
  star.title = item.starred ? 'Unstar' : 'Star';
  star.addEventListener('click', async (e) => {
    e.stopPropagation(); // don't pause the video
    const next = !item.starred;
    item.starred = next; // also updates the object in allItems (same ref)
    star.textContent = next ? '★' : '☆';
    star.classList.toggle('is-on', next);
    star.title = next ? 'Unstar' : 'Star';
    const res = await send({ type: 'star/toggle', name: item.name, starred: next });
    if (!res?.ok) { // revert on failure
      item.starred = !next;
      star.textContent = item.starred ? '★' : '☆';
      star.classList.toggle('is-on', item.starred);
    }
  });
  return star;
}

function render() {
  // Derive the class from the mode rather than comparing against a separate
  // list. The two were compared directly — `viewMode === 'is-sm'` with viewMode
  // 'sm' — so no size class was ever applied and the grid fell back to a single
  // full-width column with no grid-template-columns at all.
  feed.classList.toggle('is-grid', viewMode !== 'reel');
  for (const m of ['sm', 'md', 'lg']) feed.classList.toggle(`is-${m}`, viewMode === m);
  document.getElementById('hint').textContent = viewMode === 'reel'
    ? '\u2191 \u2193 / scroll \u00b7 space to pause'
    : 'click a tile to open it';

  // One path for both modes now. The only difference is which builder each
  // chunk uses, which renderChunk decides, so there is no longer a separate
  // grid renderer to route to.
  renderedCount = 0;
  cards = [];
  // Reel only: the observer drives setActive, and nothing in a grid plays.
  observer = viewMode === 'reel' ? makeCardObserver() : null;
  ensureSentinel();
  renderChunk();
  if (viewMode === 'reel') feed.focus();
}

function buildReelCard(item, i) {
    const card = document.createElement('section');
    card.className = 'card';
    card.dataset.index = String(i);

    const stage = document.createElement('div');
    stage.className = 'stage';

    // Poster: lazy so offscreen cards don't fetch until they're near.
    if (item.poster) {
      const img = document.createElement('img');
      img.src = item.poster;
      img.loading = 'lazy';
      img.decoding = 'async';
      img.alt = '';
      stage.append(img);
    }

    // An image record's poster IS the asset, so it needs no <video> element.
    // Everything downstream guards on the element being absent.
    const badge = buildBadge(i, items.length);
    const star = buildStar(item);

    if (item.kind === 'image') {
      stage.append(buildMeta(item));
      card.append(stage);
      card.append(badge);
      card.append(star);
      return card;
    }

    // Deliberately no src — assigned only when this card takes focus.
    const video = document.createElement('video');
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.preload = 'none';
    video.addEventListener('playing', () => card.classList.add('is-playing'));
    video.addEventListener('error', async () => {
      if (!video.src) return; // cleared by us, not a real failure
      if (video.src.startsWith('blob:')) {
        // The blob itself won't decode — that's a genuine media problem.
        markCardError(card, 'could not play — try Open');
        return;
      }

      // Try the next URL spelling before reaching for the fetch fallback.
      const tried = Number(video.dataset.variant ?? 0);
      const candidates = mediaCandidates(item.url);
      if (tried + 1 < candidates.length) {
        const next = candidates[tried + 1];
        video.dataset.variant = String(tried + 1);
        video.src = next;
        video.load();
        if (!paused) video.play().catch(() => {});
        return;
      }

      // Direct loading is blocked — fetch the bytes instead.
      const saved = await rescueCard(card, item);
      if (!saved) {
        markCardError(card, item.status === 'gone'
          ? 'file not on the CDN — generation may have failed'
          : 'not available yet — still rendering, or failed');
      }
    });
    stage.append(video);



    stage.append(buildMeta(item));
    card.append(stage);
    // Star and badge live on the CARD (viewport-sized, stable) rather than the
    // STAGE (which overflows and clips them). Appended after the stage so they
    // layer above the video.
    card.append(badge);
    card.append(star);
  return card;
}

// The archive holds two vocabularies for the same three things: the API's
// create_mode (i2v, image_text, transition) and the panel's own mode names
// (animate, frames, image), depending on whether a record came from a library
// fetch or from a local job. i2v and image_text are both animate — same
// endpoint, same inputs — and transition is frames. Collapse them so a card
// doesn't show a different word for the same generation type.
const MODE_LABEL = {
  i2v: 'animate',
  image_text: 'animate',
  animate: 'animate',
  normal: 'animate',
  transition: 'frames',
  frames: 'frames',
  i2i: 'image',
  image: 'image',
};

function modeLabel(raw) {
  const key = String(raw || '').toLowerCase();
  return MODE_LABEL[key] ?? key; // unknown modes show as-is rather than vanish
}

function buildMeta(item) {
  const meta = document.createElement('div');
  meta.className = 'meta';

  if (item.prompt) {
    const p = document.createElement('div');
    p.className = 'meta-prompt';
    p.textContent = item.prompt;
    meta.append(p);
  }

  const row = document.createElement('div');
  row.className = 'meta-row';

  const bits = [item.model, item.quality, item.duration ? `${item.duration}s` : null, modeLabel(item.mode)]
    .filter(Boolean);
  if (item.seed != null) bits.push(`seed ${item.seed}`);
  if (item.createdAt) bits.push(new Date(item.createdAt).toLocaleDateString());
  // Which login this turned up under — the archive spans accounts.
  for (const a of item.accounts ?? []) bits.push(a);
  // Nothing is filtered out of the feed, so say plainly what state a card is in
  // rather than letting a silently-broken video look like a bug.
  if (item.status === 'gone') bits.push('unreachable');
  else if (item.status !== 'ok') bits.push('unconfirmed');

  for (const b of bits) {
    const span = document.createElement('span');
    span.textContent = b;
    row.append(span);
  }

  const open = document.createElement('a');
  open.href = item.url;
  open.target = '_blank';
  open.rel = 'noopener';
  open.textContent = 'open';
  row.append(open);

  // Rerun. Decide from what was actually captured, not from the mode name —
  // guessing "image_text means frameless" is exactly what hid the button on
  // records that do have a source image.
  //   rerun block present + a frame  → active rerun
  //   rerun block present, no frame  → genuinely nothing to rerun from
  //   no rerun block at all          → archived before inputs were captured
  const scanned = Boolean(item.rerun);
  const hasFrames = Boolean(item.rerun?.firstPath);

  if (hasFrames) {
    const rerun = document.createElement('a');
    rerun.href = '#';
    rerun.className = 'meta-rerun';
    rerun.textContent = 'rerun';
    rerun.title = 'Load these settings into the compose panel';
    rerun.addEventListener('click', (e) => {
      e.preventDefault();
      stashRerun(item, rerun);
    });
    row.append(rerun);
  }

  // An i2i result holds both ends of a transition: what it was made from, and
  // what it became. One click beats switching tab and hunting the original down
  // in a picker of thousands.
  if (item.kind === 'image' && item.rerun?.firstPath && item.url) {
    const outPath = item.path || pathFromMediaUrl(item.url);
    if (outPath && outPath !== item.rerun.firstPath) {
      const toFrames = document.createElement('a');
      toFrames.href = '#';
      toFrames.className = 'meta-rerun';
      toFrames.textContent = '→ frames';
      toFrames.title = 'Frames mode, source as first frame and this result as last';
      toFrames.addEventListener('click', (e) => {
        e.preventDefault();
        stashFrames(item, outPath, toFrames);
      });
      row.append(toFrames);
    }
  }

  if (!hasFrames && scanned) {
    const na = document.createElement('span');
    na.className = 'meta-rerun-pending';
    na.textContent = 'no source image';
    na.title = 'This generation has no source image recorded, so there is nothing to reload';
    row.append(na);
  } else if (!hasFrames && item.status === 'ok') {
    const pending = document.createElement('span');
    pending.className = 'meta-rerun-pending';
    pending.textContent = 'rerun pending scan';
    pending.title = 'Rerun data is captured on the next full library scan of this account';
    row.append(pending);
  }

  meta.append(row);
  return meta;
}

// Storage path from a media URL, for records that predate `path` being stored.
// The host is matched rather than compared against a constant — browse.js has no
// MEDIA of its own, and inventing one here would be a second source of truth for
// something background.js already owns.
function pathFromMediaUrl(u) {
  const m = decodeMediaUrl(String(u ?? '')).match(/^https?:\/\/[^/]+\/(.+)$/i);
  return m ? m[1].split(/[?#]/)[0] || null : null;
}

// Hand both ends of an i2i to the panel as a Frames composition: the image it
// was generated FROM becomes the first frame, the result becomes the last.
async function stashFrames(item, outPath, linkEl) {
  const payload = {
    mode: 'frames',
    prompt: item.prompt || '',
    model: '',
    quality: item.quality || '',
    seed: null,          // a transition is its own generation, not a repeat
    duration: null,
    aspectRatio: '',
    audio: 0,
    previewMode: 0,
    multiShot: 0,
    firstPath: item.rerun.firstPath,
    lastPath: outPath,
    account: (item.accounts ?? [])[0] ?? null,
  };

  const res = await send({ type: 'rerun/stash', rerun: payload });
  const original = linkEl.textContent;
  linkEl.textContent = res?.ok ? 'sent to panel →' : 'failed';
  if (res?.ok) {
    try { await chrome.sidePanel?.open?.({ windowId: (await chrome.windows.getCurrent()).id }); } catch { /* ignore */ }
  }
  setTimeout(() => { linkEl.textContent = original; }, 2500);
}

// The browse feed is its own tab — it can't reach into the side panel's form
// directly. So stash the rerun payload where the panel reads it on load/focus,
// then tell the user to open the panel. If the panel is already open, it picks
// the pending rerun up live.
async function stashRerun(item, linkEl) {
  const r = item.rerun;
  const payload = {
    mode: r.panelMode,
    prompt: item.prompt || '',
    model: item.model || '',
    quality: item.quality || '',
    seed: item.seed ?? null,
    duration: item.duration ?? null,
    aspectRatio: r.aspectRatio || '',
    audio: r.audio ?? 0,
    previewMode: r.previewMode ?? 0,
    multiShot: r.multiShot ?? 0,
    firstPath: r.firstPath,
    lastPath: r.lastPath,
    account: (item.accounts ?? [])[0] ?? null, // which login this belongs to
  };

  const res = await send({ type: 'rerun/stash', rerun: payload });
  const original = linkEl.textContent;
  if (res?.ok) {
    linkEl.textContent = 'sent to panel →';
    // Nudge the panel open if the API allows it from here (needs the user
    // gesture we're inside of).
    try { await chrome.sidePanel?.open?.({ windowId: (await chrome.windows.getCurrent()).id }); } catch { /* ignore */ }
    setTimeout(() => { linkEl.textContent = original; }, 2500);
  } else {
    linkEl.textContent = 'failed';
    setTimeout(() => { linkEl.textContent = original; }, 2000);
  }
}

// ---------- focus / memory discipline ----------

// Fetch the bytes ourselves and play from a blob.
//
// This is the same workaround the side panel uses, and the reason the panel
// plays videos while this page didn't: a direct <video src> to the CDN gets
// refused (MEDIA_ERR_SRC_NOT_SUPPORTED), but an extension page holds
// host_permissions for media.pixverse.ai, so fetch() from here is CORS-exempt.
//
// Memory: exactly one blob is alive at a time — detach() revokes it — so this
// keeps the single-video-in-flight model intact.
async function rescueCard(card, item) {
  const video = card.querySelector('video');
  if (!video) return false; // image card

  for (const candidate of mediaCandidates(item.url)) {
    try {
      const res = await fetch(candidate, { cache: 'no-store' });
      if (!res.ok) {
        frDebug(`[FrameRoom] browse fetch: HTTP ${res.status} — ${candidate}`);
        continue;
      }
      const blob = await res.blob();
      const objUrl = URL.createObjectURL(blob);
      card.dataset.blob = objUrl; // detach() revokes this
      video.src = objUrl;
      video.load();
      if (!paused) video.play().catch(() => {});
      frDebug(`[FrameRoom] browse recovered via blob (${blob.size} bytes) — ${candidate}`);
      return true;
    } catch (err) {
      frDebug(`[FrameRoom] browse fetch threw: ${err?.message} — ${candidate}`);
    }
  }
  return false;
}

function attach(index) {
  const card = cards[index];
  const item = items[index];
  if (!card || !item) return;

  const video = card.querySelector('video');
  if (!video) return;    // image card — nothing to attach
  if (video.src) return; // already attached

  video.dataset.variant = '0';
  video.src = mediaCandidates(item.url)[0];
  video.preload = 'auto';
  if (!paused) video.play().catch(() => { /* autoplay may defer; poster stays */ });
}

function markCardError(card, text) {
  card.classList.add('is-error');
  let note = card.querySelector('.card-error');
  if (!note) {
    note = document.createElement('div');
    note.className = 'card-error';
    card.append(note);
  }
  note.textContent = text;
}

function detach(index) {
  const card = cards[index];
  if (!card) return;

  const video = card.querySelector('video');
  card.classList.remove('is-playing');
  if (!video?.src) return;

  video.pause();
  video.removeAttribute('src');
  // load() after clearing src is what actually frees the decoder and buffers.
  video.load();
  video.preload = 'none';

  // Release the fetched bytes too, or the memory model is defeated.
  if (card.dataset.blob) {
    URL.revokeObjectURL(card.dataset.blob);
    delete card.dataset.blob;
  }
}

function setActive(index) {
  if (index === activeIndex) return;
  if (activeIndex >= 0) detach(activeIndex);
  activeIndex = index;
  attach(index);
  counterEl.textContent = `${index + 1} / ${items.length}`;
}

// Returns the observer rather than observing everything itself: cards arrive a
// chunk at a time now, so each chunk registers its own as it is built.
function makeCardObserver() {
  // A high threshold means "this card fills the viewport" — with scroll-snap
  // that's unambiguous, so only one card is ever the winner.
  return new IntersectionObserver(
    (entries) => {
      let best = null;
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        if (!best || e.intersectionRatio > best.intersectionRatio) best = e;
      }
      if (best) setActive(Number(best.target.dataset.index));
    },
    { root: feed, threshold: [0.6, 0.9] },
  );
}

// ---------- controls ----------

// `behavior` is a parameter because returning to a grid should be instant.
// Smooth-scrolling to a tile two thousand rows down animates the whole way and
// reads as a hang.
function scrollToCard(index, behavior = 'smooth') {
  const clamped = Math.max(0, Math.min(items.length - 1, index));
  // Keyboard nav can walk past the rendered edge; build up to it first or the
  // reel simply stops at the end of the first chunk.
  ensureRendered(clamped);
  cards[clamped]?.scrollIntoView({ behavior, block: 'start' });
}

document.addEventListener('keydown', (e) => {
  // Reel-only. In a grid these would scroll one tile at a time and space would
  // pause nothing — the browser's own scrolling is the right behaviour there.
  if (viewMode !== 'reel') return;
  if (e.target.matches('input, textarea, select')) return;

  if (e.key === 'Escape') {
    e.preventDefault();
    goBack();
  } else if (e.key === 'ArrowDown' || e.key === 'PageDown' || e.key === 'j') {
    e.preventDefault();
    scrollToCard(activeIndex + 1);
  } else if (e.key === 'ArrowUp' || e.key === 'PageUp' || e.key === 'k') {
    e.preventDefault();
    scrollToCard(activeIndex - 1);
  } else if (e.key === ' ') {
    e.preventDefault();
    togglePause();
  }
});

feed.addEventListener('click', (e) => {
  if (e.target.closest('a')) return; // let links through
  togglePause();
});

function togglePause() {
  paused = !paused;
  const video = cards[activeIndex]?.querySelector('video');
  if (!video?.src) return;
  if (paused) video.pause(); else video.play().catch(() => {});
}

// Stop playback entirely when the tab is hidden — no point decoding frames
// nobody is looking at.
document.addEventListener('visibilitychange', () => {
  const video = cards[activeIndex]?.querySelector('video');
  if (!video?.src) return;
  if (document.hidden) video.pause();
  else if (!paused) video.play().catch(() => {});
});

load();
