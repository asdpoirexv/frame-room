// background.js — the only place that touches the network or the token.
//
// Why here and not in the panel: an MV3 extension page/service worker with
// host_permissions for the target host is exempt from the CORS check. A plain
// web page on your own origin is not — that's why your snippet would die on
// preflight if you dropped it into a localhost app.
//
// TRANSPORT FALLBACK: if the API starts 403-ing because it validates the
// Origin/Referer header (it now sees chrome-extension://...), don't fight it
// from here. Flip TRANSPORT to 'page' — see relayThroughPage() at the bottom —
// which runs the exact same fetch inside an open app.pixverse.ai tab, where the
// origin is naturally correct. That's the only line that needs to change.

const TRANSPORT = 'worker'; // 'worker' | 'page'

const API = 'https://app-api.pixverse.ai/creative_platform';
const PAGE_ORIGIN = 'https://app.pixverse.ai';
const MEDIA = 'https://media.pixverse.ai';

// Concurrency is PER ACCOUNT, not global. PixVerse caps how many generations one
// account can have in flight; it does not care that a different account is also
// busy. A single global limit meant two jobs on one account blocked a third on
// another — self-throttling for no reason, and exactly backwards for anyone
// running several accounts in parallel.
const MAX_CONCURRENT_PER_ACCOUNT = 2;

// ---------- auth ----------

async function readAuth() {
  const { auth } = await chrome.storage.session.get('auth');
  if (!auth?.token) throw new Error('NO_TOKEN');
  if (auth.expiresAt && auth.expiresAt < Date.now()) {
    // A known-expired token is the cheapest possible renewal trigger: no need to
    // spend a failed request to discover what the clock already says. Returns
    // null when the account has no stored password, which is the old behaviour.
    const fresh = await reauthAccount(auth.username, { staleToken: auth.token });
    if (fresh) return fresh;
    throw new Error('TOKEN_EXPIRED');
  }
  return auth;
}

// ---------- auth capture ----------
//
// Bind the token to the tab it came from, not "whatever fired last". With
// PixVerse open in two windows (e.g. a normal tab and an incognito one), the
// webRequest listener and storage.session are BOTH global to the single
// extension process — so a naive last-write flips the account to whichever tab
// polled most recently. Instead we key tokens by tabId and hand the panel the
// token from the tab it's actually looking at.

function decodeJwt(token) {
  try {
    const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(part.padEnd(Math.ceil(part.length / 4) * 4, '=')));
  } catch {
    return null;
  }
}

// tabId -> { token, anonId, username, expiresAt, seenAt }
//
// Persisted to storage.session because this Map lives in the service worker,
// and MV3 terminates that worker after ~30s idle. Without persistence the map
// comes back empty on every restart — and an empty map used to look identical
// to "signed out".
const TOKENS_KEY = 'tokensByTab';
const tokensByTab = new Map();
let tokensHydrated = false;

async function hydrateTokens() {
  if (tokensHydrated) return;
  tokensHydrated = true;
  try {
    const { [TOKENS_KEY]: saved } = await chrome.storage.session.get(TOKENS_KEY);
    if (saved && typeof saved === 'object') {
      for (const [k, v] of Object.entries(saved)) {
        if (!tokensByTab.has(Number(k))) tokensByTab.set(Number(k), v);
      }
    }
  } catch { /* first run */ }
}

async function persistTokens() {
  const obj = {};
  for (const [k, v] of tokensByTab) obj[k] = v;
  try {
    await chrome.storage.session.set({ [TOKENS_KEY]: obj });
  } catch { /* non-fatal */ }
}

function buildAuth(token, anonId) {
  const claims = decodeJwt(token);
  return {
    token,
    anonId: anonId ?? null,
    username: claims?.Username ?? null,
    expiresAt: claims?.ExpireTime ? claims.ExpireTime * 1000 : null,
    seenAt: Date.now(),
  };
}

// ---------- account credential vault ----------
//
// Persistent per-account { token, anonId } store, keyed by username, so
// switching between several logins doesn't mean re-authing each one. This lives
// in storage.local, which means the tokens sit in PLAINTEXT ON DISK: anyone
// with access to this machine or the extension can read every stored token and
// act as those accounts until each expires. This is a deliberate, user-chosen
// trade for the convenience of multi-account switching.
//
// Only tokens that decode to a username are stored (an account we can name).
// Expired tokens are dropped on read so the vault self-cleans.

const VAULT_KEY = 'accountVault';
const OVERRIDE_KEY = 'authOverride';

async function readVault() {
  const { [VAULT_KEY]: v } = await chrome.storage.local.get(VAULT_KEY);
  return v && typeof v === 'object' ? v : {};
}

async function vaultUpsert(auth) {
  if (!auth?.token || !auth.username) return; // only nameable accounts
  const vault = await readVault();
  const prev = vault[auth.username];

  // The token and the ai-anonymous-id are a MATCHED SET from one login session.
  // A re-login rotates both. The anon-id header isn't on every request, so a
  // capture can bring a fresh token with anonId undefined — in that case we may
  // reuse the previous anon-id ONLY if the token is unchanged. If the token
  // changed, the old anon-id belongs to a dead session and must not be carried
  // over; pairing a new token with a stale anon-id is exactly what makes every
  // fetch fail after logging out and back in.
  const tokenChanged = prev?.token !== auth.token;
  const anonId = auth.anonId ?? (tokenChanged ? null : prev?.anonId ?? null);

  // Nothing new to store.
  if (!tokenChanged && anonId === prev?.anonId) return;

  vault[auth.username] = {
    username: auth.username,
    token: auth.token,
    anonId,
    expiresAt: auth.expiresAt ?? null,
    updatedAt: Date.now(),
  };
  await chrome.storage.local.set({ [VAULT_KEY]: vault });
}

// Accounts with a still-valid stored token, newest first — for a switcher UI.
async function listVaultAccounts() {
  const vault = await readVault();
  const withPassword = await accountsWithPassword();
  const now = Date.now();
  return Object.values(vault)
    // An expired account used to be hidden, because it was useless. With a
    // stored password it is no longer useless — it is one login away — so it
    // stays in the list and the panel offers to renew it. Expired AND no
    // password is still hidden: nothing can be done with it from here.
    .filter((a) => !a.expiresAt || a.expiresAt > now || withPassword.has(a.username))
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    .map((a) => ({
      username: a.username,
      expiresAt: a.expiresAt ?? null,
      updatedAt: a.updatedAt ?? null,
      expired: Boolean(a.expiresAt && a.expiresAt <= now),
      // Names only. The password itself never leaves the service worker.
      canRenew: withPassword.has(a.username),
    }));
}

// Make a stored account the active one. This sets a MANUAL OVERRIDE that takes
// precedence over the tab-derived token — without it, the very next API call
// would snap back to whichever PixVerse tab is focused. Clearing the override
// (username null) returns to automatic tab-follows behaviour.
async function activateVaultAccount(username) {
  if (!username) {
    await chrome.storage.session.remove(OVERRIDE_KEY);
    await publishActiveAuth();
    return null;
  }

  const vault = await readVault();
  let rec = vault[username];
  if (!rec?.token) {
    // No token at all is still recoverable if a password is stored — this is
    // how an account renewed after being forgotten-then-re-added comes back.
    const revived = await reauthAccount(username, { staleToken: null }).catch(() => null);
    if (!revived) return null;
    rec = { ...revived };
  }
  if (rec.expiresAt && rec.expiresAt <= Date.now()) {
    // Expired: renew it rather than refusing the switch, which is the whole
    // point of storing the password.
    const renewed = await reauthAccount(username, { staleToken: rec?.token ?? null }).catch(() => null);
    if (!renewed) return null;
    rec = { ...renewed };
  }

  const auth = {
    token: rec.token,
    anonId: rec.anonId ?? null,
    username: rec.username,
    expiresAt: rec.expiresAt ?? null,
    seenAt: Date.now(),
  };
  await chrome.storage.session.set({ [OVERRIDE_KEY]: auth, auth });
  broadcast({ type: 'auth/state', linked: true, username: auth.username, expiresAt: auth.expiresAt, overridden: true });
  return auth;
}

// ---------- credit pricing ----------
//
// `POST /pricing/formulas` returns ~117 KB describing how every mode's credit
// cost is computed. It is a small expression-tree DSL, and implementing it means
// the panel can show what a generation will cost BEFORE you spend it — which is
// the whole point on an account with a few hundred credits.
//
// HOW TO CALL IT: no request body at all, and it must be authenticated. Called
// unauthenticated it returns `ErrCode 0` with `Resp: null` — a success-shaped
// nothing, which is exactly the sort of reply that wastes an afternoon. The site
// itself does `W.post('/pricing/formulas')` with no argument.
//
// THE DSL, in full — there is not much of it:
//   {type:'literal', value}                     a constant
//   {type:'variable', name}                     looked up in the vars bag
//   {operator:'*'|'+'|'-'|'/', params:[...]}    reduce params with the operator
//   {name:'ceil', params:[x]}                   the only function that exists
//   {switchOn, cases:[{compareValue,type,value}], default}
//
// Two traps, both of which cost a wrong answer rather than an error:
//
//   1. A binary node has NO `type` field — only `operator` and `params`. Detect
//      by shape, not by reading `type`.
//   2. `audio` and `multishot` are compared against `compareValue: true`, a real
//      BOOLEAN. Passing 1 silently matches nothing and falls through to the
//      default, which prices as if the option were off. That looked like the
//      formula ignoring audio entirely.
//
// Verified against three independent ground truths (2026-09-02): the site's own
// Create button showed 5 for qwen-image/720p and 38 for v6/540p/5s with audio,
// and the captured i2i request fixture carries credit_change 10 for
// qwen-image/1080p. This evaluator reproduces all three exactly.

const PRICING_KEY = 'pricingFormulas';
const PRICING_TTL_MS = 6 * 60 * 60_000;

// Panel mode -> formula key. The response also carries t2i/t2v/extend/modify/
// lipsync/upscale and more, for modes this tool doesn't implement.
const PRICING_FORMULA = { image: 'i2i', animate: 'i2v', frames: 'transition' };

// Absent variables must not silently become NaN. Discounts are multipliers used
// DIRECTLY as operands (not switch keys), so 1 means "no discount"; the flags
// are booleans because that is what the tree compares against.
//
// DISCOUNTS ARE THE HONEST WEAK POINT HERE, so it is spelled out.
//
// The discount MULTIPLIERS are not discoverable. `/user/credits` says *whether*
// a promotion is running (`is_v6_discount`, `promotion_discounts`,
// `marketing_hub_discount_info.promotion_mode` and friends) but not what any of
// them multiply by, and the site's own bundle only ever has the literal 1 near
// these names — it gets the real numbers from runtime state we cannot see.
//
// So the rule is: when every discount we can detect is OFF, the estimate is
// EXACT (that is the case that reproduced the site's 5 and 38 figures). When one
// is on, the true cost is LOWER than what these defaults compute — a discount
// can only reduce it — so the number becomes an honest UPPER BOUND and is
// labelled as one. Never a silently wrong exact figure.
const PRICING_DEFAULTS = {
  off_peak_discount: 1,
  preview_mode_discount: 1,
  ultra_model_discount: 1,
  v6_model_discount: 1,
  model_promotion_discount: 1,
  auto_sound: false,
  auto_speech: false,
  has_reference_video: false,
  reference_video_duration_seconds: 0,
  reference_image_count: 0,
  detail_level: 0,
};

const PRICING_OPS = {
  '*': (a, b) => a * b,
  '+': (a, b) => a + b,
  '-': (a, b) => a - b,
  '/': (a, b) => a / b,
};

function evalPricing(node, vars) {
  if (node == null) return 0;
  const t = typeof node;
  if (t === 'number' || t === 'string' || t === 'boolean') return node;

  if (node.type === 'literal') return node.value;
  if (node.type === 'variable') {
    if (!(node.name in vars)) throw new Error(`pricing: no value for ${node.name}`);
    return vars[node.name];
  }

  if (node.cases || node.type === 'switch') {
    const on = evalPricing(node.switchOn, vars);
    for (const c of node.cases) {
      // Only '=' and '>' have ever been observed. An unknown comparator must
      // not be quietly skipped — a mispriced estimate is worse than none.
      if (c.type === '=') { if (on === c.compareValue) return evalPricing(c.value, vars); }
      else if (c.type === '>') { if (Number(on) > Number(c.compareValue)) return evalPricing(c.value, vars); }
      else throw new Error(`pricing: unknown comparator ${c.type}`);
    }
    return evalPricing(node.default, vars);
  }

  if (node.name === 'ceil') return Math.ceil(Number(evalPricing(node.params[0], vars)));
  // Binary nodes carry no `type` — shape is the only signal.
  if (node.operator) {
    if (!PRICING_OPS[node.operator]) throw new Error(`pricing: unknown operator ${node.operator}`);
    return node.params.map((p) => Number(evalPricing(p, vars))).reduce(PRICING_OPS[node.operator]);
  }
  throw new Error('pricing: unrecognised node');
}

async function getPricingFormulas(auth = null) {
  const { [PRICING_KEY]: cached } = await chrome.storage.session.get(PRICING_KEY);
  if (cached?.at && Date.now() - cached.at < PRICING_TTL_MS) return cached.formulas;
  const formulas = await apiFetch('/pricing/formulas', null, 'POST', auth);
  if (!formulas || typeof formulas !== 'object') throw new Error('No pricing formulas returned');
  await chrome.storage.session.set({ [PRICING_KEY]: { formulas, at: Date.now() } });
  return formulas;
}

// Which discounts the account currently has running. Only ever used to decide
// whether the estimate is exact or an upper bound — the values themselves are
// not knowable (see PRICING_DEFAULTS).
function activeDiscounts(raw) {
  if (!raw || typeof raw !== 'object') return [];
  const on = [];
  if (raw.is_v6_discount) on.push('V6');
  if (raw.promotion_discounts) on.push('promotion');
  if (raw.marketing_hub_discount_info?.promotion_mode) on.push('marketing hub');
  if (raw.enhance_promotion_info?.enhance_promotion_mode) on.push('enhance');
  return on;
}

// Returns { credits, exact, reasons } — or credits null when it cannot be
// computed at all. Never a guess: `exact: false` means the real cost is at most
// this, and the panel must say so.
async function estimateCost({ mode, model, quality, duration, audio, multiShot, previewMode, offPeak, count }) {
  const key = PRICING_FORMULA[mode];
  if (!key) return { credits: null, exact: true, reasons: [] };
  const formulas = await getPricingFormulas();
  const tree = formulas[key];
  if (!tree) return { credits: null, exact: true, reasons: [] };

  let raw = null;
  try { raw = (await fetchCredits()).raw; } catch { /* estimate still worth having */ }

  const reasons = activeDiscounts(raw);
  // Preview mode has its own multiplier, and we know no more about its value
  // than about the others — only that it is a discount, so it reduces the cost.
  if (previewMode) reasons.push('preview mode');

  // Off-peak likewise. PixVerse's own CLI documents `--off-peak` as "use
  // off-peak pricing (lower credit cost)" without publishing the multiplier, so
  // the estimate becomes an upper bound rather than pretending to a number.
  if (offPeak) reasons.push('off-peak');

  const vars = {
    ...PRICING_DEFAULTS,
    model,
    quality,
    duration: Number(duration) || 0,
    create_count: Number(count) || 1,
    // Booleans, not 1/0 — see the trap above.
    audio: Boolean(audio),
    multishot: Boolean(multiShot),
  };
  const value = evalPricing(tree, vars);
  return {
    credits: Number.isFinite(value) ? value : null,
    exact: reasons.length === 0,
    reasons,
  };
}

