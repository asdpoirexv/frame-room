# Frame Room

A private Chrome side panel over your own PixVerse account. Your snippet, with
the sharp edges filed off.

`tools/scan-local.js` folds locally downloaded files back into the archive —
export from Browse, run the script over your downloads folder, import the result.
Run it with no arguments for usage.

`tools/har-ingest.js` is how the open questions get closed. Save a DevTools
network capture ("Save all as HAR **with content**") and it groups every
request by endpoint, merges the JSON bodies of all samples into one shape —
which fields are optional, which are enums — and flags the three known blockers:
an STS credentials response, a model catalogue, and headers the site sends that
we don't. Redacts your token by default; `--secrets` is for the one run where
you need to read an `AccessKeySecret`. The header comment lists what to do on
the site to answer each specific question.

`tools/archive-stats.js` reads the archive as a corpus rather than a file list.
Several thousand records where every field came back from the server is the
largest body of API evidence in the project, and it settles some questions
better than a fresh capture would — a capture gives you one sample of a field,
this gives you thousands. It is what corrected the model ids and what confirms,
at 1810 videos, that `videoStatus` cannot decide readiness. Absence proves
nothing here, though: it records what was generated, never what was offered.

`tools/flag-probe.js` is not a node script — it is pasted into the service
worker console. It identifies which library field marks an asset as
policy-flagged, and it is built so the output can be shared without sharing the
library: values are printed only when boolean, null, or a number under a
million, and everything else is reported as its type. Strings, and therefore
prompts, URLs, emails and ids, cannot appear in the output. The guarantee is a
whitelist in `safe()`, not a redaction pass, so it can be read and checked
rather than trusted.

Run `node test/verify.js` after changing `background.js` — 614 checks against
real captured API requests, no dependencies. (It said 92 for a long time; the
number had simply stopped being maintained.) The suite parses every shipped file
whole before testing any of its parts, because it works by extracting named
functions and would otherwise pass with a syntax error elsewhere in the file —
green ticks on an extension that won't load.

See **NOTES.md** for the accumulated knowledge behind this — how the API
actually behaves, why each design decision was taken, the wrong turns worth not
repeating, and what's deferred.

## Install

1. `chrome://extensions` → Developer mode on → **Load unpacked** → this folder.
2. Open `https://app.pixverse.ai` and sign in.
3. Click the extension icon. The dot in the header should go amber.

## What changed from your snippet, and why

**The token isn't in the code, it's read off live traffic, and it's bound to
the tab you're looking at.** The service worker watches requests to
`creative_platform/*` via `webRequest`, lifts the `token` header the page
already sends, and keeps it in `chrome.storage.session` (memory-only, wiped when
Chrome closes). Two subtleties:

- *Not storage scraping.* An earlier build tried to read the token out of
  `localStorage` from a content script. That was dropped: the token often lives
  in memory or a cookie a content script can't read, and content scripts don't
  inject into a tab that was open before the extension loaded — which is why an
  early build showed "Not linked". Reading it off live traffic has neither
  problem.
- *Per-tab, not last-write.* `webRequest` and `storage.session` are both global
  to the single extension process, so with PixVerse open in two windows a naive
  capture flips the account to whichever tab polled last. Tokens are keyed by
  `tabId` and the panel binds to the **active** tab's token, re-pointing when you
  switch tabs or windows. The header always shows the account whose tab you're
  actually on. If you run a normal and an incognito window at once, the
  `"incognito": "spanning"` setting lets the one process see both — but you must
  also tick **Allow in Incognito** on the extension's `chrome://extensions`
  card, or the incognito tab is invisible to capture.

Hardcoding is worse than any of this: the JWT carries `ExpireTime`, so it dies
on its own in ~a month, and shipping it in source leaks it. Rotate the one you
pasted into chat.

**Credentials for several accounts are saved, in plaintext, on disk.** Separate
from the per-tab capture above, every account whose token is seen is written to
a vault in `chrome.storage.local` keyed by username, so the account switcher in
the panel header can move between logins without re-authing each one. This is a
deliberate trade for convenience with 4–5 accounts, and it means:

