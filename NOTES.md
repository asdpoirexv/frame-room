# Frame Room — working notes

Everything learned building this, consolidated. The README is what the tool
does; the CHANGELOG is what changed when. This is **why things are the way they
are** — the API's actual behaviour, the decisions taken, and the wrong turns,
so none of it has to be rediscovered.

Written to be read cold, months later, by someone who has forgotten all of it.

Last updated: 2026-09-05. Sections gain a stamp when they change materially.

---

## 1. The API, as it actually behaves

These are all observed from real request/response captures, not documentation.
PixVerse's `creative_platform/*` endpoints are internal and undocumented.

### 1.1 `webp_url` is a filename carrier, not a file

**There is no webp.** Fetching `webp_url` 404s. Its only value is that its
basename is identical to the mp4's, and unlike `url` / `video_path` it is
*constructed* rather than looked up — so it never points at a placeholder.

```
webp: /pixverse/webp/media/web/<name>.webp
mp4:  /pixverse/mp4/media/web/ori/<name>.mp4
```

This is the **only** reliable way to get a video URL. It cost a long debugging
detour to establish; don't undo it.

### 1.2 `url` and `video_path` lie

When the backend can't find the real asset it returns a shared placeholder
(`.../pixverse-preview/mp4/media/default.mp4`, `.../pixverse/jpg/media/default.jpg`)
rather than an error. More common on accounts with many generations.

Nastier: every placeholder has the **basename `default`**, so anything keyed by
basename collapses them into one record that overwrites itself. Placeholders are
rejected at every entry point (`isPlaceholderUrl`).

### 1.3 `video_status` means nothing

Values **1, 7, and 10** have all been observed on videos that play perfectly.
Status 7 was seen alongside a placeholder `url` *and* an empty `video_path` on a
video whose mp4 was fine.

Two separate builds tried to shortcut readiness with this field. Both were
wrong; the second one hid working videos from the feed. **Only an actual CDN
probe decides whether a file exists.** See `mediaExists()`.

Confirmed at scale (2026-09-02) against 1810 archive videos, cross-tabbing the
server's `videoStatus` against `status`, which is our own probe verdict — i.e.
the claim against the truth:

| `videoStatus` | probe says ok | probe says gone |
|---|---|---|
| 7 | 1111 | 328 |
| 1 | 174 | 0 |
| 10 | 5 | 0 |
| 8 | 0 | 3 |

Status 7 covers 1439 videos and is right about 77% of them, which is exactly the
shape of a field that looks reliable in casual testing and quietly hides a few
hundred working videos in production. Note also that a *third* value, 8, has now
been seen and no build knew about it — any allow-list of "good" statuses would
have been wrong again. Probe.

### 1.4 A derivable URL is not a finished render

`url` and `webp_url` come back the *instant* a job is submitted, long before any
file is written. Jobs can queue first, and the site's progress percentage is
theatre — it parks at 95%, and the file is sometimes fetchable before it claims
100%.

So: derivable ≠ ready. Probe, don't infer.

### 1.5 `%2F` cuts both ways

PixVerse percent-encodes slashes in URLs — `.../upload%2F<uuid>.jpg`.

- **Reading:** Chrome's address bar decodes `%2F` on navigation (so pasted URLs
  appear to work), but `<video src>` does **not**. Must decode → `decodeMediaUrl`.
- **Writing:** request payloads use the `%2F` form. Sending plain slashes is
  wrong → `mediaUrlPacked`.

Getting this backwards in either direction is a silent failure. Keep the two
helpers distinct.

### 1.6 The CDN blocks direct `<video src>`

Returns `MEDIA_ERR_SRC_NOT_SUPPORTED` (code 4). Workaround: `fetch()` the bytes
(CORS-exempt inside the extension thanks to `host_permissions`) and play from a
blob URL.

**This is the normal path for every video, not an error.** An early build logged
it at `warn`, which made healthy playback fill the extension's Errors tab. It's
`console.debug` now, behind `FR_DEBUG`.

### 1.7 The library list has a date filter — and it's why history "disappears"

```json
"filter": { "start_time": 1776796200, "end_time": 1784658599 }
```

Unix seconds. **Omitting it makes the server apply its own default window** —
which is why old generations stop appearing while their files stay downloadable.
They were never deleted, just out of range.

The site's own picker sends variable windows (91 days in one capture, 31 in
another), so our fixed 90-day sweep is a free choice, not a constraint.

### 1.8 Pagination has a real cursor — use it

The response carries `has_more` / `next_offset` and `web_has_more` /
`web_next_offset`. An early build ignored all four, inferred "done" from a short
page, and re-sent `web_offset: 0` every time. Two failure modes: silent early
truncation, and a possible infinite loop.

Now reads `web_has_more` / `web_next_offset` with three independent stop
conditions (server says done, cursor stalls, page adds nothing) — a runaway loop
against their API is worse than stopping a page early.

### 1.9 Account identity is per-record

Every asset carries `nick_name`, `email`, and `account_id`. **Use those.**

A build that tagged records with the currently-signed-in account cross-tagged
every local record with all five accounts (they accumulate into a set), producing
an account filter showing 227 tagged records across an archive of 47. An unknown
account must stay unknown.

### 1.10 `customer_paths` field names vary by mode

This one is a genuine trap:

| Mode | Source field(s) |
|---|---|
| `transition` | `customer_first_frame`, `customer_last_frame`, `customer_img_paths[]` (plural array) |
| `i2v` | `customer_first_frame` / `customer_img_paths[]` |
| `image_text` | **`customer_img_path`** (singular!) and `customer_img_url` (nested, singular) |

Reading only the plural array made `image_text` records look frameless — which
produced a confident, entirely wrong theory that they were text-only generations.
Also note the *top-level* `customer_img_url` is empty on those records; the
populated one is nested inside `customer_paths`.

### 1.10b `asset_source` splits uploads from generations

`asset_source: 1` is generated assets; `asset_source: 0` is uploaded media. The
same `tab: "image"` query returns `total: 0` under source 1 and the uploads
under source 0. Everything hardcoded source 1 for a long time — invisible for
video, where every asset is a generation, and fatal for the frame picker, which
mostly wants uploads.

Uploaded records are a different shape too: `path` and `url` directly, no
`customer_paths`. Anything reading source frames out of `customer_paths` finds
nothing on an upload.

### 1.10c Three field shapes for "an image"

| record | preview | storage path | notes |
|---|---|---|---|
| uploaded (`asset_source: 0`) | `url` | `path` | no `customer_paths` at all |
| generated (`asset_source: 1`) | `image_url` | `image_path` | **no `url`, no `path`**; `create_mode: "create_image"`, `image_status` |
| video | derived from `webp_url` | — | see 1.1 |