// ---------- upload ----------
//
// Three legs. Bytes go to an Aliyun OSS bucket first; PixVerse is only told
// about the file afterwards.
//
//   1. POST /getUploadToken            -> temporary STS credentials {Ak,Sk,Token}
//   2. PUT  <bucket>/upload/<uuid>.ext -> the bytes, signed with those
//   3. POST /media/batch_upload_media  -> registers it, returns a usable path
//
// The `path` from leg 3 is exactly what `customer_img_path(s)` wants.
//
// WHY THIS WAS PARKED FOR SO LONG, AND WHAT IT COST TO UNPARK
// -----------------------------------------------------------
// The README used to say the AccessKeySecret "is never transmitted, so it can't
// be read from a request capture". That was wrong. It IS transmitted — in a
// RESPONSE, which is the half of the traffic `chrome.webRequest` cannot see.
// The instrument was wrong, not the target.
//
// THE ONE LINE THAT MATTERS (and the one that was got wrong first)
// ----------------------------------------------------------------
// OSS signature v1 signs this, joined by \n:
//
//     VERB
//     Content-MD5                     (empty — we don't send one)
//     Content-Type
//     Date                            <-- see below
//     CanonicalizedOSSHeaders         (x-oss-*, lowercased, SORTED, each + \n)
//     CanonicalizedResource           (/<bucket>/<key>)
//
// The Date line is **the x-oss-date value, not empty**. That looks wrong — a
// browser cannot set the `Date` header at all (it's a forbidden header name),
// which is exactly why the client sends `x-oss-date` instead — so the intuitive
// reading is that Date is absent and the line is blank. It is not. OSS
// substitutes x-oss-date into the Date position and signs that.
//
// Getting this wrong returns `SignatureDoesNotMatch` and nothing else, which is
// what makes this class of bug so unpleasant. It is also, mercifully, not how
// it has to be debugged: **the error body contains `<StringToSign>`, the exact
// string the server signed.** Diff it against yours and the discrepancy is
// right there. That is how this was settled, in one attempt, rather than by
// guessing at canonicalisation.
//
// Verified end-to-end against the live bucket on 2026-09-02: a 432 KB JPEG,
// HTTP 200 with an ETag, then registered and returned with correct dimensions.
//
// Multipart is not needed. The site chunks because ali-oss (which it bundles)
// is a generic resumable uploader, not because OSS demands it — a plain single
// PUT of the whole body is accepted.

const OSS_HOST = 'https://pixverse-fe-upload.oss-accelerate.aliyuncs.com';
const OSS_BUCKET = 'pixverse-fe-upload';

// The STS response carries NO expiry field, so we cannot honour the real one.
// Cache briefly and re-fetch on rejection rather than pretending to know: the
// client is observed reusing credentials across uploads, so one call per file
// would be needlessly chatty, but caching for long on a guessed lifetime just
// converts a cheap request into a mysterious 403.
const STS_CACHE_MS = 5 * 60_000;
let stsCache = null; // { cred, at }

async function getUploadCredentials(auth, { fresh = false } = {}) {
  if (!fresh && stsCache && Date.now() - stsCache.at < STS_CACHE_MS) return stsCache.cred;
  const cred = await apiFetch('/getUploadToken', null, 'POST', auth);
  if (!cred?.Ak || !cred?.Sk || !cred?.Token) throw new Error('Upload credentials missing');
  stsCache = { cred, at: Date.now() };
  return cred;
}

async function hmacSha1Base64(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

const EXT_MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
};
const MIME_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

// PixVerse rejects any image with a side over 4000px — `batch_upload_media`
// answers ErrCode 400, "incorrect image width or height", AFTER the bytes have
// already gone to OSS. Established by bisection against the live API: 4000
// passes, 4001 fails, and it is per-side rather than by area (4000x100 is fine,
// 4001x100 is not). The panel downscales to fit before sending, so this constant
// is here to document the rule and to keep the two ends honest.
const MAX_IMAGE_SIDE = 4000;