- The tokens survive browser restarts (that's the point) and are readable by
  anyone with access to this machine or the extension.
- **Optionally, so are passwords.** Click the ⚿ on an account row in the
  switcher and it stores that account's password, so the extension can log in
  again by itself when the token expires instead of making you sign in on the
  site. Opt-in per account; an account without one behaves exactly as before.
  Be clear about what it costs: a stolen token is an account until it expires,
  a stolen password is an account **forever**, and survives every rotation.
  Passwords live under a separate storage key (`accountPasswords`) so they can
  be wiped without touching the token vault, the password is verified by an
  actual login before it is stored, and forgetting an account forgets its
  password too. Details in NOTES 2.2b.
- A re-login rotates *both* the token and the `ai-anonymous-id`, and the two are
  a matched set. The vault never pairs a new token with an old anon-id; a token
  change forces the anon-id to null until the new session's is captured.
- Don't load this build on a shared or untrusted machine.

**Fetches run in the service worker, not the page.** An extension with
`host_permissions` for `app-api.pixverse.ai` is exempt from the CORS check.
Those custom headers (`token`, `workspace-id`, `x-platform`) force a preflight,
which is exactly what would have killed this code in a normal web app on your
own origin.

**Results are found by diffing, not by `items[0]`.** Your `listImages()` returns
the newest asset, which is only your asset if nothing else is in flight — it
breaks with `create_count > 1`, with two overlapping jobs, or with another tab
open. `background.js` snapshots the library's ids before firing and then polls
for ids that weren't there before.

**`credit_change` is echoed, not trusted.** You confirmed the server recomputes
it; the field is sent only for parity with the web client.

## Three things that will bite

1. **Origin checks.** If the API starts 403-ing, it's validating `Origin` /
   `Referer` and now sees `chrome-extension://…`. Flip `TRANSPORT` to `'page'`
   at the top of `background.js` — the same fetch then runs inside an open
   PixVerse tab, where the origin is real. Trade-off: you need a tab open.

2. **`video_status` means nothing — don't be tempted.** An early build treated
   "has a derivable URL" as done, and a later one treated `video_status: 7` as
   failure. Both were wrong, and the second one hid working videos. Status 1, 7,
   and 10 have all been observed on videos that play fine, and `url` /
   `video_path` come back populated with placeholders long before any file
   exists. The only signal that means anything is an actual CDN probe, which is
   what `mediaExists()` does. If you're ever tempted to shortcut it with a
   status check, that's the third time.

3. **The service worker can die mid-render.** MV3 terminates it during long
   waits, so a 25-minute video poll may report a timeout even though the render
   completed server-side. It'll turn up in Browse afterwards via the archive.
   The proper fix is moving long waits to `chrome.alarms`; deferred until it
   actually bites.

## Upload

**Built 2026-09-02.** The frame picker has a file input: choose an image and it
goes straight into the slot. No more switching to the site and back.

The one line worth knowing, because it is the line that was got wrong first:

> **In the OSS signature-v1 canonical string, the Date line carries the
> `x-oss-date` value — it is not empty.**

That reads backwards. A browser cannot set the `Date` header at all (forbidden
header name), which is *why* the client sends `x-oss-date`, so the natural
conclusion is that Date is absent and the line is blank. It isn't; OSS
substitutes `x-oss-date` into that position and signs it.

And the thing that makes this debuggable at all, which the old notes here did
not know: **the `SignatureDoesNotMatch` error body contains `<StringToSign>`,
the exact string the server signed.** Diff it against yours and the discrepancy
is right there. That is how this was settled in one attempt rather than by
guessing at canonicalisation. If you ever touch this code and it 403s, read the
error body before you read anything else.

Multipart turned out to be unnecessary. The site chunks because it bundles
`ali-oss`, a generic resumable uploader — not because OSS requires it. A single
`PUT` of the whole body is accepted; verified with a 432 KB JPEG.

Verified end to end against the live bucket, and `test/verify.js` pins the
canonical string so a regression fails locally instead of as a remote 403.

### The flow, as captured

Bytes go to an Aliyun OSS bucket first; PixVerse is only told about the file
afterwards.

1. The client mints a UUID and targets `upload/<uuid>.<ext>`.
2. `POST https://pixverse-fe-upload.oss-accelerate.aliyuncs.com/upload/<uuid>.png?uploads=`
   → returns `<InitiateMultipartUploadResult>` with an `<UploadId>`.
3. `PUT …/upload/<uuid>.png?partNumber=N&uploadId=<id>` per chunk (~1 MiB each;
   a 2.26 MB file produced 3 parts). Each response carries an `ETag`.
4. `POST …/upload/<uuid>.png?uploadId=<id>` with a `<CompleteMultipartUpload>`
   body listing every `<PartNumber>` + `<ETag>` → returns
   `<CompleteMultipartUploadResult>`.
5. `POST app-api.pixverse.ai/creative_platform/media/batch_upload_media` with
   `{"images":[{name, size, path, file_name}]}` → registers the asset and
   returns `{id, url, path, size, name, asset_id, width, height}`.

The `path` from step 5 is exactly what `customer_img_path(s)` wants in the
generate calls.

### The blocker is gone (2026-09-02)

**`POST app-api.pixverse.ai/creative_platform/getUploadToken`**, no request body
at all, returns the STS credentials:

```json
{"ErrCode":0,"ErrMsg":"Success","Resp":{"Ak":"STS.NX…","Sk":"…","Token":"CAISwg…"}}
```

`Ak` / `Sk` / `Token` are `AccessKeyId` / `AccessKeySecret` / `SecurityToken`.
No `Expiration` field, and the client **caches and reuses** them — a second
upload moments later did not re-fetch a token — so an implementation needs its
own expiry policy rather than one call per file.

This README used to say the `AccessKeySecret` "is never transmitted, so it can't
be read from a request capture". That was wrong. It is transmitted, in a
*response*, which is the half of the traffic `chrome.webRequest` cannot see.
Nothing was hidden; the instrument was wrong.

Worth keeping in mind: the field names are `Ak`/`Sk`/`Token`, not the
Aliyun-standard spellings, and a search for `AccessKeySecret` finds nothing.

`batch_upload_media` is now confirmed both ways, against a real 432 KB JPEG:

```
req:  {"images":[{"name":"<uuid>.jpg","size":432251,
                  "path":"upload/<uuid>.jpg","file_name":"image.jpg"}]}
resp: {"result":[{id, url, path, size, name, category, err_msg,
                  asset_id, asset_type, width, height}]}
```

### What's left

Only the OSS leg. A page-level `fetch`/XHR hook caught both PixVerse calls and
zero Aliyun ones, so the signing details below are still only as good as the
original capture — most likely the OSS SDK closed over `fetch` before the hook
went in. Verify the canonical string reproduces one real signature byte-for-byte
before running anything; `SignatureDoesNotMatch` is the only error you get.

Then: HMAC-SHA1 via `crypto.subtle`, a refresh path for STS expiry, and
`https://pixverse-fe-upload.oss-accelerate.aliyuncs.com/*` added to
`host_permissions` **and** to `connect-src` in the CSP.

Multipart is probably unnecessary for our sizes — OSS accepts a plain
`PUT /upload/<uuid>.png` with the whole body. The site chunks because its
uploader is generic and resumable, not because the API demands it.

## Also

Everything else the extension sends is built from an observed request:
`/image/i2i`, `/video/i2v`, `/video/frames`, and the library list all match
captured payloads field-for-field. Two things in there are still inferred:

- **`model_name_default`** is a per-model display name, not a formula (`v6` →
  "PixVerse V6" but `qwen-image` → "Qwen-image"). Only those two are verified;
  `v5`, `v4.5`, `flux-dev`, and `seedream` follow the observed patterns and are
  marked as guesses in `MODEL_DISPLAY_NAME`. It may well be cosmetic.
- **`multi_shot`** is passed through rather than set — an image_text capture
  sent `1`, an animate capture sent `0`, and what it switches isn't known. A
  rerun sends back whatever the original record carried.

`MODELS` in `sidepanel.js` is a placeholder list. Read the real options off the
model dropdown on the site.

The deep history sweep bottoms out at a **2023 floor** — a guess, not your
actual account start date. Too early only costs a few empty requests; set
`since` if you want it tighter.

These are internal endpoints, not a documented API. They can change under you
without notice.