On a generated image, `customer_img_paths` is the **input** upload, not the
output. Anything reading it to identify the asset shows one image and selects a
different one. Derive the path from the same URL used for the preview and they
cannot disagree.

Image responses also carry `total` rather than `has_more` / `web_has_more`.

### 1.10d Images need no webp trick — they have a path

Video depends on `webp_url` as a filename carrier because `url` can be a
placeholder. Images don't have that fallback, but they don't need it: both
shapes carry a storage path (`image_path` / `path`) alongside the URL, so a
missing or placeholder URL is rebuilt from the path. Only a record missing both
is genuinely lost.

Consequence for the archive: `basenameOf` must match more than `.mp4`, or image
records key to `null` and are dropped by the merge without a word.

### 1.10e The listing forgets image URLs, sometimes

A generated image can come back with `image_url` and `image_path` both empty on
a later listing even though the URL was populated during generation. Not all
generations, no known pattern, and `image_status` is 7 on the blank ones — but
status has never been trustworthy, so treat that as correlation.

Consequences, both learned the hard way:
- Capture at generation time. The poll result is the one sighting guaranteed to
  carry a URL; a later sweep may not.
- Never discard a record for lacking a URL. Key it by asset id and fold it into
  the real entry if a URL turns up. Dropping it loses the generation outright.
- Never let a blank field overwrite a stored one. A spread of the new record over
  the old will happily write `null` over a good URL.

### 1.10f Source paths are portable across accounts

An image generated under one account can be used as a source frame under another,
with no re-upload — the same URL, and the generation goes through. Confirmed in
practice, not inferred.

This was assumed to be false for a long time and a confirm() dialog was built on
it, offering to switch accounts before loading a rerun. The assumption was never
tested; it was just plausible.

The only real consequence of using a cross-account source is billing: credits
come from whichever account is active, not the one that made the image. For
anyone deliberately spreading work across logins that is usually the intent.

Practical upshot: the frame picker offering every archived image regardless of
account is correct, not a hazard.

### 1.10g The media host resizes on request

`media.pixverse.ai` is Aliyun OSS, so `?x-oss-process=<style>` returns a resized
webp instead of the original — kilobytes rather than megabytes. The site's own
thumbnails use it.

Two styles confirmed:

| style | use |
|---|---|
| `style/cover-webp-small` | small tiles, roughly under 200px |
| `style/cover-webp` | larger tiles; still far smaller than the original |

There may be others; nothing depends on knowing them.

The same processor grabs stills out of video:

```
?x-oss-process=video/snapshot,t_1000,f_jpg,w_400,h_0,m_fast
```

Always pass `w_` — the default is the video's full resolution. `h_0` preserves
the aspect ratio, `m_fast` uses the nearest keyframe. This is the only way to
give a poster to a video the library never described, e.g. one recovered from a
local file.

Use it for anything that shows many images at once (grid view, the frame
picker), never for the reel. Images only: an image processor does nothing for an
mp4, though a video's poster is a still and thumbs fine.

Never store it. It is a query string, `canonicalUrl` strips those, and the
archive is keyed on the canonical URL — so a stored thumbnail would be a second
spelling of an asset you already have.

### 1.11 `create_mode` is a label, not an endpoint

- `transition` → `/video/frames`
- `i2v` → `/video/i2v`
- `image_text` → **also `/video/i2v`** (confirmed by capture)