// Bytes -> OSS. Returns the storage key it wrote.
async function ossPut(cred, key, blob, contentType) {
  const date = new Date().toUTCString();
  const ossHeaders = {
    'x-oss-date': date,
    'x-oss-forbid-overwrite': 'true',
    'x-oss-security-token': cred.Token,
  };
  // Sorted, one per line, each terminated by \n.
  const canonHeaders = Object.keys(ossHeaders).sort()
    .map((k) => `${k}:${ossHeaders[k]}\n`).join('');
  const stringToSign = [
    'PUT', '', contentType, date, `${canonHeaders}/${OSS_BUCKET}/${key}`,
  ].join('\n');

  const signature = await hmacSha1Base64(cred.Sk, stringToSign);
  const res = await fetch(`${OSS_HOST}/${key}`, {
    method: 'PUT',
    headers: {
      ...ossHeaders,
      'Content-Type': contentType,
      Authorization: `OSS ${cred.Ak}:${signature}`,
    },
    body: blob,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const code = body.match(/<Code>([^<]+)<\/Code>/)?.[1] ?? res.status;
    // Surface the server's own string-to-sign when it disagrees — it is the
    // whole debugging story for this class of failure.
    const expected = body.match(/<StringToSign>([\s\S]*?)<\/StringToSign>/)?.[1];
    throw new Error(`OSS ${code}${expected ? ` (server signed: ${JSON.stringify(expected)})` : ''}`);
  }
  return key;
}

// Decode a data: URL by hand rather than with `fetch(dataUrl)`.
//
// The obvious `await (await fetch(dataUrl)).blob()` DOES NOT WORK HERE, and the
// reason is worth writing down: the MV3 service worker is subject to the
// extension's `content_security_policy.extension_pages`, and `connect-src` there
// does not list `data:`. Chrome refuses the fetch with "Refused to connect
// because it violates the document's Content Security Policy" — for a URL that
// carries its own bytes and makes no network request at all.
//
// The fix is not to widen the CSP with `data:`. Nothing needs to be fetched:
// base64 in, bytes out.
//
// Corollary worth keeping: the worker really is CSP-constrained, so listing the
// OSS host in `connect-src` was necessary, not belt-and-braces.
function blobFromDataUrl(dataUrl) {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) throw new Error('Malformed data URL');
  const meta = dataUrl.slice(5, comma);            // after "data:"
  const mime = meta.split(';')[0] || 'application/octet-stream';
  const payload = dataUrl.slice(comma + 1);

  if (!/;base64/i.test(meta)) {
    return new Blob([decodeURIComponent(payload)], { type: mime });
  }
  const bin = atob(payload);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

// The whole flow. `dataUrl` because a File cannot cross the message boundary
// from the panel to the worker — structured clone drops it.
async function uploadImage({ dataUrl, fileName }, auth = null) {
  auth = auth ?? await readAuth();

  const blob = blobFromDataUrl(dataUrl);

  // Type comes from the BYTES, not the filename. The panel re-encodes anything
  // over the size limit, so an image named .png can legitimately arrive as
  // JPEG — trusting the extension would then sign and store the wrong
  // Content-Type. The filename is only a fallback.
  const nameExt = (fileName?.split('.').pop() || '').toLowerCase();
  const contentType = blob.type || EXT_MIME[nameExt] || 'application/octet-stream';
  const ext = MIME_EXT[contentType] ?? nameExt ?? 'png';
  const objectName = `${crypto.randomUUID()}.${ext}`;
  const key = `upload/${objectName}`;

  let cred = await getUploadCredentials(auth);
  try {
    await ossPut(cred, key, blob, contentType);
  } catch (err) {
    // Cached credentials may simply have expired — we have no expiry to check
    // against, so one forced refresh and retry is the only honest recovery.
    if (!/OSS (SignatureDoesNotMatch|InvalidAccessKeyId|SecurityTokenExpired)/.test(String(err.message))) throw err;
    cred = await getUploadCredentials(auth, { fresh: true });
    await ossPut(cred, key, blob, contentType);
  }

  // `name` is the object's basename WITH extension; `file_name` is what the
  // user called it. The server derives its own display name from file_name and
  // dedupes it ("image", then "image (5)").
  const reg = await apiFetch('/media/batch_upload_media', {
    images: [{ name: objectName, size: blob.size, path: key, file_name: fileName || objectName }],
  }, 'POST', auth);

  const result = reg?.result?.[0];
  if (!result?.path) throw new Error('Upload registered but returned no path');
  if (result.err_msg) throw new Error(result.err_msg);
  return result;
}

// ---------- self re-authentication ----------
//
// The vault above stores tokens, and a token dies on its own in about a month.
// Until now the only cure was logging in on the site so a fresh token could be
// scraped off live traffic. `POST /login` returns the same token directly, so
// the extension can renew unattended.
//
// THE COST, STATED PLAINLY. This stores PASSWORDS on disk, in
// chrome.storage.local, in plaintext, alongside the tokens already there. It is
// a strictly worse exposure than the one NOTES 2.2 already accepts: a stolen
// token grants an account until it expires, a stolen password grants it forever
// and survives every rotation. Kept in a SEPARATE storage key from the token
// vault so it can be wiped on its own, and entirely opt-in per account — an
// account with no stored password behaves exactly as it did before.
//
// VERIFIED, not assumed (2026-09-02): a token straight from /login works on a
// real API call with an EMPTY `ai-anonymous-id` (ErrCode 0 from /user/credits).
// This mattered because NOTES 2.2 establishes that token and anon-id are a
// matched set from one login session, and a headless renewal has no tab traffic
// to supply the anon-id. It turns out not to be required. Had it been, none of
// this would work.

const PASSWORDS_KEY = 'accountPasswords';

async function readPasswords() {
  const { [PASSWORDS_KEY]: p } = await chrome.storage.local.get(PASSWORDS_KEY);
  return p && typeof p === 'object' ? p : {};
}

async function savePassword(username, password) {
  if (!username || !password) return false;
  const all = await readPasswords();
  all[username] = { password, savedAt: Date.now() };
  await chrome.storage.local.set({ [PASSWORDS_KEY]: all });
  return true;
}

async function forgetPassword(username) {
  const all = await readPasswords();
  if (!(username in all)) return false;
  delete all[username];
  await chrome.storage.local.set({ [PASSWORDS_KEY]: all });
  return true;
}

// Which accounts CAN renew themselves. Names only — never the secrets.
async function accountsWithPassword() {
  return new Set(Object.keys(await readPasswords()));
}

// Raw login. Deliberately does NOT go through apiFetch: that attaches a token
// header and, on failure, tries to recover auth — which is circular when the
// call being made IS the recovery.
async function apiLogin(username, password) {
  const res = await fetch(`${API}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-platform': 'Web' },
    body: JSON.stringify({ Username: username, Password: password }),
  });
  const raw = await res.json();
  // A logical failure is HTTP 200 with a non-zero ErrCode (NOTES 1.14f) — the
  // first real one ever captured was 500200, "User does not exist."
  if (raw?.ErrCode) throw new Error(raw.ErrMsg || `Login failed (${raw.ErrCode})`);
  const result = raw?.Resp?.Result;
  if (!result?.Token) throw new Error('Login returned no token');
  return result;
}

// PIXVERSE IS SINGLE-SESSION PER ACCOUNT. This is the fact the first version of
// this feature was built without, and it matters more than anything else here.
//
// A successful /login INVALIDATES whatever session that account already had.
// NOTES 2.2 half-knew this ("a re-login rotates both the token and the anon-id")
// but the consequence was missed: if the extension logs in, the browser tab
// holding that account is kicked out, and the site then shows "account has been
// logged in elsewhere". The user signs in on the site, which kicks the EXTENSION
// out, whose next API call fails, which triggers another renewal, which kicks
// the site out again. The two ends evict each other indefinitely.
//
// It only bites accounts with a stored password, because only those can log in
// unattended — which is exactly the reported symptom.
//
// The rule that fixes it: ADOPT, DON'T FIGHT. The extension already sees every
// token the site uses, via the webRequest capture that has been there from the
// beginning. So when a token is rejected, look for a newer one first and only
// log in when there is genuinely nobody to evict.
const MIN_LOGIN_INTERVAL_MS = 60_000;
const lastLoginAt = new Map();

// A token for this account that is NOT the one that just failed, taken from a
// live tab first and the vault second. Never returns an expired token: adopting
// one would satisfy the caller and fail on the very next request.
async function adoptFreshToken(username, staleToken) {
  await hydrateTokens();
  const usable = (a) => a?.token
    && a.token !== staleToken
    && (!a.expiresAt || a.expiresAt > Date.now());

  for (const auth of tokensByTab.values()) {
    if (auth?.username === username && usable(auth)) return auth;
  }
  const rec = (await readVault())[username];
  if (rec?.username === username && usable(rec)) {
    return {
      token: rec.token, anonId: rec.anonId ?? null,
      username, expiresAt: rec.expiresAt ?? null, seenAt: Date.now(),
    };
  }
  return null;
}

// Is some open tab signed in as this account? If so, logging in would sign that
// tab out, and it is the user's own browser we would be evicting.
function accountHasLiveTab(username) {
  for (const auth of tokensByTab.values()) if (auth?.username === username) return true;
  return false;
}

// "Account has been logged in elsewhere" means another session has just taken
// over. Logging in AGAIN is precisely the wrong response: it evicts whoever just
// arrived and starts the ping-pong over. Matched on message text because the
// ErrCode for it has not been measured; see NOTES.
const EVICTED_RE = /logged in elsewhere|logged in on another|another device|kicked out/i;
function isEvictionError(msg) {
  return EVICTED_RE.test(String(msg || ''));
}

// Renew one account from its stored password. Returns fresh auth, or null when
// renewal is unavailable OR would be antisocial — both ordinary outcomes, not
// errors.
//
// Only ONE renewal per account runs at a time. Several jobs failing together on
// the same dead token would otherwise each fire a login, and a burst of logins
// is a thing any sane backend treats as an attack.
const reauthInFlight = new Map();

async function reauthAccount(username, { staleToken = null } = {}) {
  if (!username) return null;
  if (reauthInFlight.has(username)) return reauthInFlight.get(username);

  // Every guard below lives INSIDE the in-flight promise, and that placement is
  // load-bearing. They await, so running them before the promise is registered
  // lets two concurrent callers both slip past the single-flight check and both
  // log in — which is the login storm this map exists to prevent.
  const run = (async () => {
    // 1. Adopt before logging in. If the site has signed in again, the capture
    //    has already seen its token and there is nothing to renew.
    const adopted = await adoptFreshToken(username, staleToken);
    if (adopted) return adopted;

    // 2. A tab holds this account and has no better token, so both ends are on
    //    the same dead session. The site will sign itself back in and the
    //    capture will pick that up. Logging in here would evict the tab the
    //    user is looking at.
    if (accountHasLiveTab(username)) return null;

    // 3. Backstop. Even if the reasoning above is wrong somewhere, this account
    //    cannot be used to hammer PixVerse with logins.
    if (Date.now() - (lastLoginAt.get(username) ?? 0) < MIN_LOGIN_INTERVAL_MS) return null;

    const all = await readPasswords();
    const entry = all[username];
    if (!entry?.password) return null;

    lastLoginAt.set(username, Date.now());
    const result = await apiLogin(username, entry.password);

    // A re-login rotates the anon-id too, and this path has no way to learn the
    // new one — so it is explicitly null rather than inherited. Pairing a new
    // token with a dead session's anon-id is the exact bug NOTES 2.2 warns
    // about. Verified above that null/empty is accepted.
    const auth = buildAuth(result.Token, null);
    await vaultUpsert(auth);

    // If this account was the active override, re-point it at the new token —
    // otherwise the next call keeps retrying the dead one forever.
    const { [OVERRIDE_KEY]: ov } = await chrome.storage.session.get(OVERRIDE_KEY);
    if (ov?.username === username) {
      await chrome.storage.session.set({ [OVERRIDE_KEY]: auth, auth });
    }
    broadcast({ type: 'auth/renewed', username, expiresAt: auth.expiresAt });
    return auth;
  })().finally(() => reauthInFlight.delete(username));

  reauthInFlight.set(username, run);
  return run;
}

async function vaultForget(username) {
  if (!username) return;
  const vault = await readVault();
  if (vault[username]) {
    delete vault[username];
    await chrome.storage.local.set({ [VAULT_KEY]: vault });
  }
  // Forgetting an account must forget its password too, or "forget" would leave
  // the more dangerous half of the credentials sitting on disk.
  await forgetPassword(username);
  // If the forgotten account was the active override, drop it.
  const { [OVERRIDE_KEY]: ov } = await chrome.storage.session.get(OVERRIDE_KEY);
  if (ov?.username === username) {
    await chrome.storage.session.remove(OVERRIDE_KEY);
    await publishActiveAuth();
  }
}

// The panel is associated with whatever PixVerse tab is currently active. Fall
// back to the most recently seen token if the active tab isn't a PixVerse tab
// (e.g. you clicked away), so a working panel doesn't blank out mid-task.
async function resolveActiveAuth() {
  await hydrateTokens();

  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (active && tokensByTab.has(active.id)) return tokensByTab.get(active.id);

  let newest = null;
  for (const auth of tokensByTab.values()) {
    if (!newest || auth.seenAt > newest.seenAt) newest = auth;
  }
  return newest;
}

async function publishActiveAuth() {
  // A manual override (from the account switcher) wins over tab-following.
  const { [OVERRIDE_KEY]: override } = await chrome.storage.session.get(OVERRIDE_KEY);
  if (override?.token) {
    // The override is a SNAPSHOT taken when you picked the account. If you then
    // log that account out and back in, it rotates its token + anon-id, and the
    // snapshot goes stale — every call under it starts failing. So before
    // serving it, refresh from the vault if the vault holds newer credentials
    // for the same account (the capture path keeps the vault current).
    let active = override;
    const vault = await readVault();
    const fresh = vault[override.username];
    if (fresh?.token && (fresh.token !== override.token || fresh.anonId !== override.anonId)) {
      active = {
        token: fresh.token,
        anonId: fresh.anonId ?? null,
        username: fresh.username,
        expiresAt: fresh.expiresAt ?? null,
        seenAt: Date.now(),
      };
      await chrome.storage.session.set({ [OVERRIDE_KEY]: active });
    }

    if (active.expiresAt && active.expiresAt <= Date.now()) {
      // Even after refreshing, the newest stored token is expired — fall back to
      // automatic tab-following.
      await chrome.storage.session.remove(OVERRIDE_KEY);
    } else {
      await chrome.storage.session.set({ auth: active });
      broadcast({ type: 'auth/state', linked: true, username: active.username, expiresAt: active.expiresAt, overridden: true });
      return;
    }
  }

  const auth = await resolveActiveAuth();

  // Deliberately do NOT clear stored auth when nothing resolves. The active tab
  // is frequently not a PixVerse tab at all — the Browse page is an extension
  // page and carries no token — and the worker may have just restarted with an
  // empty map. Clearing here logged the user out simply for opening Browse.
  if (!auth) return;

  await chrome.storage.session.set({ auth });
  broadcast({ type: 'auth/state', linked: true, username: auth.username, expiresAt: auth.expiresAt });
}

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    if (details.tabId < 0) return; // not tied to a tab we can attribute
    let token, anonId;
    for (const h of details.requestHeaders || []) {
      const name = h.name.toLowerCase();
      if (name === 'token') token = h.value;
      else if (name === 'ai-anonymous-id') anonId = h.value;
    }
    if (!token) return;

    const existing = tokensByTab.get(details.tabId);
    const sameToken = existing?.token === token;
    const anonChanged = anonId && existing?.anonId !== anonId;

    if (sameToken && !anonChanged) {
      existing.seenAt = Date.now(); // nothing new — just refresh recency
    } else if (sameToken && anonChanged) {
      // Same session, anon-id arrived (or changed) on a later request — fill it
      // in without discarding the token.
      existing.anonId = anonId;
      existing.seenAt = Date.now();
      vaultUpsert(existing);
    } else {
      // New token → new session. Take the anon-id from THIS request if present;
      // otherwise leave it null and let a subsequent request in this session
      // fill it. Never inherit the previous session's anon-id here.
      const auth = buildAuth(token, anonId);
      tokensByTab.set(details.tabId, auth);
      vaultUpsert(auth);
    }
    persistTokens();
    publishActiveAuth();
  },
  { urls: ['https://app-api.pixverse.ai/creative_platform/*'] },
  ['requestHeaders', 'extraHeaders'],
);

// Re-point the panel when you switch tabs or windows.
chrome.tabs.onActivated.addListener(publishActiveAuth);
chrome.windows.onFocusChanged.addListener((id) => {
  if (id !== chrome.windows.WINDOW_ID_NONE) publishActiveAuth();
});

// Drop a tab's token when it closes so it can't linger as the fallback.
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tokensByTab.delete(tabId)) {
    persistTokens();
    publishActiveAuth();
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (msg.type === 'auth/status') {
    chrome.storage.session.get('auth').then(({ auth }) => {
      respond({
        linked: Boolean(auth?.token),
        username: auth?.username ?? null,
        expiresAt: auth?.expiresAt ?? null,
      });
    });
    return true;
  }

  if (msg.type === 'vault/list') {
    listVaultAccounts()
      .then((accounts) => respond({ ok: true, accounts }))
      .catch((err) => respond({ ok: false, error: String(err.message || err) }));
    return true;
  }

  if (msg.type === 'vault/use') {
    activateVaultAccount(msg.username)
      .then((auth) => respond({ ok: Boolean(auth), username: auth?.username ?? null }))
      .catch((err) => respond({ ok: false, error: String(err.message || err) }));
    return true;
  }

  if (msg.type === 'vault/forget') {
    vaultForget(msg.username)
      .then(() => respond({ ok: true }))
      .catch((err) => respond({ ok: false, error: String(err.message || err) }));
    return true;
  }

  // Saving a password is verified before it is stored: log in once, and only
  // write it if that succeeded. Storing an unverified password would produce an
  // account that silently fails to renew a month later, at the exact moment the
  // feature is supposed to earn its keep.
  if (msg.type === 'vault/savePassword') {
    (async () => {
      const result = await apiLogin(msg.username, msg.password);
      await savePassword(msg.username, msg.password);
      await vaultUpsert(buildAuth(result.Token, null));
      return { ok: true, username: result.Username ?? msg.username };
    })()
      .then(respond)
      .catch((err) => respond({ ok: false, error: String(err.message || err) }));
    return true;
  }

  if (msg.type === 'pricing/estimate') {
    (async () => {
      const est = await estimateCost(msg.params);
      // The balance rides along so the panel can decide affordability without a
      // second round trip — the two are only ever useful together.
      let balance = null;
      try { balance = (await fetchCredits()).total; } catch { /* show cost anyway */ }
      return { ok: true, ...est, balance };
    })()
      .then(respond)
      .catch((err) => respond({ ok: false, error: String(err.message || err) }));
    return true;
  }

  if (msg.type === 'upload/image') {
    uploadImage({ dataUrl: msg.dataUrl, fileName: msg.fileName })
      .then((result) => respond({ ok: true, result }))
      .catch((err) => respond({ ok: false, error: String(err.message || err) }));
    return true;
  }

  if (msg.type === 'vault/forgetPassword') {
    forgetPassword(msg.username)
      .then((dropped) => respond({ ok: true, dropped }))
      .catch((err) => respond({ ok: false, error: String(err.message || err) }));
    return true;
  }


  if (msg.type === 'library/list') {
    listPickerAssets(msg.tab, { limit: msg.limit ?? 24, max: msg.max ?? 300 })
      .then((items) => respond({ ok: true, items }))
      .catch((err) => respond({ ok: false, error: String(err.message || err) }));
    return true;
  }

  if (msg.type === 'job/submit') {
    enqueue(msg.job)
      .then((id) => respond({ ok: true, id }))
      .catch((err) => respond({ ok: false, error: String(err.message || err) }));
    return true;
  }

  if (msg.type === 'library/all') {
    listAllGenerations({ max: msg.max ?? 1000, forceDeep: msg.forceDeep === true, since: msg.since ?? null })
      .then((r) => respond({ ok: true, ...r }))
      .catch((err) => respond({ ok: false, error: String(err.message || err) }));
    return true;
  }

  if (msg.type === 'rerun/stash') {
    chrome.storage.session.set({ pendingRerun: msg.rerun })
      .then(() => {
        // Push to an already-open panel. Without this the panel only checks on
        // load and visibilitychange — and clicking rerun in the browse tab
        // changes neither, so nothing populated until the window was minimized
        // and restored (which finally fires visibilitychange).
        broadcast({ type: 'rerun/ready' });
        respond({ ok: true });
      })
      .catch((err) => respond({ ok: false, error: String(err.message || err) }));
    return true;
  }

  if (msg.type === 'rerun/take') {
    chrome.storage.session.get('pendingRerun').then(({ pendingRerun }) => {
      if (pendingRerun) chrome.storage.session.remove('pendingRerun');
      respond({ rerun: pendingRerun ?? null });
    });
    return true;
  }

  // Diagnostic dump. Deliberately reports PROVENANCE, not just counts — the
  // account-tag bugs were all invisible in a count and obvious in "where did
  // this tag come from".
  if (msg.type === 'debug/archive') {
    (async () => {
      const map = await readArchive();
      const { [ARCHIVE_META_KEY]: meta } = await chrome.storage.local.get(ARCHIVE_META_KEY);
      const swept = await getSweptAccounts();
      const active = await currentAccountName();
      const { [DRIFT_KEY]: driftState } = await chrome.storage.local.get(DRIFT_KEY);
      const recs = Object.entries(map).map(([name, v]) => ({ name, ...v }));

      const byAccount = {};
      for (const r of recs) {
        const key = r.accounts?.length ? r.accounts.join('+') : '(none)';
        byAccount[key] ??= { count: 0, bySource: {}, sampleNames: [] };
        byAccount[key].count++;
        const src = r.accountSource ?? '(unset)';
        byAccount[key].bySource[src] = (byAccount[key].bySource[src] ?? 0) + 1;
        if (byAccount[key].sampleNames.length < 3) byAccount[key].sampleNames.push(r.name);
      }

      respond({
        ok: true,
        dump: {
          archiveVersion: meta?.version ?? null,
          totalRecords: recs.length,
          activeAccount: active,
          sweptAccounts: swept,
          multiTagged: recs.filter((r) => (r.accounts?.length ?? 0) > 1).length,
          untagged: recs.filter((r) => !(r.accounts?.length)).length,
          tagSumVsTotal: {
            sumOfTags: recs.reduce((n, r) => n + (r.accounts?.length ?? 0), 0),
            totalRecords: recs.length,
          },
          byAccount,
          driftEvents: driftState?.events ?? [],
          statusCounts: recs.reduce((acc, r) => {
            acc[r.status ?? '(unset)'] = (acc[r.status ?? '(unset)'] ?? 0) + 1;
            return acc;
          }, {}),
        },
      });
    })().catch((err) => respond({ ok: false, error: String(err.message || err) }));
    return true;
  }

  // Full reset. Clears the archive, the swept list, and account tags so the next
  // loads rebuild everything from authoritative library data. Does NOT touch the
  // credential vault — you stay signed in. Explicit action only.
  if (msg.type === 'backup/export') {
    exportArchive()
      .then((data) => respond({ ok: true, data }))
      .catch((err) => respond({ ok: false, error: String(err.message || err) }));
    return true;
  }

  if (msg.type === 'backup/import') {
    importArchive(msg.data)
      .then((r) => respond({ ok: true, ...r }))
      .catch((err) => respond({ ok: false, error: String(err.message || err) }));
    return true;
  }

  if (msg.type === 'debug/purge') {
    (async () => {
      await chrome.storage.local.remove([ARCHIVE_KEY, ARCHIVE_META_KEY, SWEPT_KEY, DRIFT_KEY]);
      respond({ ok: true });
    })().catch((err) => respond({ ok: false, error: String(err.message || err) }));
    return true;
  }

  if (msg.type === 'star/toggle') {
    toggleStar(msg.name, msg.starred)
      .then((starred) => respond({ ok: true, starred }))
      .catch((err) => respond({ ok: false, error: String(err.message || err) }));
    return true;
  }

  if (msg.type === 'credits/get') {
    fetchCredits()
      .then((c) => respond({ ok: true, credits: c }))
      .catch((err) => respond({ ok: false, error: String(err.message || err) }));
    return true;
  }

  if (msg.type === 'job/list') {
    chrome.storage.local.get('jobs').then(({ jobs }) => respond({ jobs: jobs ?? [] }));
    return true;
  }
});

function broadcast(payload) {
  chrome.runtime.sendMessage(payload).catch(() => { /* panel closed */ });
}

// ---------- transport ----------

// `auth` pins the call to a specific account. Without it every request reads
// whatever session is live AT THE MOMENT IT FIRES — which is wrong for anything
// long-running: a video job polls for up to 25 minutes, and switching accounts
// mid-flight would silently redirect its polling to the new account's library,
// where its asset does not exist. The job then times out while the render
// succeeds. Jobs pin their account at submit; interactive calls pass nothing and
// follow the active session, which is what you want there.
async function apiFetch(path, body, method = 'POST', auth = null) {
  auth = auth ?? await readAuth();

  const headers = {
    token: auth.token,
    'workspace-id': '0',
    'x-platform': 'Web',
    'ai-anonymous-id': auth.anonId ?? '',
    'ai-trace-id': crypto.randomUUID(),
    refresh: 'credit',
  };

  const init = { method, headers };
  if (method !== 'GET' && body != null) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  const raw = TRANSPORT === 'page'
    ? await relayThroughPage(API + path, headers, body, method)
    : await (await fetch(API + path, init)).json();

  // PixVerse envelope: { ErrCode, ErrMsg, Resp }
  if (raw?.ErrCode) {
    // If this looks like an auth rejection and we're running on a manual
    // override, the override may have gone stale (account logged out/in
    // elsewhere, rotating its token). Drop the override, re-resolve, and retry
    // once with whatever the vault/tab now has. Conservative: only one retry,
    // and only when the credentials actually differ afterward.
    if (isAuthError(raw.ErrCode, raw.ErrMsg) && await dropStaleOverride(auth)) {
      const fresh = await readAuth();
      if (fresh.token !== auth.token || fresh.anonId !== auth.anonId) {
        return apiFetchWith(path, body, method, fresh);
      }
    }

    // Second recovery: the token is dead — revoked, or rotated by a login
    // elsewhere — and the clock in readAuth() couldn't have known, because
    // ExpireTime still says it is fine.
    //
    // An EVICTION is handled differently from any other auth failure, and this
    // distinction is the whole fix: "logged in elsewhere" means another session
    // has just taken this account, so we adopt its token if the capture has seen
    // it and otherwise stand down. Logging in would evict that session in turn,
    // which is what produced the ping-pong in the first place.
    if (isAuthError(raw.ErrCode, raw.ErrMsg) && auth.username) {
      const renewed = isEvictionError(raw.ErrMsg)
        ? await adoptFreshToken(auth.username, auth.token)
        : await reauthAccount(auth.username, { staleToken: auth.token }).catch(() => null);
      if (renewed?.token && renewed.token !== auth.token) {
        return apiFetchWith(path, body, method, renewed);
      }
    }
    throw new Error(raw.ErrMsg || `API error ${raw.ErrCode}`);
  }
  return raw?.Resp ?? raw;
}

// A single retry with explicit auth, no further recursion.
async function apiFetchWith(path, body, method, auth) {
  const headers = {
    token: auth.token,
    'workspace-id': '0',
    'x-platform': 'Web',
    'ai-anonymous-id': auth.anonId ?? '',
    'ai-trace-id': crypto.randomUUID(),
    refresh: 'credit',
  };
  const init = { method, headers };
  if (method !== 'GET' && body != null) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const raw = TRANSPORT === 'page'
    ? await relayThroughPage(API + path, headers, body, method)
    : await (await fetch(API + path, init)).json();
  if (raw?.ErrCode) throw new Error(raw.ErrMsg || `API error ${raw.ErrCode}`);
  return raw?.Resp ?? raw;
}

// Auth rejection codes, MEASURED (2026-09-02) by deliberately sending bad
// credentials to /user/credits rather than guessed:
//
//   10001  "Token is invalid"    a malformed or rejected token
//   10003  "user is not login"   empty token, or no token header at all
//
// Both arrive as HTTP 200 with a non-zero ErrCode, like every other failure.
//
// The list this replaces was `[401, 403, 1001, 1002, 1003, 40001, 40100]` —
// note `1001` and `1003`, a single digit away from the real codes and therefore
// never once matching. That branch had never fired in the life of the project;
// the message regex below was silently doing all the work. Worth remembering
// the next time a plausible-looking constant is written from intuition.
//
// The regex stays as a backstop, deliberately loose: a false positive costs one
// extra re-resolve, a false negative leaves you stuck on a dead token.
const AUTH_ERR_CODES = new Set([10001, 10003]);

// Heuristic for an auth rejection: the measured codes above, plus message text.
function isAuthError(code, msg) {
  if (AUTH_ERR_CODES.has(Number(code))) return true;
  const m = String(msg || '').toLowerCase();
  return /token|auth|login|unauthor|expired|session/.test(m);
}

// If a manual override is active and matches the credentials that just failed,
// clear it and re-publish so the next read picks up fresh credentials. Returns
// whether an override was dropped.
async function dropStaleOverride(usedAuth) {
  const { [OVERRIDE_KEY]: override } = await chrome.storage.session.get(OVERRIDE_KEY);
  if (!override?.token) return false;
  if (override.token !== usedAuth.token) return false; // wasn't the culprit
  await chrome.storage.session.remove(OVERRIDE_KEY);
  await publishActiveAuth();
  return true;
}

// The API hands back URLs with the slashes percent-encoded:
//   https://media.pixverse.ai/pixverse%2Fmp4%2Fmedia%2Fweb%2Fori%2Ffile.mp4
// A browser address bar decodes %2F on paste, which is why such a URL plays in
// a new tab — but <video src> does not, and fails with MEDIA_ERR_SRC_NOT_SUPPORTED.
// Decode them back to real slashes before anything tries to load them.
function decodeMediaUrl(u) {
  return String(u).replace(/%2F/gi, '/');
}

// Turn a storage path into a CDN URL WITHOUT mangling the slashes.
// encodeURIComponent turns "/" into "%2F", which makes the CDN look for a file
// literally named "a%2Fb%2Fc.mp4". Encode each segment, keep the separators.
function mediaUrl(path) {
  const clean = String(path).replace(/^\/+/, '');
  const encoded = clean.split('/').map(encodeURIComponent).join('/');
  return `${MEDIA}/${encoded}`;
}

// Same, but with the slashes percent-encoded — the form PixVerse itself sends
// in request payloads (e.g. .../upload%2F<uuid>.jpg). Their own URLs use %2F
// throughout, so payload parity means matching it rather than "fixing" it.
function mediaUrlPacked(path) {
  const clean = String(path).replace(/^\/+/, '');
  return `${MEDIA}/${encodeURIComponent(clean)}`;
}

// Asset list items sometimes carry a ready-to-use absolute URL, sometimes just
// a storage path. Normalize either into a loadable URL.
function assetUrl(value) {
  if (!value) return null;
  const s = String(value);
  return /^https?:\/\//i.test(s) ? decodeMediaUrl(s) : mediaUrl(s);
}

// Derive the mp4 URL from webp_url.
//
// IMPORTANT: there is no webp file. `webp_url` is a placeholder the backend
// emits alongside every generation; fetching it 404s. Its only value is that
// its basename is identical to the mp4's, and unlike `url`/`video_path` it is
// constructed rather than looked up — so it never points at a placeholder
// video. We use it purely as a filename carrier.
//   webp_url basename → pixverse/mp4/media/web/ori/<basename>.mp4
function mp4FromWebp(webpUrl) {
  if (!webpUrl) return null;
  const decoded = decodeMediaUrl(webpUrl);
  const m = decoded.match(/\/pixverse\/webp\/media\/web\/(.+?)\.webp(?:$|[?#])/i);
  return m ? `${MEDIA}/pixverse/mp4/media/web/ori/${m[1]}.mp4` : null;
}

// Poster image. NOT the webp (it doesn't exist) — the generation's own source
// frame, which is a real uploaded file. Missing for text-to-video.
function posterFor(item) {
  const cp = item?.customer_paths;
  const raw = cp?.customer_first_frame_url
    || cp?.customer_img_urls?.[0]
    // image_text records carry a SINGULAR nested key, not the plural array —
    // missing it is why those cards had no poster.
    || cp?.customer_img_url
    || item?.customer_img_url // top-level; empty on image_text
    // Last resort: the backend's own frame grab from the finished video.
    || item?.first_frame
    || null;
  if (!raw || isPlaceholderUrl(raw)) return null;
  return decodeMediaUrl(raw);
}

// The backend fills `url` / `first_frame` with shared default assets when a
// generation has no real output — e.g. .../pixverse-preview/mp4/media/default.mp4
// and .../pixverse/jpg/media/default.jpg. These must never reach the archive:
// they're not your render, and every one of them has the basename "default", so
// they'd all collapse into a single entry.
function isPlaceholderUrl(u) {
  if (!u) return false;
  return /\/media\/default\.\w+(?:$|[?#])/i.test(decodeMediaUrl(String(u)));
}

// Which account a record belongs to, taken from the record itself rather than
// the current session. Session-derived tagging mislabels everything whenever
// the token lags an account switch — and the payload already knows.
function accountOf(item) {
  const nick = item?.nick_name?.trim();
  if (nick) return nick;
  const email = item?.email?.trim();
  if (email) return email.split('@')[0];
  return item?.account_id ? String(item.account_id) : null;
}

// Does the mp4 actually exist yet?
//
// A derivable URL proves nothing: both `url` and `webp_url` come back the
// instant a generation is submitted, long before any file is written. The
// request may queue first, and the site's progress percentage is theatre — it
// parks at 95%, and the file is sometimes fetchable before it claims 100%.
// So the only trustworthy readiness signal is asking the CDN.
//
// 404 here means one of two things we can't tell apart in the moment: not yet,
// or the generation failed. Failed ones 404 forever, which is why the archive
// ages them out rather than retrying indefinitely.
// Run an async fn over a list with bounded concurrency. Sequential awaits in a
// loop are what made Browse take ~25s to appear: verifyPending probed 24 URLs
// at ~1s each, in series, before the page rendered anything.
async function mapLimit(list, limit, fn) {
  const out = new Array(list.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, list.length) }, async () => {
    while (cursor < list.length) {
      const i = cursor++;
      out[i] = await fn(list[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

async function mediaExists(url) {
  if (!url) return false;

  const probe = async (init) => {
    try {
      return await fetch(url, { cache: 'no-store', ...init });
    } catch {
      return null;
    }
  };

  const head = await probe({ method: 'HEAD' });
  if (head?.ok) return true;

  // Never conclude "missing" from a HEAD alone. Object stores can reject or
  // mis-answer HEAD while serving GET perfectly well, and a false negative here
  // retires a render that exists.
  //
  // The confirmation used to be a one-byte ranged GET, and that was the bug:
  // `Range` is not a CORS-safelisted request header, so it forces a preflight
  // this CDN does not answer, and the request fails before it is ever made. Both
  // attempts then fail for unrelated reasons and a perfectly good file is
  // reported missing. Symptom: a tile stuck on "rendering" whose OPEN link
  // shows the image immediately.
  //
  // A bare GET is exactly the request the blob rescue makes successfully
  // everywhere else in this extension, so it is the shape to copy. Headers
  // arrive before the body, so cancelling the stream answers the question
  // without downloading the file.
  const res = await probe({ method: 'GET' });
  if (!res) return false;
  try { await res.body?.cancel(); } catch { /* already consumed or empty */ }
  return res.ok;
}

// Video URL — derived from webp_url ONLY, deliberately.
//
// `url` and `video_path` are not trustworthy: when the backend can't find the
// real asset (which shows up more often on accounts with a lot of generations)
// it fills those fields with a PixVerse placeholder video, and you get the
// placeholder instead of your render with no error to catch. `webp_url` is
// built from the asset's own basename, so it either points at your render or
// isn't there at all — a missing URL we can handle; a wrong one we can't.
//
// Trade-off accepted: an item whose webp hasn't been written yet resolves to
// null and is treated as not-ready, rather than risking a placeholder.
function videoUrlFor(item) {
  const url = mp4FromWebp(item?.webp_url);
  return isPlaceholderUrl(url) ? null : url;
}

// Images have no webp preview; their own URL fields are the source.
function imageUrlFor(item) {
  const raw = item?.url || item?.image_url || item?.img_url || item?.img_path || null;
  return isPlaceholderUrl(raw) ? null : assetUrl(raw);
}

// Playable URL for an asset, by library tab.
function mediaUrlForAsset(item, tab) {
  return tab === 'video' ? videoUrlFor(item) : imageUrlFor(item);
}

// Identity key for a media URL.
//
// The same asset can arrive as two different strings: the API returns
// %2F-encoded slashes, our derived URLs use real ones, and local records stored
// whichever form was current when they were written. Comparing raw strings
// therefore shows the same video twice. Decode, and drop any query/hash so a
// signed or cache-busted variant still matches its plain twin.
//
// Use this ONLY as a key — play from the full URL, not this.
function canonicalUrl(u) {
  if (!u) return '';
  return decodeMediaUrl(String(u)).split(/[?#]/)[0];
}

// ---------- endpoints ----------

// mode -> media type it produces, which is also the library `tab` we poll.
const OUTPUT = { image: 'image', animate: 'video', frames: 'video' };

// The display name PixVerse sends alongside `model`. It is NOT derivable from
// the model string — captures show `v6` → "PixVerse V6" but `qwen-image` →
// "Qwen-image", so the old `PixVerse ${model.toUpperCase()}` formula produced
// "PixVerse QWEN-IMAGE" for every non-PixVerse model.
//
// VERIFIED from captured requests: v6, qwen-image.
// The rest follow the two observed patterns and are unverified — PixVerse's own
// models take the "PixVerse V<n>" form, third-party ones appear to be the model
// id with only the first letter capitalised. Worth replacing with captured
// values if a call ever rejects one; it may well be cosmetic.
// Display names. `verified` means a real captured request carried that exact
// pairing; everything else follows the observed pattern and is a guess.
//
// The KEYS were checked against the 4087-record archive, where `model` is the
// id the server echoed back. `seedream` is not one of them — real records carry
// `seedream-4.0` — so the old bare key could never have matched anything. The
// ids `v5.6` and `pixverse-c1` do occur and had no entry at all; they fall
// through to the pattern rules below, which handle `v5.6` correctly and are
// merely guessing at `pixverse-c1`.
const MODEL_DISPLAY_NAME = {
  v6: 'PixVerse V6',              // verified
  'qwen-image': 'Qwen-image',     // verified
  v5: 'PixVerse V5',              // inferred
  'v5.6': 'PixVerse V5.6',        // inferred; id seen in the archive
  'pixverse-c1': 'PixVerse C1',   // display name read off the live dropdown
  'seedream-4.0': 'Seedream 4.0', // display name read off the live dropdown
  'seedream-4.5': 'Seedream 4.5', // display name read off the live dropdown
  'seedream-5.0-lite': 'Seedream 5.0 Lite',
  'seedream-5.0-pro': 'Seedream 5.0 Pro',
};

function modelDisplayName(model) {
  const key = String(model || '').toLowerCase();
  if (MODEL_DISPLAY_NAME[key]) return MODEL_DISPLAY_NAME[key];
  // Unknown model: follow whichever pattern its id suggests.
  if (/^v[\d.]+$/.test(key)) return `PixVerse ${key.toUpperCase()}`;
  return key.charAt(0).toUpperCase() + key.slice(1);
}

// Image -> image. Payload verified against a real captured /image/i2i call.
//
// The response shape differs from the video endpoints (success_ids / image_id /
// fail_count, and a total_count that came back 0 alongside success_count 1).
// Nothing here reads it — completion is detected by diffing the asset library —
// so the inconsistency doesn't matter.
function generateImage({ imagePath, prompt, model, count, seed, quality, aspectRatio, creditChange }, auth = null) {
  return apiFetch('/image/i2i', {
    customer_img_paths: [imagePath],
    prompt,
    model,
    create_count: count,
    seed,
    quality,
    aspect_ratio: aspectRatio,
    credit_change: creditChange, // echoed for parity with the web client; the
                                 // server recomputes the real cost anyway
    model_name_default: modelDisplayName(model),
  }, 'POST', auth);
}

// Single image -> video. Payload verified against two real captured /video/i2v
// calls. Note `image_text` generations use THIS endpoint too — the create_mode
// in the library is a label the backend assigns, not a separate API.
//
// multi_shot is passed through rather than fixed: the captured image_text call
// sent 1, an earlier animate capture sent 0. What it switches isn't confirmed,
// so a rerun sends back whatever the original record carried, and a fresh
// generation defaults to 0.
function generateI2V({ imagePath, prompt, model, count, quality, duration, seed, creditChange, multiShot = 0 }, auth = null) {
  return apiFetch('/video/i2v', {
    customer_img_path: imagePath, // singular — not an array
    prompt,
    model,
    create_count: count,
    customer_img_url: mediaUrlPacked(imagePath), // %2F form, as captured
    multi_shot: multiShot,
    quality,
    duration,
    seed,
    credit_change: creditChange, // server-authoritative; sent for shape parity
    model_name_default: modelDisplayName(model),
  }, 'POST', auth);
}

// First + last frame -> video. Payload verified against a real captured
// /video/frames call. The earlier inferred version was right about the endpoint
// and about carrying both singular and array forms (prompt + prompts[],
// duration + durations[]), and right about the audio / preview_mode / off_peak
// field names — those are always present, not conditional on the toggles.
//
// Two things it had wrong: customer_img_urls were built with plain slashes
// (PixVerse sends the %2F form), and model_name_default was missing entirely.
//
// Note the two sources can have different prefixes and extensions — a captured
// call mixed an uploaded PNG with an i2i-generated JPG — so nothing here may
// assume a shape for the paths.
function generateFrames({ firstPath, lastPath, prompt, model, count, duration, quality, seed, audio, previewMode, offPeak }, auth = null) {
  return apiFetch('/video/frames', {
    customer_img_paths: [firstPath, lastPath],
    prompt,
    model,
    create_count: count,
    customer_img_urls: [mediaUrlPacked(firstPath), mediaUrlPacked(lastPath)],
    prompts: [prompt],
    durations: [duration],
    preview_mode: previewMode,
    quality,
    duration,
    off_peak: offPeak,
    seed,
    audio,
    model_name_default: modelDisplayName(model),
  }, 'POST', auth);
}

// Returns the pagination envelope, not just the rows. The server tells us
// whether more exists (web_has_more) and where to resume (web_next_offset); we
// used to ignore both and infer "done" from a short page, which stops early
// when a page is short but more remains. `filter` is { start_time, end_time }
// in Unix seconds — the site sends it to window results (its date picker), and
// omitting it lets the server apply its own default window, which is very
// likely why old generations stop appearing.
async function listAssets(tab, { limit = 50, offset = 0, webOffset = 0, current = 1, filter = null, assetSource = 1, auth = null } = {}) {
  const resp = await apiFetch('/asset/library/list', {
    tab, // "image" | "video"
    // asset_source separates UPLOADED media (0) from GENERATED assets (1).
    // Hardcoding 1 was correct for video — every generation is source 1, which
    // is why that path always worked — and silently excluded every uploaded
    // image from the frame picker.
    asset_source: assetSource,
    folder_id: 0,
    offset,
    limit,
    sort_order: '',
    current,
    app_offset: 0,
    web_offset: webOffset,
    ...(filter ? { filter } : {}),
  }, 'POST', auth);
  return {
    data: resp?.data ?? [],
    hasMore: Boolean(resp?.web_has_more ?? resp?.has_more),
    nextOffset: resp?.web_next_offset ?? resp?.next_offset ?? null,
  };
}

// ---------- archive ----------
//
// A persistent local record of every generation we've seen, keyed by mp4
// basename. It exists because the API listing forgets: old generations drop off
// it while their files stay downloadable indefinitely. It also spans accounts —
// storage.local isn't cleared on account switch, so libraries from several
// logins consolidate here, each record tagged with where it was seen.
//
// Nothing is ever pruned. Records carry a status so a failed generation (which
// 404s forever) stops being probed instead of costing a request every load.

function frLog(msg) {
  console.debug(`[FrameRoom] ${msg}`);
}

const ARCHIVE_KEY = 'archive';
const ARCHIVE_META_KEY = 'archiveMeta';
const ARCHIVE_VERSION = 11;

// video_status is stored for reference but is NOT used to decide whether a
// render exists. A record with status 7, a placeholder `url` and an empty
// `video_path` still had a perfectly good mp4 at the webp-derived path — so the
// status tells us nothing reliable, and acting on it would hide real videos.
// Only an actual probe decides.
const GONE_AFTER_MS = 24 * 3600_000;   // missing this long → probably failed
const GONE_RECHECK_MS = 24 * 3600_000; // but re-check daily, in case we're wrong

const SWEPT_KEY = 'sweptAccounts';

// Which accounts have had the one-time deep history sweep. Kept in local so it
// survives restarts — a deep sweep is expensive and only needs to run once.
async function getSweptAccounts() {
  const { [SWEPT_KEY]: s } = await chrome.storage.local.get(SWEPT_KEY);
  return Array.isArray(s) ? s : [];
}

async function markAccountSwept(account) {
  const swept = await getSweptAccounts();
  if (!swept.includes(account)) {
    await chrome.storage.local.set({ [SWEPT_KEY]: [...swept, account] });
  }
}

// Toggle (or explicitly set) the starred flag on an archive record, keyed by
// mp4 basename. Lives on the record itself, so a star persists across reloads
// and account switches like everything else in the archive. Returns the new
// state; a no-op if the record isn't there.
async function toggleStar(name, explicit) {
  if (!name) throw new Error('no record');
  const map = await readArchive();
  const rec = map[name];
  if (!rec) return false;

  rec.starred = typeof explicit === 'boolean' ? explicit : !rec.starred;
  map[name] = rec;
  await chrome.storage.local.set({ [ARCHIVE_KEY]: map });
  return rec.starred;
}

async function readArchive() {
  const { [ARCHIVE_KEY]: a } = await chrome.storage.local.get(ARCHIVE_KEY);
  return a && typeof a === 'object' ? a : {};
}


// The archive index is the properly-formatted media URL: %2F decoded, query
// stripped. Nothing else identifies an asset as precisely.
//
// It used to be the filename stem, which collides — every placeholder shares the
// basename `default`, so unrelated records collapsed into one entry and
// overwrote each other. Two assets with the same stem under different prefixes
// (an upload and an i2i output) would have done the same. A full URL cannot.
//
// The one case with no URL to index by: generations whose image_url AND
// image_path both come back blank, the file having been there during generation
// and forgotten by the listing afterwards. Those are keyed by asset id so they
// are kept rather than dropped, and fold into the URL-keyed entry if one ever
// arrives.
function archiveKeyFor(rec) {
  return rec?.url ? canonicalUrl(rec.url) : (rec?.id ? `id:${rec.id}` : null);
}

async function archiveMerge(records) {
  if (!records.length) return { added: 0, total: 0 };

  const map = await readArchive();
  const now = Date.now();
  let added = 0;

  // asset id -> existing key, so a sighting that arrives WITHOUT a url lands on
  // the entry already filed under its media basename instead of forking a
  // second, id-keyed copy of the same generation.
  const byId = new Map();
  for (const [k, v] of Object.entries(map)) {
    if (v?.id != null) byId.set(String(v.id), k);
  }

  for (const r of records) {
    let key = archiveKeyFor(r);
    if (!key) continue;

    if (key.startsWith('id:') && r.id != null && byId.has(String(r.id))) {
      key = byId.get(String(r.id)); // already known under a real media key
    }

    // A record first seen without a URL was filed under its id. When a later
    // sighting finally carries one, fold that placeholder into the real entry
    // rather than leaving the same generation in the archive twice.
    if (!key.startsWith('id:') && r.id && map[`id:${r.id}`]) {
      const orphan = map[`id:${r.id}`];
      delete map[`id:${r.id}`];
      byId.delete(String(r.id));
      map[key] = { ...orphan, ...(map[key] ?? {}), starred: orphan.starred || map[key]?.starred || false };
    }

    const prev = map[key];
    if (!prev) added++;
    if (r.id != null) byId.set(String(r.id), key);

    // A generation belongs to exactly ONE account, and only the library payload
    // can say which — it names the owner on the record itself (nick_name /
    // email / account_id).
    //
    // Local job records are NOT a valid source, even as a fallback for records
    // with no tag. They carry whatever account was active at submit time, which
    // before the credential-rotation fix could be stale — and that is the
    // original source of every mis-tag. Letting them fill a gap meant a record
    // the migration had just cleared got re-tagged from the same bad data on the
    // very next load, so counts moved every time accounts were switched.
    //
    // A record the library has never confirmed stays unattributed. That's an
    // honest gap; a guess that silently rewrites itself is not.
    const fromLibrary = r.source === 'library' || r.source === 'both';
    const accounts = fromLibrary && r.account ? [r.account] : (prev?.accounts ?? []);

    map[key] = {
      ...prev,
      ...r,
      // A later sighting with blank fields must not erase what we already knew.
      // url matters most: the listing serves a populated image_url during
      // generation and a blank one afterwards, so the first sighting is often
      // the only one that ever carries it.
      url: r.url || prev?.url || null,
      path: r.path || prev?.path || null,
      prompt: r.prompt || prev?.prompt || '',
      poster: r.poster || prev?.poster || null,
      model: r.model || prev?.model || '',
      quality: r.quality || prev?.quality || '',
      seed: r.seed ?? prev?.seed ?? null,
      createdAt: r.createdAt || prev?.createdAt || null,
      videoStatus: r.videoStatus ?? prev?.videoStatus ?? null,
      // Rerun inputs — keep whichever sighting actually captured them.
      rerun: r.rerun ?? prev?.rerun ?? null,
      accounts,
      // Provenance for the tag above. Only ever 'library'; kept so a future
      // migration can tell a confirmed tag from a legacy one without guessing.
      accountSource: fromLibrary && r.account ? 'library' : (prev?.accountSource ?? null),
      // User field — a re-sighting from the API must never clear it.
      starred: prev?.starred ?? false,
      // Once verified present it stays verified — files don't un-exist.
      status: prev?.status === 'ok' ? 'ok' : (prev?.status ?? 'pending'),
      firstSeenAt: prev?.firstSeenAt ?? now,
      lastSeenAt: now,
    };
  }

  await chrome.storage.local.set({ [ARCHIVE_KEY]: map });
  return { added, total: Object.keys(map).length };
}

// Probe a bounded number of unverified records per call, least-recently-checked
// first, so a large archive doesn't fire hundreds of requests on every load.
async function verifyPending({ max = 60 } = {}) {
  const map = await readArchive();
  const now = Date.now();

  // Unverified records first, but 'gone' records are re-checked daily too —
  // being marked gone must never be permanent, because the only evidence for it
  // is a probe that failed, and probes can fail for reasons unrelated to the
  // file (transient network, a render still queued, an odd CDN response).
  const due = Object.entries(map)
    .filter(([, v]) => {
      if (v.status === 'ok') return false;
      if (v.status === 'gone') return now - (v.lastCheckedAt ?? 0) > GONE_RECHECK_MS;
      return true;
    })
    .sort((a, b) => (a[1].lastCheckedAt ?? 0) - (b[1].lastCheckedAt ?? 0))
    .slice(0, max);

  if (!due.length) return { checked: 0, ok: 0, gone: 0, revived: 0 };

  let ok = 0;
  let gone = 0;
  let revived = 0;

  // Probe in parallel — 8 at a time. In series this was the whole load stall.
  const probed = await mapLimit(due, 8, async ([, rec]) => ({
    rec, exists: await mediaExists(rec.url),
  }));

  for (const { rec, exists } of probed) {
    const key = archiveKeyFor(rec);
    const wasGone = rec.status === 'gone';
    rec.lastCheckedAt = now;

    if (exists) {
      rec.status = 'ok';
      ok++;
      if (wasGone) revived++; // we were wrong about this one; it's back
    } else if (now - (rec.firstSeenAt ?? now) > GONE_AFTER_MS) {
      rec.status = 'gone';
      if (!wasGone) gone++;
    }
    map[key] = rec;
  }

  await chrome.storage.local.set({ [ARCHIVE_KEY]: map });
  return { checked: due.length, ok, gone, revived };
}

// Schema migration. Records marked 'gone' by earlier rules — including the
// video_status shortcut, which was wrong — are reset so they get re-probed
// rather than staying hidden on the strength of a bad inference.
async function migrateArchive() {
  const { [ARCHIVE_META_KEY]: meta } = await chrome.storage.local.get(ARCHIVE_META_KEY);
  const from = meta?.version ?? 0;
  if (from >= ARCHIVE_VERSION) return { migrated: 0 };

  const map = await readArchive();
  let migrated = 0;

  for (const rec of Object.values(map)) {
    // v2: records marked gone by earlier rules — including the video_status
    // shortcut, which was wrong — get re-probed instead of staying hidden.
    if (from < 2 && rec.status === 'gone') {
      rec.status = 'pending';
      rec.lastCheckedAt = 0;
      migrated++;
    }

    // v3: account tags written before per-record attribution are unreliable —
    // the old fallback stamped the signed-in account onto records that never
    // named one, so a record could claim every account you'd browsed under.
    // There's no way to tell a correct tag from a guessed one after the fact,
    // so clear them; they repopulate from library payloads, which are
    // authoritative. A wrong tag is worse than a missing one when the entire
    // point is filtering by it.
    if (from < 3 && rec.accounts?.length) {
      rec.accounts = [];
      migrated++;
    }
  }

  // The old placeholder-collision entry, if one was written.
  if (map.default) {
    delete map.default;
    migrated++;
  }

  // v4: rerun inputs (source frames, mode) were added in 0.22 and are only
  // captured by a fresh library fetch. Existing records don't have them and,
  // once an account is marked swept, wouldn't re-fetch. Clear the swept list so
  // every account deep-sweeps once more and every record gains rerun data.
  //
  // v5: same again. image_text records store their source under the SINGULAR
  // customer_img_path, which the extractor wasn't reading — so they were
  // archived with an empty rerun block and looked frameless. Re-sweep so they
  // pick up the source image they always had.
  //
  // v6: account tags were a growing set that never dropped a wrong entry, so
  // records could claim two accounts. The library payload is authoritative now
  // and replaces the tag — re-sweep so every record the API still returns gets
  // corrected. Deliberately NOT clearing tags outright: records the API has
  // forgotten would become permanently unattributed, and a possibly-stale tag
  // beats no tag for those.
  //
  // v7: v6 made the library account authoritative, but replacement only fixes a
  // record when it is re-seen — and a record wrongly tagged with account X
  // belongs to Y, so X's library never returns it. The removal pass
  // (reconcileAccountTags) needs a deep sweep to run, and v6 had already marked
  // accounts swept. Clear again so each account reconciles once.
  if (from < 7) {
    await chrome.storage.local.remove(SWEPT_KEY);
    migrated++;
  }

  // v7: actually REPAIR the multi-tagged records. v6 made the library payload
  // authoritative, but that only corrects a record when the API re-confirms it —
  // and sweeping one account returns only that account's own records, never the
  // ones wrongly tagged with it that belong elsewhere. Repairing by re-fetching
  // would mean signing into every account in turn.
  //
  // No re-fetch is needed: a generation has exactly one owner, so any record
  // carrying two or more tags is corrupt on its face. The record's own
  // `account` field is the most recent sighting and prefers the library value
  // over a local job's, so collapse to that. If there isn't one, the honest
  // answer is unattributed rather than a coin flip between two tags.
  if (from < 7) {
    for (const rec of Object.values(map)) {
      if ((rec.accounts?.length ?? 0) > 1) {
        rec.accounts = rec.account ? [rec.account] : [];
        migrated++;
      }
    }
  }

  // v8: local job records are no longer allowed to write an account tag at all —
  // they were re-applying stale tags to records v7 had just cleared, which is
  // why counts shifted every time accounts were switched. Any tag not confirmed
  // by a library payload is suspect, so drop the unconfirmed ones and let the
  // sweep re-establish them from authoritative data. Clearing the swept list
  // gives that sweep a chance to run.
  if (from < 8) {
    for (const rec of Object.values(map)) {
      if (rec.accounts?.length && rec.accountSource !== 'library') {
        rec.accounts = [];
        migrated++;
      }
    }
    await chrome.storage.local.remove(SWEPT_KEY);
  }

  // v9: re-key from filename stem to the full canonical URL. Stems collide —
  // `default` most visibly — so entries could overwrite each other. Merging on
  // collision rather than letting the last write win, because a colliding pair
  // may already hold a star or a verified status worth keeping.
  // v10: the empty-window tolerance went 3 -> 6, so a sweep that previously
  // stopped at a long dormant stretch can now reach past it. Clearing the swept
  // list lets every account try again; without it the accounts that stopped
  // short would keep their truncated history forever.
  // v11: every "unreachable" verdict to date came from a probe that sent a
  // Range header, which a browser will not send cross-origin without a
  // preflight. Those verdicts are unsafe, so reset them and let the corrected
  // probe decide again rather than leaving good records retired on bad evidence.
  if (from < 11) {
    for (const rec of Object.values(map)) {
      if (rec.status === 'gone') {
        rec.status = 'pending';
        rec.lastCheckedAt = 0;
        migrated++;
      }
    }
  }

  if (from < 10) {
    await chrome.storage.local.remove(SWEPT_KEY);
    migrated++;
  }

  if (from < 9) {
    const rekeyed = {};
    for (const [oldKey, rec] of Object.entries(map)) {
      const newKey = archiveKeyFor(rec) ?? oldKey;
      const clash = rekeyed[newKey];
      rekeyed[newKey] = clash
        ? {
            ...clash,
            ...rec,
            url: rec.url || clash.url || null,
            starred: clash.starred || rec.starred || false,
            status: clash.status === 'ok' || rec.status === 'ok' ? 'ok' : (rec.status ?? clash.status),
            accounts: [...new Set([...(clash.accounts ?? []), ...(rec.accounts ?? [])])],
          }
        : rec;
      if (newKey !== oldKey) migrated++;
    }
    for (const k of Object.keys(map)) delete map[k];
    Object.assign(map, rekeyed);
  }

  await chrome.storage.local.set({
    [ARCHIVE_KEY]: map,
    [ARCHIVE_META_KEY]: { version: ARCHIVE_VERSION, migratedAt: Date.now() },
  });
  return { migrated };
}

// ---------- backup / restore ----------
//
// The archive is the artifact worth keeping: prompt, seed, model, settings and
// account for every generation, including ones the platform's listing has since
// forgotten. The media files themselves carry none of that.
//
// The credential vault is deliberately NOT exported. Tokens expire in about a
// month, so a backup of them is near-worthless by the time you would restore it,
// and writing live bearer tokens into a file that lands in a downloads folder —
// and from there into whatever syncs it — is a materially worse exposure than
// the plaintext-on-disk trade already accepted.
//
// The swept-accounts list is not exported either. Restoring it would tell a
// fresh install "already scanned everything" and skip the deep sweep that would
// find anything generated since the backup. One slow load per account is the
// correct price.

// Earliest of two possibly-absent timestamps, never Infinity.
function earliest(a, b) {
  const v = Math.min(a ?? Infinity, b ?? Infinity);
  return Number.isFinite(v) ? v : Date.now();
}

const BACKUP_FORMAT = 'frame-room/archive';
const BACKUP_VERSION = 1;

async function exportArchive() {
  const map = await readArchive();
  const { [ARCHIVE_META_KEY]: meta } = await chrome.storage.local.get(ARCHIVE_META_KEY);
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    archiveVersion: meta?.version ?? null,
    recordCount: Object.keys(map).length,
    records: map,
  };
}

// Merge, never replace. Two archives of the same accounts overlap heavily, and a
// restore should fold a backup into a live archive without discarding whatever
// has happened since — the same reasoning that makes the archive append-only.
async function importArchive(data) {
  if (!data || typeof data !== 'object') throw new Error('Not a backup file.');
  if (data.format !== BACKUP_FORMAT) throw new Error('Not a Frame Room archive backup.');
  if (!data.records || typeof data.records !== 'object') throw new Error('Backup contains no records.');
  if (Number(data.version) > BACKUP_VERSION) {
    throw new Error(`Backup is from a newer version (${data.version}).`);
  }

  const map = await readArchive();
  let added = 0;
  let merged = 0;
  let skipped = 0;

  for (const incoming of Object.values(data.records)) {
    // Re-key rather than trusting the file's keys: a backup may predate the
    // index change from filename stem to canonical URL.
    const key = archiveKeyFor(incoming);
    if (!key) { skipped++; continue; }

    const prev = map[key];
    if (!prev) {
      // Normalise on the way in. Storing the file's raw shape would leave an
      // imported record subtly different from a natively-archived one — missing
      // accounts, missing timestamps — and re-importing the same file would then
      // "change" it. An imported record should be indistinguishable.
      map[key] = {
        ...incoming,
        accounts: incoming.accounts ?? [],
        starred: Boolean(incoming.starred),
        firstSeenAt: incoming.firstSeenAt ?? Date.now(),
        lastSeenAt: incoming.lastSeenAt ?? Date.now(),
      };
      added++;
      continue;
    }

    map[key] = {
      ...prev,
      ...incoming,
      // Same preference rules the live merge uses: a blank must never overwrite
      // something known, whichever side it arrived from.
      url: prev.url || incoming.url || null,
      path: prev.path || incoming.path || null,
      prompt: prev.prompt || incoming.prompt || '',
      poster: prev.poster || incoming.poster || null,
      model: prev.model || incoming.model || '',
      quality: prev.quality || incoming.quality || '',
      seed: prev.seed ?? incoming.seed ?? null,
      createdAt: prev.createdAt || incoming.createdAt || null,
      accounts: [...new Set([...(prev.accounts ?? []), ...(incoming.accounts ?? [])])],
      accountSource: prev.accountSource ?? incoming.accountSource ?? null,
      starred: Boolean(prev.starred || incoming.starred),
      status: prev.status === 'ok' || incoming.status === 'ok' ? 'ok' : (prev.status ?? incoming.status),
      // Math.min of two missing values is Infinity, which is truthy — so `||
      // Date.now()` never fires and the record stores Infinity, serialising to
      // null on the next export. Check for a finite result instead.
      firstSeenAt: earliest(prev.firstSeenAt, incoming.firstSeenAt),
      lastSeenAt: Math.max(prev.lastSeenAt ?? 0, incoming.lastSeenAt ?? 0) || Date.now(),
    };
    merged++;
  }

  await chrome.storage.local.set({ [ARCHIVE_KEY]: map });
  return { added, merged, skipped, total: Object.keys(map).length };
}

// ---------- drift detection ----------
//
// Account counts have shifted between loads three times now, and each time the
// only evidence was a screenshot and my recollection of what changed. That is a
// bad way to debug a data bug. So the extension records it itself: after every
// load, per-account counts are compared with the previous load, and any change
// is logged alongside what that load actually did — whether it deep-swept,
// whether the sweep finished, whether reconciliation ran, how many records came
// from the library versus local job records.
//
// A count changing after a deep sweep of that account is expected. A count
// changing on a plain reload is not, and that distinction is exactly what was
// missing. Surfaced in the D diagnostic.

const DRIFT_KEY = 'accountDrift';
const DRIFT_HISTORY = 20;

async function recordAccountDrift(map, context) {
  const now = {};
  for (const rec of Object.values(map)) {
    for (const a of rec.accounts ?? []) now[a] = (now[a] ?? 0) + 1;
  }
  now['(untagged)'] = Object.values(map).filter((r) => !(r.accounts?.length)).length;

  const { [DRIFT_KEY]: state } = await chrome.storage.local.get(DRIFT_KEY);
  const prev = state?.counts ?? null;
  const events = state?.events ?? [];

  const changes = [];
  if (prev) {
    for (const k of new Set([...Object.keys(prev), ...Object.keys(now)])) {
      const from = prev[k] ?? 0;
      const to = now[k] ?? 0;
      if (from !== to) changes.push({ account: k, from, to, delta: to - from });
    }
  }

  if (changes.length) {
    events.unshift({ at: new Date().toISOString(), changes, ...context });
    events.splice(DRIFT_HISTORY);
  }

  await chrome.storage.local.set({ [DRIFT_KEY]: { counts: now, events } });
  return { changes, explained: Boolean(context.deep || context.reconciled) };
}