`image_text` means image **+** text, carrying one source image and a prompt —
identical input shape to i2v. There is no separate text-to-video endpoint to
find. `i2v` and `animate` (our panel's name) are the same thing.

Source paths can differ in prefix *and* extension in the same call — one capture
mixed an uploaded `.png` with an i2i-generated `.jpg`. Assume nothing about path
shape.

### 1.12 `model_name_default` is a lookup, not a formula

| model | display name |
|---|---|
| `v6` | `PixVerse V6` (verified) |
| `qwen-image` | `Qwen-image` (verified) |

A formula derived from the v6 captures (`PixVerse ${model.toUpperCase()}`)
produced `PixVerse QWEN-IMAGE` — wrong for every image model, since none are
PixVerse models. The remaining entries in `MODEL_DISPLAY_NAME` follow the
observed patterns and are **unverified guesses**. May be cosmetic.

**The model IDS, though, are now checked** (2026-09-02). A record's `model`
field is what the server echoed back, so an id present in the 4087-record
archive is an id the API accepts. Counted across that archive:

| id | records | was in the code? |
|---|---|---|
| `v6` | 1611 | yes |
| `qwen-image` | 790 | yes |
| `v5` | 7 | yes |
| `seedream-4.0` | 2 | **no — the code said `seedream`** |
| `v5.6` | 2 | no |
| `pixverse-c1` | 1 | no |
| `v4.5` | 0 | yes |
| `flux-dev` | 0 | yes |

So `seedream` was a straightforward bug: no record anywhere carries a bare
`seedream`, meaning the dropdown was offering an id the API has never been
observed to accept. Fixed to `seedream-4.0`.

`v4.5` and `flux-dev` are **unproven, not disproven** — the archive is evidence
of what was generated, not of what is offered, and neither was ever used. They
stay in the list, because dropping a real option costs a capability while
keeping a dead one costs a failed request. Reading the site's dropdown is still
the only thing that closes this properly; `tools/har-ingest.js` flags a model
catalogue response when it sees one.

Model use splits cleanly by panel mode, which is why `MODELS` is keyed that way:
`qwen-image`/`seedream-4.0` only ever appear on image, `v6`/`v5.6` on animate,
`v6`/`v5`/`pixverse-c1` on frames.

### 1.13 `multi_shot` — unknown semantics, passed through

An `image_text` capture sent `1`; an `animate` capture sent `0`. What it
switches isn't known, so a rerun sends back whatever the original record carried
and fresh generations default to `0`. Reproduces the original without inventing
meaning.

**Narrowed, not solved** (2026-09-02). Across 3628 archive records carrying a
rerun payload, `multiShot` is `1` exactly **twice** — both `mode: image_text`,
`panelMode: animate`, model `v6`, quality 360p. Every other mode (`upload`,
`create_image`, `transition`, `frames`, `mimic`) is `0` without exception.

So it is confined to `image_text`, and it is rare enough there (2 of 884) to be
a UI toggle that is almost never on rather than a mode flag. Two samples is not
enough to say what it does, and a guess here would be inventing meaning — which
is the thing pass-through exists to avoid. Left alone.

A tempting-looking clue that isn't one: one of the two has `duration: 7`, an
off-menu value, which would fit "multi-shot stitches several clips". It doesn't
hold. `duration` on a record is the *measured* length of the file, not the
requested one — off-menu values (2, 4, 6, 7, 8, 9, 11, 12, 13, 14) occur all
over the archive on `multiShot: 0` records too.

### 1.14f `/login`, and the first real ErrCode (2026-09-02)

```
POST /creative_platform/login
req:  {"Username": "<email>", "Password": "<plaintext>"}
resp: {"ErrCode":0,"ErrMsg":"Success",
       "Resp":{"Result":{AccountId, Username, Token, DeleteAt}}}
```

The password goes up **in plaintext** — no client-side hash — over TLS. And the
`Token` in that response is the same token the extension currently scrapes off
live traffic.

**Two things follow, one of them a decision.**

*The failure envelope is confirmed.* A mistyped username returned **HTTP 200**
with `ErrCode: 500200, ErrMsg: "User does not exist."`. So a logical failure is
a 200 with a non-zero `ErrCode`, exactly as `apiFetch` already assumes. That
code is the **first real ErrCode ever captured**, and it is worth noting that
`500200` matches none of `[401, 403, 1001, 1002, 1003, 40001, 40100]` — the
invented list in `isAuthError`. Those numbers now look like guesses at the wrong
shape entirely; the real family appears to be `500xxx`. This does not disprove
them for *token* rejection specifically, which is a different endpoint and a
different error class, but the numeric branch has probably never once fired and
the message-text regex is doing all the work. Don't add `500200` to the list —
"user does not exist" is not a stale token, and a false positive there would
churn credentials for no reason.

*Frame Room re-auths itself.* The vault used to die when a JWT expired (~a
month), and the only fix was logging in on the site so the token could be
scraped again. This endpoint renews it unattended.

**Built on 2026-09-02, owner's call taken explicitly** — it stores passwords on
disk, which is a materially worse trade than the token vault of section 2.2, so
it was put to him rather than slipped in. The mechanics, the risk, and the one
thing that had to be verified first are in **2.2b**.

Still unexamined: `DeleteAt` in the login response. Nothing reads it. Worth
understanding before anyone leans harder on this endpoint — a field named that,
on an account object, is not obviously harmless.

### 1.14e The real model catalogue (2026-09-02)

Read off the live dropdowns, signed in. Both lists are far larger than anything
the code carried, and two of the ids the code *did* carry do not exist.

**Video — 14 entries in the dropdown.** IDs marked (i18n) are verified from the
app's own `externalModels` translation keys, which pair id to display name
directly; (archive) means the id appears in server-echoed records.

| shown | id | how known |
|---|---|---|
| PixVerse V6 | `v6` | archive, verified |
| PixVerse C1 | `pixverse-c1` | archive |
| PixVerse V5.6 | `v5.6` | archive |
| Seedance 2.5 | `seedance-2.5` | bundle |
| Seedance 2.0 | `seedance-2.0-standard` | i18n |
| MiniMax H3 | `minimax-h3` | bundle |
| Gemini Omni Flash | `gemini-omni-flash` | bundle |
| Happy Horse 1.0 | `happyhorse-1.0` | i18n |
| Kling O3 | `kling-o3-standard` | i18n |
| Kling 3.0 | `kling-3.0-standard` | i18n |
| Grok Imagine 1.5 | `grok-imagine-1.5` | i18n |
| Grok Imagine | `grok-imagine` | i18n |
| Veo 3.1 | `veo-3.1-lite` | i18n |
| Sora 2 | `sora-2` | i18n |

Several carry hidden variants the dropdown collapses — the i18n labels say so
outright ("Seedance 2.0 (Standard, Fast & Mini)", "Veo 3.1 (Standard & Fast &
Lite)"). The full id set in the bundle: `seedance-2.0-fast`, `seedance-2.0-mini`,
`kling-o3-pro`, `kling-o3-4k`, `kling-3.0-pro`, `kling-3.0-4k`,
`veo-3.1-standard`, `veo-3.1-fast`, `sora-2-pro`.

Everything except V6, C1 and V5.6 is badged **PRO+**, so an account on a lower
plan will be refused. Most also carry a max duration on the badge: 60s for Grok,
120s for most, 200s for Veo 3.1, 300s for Sora 2. That breaks the assumption
that durations are 5/8/10-ish.

**Image — 12 entries.** Qwen-image and Seedream 4.0 are unbadged; the rest are
**Standard+**.

Qwen-image · GPT Image 2 · Nano Banana Pro · Nano Banana 2 · Nano Banana 2 Lite ·
Nano Banana · Seedream 5.0 Pro · Seedream 5.0 Lite · Seedream 4.5 ·
Seedream 4.0 · Kling O3 · Kling 3.0

Image ids present in the bundle: `qwen-image`, `seedream-4.0`, `seedream-4.5`,
`seedream-5.0-lite`, `seedream-5.0-pro`, `kling-image-o3`, `kling-image-v3`,
`gemini-2.5-flash`, `gemini-3.0`, `gemini-3.1-flash`, `gemini-3.1-flash-lite`,
`wan2.7-image`, `wan2.7-image-pro`, `flux_turbo`.

**The id↔name mapping is only partly settled on the image side.** "Nano Banana"
is Google's branding, and there are four Nano Banana entries and four `gemini-*`
ids, so the pairing is obvious but *not verified* — don't write it down as fact.
**Superseded on 2026-09-06 by PixVerse's own CLI — see 1.14j.** Read that first;
several statements in this section are confirmed there and one is wrong.

GPT Image 2's id was not found at all. `wan2.7-image` did not appear in the
dropdown. The way to close this costs one generation per model: pick it, fire,
and read `model` off the payload.

**Two ids in the code are fiction.** `v4.5` appears nowhere — not the dropdown,
not the bundle, not 4087 archive records. And `flux-dev` is wrong twice over:
the bundle's id is `flux_turbo`, and no Flux model is in the dropdown at all.

### 1.14c The upload blocker is gone (2026-09-02)

Captured live, signed in, by uploading one 432 KB JPEG through the composer.

**The STS endpoint is `POST /creative_platform/getUploadToken`.** It takes **no
request body at all** — `req: null` on the wire — and returns:

```json
{"ErrCode":0,"ErrMsg":"Success","Resp":{
  "Ak":    "STS.NX…"   (29 chars),
  "Sk":    "…"         (44 chars),
  "Token": "CAISwg…"   (616 chars)
}}
```

`Ak` / `Sk` / `Token` are `AccessKeyId` / `AccessKeySecret` / `SecurityToken`.
There is no `Expiration` field. The credentials are **cached and reused** by the
client: a second upload moments later fired `batch_upload_media` again but did
*not* re-fetch a token, so a real implementation needs its own expiry policy
rather than one call per file.

This is the `AccessKeySecret` the README said "is never transmitted, so it can't
be read from a request capture". That was wrong — it is transmitted, in a
response, which is exactly the half of the traffic `chrome.webRequest` cannot
see. Nothing was hidden; we were looking with the wrong instrument.

**The naming is the trap.** `tools/har-ingest.js` was written to hunt for
`AccessKeySecret` and `SecurityToken` — the Aliyun-standard spellings, straight
from the docs — and it would have scanned right past `Ak`/`Sk`/`Token`. Hunt for
the shape and the endpoint name, not the vendor's vocabulary. Fixed.

`batch_upload_media` is confirmed field-for-field, request and response:

```
req:  {"images":[{"name":"<uuid>.jpg","size":432251,
                  "path":"upload/<uuid>.jpg","file_name":"image.jpg"}]}
resp: {"result":[{"id":…, "url":"https://media.pixverse.ai/upload%2F<uuid>.jpg",
                  "path":"upload/<uuid>.jpg", "size":432251, "name":"image",
                  "category":0, "err_msg":"", "asset_id":…, "asset_type":0,
                  "width":1672, "height":941}]}
```

Note `name` is the basename without extension, `file_name` is the original
filename, and the returned `url` carries the `%2F` form (NOTES 1.5).

**Still not captured: the OSS leg itself.** A page-level `fetch`/XHR hook caught
both PixVerse calls and zero Aliyun ones, and the browser's own resource
timeline showed no `aliyuncs` host either. Most likely the OSS SDK closed over
`fetch` at module load, before the hook was installed. So the signing mechanics
in the README are still only as good as the original capture. Before building
this, verify the canonical string reproduces one real signature byte-for-byte —
`SignatureDoesNotMatch` is the only error you get.

### 1.14c-bis Uploads are capped at 4000px a side (2026-09-02)

`batch_upload_media` answers `ErrCode: 400, "incorrect image width or height"`
for any image with a side over **4000px**. Bisected against the live API:

| size | result |
|---|---|
| 32×32, 100×100, 512×512 | ok |
| 1672×941 (a real photo) | ok |
| 4000×4000, 4000×100 | ok |
| **4001×4001, 4001×100** | **rejected** |
| 4096, 6000, 8000 (square or not) | rejected |

So it is a **per-side maximum, not an area or aspect rule** — 4000×100 passes
while 4001×100 does not. No minimum was found; 32×32 registers fine.

Two things make this nastier than it sounds. It is enforced at **registration**,
which is the *last* leg — so the bytes are pushed to OSS in full, and only then
does the upload fail. And `ErrCode 400` here is a plain HTTP-style code, unlike
the `500200` seen from `/login` (1.14f), so there is still no coherent error-code
family to pattern-match on.

The panel downscales to fit rather than refusing the file: the cap sits far above
anything PixVerse generates, so a larger source carries no usable detail into the
result. The resize is stated in the status line, never silent. One consequence
worth keeping in mind — re-encoding can change the format, so the worker types
the object from the **blob**, not from the filename.

### 1.14g Auth error codes, measured at last (2026-09-02)

Sent deliberately bad credentials to `/user/credits` rather than waiting to
observe one in the wild:

| sent | ErrCode | ErrMsg |
|---|---|---|
| malformed / rejected token | **10001** | `Token is invalid` |
| empty token header | **10003** | `user is not login` |
| no token header at all | **10003** | `user is not login` |
| (from `/login`, bad username) | 500200 | `User does not exist.` |
| (from `batch_upload_media`, oversized) | 400 | `incorrect image width or height` |

All HTTP 200 with a non-zero `ErrCode`, as ever.

The list these replace in `isAuthError` was
`[401, 403, 1001, 1002, 1003, 40001, 40100]`. Look closely: `1001` and `1003`
are one digit away from `10001` and `10003`. **That branch had never once
matched in the life of the project** — the message regex was quietly doing all
the work, which is why nothing ever looked broken. A plausible constant written
from intuition, sitting inert for months, indistinguishable from a working one.

There is still no coherent error-code family: `10001`, `500200` and `400` are
three different schemes from three endpoints. Do not infer a fourth.

### 1.14h `DeleteAt` — nothing to see (2026-09-02)

The `/login` response carries `DeleteAt` alongside `AccountId`, `Username` and
`Token`. Searched every loaded JS chunk of the official client: **zero
occurrences.** The site never reads it. Presumably account-deletion scheduling
held server-side. Closed as uninteresting rather than left as an open question.

### 1.14i Restyle — endpoint known, payload not (2026-09-02)

Two routes exist: `POST /restyle/list` (the 13 presets, unauthenticated — see
1.14b) and **`POST /video/restyle`**, the generate call. `restyle` is already a
key in the pricing formulas, so cost estimation would come free.

What is missing is the request payload. The route table lives in one vendor
chunk and the body is assembled elsewhere, so it was not recoverable by reading
around the call site. Closing it means either deeper bundle work or running one
real restyle on the site to capture the request — which costs credits and needs
a source video, so it was not done unprompted.

Preset fields worth knowing when it is picked up: `restyle_id`, `display_name`,
`restyle_prompt` (the full prompt text), and a per-preset `qualities`.

### 1.14j PixVerse publishes its own CLI, and it settles the model list (2026-09-06)

`github.com/PixVerseAI` has three public repos: **cli** (official, npm `pixverse`),
**skills**, and **PixVerse-MCP**. The CLI's README carries the authoritative model
ids. Everything in 1.14e that was derived from the web bundle's i18n keys is
**confirmed exactly** — `seedance-2.0-standard/-fast/-mini`, `happyhorse-1.0`,
`kling-o3-standard/-pro/-4k`, `kling-3.0-*`, `grok-imagine`, `grok-imagine-1.5`,
`veo-3.1-lite/-standard/-fast`, `sora-2`, `sora-2-pro`, `minimax-h3`,
`gemini-omni-flash`, `pixverse-c1`, `v6`, `v5.6`, `v5`, `seedance-2.5`.

**One thing we got wrong.** 1.14e says "no Flux model is in the dropdown at all",
and the code comment said the same. **`flux-3.0` exists**, and it is a *video*
model, not an image one. Removing `flux-dev` was still correct — that id is
fiction — but the conclusion drawn from its absence was too broad. Absence from
one account's dropdown is not absence from the platform, which is the same
mistake 1.12 already warned about for the archive and which was made again
anyway.

Also missing from our list: **`v5.5`** and **`wan-3.0`** (video). `v4.5` appears
nowhere in the official list either, so removing it was right.

**Two guesses now closed:**

- **GPT Image 2 is `gpt-image-2.0`.** 1.14e recorded that its id "was not found
  at all".
- **Nano Banana 2 is `gemini-3.1-flash`**, stated outright in the CLI README. The
  image list is `gemini-3.1-flash`, `gemini-3.1-flash-lite`, `gemini-3.0`,
  `gemini-2.5-flash` — exactly the four ids guessed against exactly the four Nano
  Banana entries. `2 Lite` to `-flash-lite` is near-certain by name. Which of
  `gemini-3.0` / `gemini-2.5-flash` is "Pro" versus plain "Nano Banana" is still
  **not** established; do not write it down.

**Flags the official client exposes that we do not:**

- **`--off-peak`** — "Use off-peak pricing (lower credit cost)". This is a real,
  user-selectable discount, not a time-of-day condition. `off_peak` is already
  plumbed through our frames payload and hardcoded to `0` in `sidepanel.js`, so
  we have been declining it on every generation. Not supported by Seedance 2.5.
- **`--multi-shot`** — "Enable or disable multi-shot mode (video only)",
  confirming both the meaning (1.14d) and that it is video-only. Not supported by
  Seedance 2.5.
- **`--detail-level`** and **`--idempotency-key`** — present in `capabilities.json`
  though absent from the README. `detail_level` is the variable that appears in
  the i2i pricing formula and that our estimator defaults to `0` without knowing
  what it is. An idempotency key is directly relevant to duplicate submissions.

The CLI also auto-resizes local images "to fit 1920x1920", against the 4000px
hard reject we measured in 1.14c-bis. Not a contradiction — one is PixVerse's
sensible default, the other is the API's limit — but 1920 is what they consider
reasonable.

### 1.14k There is a second, official, public API — and we should not move to it (2026-09-06)

`PixVerse-MCP` talks to a **completely different surface**:
`https://api.pixverse.ai/openapi/v2/...`, authenticated with an `api_key` header,
not the `token` header on `app-api.pixverse.ai/creative_platform` that this
extension uses. Endpoints there:

```
POST /openapi/v2/video/text/generate        POST /openapi/v2/video/extend/generate
POST /openapi/v2/video/img/generate         POST /openapi/v2/video/lip_sync/generate
POST /openapi/v2/video/transition/generate  POST /openapi/v2/video/sound_effect/generate
POST /openapi/v2/video/fusion/generate      GET  /openapi/v2/video/result/{video_id}
POST /openapi/v2/image/upload               POST /openapi/v2/media/upload
```

It is tempting — documented, stable, and it offers modes we lack (text-to-video,
extend, lip sync, sound effects, fusion) plus a plain `image/upload` instead of
the Aliyun OSS signing dance. **Do not migrate.** Two disqualifying reasons:

1. **It bills separately.** "This feature requires API Credits, which must be
   purchased separately on PixVerse Platform." Subscription credits do not carry
   over, so every generation would be paid for twice over.
2. **It has no library.** There is no endpoint anywhere in that surface for
   listing or searching past generations — only `video/result/{video_id}` for a
   job you already hold the id of. The archive, the Browse feed and every sweep in
   this project are built on `asset/library/list`. Moving would trade the
   irreplaceable asset for cleaner plumbing.

Worth stealing without migrating: `POST /openapi/v2/video/lip_sync/tts_list` is
the public twin of the `video/tts/list` seen in 1.14b, and the `fusion`,
`extend`, `lip_sync` and `sound_effect` modes tell us what the platform can do
even if we reach them by another door.

**A status enum, with a caveat.** That API's `status` field is documented in the
client as `1` COMPLETED, `2` PENDING, `3` IN_PROGRESS, `6` CANCELLED, `7` FAILED,
`8` FAILED, polled every 10s with a 300s default timeout.

This is **not** the same field as the internal `video_status` in 1.3 and must not
be treated as its documentation. But the overlap is striking: our 1810-video
cross-tab found `1` always fetchable (174/174) and `8` never (0/3), matching
COMPLETED and FAILED exactly. The anomaly is `7`, officially FAILED, where 1111 of
1439 files were fetchable.

If the enums are shared, `7` does not mean "not ready" — it means the generation
was **failed or rejected** while the file still landed on the CDN. The account's
own creation page is covered in "Policy Violation Detected" cards, which is
exactly what that would look like. This is a hypothesis, not a finding, and it
does not soften 1.3: a status that is 77% wrong about fetchability still cannot
decide readiness. Probe. But it may finally explain *why* 7 behaves that way.

### 1.14l Upload rejections and content moderation (2026-09-06)

Pulled from the site's own i18n bundle (`i18n-enUS-*.js`, public, no auth). Note
the bundle hash had changed since 2026-09-02, so the site redeploys often enough
that any of this can move.

**There is no single upload rule. Each entry point has its own**, which is why
"upload sometimes fails" felt arbitrary:

| rule | limit | where |
|---|---|---|
| `referenceGenerationFailed` | JPEG/PNG/WEBP, **300-6000 px** per side, **aspect ratio 0.4-2.5**, **max 30MB** | reference-image generation |
| `tip` | JPG/PNG/WebP, max 1920x1920, up to 10MB | an upload widget |
| `imageSizeLimit` | at least 300x300 | cover/upload validation |
| `imageTooLarge` / `imageSizeInvalid` | 10MB / 20MB | two different widgets |
| `videoSizeLimit` / `size` | 500MB / 2GB | video upload |
| measured (1.14c-bis) | **max 4000 px per side** | `batch_upload_media`, our path |

**The aspect-ratio and minimum-size rules do NOT apply to our path**, and we
already have the evidence: the 1.14c-bis bisection registered **4000x100**
successfully (aspect 40, far outside 0.4-2.5) and **32x32** successfully (far
below the 300 minimum). So for `batch_upload_media` the only measured hard rule
remains 4000 px per side. Do not import the reference-image constraints into our
validation; they belong to a different endpoint.

**Content moderation is POST-generation, not pre-submission.** The card the site
shows on a flagged asset is i18n key `appeal`, "Policy Violation Detected", with
`appealContent`:

> This content was flagged by internal or third-party safety systems for
> violating Community Guidelines.

Flagged, not blocked. The generation runs, the file lands on the CDN, and the
flag is applied afterwards. **This is very probably the explanation for
`video_status: 7`** (1.3, 1.14k): 1111 of 1439 status-7 records have a fetchable
file because the render genuinely completed before being flagged. Still a
hypothesis - the field driving the card has not been identified - but it now has
a mechanism behind it rather than being merely odd.

**The client does no prompt content-filtering at all.** The only prompt rules in
the bundle are lengths: `promptTooLong` "Each prompt must not exceed 5000
characters" and `promptLengthLimit` "The text should not exceed 500 characters".
There is no blocklist, no pre-flight check endpoint, and **no numeric error-code
to message map anywhere in the client** - it simply renders whatever `ErrMsg` the
server returns. So any prompt filtering is server-side and only observable by
submitting.

**Consequences are real.** The bundle carries account-state strings: "Your
account has been suspended because content you generated or your activity
violated our Community Guidelines" and a permanent-ban variant. Repeated flags
are not free.

**Deliberately not done:** characterising the prompt filter by submitting
candidate prompts. Given the suspension and ban strings above, probing a
moderation system with the account's own credentials risks the accounts rather
than the credits. If it is ever wanted, do it on a throwaway account and not this
one.

**What would close the rest**, both needing a signed-in session:
1. Load `/creation/video` and scan the chunks that only load there - the prompt
   handling and upload validation live in those, not in the homepage bundle.
2. Fetch `asset/library/list` and diff a flagged record against a clean one. The
   field driving the `appeal` card is in that response and is currently being
   discarded by `slimVideo`, which is why the archive has no moderation column.

### 1.14d `multi_shot` — answered (2026-09-02)

It is a **user-facing toggle** in the video composer, sitting next to Audio. Its
tooltip, verbatim:

> Generate multi-shot video with model-native capabilities. For best results,
> use clips longer than 5 seconds

So it asks the model for a video with several shots rather than one continuous
take, using whatever native support the model has. Not a mode flag, not
something the client computes — just a switch the user sets per generation.

This also explains the archive: 2 of 3628 (NOTES 1.13) is what a
default-off toggle looks like. Supersedes the "unknown semantics" note; the
pass-through behaviour stays correct, but it can now be surfaced as a real
control instead of an opaque field.

### 1.14b Six endpoints the client doesn't speak (2026-09-02)

Captured live off a **signed-out** browser on `app.pixverse.ai`. All six return
`200` with no `token` header at all, which is itself worth knowing: they are
public config, so Frame Room can call them before the account switcher has
resolved, and a 401 from one means something else is wrong.

| endpoint | method | what it carries |
|---|---|---|
| `/pricing/formulas` | POST | unknown — `{}` returns `Resp: null`, so it needs a real body |
| `/video/tts/list` | GET | 15 TTS voices: `speaker_id`, `display_name`, preview `url`, `img_url` |
| `/restyle/list` | POST | 13 restyle presets, 30 fields each — incl. the full `restyle_prompt` text and a per-preset `qualities` |
| `/content/template/price/multiplier` | GET | the quality multiplier table, below |
| `/content/categories/secondary` | GET | template categories; takes `primary_category_id` + `platform` |
| `/campaign/list` | GET | paginated, takes `page_num` / `page_size` / `status` |

The multiplier table, verbatim:

```
360p  x1      540p  x1.5      720p  x2      1080p  x4
```

**Read that carefully before using it.** The endpoint is
`content/template/price/**multiplier**` — it is the *template* price multiplier.
Nothing yet shows it governs `/image/i2i` or `/video/i2v`, and the one i2i
capture we have (qwen-image, 1080p, `credit_change: 10`) divides by the 1080p
multiplier to 2.5, which is not an obviously sane base. So this is a real,
verified table for templates and a **hypothesis** for anything else. It is not
yet a licence to compute a cost estimate in the panel; `creditChange: 1` stays
hardcoded and server-authoritative until the base cost is known.

`/pricing/formulas` is the endpoint that would supply that base, and it is the
one thing here still closed: it needs the request body the site actually sends,
which only appears on the Creation page, which is behind login.

### 1.14 Verified payloads

All three generate calls match captured requests field-for-field. Response
shapes differ between them (`/image/i2i` returns `success_ids` / `image_id` /
`fail_count` with a `total_count` of 0 alongside `success_count` 1) — nothing
reads them, since completion is detected by diffing the asset library.

---

## 2. Architecture, and why

### 2.1 Token capture off live traffic

`chrome.webRequest.onBeforeSendHeaders` lifts the `token` and
`ai-anonymous-id` headers from requests the page already makes.

Rejected alternatives: hardcoding (leaks, expires ~monthly), and reading
`localStorage` from a content script (the token often isn't there, and content
scripts don't inject into tabs opened before the extension loaded).

Tokens are keyed by `tabId`, because `webRequest` and `storage.session` are both
global to the single extension process — a naive capture flips accounts to
whichever tab polled last.

**The map must be persisted.** MV3 kills the service worker after ~30s idle; an
empty map on restart is indistinguishable from "signed out". A build that
cleared stored auth on an empty lookup logged the user out just for opening the
Browse tab.

### 2.2 Credential vault (deliberate security trade)

Per-account `{token, anonId}` in `chrome.storage.local`, **plaintext, on disk**,
surviving restarts. Chosen knowingly for painless switching across 4–5 accounts.
Anyone with machine or extension access can read them all.

Non-obvious rule: **token and anon-id are a matched set.** A re-login rotates
both. The anon-id header isn't on every request, so a capture can bring a fresh
token with no anon-id — reusing the previous one then pairs a live token with a
dead session's id and every call fails. A token change forces the anon-id to
null until the new session's is captured.

The switcher sets a *manual override* that beats tab-following, and that override
refreshes from the vault when credentials rotate — otherwise it serves a stale
snapshot forever.

### 2.2b Self re-authentication, and a worse trade (2026-09-02)

Tokens die in about a month. `POST /login` (NOTES 1.14f) returns one directly,
so an account can renew itself instead of waiting for you to sign in on the site
and have the token scraped off live traffic.

**This stores passwords in plaintext on disk**, in `chrome.storage.local`, under
`accountPasswords` — a key separate from `accountVault` so it can be wiped on
its own. It is strictly worse than the trade above and worth being blunt about:
a stolen token is an account until it expires, a stolen password is an account
forever and survives every rotation. It is **opt-in per account**; one without a
saved password behaves exactly as it always did.

**Proven in the wild, not just in the harness (2026-09-02).** A real account was
left holding a dead token — its session had been rotated out from under it by a
`/login` fired during this investigation, which is precisely the failure this
feature exists to absorb. Saving the password renewed it: the vault went from an
expired token to one dated 30 days out. The 28 harness checks cover the shapes
that are impractical to produce by hand; this covered the one that matters most,
and it happened by accident rather than by contrivance.

A thing to keep straight when testing it: **the page session and the vault token
are separate.** Renewing the extension's token does not sign the browser tab back
in, and a tab sitting on `/login` says nothing about whether renewal worked. The
credit figure in the panel is the signal, because that comes from the
extension's own API call.

**PixVerse is single-session per account, and that broke this (2026-09-05).**

A successful `/login` invalidates whatever session the account already had.
Section 2.2 above half-knew it — "a re-login rotates both the token and the
anon-id" — but the consequence went unnoticed: renewing kicks the browser tab
out, the user signs in on the site, that kicks the EXTENSION out, whose next
call triggers another renewal. The two ends evict each other indefinitely and
the user sees "account has been logged in elsewhere" repeatedly. Only accounts
with a stored password could suffer it, since only those log in unattended.

The evidence was in front of me on 2026-09-02 and I filed it as a convenience:
a `/login` fired during testing dropped the live tab to the sign-in page, and
that was written up as a handy way to test renewal rather than as the design
fault it was.

**The rule now is: adopt, don't fight.** The extension already sees every token
the site uses, through the `webRequest` capture that predates all of this. So
`reauthAccount` will:

1. adopt a newer token for that account from a live tab, or the vault, before
   considering a login at all;
2. refuse to log in while a tab holds that account on the same dead token — both
   ends are stuck, the site will sign itself back in, and the capture picks it
   up. Logging in here would evict the tab the user is looking at;
3. refuse more than one login per account per minute, as a backstop that holds
   even if the reasoning above is wrong somewhere.

An **eviction is handled differently from any other auth failure**: on "logged in
elsewhere" `apiFetch` only adopts, never renews, because renewing is the thing
that causes it.

Two traps found while fixing it, both caught by tests rather than by reading:

- The guards must live INSIDE the in-flight promise. They await, so running them
  before the promise is registered let two concurrent callers both slip past the
  single-flight check and both log in — the exact storm that map exists to stop.
- An expired token must never be adopted. It satisfies the caller and then fails
  on the very next request, which looks like a different bug entirely.

Design points that are not obvious:

- **Verified before stored.** `vault/savePassword` logs in first and only writes
  on success. Storing an unverified password would produce an account that
  fails to renew a month later, at exactly the moment the feature exists to
  matter, with no clue why.
- **The anon-id turned out not to be required.** This was the risk that could
  have sunk the whole thing: 2.2 above establishes token and anon-id as a
  matched set, and a headless renewal has no tab traffic to supply a new
  anon-id. Checked before building rather than after — a token straight from
  `/login` returned `ErrCode 0` from `/user/credits` with an **empty**
  `ai-anonymous-id`. So renewal sets anon-id to null and lets the next captured
  request fill it, which is what `vaultUpsert` already does on a token change.
- **One renewal per account at a time** (`reauthInFlight`). Several jobs failing
  together on one dead token would otherwise each fire a login, and a burst of
  logins is what any sane backend treats as an attack.
- **Two triggers, deliberately.** `readAuth()` renews when the clock says the
  token is expired, which is free. `apiFetch` renews on an auth-shaped `ErrCode`,
  which catches the case the clock cannot know about — a token revoked or
  rotated by a login elsewhere while `ExpireTime` still reads fine. The retry
  goes through `apiFetchWith`, which does not recurse, so a login that yields
  another rejection surfaces the error instead of looping.
- **Forgetting an account forgets its password.** Otherwise "forget" would leave
  the more dangerous half of the credentials on disk.
- Expired accounts used to be hidden from the switcher because they were
  useless. With a password they are one login away, so they stay listed and the
  row says `renew` rather than `expired`.

### 2.3 The archive

Persistent store in `chrome.storage.local`. Never pruned.

**Why it is not over-engineering.** The obvious read is that it works around a
listing that windows its results — an inconvenience. The real reason is worse:
PixVerse have lost user data, announced a recovery that turned out to be
incomplete, and were not much concerned about it. The community worked out its
own recovery methods. Against a platform with that history, a local index of
every generation is not a convenience layer, it is the only copy you control.

That is the justification for the rules that otherwise look excessive — nothing
is ever pruned, failed and limbo generations are archived alongside good ones,
and assets are captured at generation time rather than trusting a later sweep to
still have them. Anyone tempted to tidy those away should know they were written
against a specific failure that has already happened once.

Two problems it solves day to day: the API forgetting old generations, and
multi-account
fragmentation (local storage isn't cleared on account switch, so libraries
consolidate).

**The index is the properly-formatted media URL** (`%2F` decoded, query
stripped). It was the filename stem until 0.41.0, which collides — every
placeholder shares `default`, and two assets with the same stem under different
prefixes would collapse together. Records with no URL at all are keyed by asset
id and fold into the URL-keyed entry if one turns up.

Merge rules that matter:
- A later sighting with blank fields must not erase what's known.
- `starred` is a user field — an API re-sighting never clears it.
- Verified-present stays verified; files don't un-exist.
- Being marked unreachable is **never permanent** — re-probed daily, reverts the
  moment one answers.
- **One account per record.** Account tags were once a growing set, which meant a
  wrong tag could never be dropped — a 2-video account showed 13 because stale
  local-job tags accumulated alongside the real owner. The library payload names
  the owner and replaces the tag; local records only fill a gap.
- **Only the library may set an account tag.** Local job records carry the
  session account from submit time, which can be stale — they are the origin of
  every mis-tag. Allowing them as a fallback for untagged records meant a
  migration's repair was undone on the next load, so counts visibly shifted when
  switching accounts. Unconfirmed means unattributed.
- **Correcting a bad tag needs two halves.** Replacement alone doesn't work: a
  record wrongly tagged with account X belongs to Y, so X's library never returns
  it and the tag survives re-sweeps. After a *deep* sweep the fetched set is that
  account's complete history, so anything still tagged with it and absent from
  the sweep is mis-tagged and the tag is removed. Deep only — a recent-window
  fetch is incomplete by design and would strip valid tags.
  Worth knowing for any future data bug: making the *rule* authoritative doesn't
  repair what's already stored. Replacement only fires when the API re-confirms
  a record, and a sweep of account X never returns the records wrongly tagged X
  that belong to other accounts. Corrupt data needs a migration that repairs it
  offline, using an invariant that holds without re-fetching — here, "more than
  one tag is impossible".

Schema migrations are versioned (`archiveMeta`); several past migrations exist
solely to force a re-sweep after an extraction bug was fixed.

### 2.4 Nothing is filtered from the browse feed

Explicit product decision: queued, rendering, and failed generations all render.
A card that won't play tells you the generation existed; a hidden one tells you
nothing. **Missing a past render is the worse outcome.** Cards state which state
they're in rather than failing silently.

### 2.4b Nothing may wait forever

`chrome.runtime.sendMessage` returns a promise that never settles if the service
worker is terminated mid-request — no rejection, no timeout, just silence. Any
`await send(...)` without a race against a timer is a potential permanent hang,
and it presents as a UI stuck on a loading message with no error anywhere.

Same rule for outbound API calls behind a UI: bound them, and prefer a partial
result over a complete one that might never arrive. The frame picker shows
whatever the archive holds even when the live library never answers.

### 2.4c aspect-ratio cannot size a grid tile here

Four attempts went into making grid tiles the right height. The first three
assumed `aspect-ratio: 3 / 4` worked and something was overriding it. It never
worked:

- An `auto` grid row is sized from its items' intrinsic content.
- A tile's children are all absolutely positioned, so its intrinsic content
  height is zero.
- `aspect-ratio` does not contribute when the item's width comes from a `1fr`
  track — that width isn't known during intrinsic sizing.

So the row collapsed, and `align-items` had nothing to align against. The fix is
to state `grid-auto-rows` per size class and let the tile fill it.

General form, worth remembering: when a layout depends on a value the browser
computes in a different phase than the one you're reasoning about, state the
value instead of deriving it.

### 2.4d Probe with the request shape that already works

The media CDN answers a plain `GET` from an extension context and little else.
It refuses a direct `<video src>`, and it will not answer the preflight that a
`Range` header triggers, so a ranged GET fails before it is sent. That made the
existence probe report living files as missing for a long time, which in turn
retired good records and failed jobs that had actually rendered.

Rule: probe with the same request the blob rescue uses, a bare GET with no custom
headers, and cancel the body stream instead of reading it. Anything more exotic
is a new failure mode, not a saving.

Node is different. `tools/scan-local.js` keeps a ranged GET because there is no
CORS there and it avoids pulling whole files. The two are deliberately not
unified.

### 2.5 Browse memory model

Full-viewport scroll-snap feed, but only the focused card holds a `<video>` with
a src. On losing focus: pause, strip src, `load()` (this is what actually frees
the decoder), revoke the blob. Exactly one video alive at a time.

Posters use the generation's **source frame**, never the webp (see 1.1).

---

## 3. Wrong turns — the actual lesson

Each of these was a confident inference from one observation that turned out
wrong. They're listed because the *pattern* repeated, not because the individual
bugs matter now.

| Inference | Reality |
|---|---|
| Blank videos were an autoplay problem | CDN blocks direct `<video src>` |
| `%2F` in URLs was our own encoding bug | It's PixVerse's format, in both directions |
| `video_status: 7` means failed | Status is meaningless; 1/7/10 all seen on working videos |
| Fall back to the session account when a record has none | Cross-tagged every local record with all 5 accounts |
| `image_text` is text-only, so can't be rerun | It has a source image under a field name we weren't reading |
| `model_name_default` follows a formula | It's a per-model display name |
| Routine recovery is worth a `console.warn` | Made healthy playback look broken in the Errors tab |

**The rule that came out of it:** probe or capture; don't infer. Every wrong turn
above was resolved in minutes once a real request/response was in hand, after
much longer spent reasoning from a plausible-sounding theory. When a field looks
like it's telling you something, check what it actually does.

Corollary: a blank space in the UI where a control might be reads as a bug.
Labels now say *which* case applies (`rerun pending scan`, `no source image`,
`unconfirmed`, `unreachable`) rather than leaving absence to be interpreted.

---

## 4. Deferred, with reasons

Most of what follows is blocked on the same thing: a capture we don't have.
`chrome.webRequest`, which is what the extension uses to lift the token, can
read request headers and request bodies but **not response bodies** — there is
no such event. Every question below is a question about a response, so the
extension's own capture path can never answer any of them, no matter how much
is added to it.

`tools/har-ingest.js` is the way in. Save a DevTools capture ("Save all as HAR
with content"), run it through, and it merges every sample of each endpoint
into one shape and flags the specific blockers. Its header comment lists what
to do on the site to produce the capture each item below needs.

**Upload** — **built 2026-09-02.** No longer deferred. STS credentials from
`POST /getUploadToken` (1.14c), signature v1 in `crypto.subtle`, single PUT, then
`batch_upload_media`. The canonical-string trap and the `<StringToSign>` trick
that cracked it are in the `uploadImage` comment block in `background.js` and in
the README. Two things that turned out to be false in the old write-up: the
AccessKeySecret is not un-capturable (it is in a *response*), and multipart is
not required.

**MV3 worker termination on long polls** — **fixed 2026-09-02.** Not by
rewriting the poller into an alarm-driven state machine, which would have meant
rebuilding the most delicate code in the project, but by adding a recovery layer
underneath it. `chrome.alarms` fires every minute; `resumeOrphanedJobs()` finds
jobs left `running` with no live in-memory loop and resumes polling them.

What made this possible was persisting the `knownIds` snapshot on the job
record. That snapshot is the only thing separating a job's own output from every
other asset in the library, and it used to live solely in a local variable
inside the function Chrome was terminating — so there was nothing to resume
*with*, only something to resume. Jobs from before this build have no snapshot
and are settled with an explanatory error rather than polled blindly.

Guarded on both sides: `runningJobIds` (in-memory, so it dies with the worker —
which is exactly the signal that a job is orphaned) and `resuming` prevent a
second poller for a job already in flight, and anything past its own
`pollUntil` is settled rather than polled forever.

**History floor** — the deep sweep bottoms out at Jan 2023, a guess rather than
the real account start date. Too early only costs a few empty window requests.

**`MODELS` list** in `sidepanel.js` is a placeholder; real options should be read
off the site's dropdown.

**Origin checks** — if the API starts 403-ing it's validating `Origin`/`Referer`
and seeing `chrome-extension://…`. Flip `TRANSPORT` to `'page'` in
`background.js` to relay fetches through an open PixVerse tab.

---

## 5. Context

Personal tool, own accounts — a lot of them — driven by the official UI being
buggy and by needing to switch between accounts constantly.

**Why there are so many accounts.** Not by design. There was a period when
generations went into limbo for 48 hours or more, and PixVerse caps how many
generations can run concurrently. Stuck jobs hold those slots, so an account with
credits left is still unusable until they clear, and the only lever available is
to move to another account. Add test accounts that worked out and quietly became
main ones, and the number climbs on its own.

This matters for reading the archive: a large share of the records marked
unreachable, the ones with `video_status: 7` and a placeholder URL, and the
images whose `image_url` comes back blank are that limbo state showing through.
They are not parsing failures.

It is tempting to connect the vanishing `image_url` to the same underlying data
problems. It fits, but so would several other explanations, and there is no
evidence either way. Hold it loosely — the handling is identical regardless:
capture early, never discard, key on something stable.

These are internal endpoints, not a documented API. They can change without
notice.