async function currentAccountName() {
  const { auth } = await chrome.storage.session.get('auth');
  return auth?.username ?? null;
}

// After a DEEP sweep, the fetched set is that account's complete history — so
// any record still tagged with it that wasn't returned is mis-tagged, and the
// tag is dropped.
//
// This is the half that replacing-on-sighting can't do. Replacement only fixes
// a record when it's re-seen, but a record wrongly tagged with account X
// actually belongs to account Y, so X's library never returns it and the bad
// tag survives forever. Hence an explicit removal pass.
//
// Only safe after a *deep* sweep (a recent-window fetch is incomplete by
// design) and only when the fetch succeeded. The account name is derived from
// the fetched records rather than the session, so it can't drift from the
// spelling used in the tags.
async function reconcileAccountTags(apiItems) {
  const names = new Set(apiItems.map((r) => r.account).filter(Boolean));
  if (names.size !== 1) return { account: null, cleared: 0 }; // ambiguous or empty
  const account = [...names][0];

  const present = new Set(apiItems.map((r) => archiveKeyFor(r)).filter(Boolean));
  const map = await readArchive();
  let cleared = 0;

  for (const [key, rec] of Object.entries(map)) {
    if (!rec.accounts?.includes(account)) continue;
    if (present.has(key)) continue; // genuinely this account's
    rec.accounts = rec.accounts.filter((a) => a !== account);
    map[key] = rec;
    cleared++;
  }

  if (cleared) await chrome.storage.local.set({ [ARCHIVE_KEY]: map });
  return { account, cleared };
}


// What media type a job record produced. Records have carried three different
// shapes over time: `output` (current), `mode` (0.6+), `kind` (pre-0.6).
function jobOutputType(job) {
  if (job.output) return job.output;
  if (job.mode) return OUTPUT[job.mode] ?? null;
  if (job.kind === 'video' || job.kind === 'image') return job.kind;
  return null;
}

// Videos we generated through this extension, from our own job records.
// This is a genuinely separate source from the API listing: it survives the
// library call coming back short, and it carries the params you generated with
// (model/quality/duration) which the list payload doesn't always include.
//
// Note the re-derivation: records written before 0.12 stored a URL built from
// `url`/`video_path`, which can be a placeholder. They also stored `thumb` (the
// webp), so we rebuild the mp4 from that — which retroactively cleans old
// records without touching what's on disk.
async function listLocalVideos() {
  const { jobs = [] } = await chrome.storage.local.get('jobs');
  const out = [];

  for (const job of jobs) {
    if (job.state !== 'done') continue;
    if (jobOutputType(job) !== 'video') continue;

    for (const r of job.results ?? []) {
      // Decode the fallback: records written before 0.11 stored the raw asset
      // URL with %2F-encoded slashes, which both breaks <video> and fails to
      // match the API's clean form during dedupe.
      const url = mp4FromWebp(r.thumb) ?? decodeMediaUrl(r.url);
      if (!url || isPlaceholderUrl(url)) continue; // every placeholder shares
                                                   // the basename "default"

      // Records written by 0.11–0.13 stored the webp URL as the thumb. There is
      // no webp file, so that would render as a broken image — drop it.
      const thumb = r.thumb && !/\/pixverse\/webp\//i.test(r.thumb)
        ? decodeMediaUrl(r.thumb)
        : null;

      out.push({
        id: r.id ?? null,
        url,
        poster: thumb,
        prompt: job.prompt ?? '',
        model: job.params?.model ?? '',
        quality: job.params?.quality ?? '',
        duration: job.params?.duration ?? null,
        seed: job.seed ?? job.params?.seed ?? null,
        createdAt: job.startedAt ? new Date(job.startedAt).toISOString() : null,
        mode: job.mode ?? job.kind ?? '',
        // Only what this job actually recorded. Jobs from before 0.18 have
        // none, and that stays null rather than being guessed at.
        account: job.account ?? null,
        source: 'local',
      });
    }
  }

  return out;
}

// Merge the two sources. Keyed on canonicalUrl so the %2F-encoded and
// plain-slash spellings of the same asset collapse into one card instead of
// appearing twice.
function mergeGenerations(apiItems, localItems) {
  const byUrl = new Map();

  for (const it of apiItems) {
    byUrl.set(canonicalUrl(it.url), { ...it, url: decodeMediaUrl(it.url), source: 'library' });
  }

  for (const it of localItems) {
    const key = canonicalUrl(it.url);
    const existing = byUrl.get(key);
    if (!existing) {
      byUrl.set(key, { ...it, url: decodeMediaUrl(it.url) }); // local-only — the point of this merge
      continue;
    }
    // Present in both: keep the library record but let local fill any gaps.
    byUrl.set(key, {
      ...existing,
      prompt: existing.prompt || it.prompt,
      model: existing.model || it.model,
      quality: existing.quality || it.quality,
      duration: existing.duration ?? it.duration,
      seed: existing.seed ?? it.seed,
      createdAt: existing.createdAt ?? it.createdAt,
      // The library payload names the account authoritatively; a local record
      // only knows what it captured at creation.
      account: existing.account || it.account || null,
      source: 'both',
    });
  }

  const merged = [...byUrl.values()];
  const ts = (v) => (v ? Date.parse(v) || 0 : 0);
  merged.sort((a, b) => ts(b.createdAt) - ts(a.createdAt)); // newest first
  return merged;
}

// Everything we can show. Both live sources feed the archive, then the archive
// is what's returned — so generations the API has forgotten, and ones made
// under other accounts, keep showing up.
async function listAllGenerations({ max = 1000, forceDeep = false, since = null } = {}) {
  let apiItems = [];
  let apiError = null;
  let sweepComplete = false;
  let sweepStoppedBy = null;

  // Run migrations FIRST — v4 clears the swept list, and the deep-sweep decision
  // below must see that this load, not next.
  await migrateArchive();

  // Deep-sweep the full 90-day-windowed history once per account, then only the
  // recent window on subsequent loads. The archive holds everything the deep
  // pass found, so later loads stay fast.
  const account = await currentAccountName();
  const swept = await getSweptAccounts();
  const deep = forceDeep || (account ? !swept.includes(account) : false);

  try {
    const sweep = await listAllVideos({ max, deep, since });
    apiItems = sweep.items;
    sweepComplete = sweep.complete;
    sweepStoppedBy = sweep.stoppedBy;
    // Only bank a sweep as done when it actually reached the floor; a truncated
    // one should be retried on the next load rather than never repeated.
    if (deep && account && sweep.complete) await markAccountSwept(account);
  } catch (err) {
    apiError = String(err.message || err);
  }

  // Images are archived alongside videos so the API forgetting them costs
  // nothing, same as for video.
  const imageItems = await listAllImages().catch(() => []);

  const localItems = await listLocalVideos().catch(() => []);

  // Everything we just saw goes into the archive before anything is displayed.
  const generations = [
    ...mergeGenerations(apiItems, localItems),
    ...imageItems.map((i) => ({ ...i, source: 'library' })),
  ];

  // Source frames referenced by those generations, archived as images in their
  // own right. Stripped off the parents afterwards so the same URLs aren't
  // stored twice.
  const derived = generations.flatMap((r) => r.inputs ?? []);
  const merged = [...generations.map(({ inputs, ...rest }) => rest), ...derived];

  const { added, total } = await archiveMerge(merged);

  // A deep sweep saw this account's whole history, so it can also say what does
  // NOT belong to it — strip the tag from anything it didn't return.
  // Reconciliation argues from absence: "not in this account's history, so not
  // this account's". That is only valid against a sweep that actually finished.
  // A truncated sweep would strip tags from every record it never reached.
  const reconciled = deep && !apiError && sweepComplete
    ? await reconcileAccountTags(apiItems)
    : { account: null, cleared: 0 };

  // Confirm a bounded batch of unverified records per load.
  const verify = await verifyPending();

  const map = await readArchive();

  const drift = await recordAccountDrift(map, {
    activeAccount: account,
    deep,
    sweepComplete,
    sweepStoppedBy,
    reconciled: reconciled.cleared,
    reconciledAccount: reconciled.account,
    fromLibrary: apiItems.length,
    fromLocal: localItems.length,
    apiError,
  });

  const ts = (v) => (v?.createdAt ? Date.parse(v.createdAt) || 0 : (v?.firstSeenAt ?? 0));

  // Nothing is filtered out. A generation that's queued, still rendering, or
  // outright failed will render as a card that won't play — and that is the
  // preferred failure: a broken card tells you the generation existed, a hidden
  // one tells you nothing. Missing a past render is the worse outcome.
  const items = Object.entries(map)
    .map(([name, v]) => ({ ...v, name }))
    .sort((a, b) => ts(b) - ts(a));

  return {
    items,
    counts: {
      library: apiItems.length,
      local: localItems.length,
      archive: total,
      added,
      unreachable: Object.values(map).filter((v) => v.status === 'gone').length,
      // Excludes 'gone' — those are reported separately, and counting them in
      // both buckets made "41 unconfirmed - 41 unreachable" look like 82
      // problems when it was the same 41 records twice.
      pending: items.filter((v) => v.status !== 'ok' && v.status !== 'gone').length,
      accounts: [...new Set(Object.values(map).flatMap((v) => v.accounts ?? []))],
      deepSwept: deep,
      reconciled: reconciled.cleared,
      reconciledAccount: reconciled.account,
      sweepComplete,
      sweepStoppedBy,
      drift: drift.changes.length,
      driftExplained: drift.explained,
    },
    apiError,
    verify,
  };
}

// Uploaded media lives under upload/, generated output under pixverse/…. That
// prefix is the only origin signal available on a referenced source frame, which
// carries no asset_source of its own.
function originFromPath(pathOrUrl) {
  const s = decodeMediaUrl(String(pathOrUrl ?? ''));
  if (!s) return null;
  if (/(^|\/)upload\//i.test(s)) return 'uploaded';
  if (/(^|\/)pixverse\//i.test(s)) return 'generated';
  return null;
}

// Every generation — i2i, i2v, image_text, frames — carries the image(s) it was
// made FROM, with both a storage path and a URL. Those inputs are images in
// their own right and drop out of the library like anything else, so they get
// archived alongside the outputs. The data is already in hand; not keeping it
// was just an oversight.
//
// The field names differ per mode, which is the only reason this is fiddly:
//   frames/transition : customer_paths.customer_img_paths[] + _urls[],
//                       plus customer_first_frame / customer_last_frame
//   image_text / i2v  : customer_paths.customer_img_path (singular)
//   i2i               : top-level customer_img_paths[] + _urls[]
function inputImagesFrom(it) {
  const cp = it?.customer_paths || {};
  const seen = new Set();
  const out = [];

  const push = (path, url) => {
    const resolved = url && !isPlaceholderUrl(url)
      ? decodeMediaUrl(url)
      : (path ? mediaUrl(path) : null);
    if (!resolved) return;
    const key = canonicalUrl(resolved);
    if (seen.has(key)) return; // the same frame often appears under two fields
    seen.add(key);
    out.push({
      kind: 'image',
      url: resolved,
      path: path || null,
      poster: resolved,
      // No asset_source on a referenced input — the storage prefix says which.
      origin: originFromPath(path || resolved),
      // Deliberately no account: this is one step removed from a payload that
      // names an owner, and guessing attribution is what caused the account-tag
      // mess. A direct library sighting will tag it properly.
      source: 'derived',
      createdAt: it.created_at || it.video_created_at || null,
    });
  };

  const pairArrays = (paths, urls) => {
    if (!Array.isArray(paths)) return;
    paths.forEach((path, i) => push(path, Array.isArray(urls) ? urls[i] : null));
  };

  pairArrays(cp.customer_img_paths, cp.customer_img_urls);
  pairArrays(it?.customer_img_paths, it?.customer_img_urls);
  push(cp.customer_first_frame, cp.customer_first_frame_url);
  push(cp.customer_last_frame, cp.customer_last_frame_url);
  push(cp.customer_img_path, cp.customer_img_url);

  return out;
}

// Flatten an IMAGE asset row. Two shapes exist — uploaded (url/path) and
// generated (image_url/image_path) — and neither has the video's webp
// filename-carrier trick to fall back on.
//
// What they do have is a storage PATH alongside the URL, so the dependency runs
// the other way: if the server omits a URL we rebuild it from the path, and only
// a record missing BOTH is genuinely unrecoverable. That closes the gap the
// webp trick covers for video.
function slimImage(it) {
  const rawUrl = it.image_url || it.url || it.img_url || null;
  const path = it.image_path || it.path || it.img_path || null;

  let url = rawUrl && !isPlaceholderUrl(rawUrl) ? decodeMediaUrl(rawUrl) : null;
  if (!url && path) url = mediaUrl(path); // rebuilt from the path

  const id = assetId(it);
  // No url and no path. Previously this was discarded, which meant a generation
  // whose listing had gone blank vanished from the archive as though it had
  // never happened. Keep it on the strength of its id — the prompt, seed and
  // source frame are still worth having, and a future sighting (or the capture
  // taken during generation) can fill the url in.
  if (!url && !id) return null;

  return {
    kind: 'image',
    inputs: inputImagesFrom(it),
    // asset_source is authoritative when present: 0 uploaded, 1 generated.
    origin: it.asset_source === 0 ? 'uploaded' : (it.asset_source === 1 ? 'generated' : originFromPath(path || url)),
    id,
    url,
    path,
    poster: url, // an image is its own poster
    prompt: it.prompt || '',
    model: it.model || '',
    quality: it.quality || '',
    duration: null,
    seed: it.seed ?? null,
    createdAt: it.created_at || it.updated_at || null,
    mode: it.create_mode || (it.asset_source === 0 ? 'upload' : 'create_image'),
    account: accountOf(it),
    videoStatus: it.image_status ?? null,
    rerun: {
      panelMode: 'image',
      // The INPUT that produced it, when there was one — that is what a rerun
      // needs. Uploads have no input.
      firstPath: Array.isArray(it.customer_img_paths) ? it.customer_img_paths[0] ?? null : null,
      lastPath: null,
      aspectRatio: it.aspect_ratio || '',
      audio: 0,
      previewMode: 0,
      multiShot: 0,
    },
  };
}

// Sweep the image library across both asset sources.
async function listAllImages({ limit = 200 } = {}) {
  const seen = new Set();
  const out = [];
  for (const assetSource of [0, 1]) {
    let data = [];
    try {
      ({ data } = await listAssets('image', { limit, assetSource, filter: { video_status: [1] } }));
    } catch (err) {
      if (String(err.message).startsWith('TOKEN')) throw err;
      continue;
    }
    for (const it of data) {
      const rec = slimImage(it);
      if (!rec) continue;
      const key = canonicalUrl(rec.url);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(rec);
    }
  }
  return out;
}

// Flatten one API asset row into the slim record the feed and archive use.
// Returns null for rows with no derivable URL (nothing to store).
// Map the API's create_mode to our panel modes.
//   transition   → frames (first + last)
//   i2v          → animate (single source image)
//   image_text   → animate too: despite the name it carries ONE source image
//                  (customer_img_path) plus a prompt, which is the same input
//                  shape as i2v. It is NOT text-alone generation.
function panelModeFor(it) {
  const cm = (it.create_mode || '').toLowerCase();
  const cp = it.customer_paths || {};
  const hasLast = Boolean(cp.customer_last_frame || cp.customer_img_paths?.length > 1);
  if (cm === 'transition' || hasLast) return 'frames';
  return 'animate';
}

function slimVideo(it) {
  const url = videoUrlFor(it);
  if (!url) return null; // no webp_url to derive a filename from

  const cp = it.customer_paths || {};
  const imgs = Array.isArray(cp.customer_img_paths) ? cp.customer_img_paths : [];
  // Field names differ by mode: i2v/transition use customer_first_frame and the
  // plural customer_img_paths[]; image_text uses the SINGULAR customer_img_path.
  // Missing the singular form is why image_text records looked frameless and
  // got no rerun button.
  const firstPath = cp.customer_first_frame || imgs[0] || cp.customer_img_path || null;
  const lastPath = cp.customer_last_frame || imgs[1] || null;
  const panelMode = panelModeFor(it);

  return {
    kind: 'video',
    inputs: inputImagesFrom(it),
    id: assetId(it),
    url,
    poster: posterFor(it),
    prompt: it.prompt || cp.prompts?.[0] || '',
    model: it.model || '',
    quality: it.quality || '',
    duration: it.duration ?? it.video_duration ?? (Array.isArray(cp.durations) ? cp.durations[0] : null),
    seed: it.seed ?? null,
    createdAt: it.created_at || it.video_created_at || null,
    mode: it.create_mode || '', // raw, for display
    account: accountOf(it),
    videoStatus: it.video_status ?? null,

    // Inputs needed to rerun this generation. Stored so the browse page can
    // repopulate the compose form. Source paths are what the API wants for a
    // fresh call; the URLs are for previewing the frame in the slot.
    rerun: {
      panelMode, // 'frames' | 'animate'
      firstPath,
      lastPath,
      aspectRatio: it.aspect_ratio || '',
      audio: it.audio ?? 0,
      previewMode: it.preview_mode ?? 0,
      // Sent back verbatim on rerun — see generateI2V for why it isn't fixed.
      multiShot: it.multi_shot ?? 0,
    },
  };
}

const DAY = 86400;
const WINDOW_SEC = 90 * DAY; // matches the site's own date-picker granularity

// Paginate one time window fully, using the server's cursor rather than
// inferring "done" from a short page. Pushes into the shared out/seen sets.
async function sweepWindow({ start, end, out, seenIds, seenUrls, max }) {
  let offset = 0;
  let webOffset = 0;

  for (let page = 1; page <= 60 && out.length < max; page++) {
    const filter = start != null && end != null ? { start_time: start, end_time: end } : null;
    const { data, hasMore, nextOffset } = await listAssets('video', {
      limit: 50, offset, webOffset, current: page, filter,
    });
    if (!data.length) break;

    const before = out.length;
    for (const it of data) {
      const id = assetId(it);
      if (id && seenIds.has(id)) continue;
      if (id) seenIds.add(id);

      const rec = slimVideo(it);
      if (!rec) continue;

      const key = canonicalUrl(rec.url);
      if (seenUrls.has(key)) continue; // second guard for rows without an id
      seenUrls.add(key);

      out.push(rec);
      if (out.length >= max) break;
    }

    // Three independent stop conditions — a cursor that never advances against
    // their API is a worse failure than stopping one page early.
    if (!hasMore) break;                                    // server: that's all
    if (nextOffset == null || nextOffset === webOffset) break; // cursor stalled
    if (out.length === before) break;                       // page added nothing
    webOffset = nextOffset;
    offset = nextOffset;
  }
}

// Everything usable as a source frame, across both asset sources: uploads (0)
// and generations (1). Querying one source only ever returns half the library —
// an image tab query with asset_source 1 came back empty for an account that
// had uploads, because uploads are source 0.
//
// The filter shape here matches what the site's own picker sends. It is NOT the
// date filter the video sweep uses — that one is { start_time, end_time }.
// Stable identity across every shape this can arrive in — live API rows
// (uploaded vs generated field names) and archive records alike. Keyed on the
// canonical URL so %2F spellings and query strings can't split one asset in two.
function pickerKey(it) {
  const url = it.image_url || it.url || it.img_url || null;
  if (url) return canonicalUrl(url);
  const path = it.image_path || it.path || it.img_path || null;
  return path ? `path:${path}` : null;
}

// A slow or stalled library call must not leave the picker on "Loading…"
// forever. Whatever arrives inside the window is used; whatever doesn't is
// simply absent, and the archive covers most of it anyway.
const PICKER_TIMEOUT_MS = 8000;

function withTimeout(promise, ms, fallback) {
  return Promise.race([
    promise.catch(() => fallback),
    new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

async function listPickerAssets(tab, { limit = 24, max = 300 } = {}) {
  const seen = new Set();
  const out = [];

  const take = (it) => {
    const key = pickerKey(it);
    if (!key || seen.has(key)) return;
    seen.add(key);
    // The picker needs a preview and a storage path. Sending whole archive
    // records instead was shipping a dozen unused fields per item across the
    // message boundary — fine at 50 records, not at a thousand.
    const url = it.image_url || it.url || it.img_url || null;
    out.push({
      url: url ? decodeMediaUrl(url) : null,
      path: it.image_path || it.path || it.img_path || null,
      at: Date.parse(it.created_at || it.createdAt || it.updated_at || 0) || 0,
    });
  };

  // Both sources at once. Sequentially, a stall on the first delayed the second
  // as well, doubling the worst case for no reason.
  const sources = await Promise.all([0, 1].map((assetSource) => withTimeout(
    listAssets(tab, { limit, assetSource, filter: { video_status: [1] } }).then((r) => r.data),
    PICKER_TIMEOUT_MS,
    [],
  )));
  for (const data of sources) for (const it of data) take(it);

  // Then the archive — the whole point of having one. The API drops old
  // generations from its listing while the files stay fetchable, so anything it
  // has forgotten is still pickable here. Local, so it can't stall.
  if (tab === 'image') {
    try {
      const map = await readArchive();
      for (const rec of Object.values(map)) {
        if (rec.kind !== 'image' || !rec.url) continue;
        take(rec);
      }
    } catch { /* archive unreadable — live results still stand */ }
  }

  out.sort((a, b) => b.at - a.at); // newest first
  return out.slice(0, max);
}

// Read the video library from the API.
//
// The list endpoint accepts filter:{start_time,end_time} (Unix seconds), and
// when it's omitted the server applies its own default window — the most likely
// reason old generations stop appearing. So we sweep backwards in 90-day
// windows to reach the full history.
//
// `deep`: false (default) fetches only the most recent window — fast, for
// normal loads once the archive is populated. true walks all the way back to
// `since`, for the one-time backfill.
async function listAllVideos({ max = 1000, deep = false, since = null } = {}) {
  const out = [];
  const seenIds = new Set();
  const seenUrls = new Set();

  const nowSec = Math.floor(Date.now() / 1000) + DAY; // clock-skew buffer
  // Default floor: PixVerse didn't exist before ~2023. Override via `since`
  // (set it to when the account started) to avoid a few empty windows.
  const floor = since ?? Math.floor(Date.UTC(2023, 0, 1) / 1000);

  if (!deep) {
    // Just the newest window. Never a complete picture, by definition.
    await sweepWindow({ start: nowSec - WINDOW_SEC, end: nowSec, out, seenIds, seenUrls, max });
    return { items: out, complete: false, stoppedBy: 'shallow' };
  }

  let end = nowSec;
  let emptyRun = 0;
  // Six windows — about 18 months of silence — before assuming the account's
  // history has ended. Three (270 days) was stopping real sweeps short: accounts
  // get abandoned during a bad stretch and picked up again much later, and
  // everything before the gap was never seen. The cost of being wrong is a few
  // empty requests, once, against losing generations permanently.
  const EMPTY_WINDOWS_BEFORE_STOP = 6;
  let stoppedBy = 'floor';

  while (end > floor) {
    if (out.length >= max) { stoppedBy = 'max'; break; }
    if (emptyRun >= EMPTY_WINDOWS_BEFORE_STOP) { stoppedBy = 'gap'; break; }

    const start = Math.max(floor, end - WINDOW_SEC);
    const before = out.length;

    await sweepWindow({ start, end, out, seenIds, seenUrls, max });

    emptyRun = out.length === before ? emptyRun + 1 : 0;
    end = start - 1;
  }

  // ONLY reaching the floor means "I have seen everything this account has".
  // Stopping on the record cap, or on a run of empty windows (an account
  // dormant for nine months then active before that), leaves older generations
  // unseen — and anything downstream that treats a truncated sweep as complete
  // will draw false conclusions from the absence.
  return { items: out, complete: stoppedBy === 'floor', stoppedBy };
}

// Credits. The response has no single "balance" field — the spendable total is
// the sum of the currency buckets: daily + monthly + package. renewal_credits
// is surfaced separately in the breakdown but isn't part of the spendable sum
// (it's what will be added at renewal, not current balance).
async function fetchCredits() {
  const r = await apiFetch('/user/credits', null, 'GET');
  const daily = r?.credit_daily ?? 0;
  const monthly = r?.credit_monthly ?? 0;
  const pkg = r?.credit_package ?? 0;
  const renewal = r?.renewal_credits ?? 0;
  return {
    total: daily + monthly + pkg,
    breakdown: { daily, monthly, package: pkg, renewal },
    raw: r, // kept so the panel can show anything else if needed
  };
}

// ---------- readiness ----------
//
// Your snippet took items[0] as "the result". That's a race: it's wrong the
// moment two generations overlap, or create_count > 1, or you have another tab
// open. Instead: snapshot the library's ids BEFORE firing, then poll for ids
// that weren't there before. Works without knowing the response shape.

const ID_KEYS = ['image_id', 'video_id', 'id', 'asset_id'];

function assetId(item) {
  for (const k of ID_KEYS) if (item?.[k] != null) return String(item[k]);
  return null;
}

// Readiness is decided by mediaExists(), not by whether a URL can be built —
// see the comment there. isReady() only screens for "we have a URL to probe".
function hasResolvableUrl(item, tab) {
  return Boolean(mediaUrlForAsset(item, tab));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pollForNew(tab, knownIds, expected, timeoutMs, onProgress, auth = null, onSeen = null) {
  const deadline = Date.now() + timeoutMs;
  let wait = 2000;
  // Rows seen with a usable URL, kept so a timeout can report them instead of
  // throwing away a generation that demonstrably happened.
  let seenWithUrls = [];

  while (Date.now() < deadline) {
    await sleep(wait);
    wait = Math.min(wait * 1.4, 8000); // back off; don't hammer

    let items;
    try {
      ({ data: items } = await listAssets(tab, { limit: 24, auth }));
    } catch (err) {
      if (String(err.message).startsWith('TOKEN')) throw err;
      continue; // transient — keep waiting
    }

    const fresh = items.filter((it) => {
      const id = assetId(it);
      return id && !knownIds.has(id);
    });

    // Hand every fresh row over the moment it appears, BEFORE any judgement
    // about readiness. Archiving used to happen only after the job completed,
    // so a job that timed out discarded rows the poller had already seen —
    // the URL was in hand and thrown away. Readiness decides when the job is
    // done, never whether a record is worth keeping.
    if (fresh.length) await onSeen?.(fresh);

    const withUrls = fresh.filter((it) => hasResolvableUrl(it, tab));
    if (withUrls.length >= seenWithUrls.length) seenWithUrls = withUrls;

    if (fresh.length < expected) continue;

    // The asset row appears immediately on submit, with a URL that points at
    // nothing. Videos must be probed; images are written before they're listed.
    const ready = [];
    for (const it of withUrls) {
      if (await mediaExists(mediaUrlForAsset(it, tab))) ready.push(it);
    }

    if (ready.length >= expected) return ready;

    // Surface queue position when the backend gives us one — a job can sit in
    // the queue for a long time before any rendering starts, and silence for
    // several minutes otherwise looks like a hang.
    const q = fresh.find((it) => it.queue_data?.queue_count > 0)?.queue_data;
    if (q) onProgress?.({ queued: q.queue_count, eta: q.estimated_gen_time ?? null });
  }

  // Deadline reached without the probe ever confirming a file.
  //
  // If rows with usable URLs were seen, the generation happened and the probe is
  // what failed — observed in practice: an image the probe kept rejecting opened
  // fine in a browser. Reporting those as done beats reporting failure, because
  // the archive re-probes on its own schedule and will correct the status
  // either way. A false "failed" is the more expensive mistake.
  if (seenWithUrls.length >= expected) {
    frLog(`poll deadline reached; reporting ${seenWithUrls.length} unverified row(s)`);
    return seenWithUrls;
  }

  throw new Error('TIMED_OUT');
}

// ---------- job queue ----------

// account name -> jobs currently in flight for it. Keyed by name because that is
// what the job record carries; jobs with no known account share the null bucket.
const running = new Map();
const pending = [];

const runningFor = (account) => running.get(account ?? '') ?? 0;

function markRunning(account, delta) {
  const key = account ?? '';
  const next = runningFor(account) + delta;
  if (next > 0) running.set(key, next);
  else running.delete(key);
}

async function enqueue(job) {
  const id = crypto.randomUUID();
  const record = {
    id,
    mode: job.mode, // 'image' | 'animate' | 'frames'
    output: OUTPUT[job.mode], // 'image' | 'video' — media type for the reel
    prompt: job.prompt,
    seed: job.params.seed,
    params: job.params, // full settings, so a tile can repopulate the form
    // Which account this ran under, captured now. Reading it later is wrong —
    // by then the session may belong to a different login.
    account: await currentAccountName(),
    state: 'queued',
    startedAt: null,
    results: [],
    error: null,
  };

  await saveJob(record);
  pending.push({ record, job });
  pump();
  return id;
}

function pump() {
  // Walk the whole queue rather than only its head: a job blocked because its
  // own account is busy must not hold up a job for a different account behind
  // it. Anything still blocked stays queued in order.
  const blocked = [];

  while (pending.length) {
    const next = pending.shift();
    const account = next.record.account;

    if (runningFor(account) >= MAX_CONCURRENT_PER_ACCOUNT) {
      blocked.push(next);
      continue;
    }

    markRunning(account, +1);
    run(next).finally(() => {
      markRunning(account, -1);
      pump();
    });
  }

  pending.push(...blocked);
}

// Jobs this worker is actively polling right now. The alarm-driven resumer
// checks it before adopting anything, so a job with a live in-memory loop is
// never polled twice. It is in-memory ON PURPOSE: if the worker dies the set
// dies with it, which is precisely the condition that should make the job
// eligible for resumption.
const runningJobIds = new Set();

async function run({ record, job }) {
  const tab = OUTPUT[job.mode]; // 'image' | 'video'
  runningJobIds.add(record.id);

  // Hoisted: the credit ledger reads it from catch and finally, and a job that
  // fails before readAuth() resolves must still settle cleanly rather than
  // throwing a ReferenceError over the top of the real error.
  let auth0 = null;

  try {
    // Pin the account for this job's entire lifetime, right now. Everything
    // below — the snapshot, the generate call, and up to 25 minutes of polling —
    // uses this and not the live session. That is what lets several jobs run
    // under different accounts at once: switch accounts and submit again, and
    // the first job keeps polling its own library instead of following you.
    const auth = await readAuth();
    auth0 = auth;

    record.state = 'running';
    record.startedAt = Date.now();
    await saveJob(record);

    // Archive raw asset rows the moment they are seen.
    //
    // The listing serves a populated URL during generation and, for some
    // generations, a blank one when you come back. It is also the only sighting
    // guaranteed to exist at all: a job that times out used to discard rows it
    // had already read.
    const captureRows = async (rows) => {
      await archiveAssetRows(rows, tab);

      // Surface the URLs on the job record too, so the panel can offer OPEN
      // while the job is still running. The row carries a URL long before the
      // probe confirms the file, and when the probe is wrong (it has been) that
      // link is the only way to reach a render that finished.
      try {
        const urls = rows.map((it) => mediaUrlForAsset(it, tab)).filter(Boolean);
        if (urls.length) {
          const merged = [...new Set([...(record.seenUrls ?? []), ...urls])];
          if (merged.length !== (record.seenUrls ?? []).length) {
            record.seenUrls = merged;
            await saveJob(record); // broadcasts job/update, so the tile repaints
          }
        }
      } catch (err) {
        frLog(`seen-url capture failed: ${err.message}`);
      }
    };

    // Snapshot first — this is what makes the diff reliable.
    const { data: before } = await listAssets(tab, { limit: 24, auth });
    const knownIds = new Set(before.map(assetId).filter(Boolean));

    // Persist it. The snapshot is the ONLY thing that distinguishes this job's
    // output from every other asset in the library, and it lives in a local
    // variable inside a function that Chrome may terminate mid-poll. Without it
    // on disk, a resumed job cannot tell its own result from anything else and
    // the render is unrecoverable from here. See resumeOrphanedJobs().
    record.knownIds = [...knownIds];
    record.pollUntil = Date.now() + (job.mode === 'image' ? 5 * 60_000 : 25 * 60_000);
    await saveJob(record);

    // CREDIT LEDGER. Read the balance immediately before submitting and again
    // once the job settles, so what a generation actually cost becomes a
    // measurement rather than a guess.
    //
    // It exists because the cost of a REJECTED submit is genuinely unclear from
    // the outside: observed as charged for i2i, and sometimes charged and
    // sometimes not for frames. Nobody is going to work that out by watching the
    // number by hand across a handful of tries; a few dozen real jobs with the
    // parameters recorded alongside will show it.
    //
    // The delta is NOISY and is recorded, never trusted. The balance also moves
    // for the daily refresh and for anything generated in another tab or by
    // another job on the same account. `soloAtStart` marks whether this job had
    // the account to itself at submit, which is the only condition under which
    // the delta is attributable to it — analysis filters on that rather than
    // pretending the number is clean.
    record.creditsBefore = await creditsSnapshot(auth);
    record.soloAtStart = runningFor(record.account) <= 1;
    await saveJob(record);

    if (job.mode === 'image') {
      await generateImage(job.params, auth);
    } else if (job.mode === 'animate') {
      await generateI2V(job.params, auth);
    } else {
      await generateFrames(job.params, auth);
    }

    // Straight after the submit is accepted, before any polling. A submit that
    // throws skips this and is measured in the catch instead, which is exactly
    // the case in question.
    record.creditsAfterSubmit = await creditsSnapshot(auth);
    await saveJob(record);

    // Videos can sit in a queue before rendering even starts, so the window has
    // to be generous. Chrome can terminate the worker during a wait this long;
    // resumeOrphanedJobs(), driven by chrome.alarms, picks the job back up
    // rather than leaving it to report a timeout on a render that succeeded.
    const timeout = Math.max(0, record.pollUntil - Date.now());
    const fresh = await pollForNew(tab, knownIds, job.params.count ?? 1, timeout, (p) => {
      record.queue = p;
      saveJob(record);
    }, auth, captureRows);

    // Belt and braces: the poller already archived these on sight, and
    // archiveMerge is keyed by URL so re-merging is free.
    await captureRows(fresh);

    record.state = 'done';
    record.results = fresh.map((it) => ({
      id: assetId(it),
      url: mediaUrlForAsset(it, tab),
      thumb: posterFor(it) ?? imageUrlFor(it),
    }));
  } catch (err) {
    record.state = 'failed';
    record.error = friendly(err);
    // The interesting measurement. A submit rejected on content grounds lands
    // here, and whether the balance moved is the whole question.
    record.creditsAtFailure = await creditsSnapshot(auth0);
  } finally {
    runningJobIds.delete(record.id);
  }

  record.creditsFinal = await creditsSnapshot(auth0);
  record.settledAt = Date.now();
  await saveJob(record);
}

// Balance, or null. Never throws and never blocks a job: a job must not fail
// because bookkeeping did.
async function creditsSnapshot(auth) {
  try {
    const r = await apiFetch('/user/credits', null, 'GET', auth ?? null);
    const total = (r?.credit_daily ?? 0) + (r?.credit_monthly ?? 0) + (r?.credit_package ?? 0);
    return Number.isFinite(total) ? total : null;
  } catch {
    return null;
  }
}

function friendly(err) {
  const msg = String(err?.message ?? err);
  if (msg === 'NO_TOKEN') return 'Not linked. Open PixVerse in a tab and sign in.';
  if (msg === 'TOKEN_EXPIRED') return 'Session expired. Reload your PixVerse tab.';
  if (msg === 'TIMED_OUT') return 'Still rendering after the wait window. Check your library.';
  return msg;
}

// Archive raw asset rows the moment they are seen — shared by the live poller
// and by the resume path, so a recovered job records exactly what a normal one
// would. Never fatal: losing an archive write must not fail a real generation.
async function archiveAssetRows(rows, tab) {
  try {
    const slimmed = rows
      .map((it) => (tab === 'image' ? slimImage(it) : slimVideo(it)))
      .filter(Boolean);
    const captured = [
      ...slimmed.map(({ inputs, ...rest }) => ({ ...rest, source: 'library' })),
      ...slimmed.flatMap((r) => r.inputs ?? []), // the frames it was made from
    ];
    if (captured.length) await archiveMerge(captured);
  } catch (err) {
    frLog(`capture failed: ${err.message}`);
  }
}

// ---------- surviving worker death ----------
//
// THE PROBLEM. A video poll runs for up to 25 minutes inside `run()`, in an MV3
// service worker Chrome is free to terminate at any point. When it does, the
// in-memory loop simply ceases to exist: the job stays `running` on disk
// forever, or reports a timeout, while the render completes server-side and
// turns up in Browse hours later looking like an unrelated asset.
//
// THE FIX IS NOT TO REWRITE THE POLLER. Converting `pollForNew` into an
// alarm-driven state machine would mean rebuilding the most delicate code in
// the project — the bit that decides a generation is finished — and a mistake
// there loses work. Instead the existing loop is left exactly as it is, for the
// common case where the worker survives, and this adds a RECOVERY layer beneath
// it: an alarm wakes the worker, notices jobs that were left mid-flight, and
// resumes polling them.
//
// What makes resumption possible at all is that `run()` now persists its
// `knownIds` snapshot. That snapshot is the only thing separating this job's
// output from every other asset in the library; without it on disk a resumed
// job has nothing to diff against.
//
// Deliberately conservative:
//   - Only jobs still inside their own `pollUntil` window are resumed. Past it,
//     they are settled honestly rather than polled forever.
//   - `resuming` guards against a second poller for a job already in flight,
//     which would double-archive and could double-report.
//   - A job whose account can no longer be authenticated is failed with a real
//     reason, not retried in a loop.

const JOB_ALARM = 'frameroom-resume-jobs';
const JOB_ALARM_MINUTES = 1;
const resuming = new Set();

function ensureJobAlarm() {
  // create() on an existing name just replaces it, so this is idempotent.
  chrome.alarms.create(JOB_ALARM, { periodInMinutes: JOB_ALARM_MINUTES });
}

async function authForAccount(username) {
  if (!username) return null;
  const vault = await readVault();
  const rec = vault[username];
  if (rec?.token && (!rec.expiresAt || rec.expiresAt > Date.now())) {
    return { token: rec.token, anonId: rec.anonId ?? null, username, expiresAt: rec.expiresAt ?? null };
  }
  // Expired or missing — self re-auth handles it when a password is stored.
  return reauthAccount(username, { staleToken: rec?.token ?? null }).catch(() => null);
}

async function resumeOrphanedJobs() {
  const { jobs = [] } = await chrome.storage.local.get('jobs');
  const now = Date.now();

  for (const record of jobs) {
    if (record.state !== 'running') continue;
    if (resuming.has(record.id)) continue;      // this worker is already on it
    if (runningJobIds.has(record.id)) continue; // the original loop still lives

    // Older records predate the snapshot being persisted. Nothing can be done
    // for them from here; settle rather than leave them running forever.
    if (!record.knownIds || !record.pollUntil) {
      record.state = 'failed';
      record.error = 'Interrupted before this build could resume it — check Browse.';
      await saveJob(record);
      continue;
    }

    if (now >= record.pollUntil) {
      record.state = 'failed';
      record.error = 'Timed out. If it rendered, it will appear in Browse.';
      await saveJob(record);
      continue;
    }

    resuming.add(record.id);
    (async () => {
      const tab = record.output === 'image' ? 'image' : 'video';
      try {
        const auth = await authForAccount(record.account);
        if (!auth?.token) throw new Error(`Cannot sign in as ${record.account ?? 'this account'}`);

        frLog(`resuming orphaned job ${record.id} (${record.mode})`);
        const fresh = await pollForNew(
          tab,
          new Set(record.knownIds),
          record.params?.count ?? 1,
          Math.max(0, record.pollUntil - Date.now()),
          (p) => { record.queue = p; saveJob(record); },
          auth,
          async (rows) => { await archiveAssetRows(rows, tab); },
        );
        record.state = 'done';
        record.results = fresh.map((it) => ({
          id: assetId(it),
          url: mediaUrlForAsset(it, tab),
          thumb: posterFor(it) ?? imageUrlFor(it),
        }));
      } catch (err) {
        record.state = 'failed';
        record.error = friendly(err);
      }
      await saveJob(record);
    })().finally(() => resuming.delete(record.id));
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === JOB_ALARM) resumeOrphanedJobs();
});

// A restarted worker should not wait a full alarm period to notice.
chrome.runtime.onStartup.addListener(() => { ensureJobAlarm(); resumeOrphanedJobs(); });
ensureJobAlarm();

async function saveJob(record) {
  const { jobs = [] } = await chrome.storage.local.get('jobs');
  const idx = jobs.findIndex((j) => j.id === record.id);
  if (idx >= 0) jobs[idx] = record; else jobs.unshift(record);
  await chrome.storage.local.set({ jobs: jobs.slice(0, 60) });
  broadcast({ type: 'job/update', job: record });
  // A finished render changed the balance — tell the panel to re-pull.
  if (record.state === 'done' || record.state === 'failed') {
    broadcast({ type: 'credits/stale' });
  }
}

// ---------- transport fallback ----------
//
// Only used when TRANSPORT === 'page'. Runs the fetch inside a live
// app.pixverse.ai tab so Origin/Referer are the real ones. Requires a PixVerse
// tab to be open, which is the trade you make for it.

async function relayThroughPage(url, headers, body, method = 'POST') {
  const [tab] = await chrome.tabs.query({ url: `${PAGE_ORIGIN}/*` });
  if (!tab) throw new Error('Open a PixVerse tab — page transport needs one.');

  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    func: async (u, h, b, m) => {
      const init = { method: m, headers: h };
      if (m !== 'GET' && b != null) init.body = JSON.stringify(b);
      const res = await fetch(u, init);
      return res.json();
    },
    args: [url, headers, body, method],
  });

  return result;
}

// ---------- wiring ----------

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});
