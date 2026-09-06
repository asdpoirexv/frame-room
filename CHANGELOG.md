# Changelog

Entries from 0.48.0 onward carry a timestamp (IST, the author's local time).
Earlier entries predate that convention and are unstamped — the build history
they were reconstructed from had no reliable times, and back-filling guesses
would be worse than leaving them blank.

0.60.0 through 0.63.1 carry a date but no clock time. They were written up after
the fact, in two sittings rather than as each change landed, and the times were
not recorded. Inventing them would break the rule directly above.

## 0.64.0 — 2026-09-06

**Browse renders a chunk at a time instead of the whole archive.**

Both the reel and the grid built a DOM node for every filtered record, and the
grid wired hover listeners per tile. At four thousand records that is four
thousand nodes rebuilt from scratch on every filter change. Lazy images spare the
network and do nothing for layout or memory, which is why browsing was slow.

Nodes now come sixty at a time, pulled in by a sentinel at the end of the feed.
First paint and every filter change became O(chunk) rather than O(archive). The
catch is that the reel is index-addressed: `scrollToCard`, the keyboard nav and
the grid's click-to-open all reach for `cards[n]`, which may not exist yet, so
anything jumping to an index calls `ensureRendered` first.

**Search over prompts.** The archive holds thousands of prompts, every one
rendered onto its card, with no way to find any of them. Case-insensitive
substring, debounced, deliberately not fuzzy: these are your own prompts and you
are usually looking for a phrase you remember writing. Uploads carry no prompt,
so a search necessarily excludes them.

**A way back out of a tile.** Clicking a grid tile opened the reel at that item
and there was no exit except the view dropdown, which resets `scrollTop` to 0. On
a four thousand tile grid that meant every look at a single item cost you your
place. The tile click was a one-way door.

There is now a back control in the header and Escape does the same thing. The
return point stores the item's **URL rather than its index**, because an index is
a position in the current filtered list, so a stored one silently points at a
different record once the list changes — worse than no back button, since it
takes you somewhere confidently wrong. It is discarded when you change the view
or the filters by hand, both of which are deliberate navigations that make the
old position meaningless. Returning scrolls instantly rather than smoothly:
animating two thousand rows reads as a hang.

**Model and date filters.** `buildMeta` was already printing model, quality,
duration, mode, seed and date on every card while only account could be filtered
on. Model and a period selector close the two that matter. The period dates by
`madeAt`, which prefers `createdAt` and falls back to `firstSeenAt`, so a record
the archive discovered late still sits at the date it was generated.

**The parse guard was checking the wrong grammar.** Added in 0.60.0 to stop the
suite passing on a file the extension cannot load, it used `new vm.Script` —
which parses the classic script grammar. All three shipped files are loaded as
ES modules, and the two are not the same language: modules are always strict, so
duplicate parameter names, octal literals and `with` are syntax errors in one and
legal in the other, and `import`/`export` only parse as a module at all. A guard
written to catch "this will not load" could pass on a file Chrome refuses. It now
spawns node with `--input-type=module`, and the fix was verified by injecting a
duplicate parameter name, which the old check accepted and the new one rejects.

A refactor bug worth recording. `render()` kept the line
`if (viewMode !== 'reel') return renderGrid();` after `renderGrid` had been split
into a per-tile builder. It parsed cleanly and would have thrown the instant a
grid was opened. The suite stayed green because those tests asserted that the
CALL existed rather than that a grid rendered — a test pinned to the shape of the
code instead of its behaviour, which is worth less than no test at all, since it
reads as coverage. Both paths now share one chunked route and there is no
`renderGrid` left to call.

## 0.63.1 — 2026-09-05

**PixVerse is single-session per account, and self re-authentication did not
know it.**

A successful `/login` invalidates whatever session that account already had. So
renewing kicked the browser tab out; signing in on the site then kicked the
extension out; the extension's next call renewed again. The two ends evicted
each other indefinitely and the account showed "account has been logged in
elsewhere" over and over. Only accounts with a saved password could suffer it,
since only those log in unattended.

The evidence was in hand three days earlier and was misread. A `/login` fired
during testing dropped the live tab to the sign-in page, and that got written up
as a convenient way to test renewal against a dead token rather than as the
design fault it was. NOTES 2.2 had even recorded that a re-login rotates the
token, without anyone following the sentence to its consequence.

`reauthAccount` now adopts rather than fights. The extension already sees every
token the site uses, through the `webRequest` capture that predates all of this,
so it takes a newer token from a live tab or the vault before considering a
login at all. It refuses to log in while a tab holds that account on the same
dead token, because both ends are then stuck and the site will sign itself back
in for us to capture. And it allows at most one login per account per minute
regardless. An eviction is handled separately from any other auth failure: on
"logged in elsewhere" the fetch path only ever adopts, because renewing is the
thing that causes it.

Two faults the tests caught and reading did not. The new guards `await`, so
placing them before the in-flight promise was registered let two concurrent
callers both slip past the single-flight check and both log in — precisely the
storm that map exists to prevent. And an expired token must never be adopted: it
satisfies the caller and then fails on the very next request, presenting as an
unrelated bug.

`isEvictionError` matches on message text. The ErrCode for it has not been
measured the way 10001 and 10003 were, and is marked as such rather than guessed.

## 0.63.0 — 2026-09-02

**The panel says what a generation will cost before you spend it.**

`POST /pricing/formulas` returns roughly 117 KB describing how every mode's cost
is computed. It must be called authenticated and with **no request body at
all**; called without a token it returns `ErrCode 0` and `Resp: null`, a
success-shaped nothing that wasted an hour on its own.

It is a small expression-tree DSL — literal, variable, binary operator, one
function (`ceil`), and switch. Two traps, both of which cost a wrong answer
rather than an error. A binary node carries no `type` field, only `operator` and
`params`, so nodes must be recognised by shape. And `audio` and `multishot` are
compared against `compareValue: true`, a real boolean: passing `1` matches
nothing, falls through to the default, and prices as though the option were off.

Verified against three independent figures: the site's own Create button showed
5 for qwen-image at 720p and 38 for v6 at 540p/5s with audio, and the captured
i2i fixture carries `credit_change: 10` for qwen-image at 1080p. The evaluator
reproduces all three exactly.

**Discounts are the honest weak point, so the display says so.** The multipliers
are not discoverable — `/user/credits` reports whether a promotion runs but never
what it multiplies by, and the bundle only ever has the literal 1 near those
names. When no discount is detected the figure is exact. When one is, the true
cost can only be lower, so the badge reads `⚡≤38` with a tooltip naming the
promotion. An upper bound is useful; a silently wrong exact number is not. This
also caught a live case rather than a hypothetical: the Preview toggle has its
own multiplier that was being ignored, so preview jobs were over-quoted.

**Generate is disabled when the cost exceeds the balance**, checked against the
upper bound — the right side to be wrong on. It may occasionally refuse something
narrowly affordable; it will never fire a job that bounces.

**Multi-shot is now a real control.** Its meaning was finally established from
the site's own tooltip: "Generate multi-shot video with model-native
capabilities. For best results, use clips longer than 5 seconds." Until now the
field existed only as pass-through, reachable by accident when rerunning an old
job that happened to carry it.

## 0.62.0 — 2026-09-02

**Upload works. The frame picker takes a file from disk.**

The README had said the Aliyun `AccessKeySecret` "is never transmitted, so it
can't be read from a request capture", and that single sentence parked the
feature indefinitely. It is wrong. The secret is transmitted, in a *response* —
the half of the traffic `chrome.webRequest` cannot see. The instrument was
wrong, not the target. `POST /getUploadToken`, no body, returns `{Ak, Sk,
Token}`. Note the names: a search for `AccessKeySecret` finds nothing, and the
capture tool built to hunt for it would have scanned straight past.

The signing line that matters: in the OSS signature-v1 canonical string, **the
Date line carries the `x-oss-date` value and is not empty**. That reads
backwards, since a browser cannot set the `Date` header at all — which is
precisely why the client sends `x-oss-date` — so "Date is absent, therefore
blank" is the natural and wrong conclusion. What makes this debuggable at all is
that the `SignatureDoesNotMatch` body contains `<StringToSign>`, the exact string
the server signed. Diffing it against ours settled the whole thing in one
attempt. If this code ever 403s, read the error body before reading anything
else.

Multipart turned out to be unnecessary. The site chunks because it bundles
`ali-oss`, a generic resumable uploader, not because OSS requires it.

Two failures found only by running it. `fetch(dataUrl)` is refused inside the
service worker: MV3 workers are bound by the extension CSP and `connect-src` has
no `data:`, so a URL carrying its own bytes and making no network request is
blocked as a connection. Decoded by hand instead of widening the CSP. That also
proved the OSS host entry in `connect-src` was load-bearing rather than the
belt-and-braces it had been assumed to be.

And **uploads are capped at 4000px a side**, enforced at registration — after the
bytes have already gone to OSS. Bisected: 4000 passes, 4001 fails, per-side
rather than by area, so 4000x100 is fine and 4001x100 is not. The panel
downscales to fit rather than refusing the file, since the cap sits far above
anything PixVerse generates, and says so in the status line. Because re-encoding
can change the format, the worker now types the object from the blob rather than
the filename.

## 0.61.0 — 2026-09-02

**Accounts renew themselves instead of dying with their token.**

`POST /login` returns the same token the extension scrapes off live traffic, so a
stored password lets an expired account come back unattended rather than waiting
for a manual sign-in on the site.

**This stores passwords in plaintext on disk**, under a storage key separate from
the token vault so it can be wiped on its own. It is strictly worse than the
trade the vault already makes: a stolen token is an account until it expires, a
stolen password is an account forever. Opt-in per account; an account without one
behaves exactly as before. The warning sits in the password form, not buried in a
document.

The risk that could have sunk it was checked first rather than discovered later.
NOTES 2.2 establishes that token and anon-id are a matched set from one login
session, and a headless renewal has no tab traffic to supply a new anon-id. It
turns out not to be required: a token straight from `/login` returns `ErrCode 0`
from `/user/credits` with an empty `ai-anonymous-id`.

A password is verified by an actual login before it is stored. Storing an
unverified one would produce an account that fails to renew a month later, at
exactly the moment the feature exists to matter, with no clue why. Forgetting an
account forgets its password too. Renewal is single-flight per account.

Also measured, by deliberately sending bad credentials rather than waiting to
observe one: the auth ErrCodes are **10001** ("Token is invalid") and **10003**
("user is not login"). The list they replace was `[401, 403, 1001, 1002, 1003,
40001, 40100]` — note 1001 and 1003, one digit from the real values. That branch
had never matched once in the life of the project; the message regex was quietly
doing all the work, which is why nothing ever looked broken.

## 0.60.0 — 2026-09-02

**Two model ids in the dropdown were fiction.**

`v4.5` appears nowhere — not the live dropdown, not the JS bundle, not 4087
archive records. `flux-dev` is wrong twice over: the bundle's id is `flux_turbo`,
and no Flux model is offered at all. `seedream` was also wrong; every real record
carries `seedream-4.0`. Since a record's `model` field is what the server echoed
back, an id present there is one the API accepts, which is stronger evidence than
the dropdown.

The real catalogue is far larger than anything the code carried: 14 video models
and 12 image models, with ids verified from the app's own i18n keys. `MODELS`
deliberately lists only the short set these accounts can actually run — everything
else is badged PRO+ or Standard+, and offering them on a Basic plan buys a
refusal from the server. The rest are recorded in a comment so nobody has to
re-derive them.

**`tools/har-ingest.js`** turns a DevTools capture into answers.
`chrome.webRequest` can read request headers and bodies but not response bodies —
there is no such event — and every open question in NOTES was a question about a
response, so the extension's own capture path could never have answered any of
them. The tool groups requests by endpoint and merges every sample into one
shape, which is what tells you that a field is optional or an enum rather than
just present.

**`tools/archive-stats.js`** reads the archive as a corpus rather than a file
list. It is what corrected the model ids, and it confirms at 1810 videos that
`videoStatus` cannot decide readiness: status 7 covers 1439 of them and is right
about 77%, exactly the hit rate that survives casual testing and then hides a few
hundred working videos. A third value, 8, turned up that no build knew about.

**`test/verify.js` could pass with a syntax error in the file it tests.** It
pulls named functions out by brace matching and evaluates them individually, so a
fault anywhere else sailed through with green ticks on an extension that would
not load. It now parses every shipped file whole before testing any part of one.
A second fault in the same harness: `extractFn` took the first `{` after the
name, which for a destructured parameter is the parameter list, so such a
function appeared to contain none of its own code.

## 0.59.0 — 2026-08-12 07:24 IST

**The existence probe was sending a header a browser will not send.**

A tile stuck on "rendering" whose OPEN link showed the image immediately. The
probe and the browser were requesting the same URL, so the difference had to be
the request shape, and it was: after a non-OK HEAD the probe confirmed with a
one-byte ranged GET. `Range` is not a CORS-safelisted request header, so a
browser forces a preflight this CDN does not answer and the request fails before
it is sent. Both attempts then failed for unrelated reasons and a file that
plainly exists was reported missing.

The fallback is now a bare GET, which is exactly the request the blob rescue
makes successfully everywhere else in the extension. Headers arrive before the
body, so the stream is cancelled rather than downloading the file to learn it is
there.

**Every "unreachable" verdict so far is suspect**, because all of them came from
that probe. Migration v11 resets them to unverified and lets the corrected probe
decide again, rather than leaving good records retired on bad evidence. Expect
the unreachable count to fall over the next few loads.

`tools/scan-local.js` keeps its ranged GET deliberately. It runs in Node where
there is no CORS, and the header saves pulling whole files across thousands of
checks. The reason the two differ is written down so neither gets "fixed" to
match the other.

## 0.58.1 — 2026-08-12 07:06 IST

- **OPEN now appears on a tile while it is still rendering**, as soon as the
  poller has seen an asset row. The comment there said there was no URL until the
  render landed, which stopped being true in 0.58.0: rows are read on every poll
  pass and carry a URL long before the readiness probe confirms the file.
- This matters precisely when the probe is wrong. An image the probe kept
  rejecting opened fine in a browser, and at that moment the link was the only
  way to reach a render that had already finished.
- The link is added the instant a URL turns up and never duplicated. Its tooltip
  says the file is listed but not yet confirmed, so a broken link reads as a
  pending render rather than a fault.
- Recording the URL cannot affect the job: it is wrapped separately from the
  archive write, and an unchanged set does not trigger a save.

## 0.58.0 — 2026-08-11 20:07 IST

**A failed job no longer discards the URLs it already saw.**

Archiving happened only after a job completed. The poller reads the asset rows on
every pass, so a job that timed out had the URL in hand and threw it away. That
is the opposite of what the archive exists for.

Rows are now handed over the moment they appear, before any judgement about
readiness. Readiness decides when a job is *done*; it never decides whether a
record is worth keeping.

**A probe failure no longer reports a successful generation as failed.** An image
the probe kept rejecting opened fine in a browser, so the probe produced a false
negative. When the deadline is reached and rows with usable URLs were seen, those
are reported instead of throwing: the generation demonstrably happened, and the
archive re-probes on its own schedule and corrects the status either way. A false
failure is the more expensive mistake. A generation that genuinely never appears
still fails.

Caught before shipping: `captureRows` was declared after the line that passes it
to the poller. A `const` referenced earlier in the same block is a temporal dead
zone error, and that one would have thrown on every generation. Same shape as the
grid bug in 0.48.0, so the suite now asserts the declaration order directly.

## 0.57.1 — 2026-07-26 17:52 IST

- **The renders reel showed seven tiles when something was in flight.**
  `REEL_LIMIT` was applied to the finished renders, and placeholders were then
  prepended on top of a full six. The cap belongs on the reel as a whole.
  In-flight work now takes the slots it needs and finished renders fill the rest
  — a placeholder is the thing you are actually waiting on, so it should displace
  an old render rather than squeeze in beside them.
- The `N of M` count includes in-flight jobs, which it previously ignored.

Introduced in 0.34.3, when placeholders started being derived from the job list.

## 0.57.0 — 2026-07-26 17:11 IST

**`→ frames` — one click from an i2i result to a transition video.**

The workflow it replaces: generate an i2i, switch to the Frames tab, open the
picker, find the original among thousands, open it again, find the result. Every
one of those steps re-supplies something the record already knows — an i2i holds
both ends of the transition, the image it was made from and the image it became.

The button appears on any completed image generation and fills Frames mode with
the source as first frame and the result as last, carrying the prompt across.
Nothing is submitted; the settings are yours to adjust.

- **In the panel**, on a finished image tile — the moment right after generating.
- **In Browse**, on any archived image record, via the same stash the rerun
  button uses.
- Not offered when the source and the result are the same file, which would be a
  transition to itself.

Fixed while building: the browse path helper referenced a `MEDIA` constant that
only exists in `background.js`. It matches the host pattern instead — inventing a
second copy would make two sources of truth for one value.

## 0.56.0 — 2026-07-26 10:00 IST

- **The deep sweep tolerates a longer dormant stretch before giving up** — six
  empty 90-day windows instead of three, so ~18 months of silence rather than
  ~9. Three was ending real sweeps early: an account abandoned during a bad
  period and picked up again later looks finished, and everything before the gap
  is never seen. That is what `partial scan (gap)` in the header has been
  reporting.
- **Archive migration v10** clears the swept list so every account retries. Without
  it the accounts that already stopped short would keep their truncated history
  indefinitely.

The history floor stays at January 2023. The cost of the wider tolerance is a few
extra empty requests, once per account.

## 0.55.0 — 2026-07-26 09:32 IST

**scan-local now checks the CDN before writing a record, and can remove records
an earlier run got wrong.**

A UUID filename is not a PixVerse signature. Other services — Grok among them —
name generated files exactly the same way, and a downloads folder holds work from
several of them. 0.50.1 removed the CDN probe on the grounds that the
`upload/` vs `i2i/` ambiguity didn't arise; that was true, and it missed the
ambiguity that does: *whose file is this?* Nothing in `<uuid>.jpg` answers it.

- **Verification is on by default.** Each candidate is checked before a record is
  written; a non-OK HEAD is confirmed with a one-byte ranged GET before rejecting
  a file. Runs 8 at a time with progress every 250. `--no-verify` skips it and
  marks the records `unverified`.
- **`--prune` re-checks records a previous scan added** — identified by the
  `localFile` marker, so records from the API are never touched — and drops the
  ones that no longer resolve.
- Prune output states plainly that **import merges and cannot remove**, so
  applying it requires a purge first.

Verified end to end against a stubbed CDN: dead local records dropped, verified
ones kept with their stars, API records untouched, non-existent files never
added.

## 0.54.0 — 2026-07-26 05:46 IST

**Videos with no stored poster now show a frame from the video itself.**

The media host can grab a still out of an mp4:

```
…/<name>.mp4?x-oss-process=video/snapshot,t_1000,f_jpg,w_400,h_0,m_fast
```

Without `w_` it returns the snapshot at full video resolution — worse than no
poster at all on a wall of tiles. Width is set per grid size (220 / 400 / 600),
`h_0` keeps the aspect ratio, and `m_fast` takes the nearest keyframe instead of
decoding to an exact timestamp.

This fixes two groups at once: records imported by `scan-local` (a filename says
nothing about a still frame, so they were written `poster: null`) and any video
whose own poster never resolved.

- Only a fallback. A record with a real poster keeps it — that is the actual
  source frame, which says more about the generation than a still from one
  second in.
- Derived at display time, never stored. It is a query string, `canonicalUrl`
  strips those, so it cannot fork an archive record — asserted in the suite.
- The two transforms compose: a snapshot URL already carries `x-oss-process`, so
  `thumbUrl` leaves it alone rather than appending a second one.

## 0.53.2 — 2026-07-26 05:23 IST

**Hover preview now works in the small grid too — and the way it was disabled
there was wasting bandwidth.**

0.49.0 turned it off at small size with `display: none`. But the JS wires hover
for every video tile and fetches the whole file; the CSS only hid the result. So
hovering a small tile downloaded the entire video and showed nothing — strictly
worse than either enabling or disabling it properly.

The reasoning behind the restriction was wrong as well: a video is the same
number of bytes whatever size tile it plays in, so the cost at small was
identical to medium and large.

Enabled everywhere. A test now guards against re-introducing a CSS-only disable —
if a size restriction is ever wanted it belongs in `wireHoverPreview`, where it
stops the fetch instead of discarding it.

## 0.53.1 — 2026-07-26 05:20 IST

**"Uncaught (in promise) Error: The extension worker did not respond."**

Introduced in 0.46.0. The `send()` timeout added there *rejected*, and only the
picker's call was wrapped — so nine of the eleven call sites in the panel became
unhandled promise rejections the moment the worker was slow to answer. And it is
legitimately slow sometimes: a deep sweep across several thousand records takes a
while, and MV3 can terminate the worker mid-request.

`send()` now **resolves** with `{ ok: false, timedOut: true, error }` instead of
rejecting. Callers already test `res?.ok`, so every failure lands in the branch
that was already there rather than escaping as an exception. One fix instead of
nine.

- The pending timer is cleared when a reply arrives, so a settled call no longer
  holds one for another 45 seconds.
- A transport error (port closed, worker gone) resolves the same way.
- The picker's try/catch and the browse page's are removed — both were dead, and
  leaving them implied `send` could still throw.

The errors already in your list are from the old build and can be cleared.

## 0.53.0 — 2026-07-26 05:15 IST

**Load more in the frame picker.** It was capped at 300 items with no way past
it — with a 3,778-record archive, most of the library was simply unreachable.

- The ceiling is now 5,000, and the picker renders 60 tiles at a time with a
  `Load 60 more · N left` button pinned below the grid.
- **Fetched once, paged in the DOM.** The library is mostly the local archive, so
  a second round trip buys nothing; what actually hurts is putting several
  thousand `<img>` elements on the page at once.
- The button sits below the scrolling grid rather than at the end of it, so it's
  reachable without scrolling past everything already loaded.
- Items are resolved to `{src, path}` up front, so paging is pure DOM work.

Paging verified for 0, 1, 60, 61, 150 and 3,778 items: every item reachable, no
page overruns, button hidden exactly at the end.

## 0.52.1 — 2026-07-26 05:13 IST

- **Thumbnail size now follows the grid size.** `style/cover-webp-small` is soft
  much above 200px, so the medium (300px rows) and large (440px rows) grids ask
  for `style/cover-webp` instead — still a fraction of the original. Small keeps
  the smaller style, and the picker keeps it too since those tiles are ~84px.
- An unrecognised view mode falls back to the larger style: soft-but-correct
  beats sharp-but-wrong-sized.

Two styles are confirmed to work. There may be others; nothing depends on
knowing them.

## 0.52.0 — 2026-07-26 05:11 IST

**Grids and the picker request thumbnails.**

The media host is Aliyun OSS, which resizes on request:

```
…/upload%2F<uuid>.png?x-oss-process=style/cover-webp-small
```

A few kB instead of a few MB. The site uses this for its own thumbnails — it was
visible in an earlier network capture and went unnoticed. Until now the grid
fetched full-size originals for every tile, which at nearly 4,000 items is
absurd.

- Grid tiles and the frame picker request thumbnails; both fall back to the
  original once if the processor refuses a particular object.
- **The reel does not** — that's where you actually look at something.
- **Videos are left alone.** An image processor has nothing to do with an mp4; a
  video's *poster* is a still, so that gets thumbed like any other image.
- **Not stored on the record.** It's a display concern, and it's a query string,
  which `canonicalUrl` strips — so a thumbnail keys to the same archive record as
  its original and cannot fork one. That invariant is asserted in the suite.

Applying the transform twice adds one parameter, not two.

## 0.51.0 — 2026-07-26 04:56 IST

**Grid tile height is stated, not derived. Fourth attempt, and the mechanism is
finally understood.**

Three previous fixes all assumed `aspect-ratio: 3 / 4` would size the tile and
that something was interfering. Nothing was interfering — aspect-ratio simply
cannot do that job here:

> An `auto` grid row is sized from its items' intrinsic content. A tile's
> children are all absolutely positioned, so its intrinsic content height is
> zero. `aspect-ratio` does not participate in that calculation when the item's
> width comes from a `1fr` track, because the width isn't known yet. The row
> collapses to nothing, and no `align-items` value rescues it — there is no row
> to align against.

Each size class now states `grid-auto-rows` outright — 190px, 300px, 440px — and
the tile fills its row. The columns still flex, so tiles aren't exactly 3:4 at
every viewport width; `object-fit: cover` handles that. A shape that is always
right beats a ratio that is sometimes zero.

The tests asserted the broken design — that the tile *was* sized by aspect-ratio
and carried no fixed height. They now require every size class to state a row
height, which is the actual invariant.

Also: the rule-body helper in the suite now strips comments before matching. A
property name mentioned in prose was reading as a declaration, which made one
check pass for the wrong reason.

## 0.50.3 — 2026-07-26 04:48 IST

- **scan-local accepts only the formats PixVerse produces**: `.jpg`, `.jpeg`,
  `.png` for images and `.mp4` for video. `.webm` and `.mov` were speculative and
  were never output formats. `.webp` was worse than speculative — the webp URL is
  the phantom that never exists as a file, so a downloaded `.webp` is by
  definition not an asset.

## 0.50.2 — 2026-07-26 04:44 IST

**scan-local was unusable on a real downloads folder.** Three problems, found by
asking what such a folder actually contains rather than what a clean one would.

- **It accepted any image or video.** `vacation-photo.jpg` mapped to
  `pixverse/i2i/ori/vacation-photo.jpg` — a record pointing at a URL that does
  not exist and never will, indistinguishable in Browse from a real generation
  the CDN had lost. PixVerse names every asset with a UUID, optionally suffixed
  with the seed, so that shape is now required. Being strict costs nothing: a
  real asset always matches.
- **It recursed into subfolders.** Top level only now; `--recurse` if you want
  the old behaviour.
- **Windows duplicate markers broke resolution.** A colliding download becomes
  `name (1).mp4`, which fails a strict stem check — so the stricter matching
  above would have silently dropped every duplicate. The marker is stripped
  before matching, and `x (1).mp4` resolves to the same asset as `x.mp4`.

The two skip reasons are now reported separately: a `.pdf` is noise, but a `.mp4`
whose name isn't an asset id might be a naming case the tool doesn't know about,
and those are listed so a false negative is visible rather than silent.

Verified against a generated folder of 2,058 files — 800 assets across all four
naming conventions, 30 Windows duplicates, 1,228 unrelated files, and a subfolder
of assets that must not be picked up. 830 records added, no junk, no duplicate
keys, 279ms.

## 0.50.1 — 2026-07-26 04:37 IST

**scan-local: the ambiguity it was built around doesn't exist.**

A bare `<uuid>.jpg` is well-formed as both `upload/<uuid>.jpg` and
`pixverse/i2i/ori/<uuid>.jpg`, so 0.50.0 probed the CDN to tell them apart. But
nobody downloads a file they uploaded — anything in a downloads folder is output.
The filename was never ambiguous; the missing information was about the user, not
the data.

Every filename now maps to exactly one path, which removes more than a special
case:

- No network. The tool is fully synchronous and works offline.
- No `--no-probe` flag, no `pathUnverified` records, no unresolved bucket, no
  per-file HTTP round trip.
- ~50 lines shorter.

The extension's own probe still confirms every imported record on the next load,
which is where that check belonged anyway.

## 0.50.0 — 2026-07-26 04:34 IST

### Grid tiles collapsed to nothing (third fix, and the real one)

Grid items default to `align-self: stretch`, which sets their height from the row
and makes **`aspect-ratio` inert**. The row was sized by its content, the content
was a `loading="lazy"` image with no intrinsic size until it arrives — so every
tile collapsed, and the star buttons chained down each column.

- `align-items: start` on the grid, so aspect-ratio governs the height.
- The image is absolutely positioned, so whether it has loaded contributes
  nothing to layout at all.

That is three separate bugs in one feature across three turns — a class that
shouldn't have been there, a class name that never matched, and a CSS default
that silently disabled the sizing. Each shipped with the suite green, because
none of them is reachable without rendering the page.

### tools/scan-local.js — fold downloaded files into the archive

For files on disk that never made it into the archive. Export → run → import.

Downloads preserve the storage path in one of two ways, or not at all:

| filename | resolves to |
|---|---|
| `pixverse_mp4_media_web_ori_<name>.mp4` | `pixverse/mp4/media/web/ori/<name>.mp4` |
| `pixverse_i2i_ori_<uuid>.jpg` | `pixverse/i2i/ori/<uuid>.jpg` |
| `<uuid>_seed<n>.mp4` | `pixverse/mp4/media/web/ori/<uuid>_seed<n>.mp4` |
| `<uuid>.jpg` | **ambiguous** — upload or i2i output |

The last row is the interesting one: a bare `uuid.jpg` is equally plausible as
`upload/<uuid>.jpg` or `pixverse/i2i/ori/<uuid>.jpg`, and the filename cannot
settle it. Rather than guess, the tool asks the CDN which one responds.
`--no-probe` skips the network, takes the likelier candidate, and marks the
record `pathUnverified` rather than pretending to certainty.

- Only files not already archived are added — a basename-only download matches
  the same asset stored under its full path, so re-running is safe.
- Seeds are recovered from `_seed<n>`.
- The tool's archive key is asserted against the extension's in the test suite;
  if they ever diverge, imports would fork records instead of merging.
- Records are written `status: 'pending'` so the extension's own probe confirms
  them rather than the tool asserting they exist.

## 0.49.2 — 2026-07-25 23:52 IST

**Grid still broken after 0.49.1 — a second, separate bug in the same feature.**

The size class was built one way and compared another:

```js
for (const c of ['is-sm','is-md','is-lg']) feed.classList.toggle(c, viewMode === c);
```

`viewMode` holds `'sm'`; `c` holds `'is-sm'`. Never equal, for any mode. So
`is-grid` was applied but no size class ever was, leaving `display: grid` with no
`grid-template-columns` — a single full-width column, every tile viewport-wide.

- The class is derived from the mode now rather than compared against a parallel
  list, which removes the chance of the two drifting.
- `.feed.is-grid` carries default columns, so a missing size class degrades to a
  usable grid instead of a broken page.
- Tests assert that every class the JS can emit is actually styled. That is the
  general form of this bug — a string built in one file and matched in another —
  and it is invisible to both a syntax check and a CSS validator.

Two bugs in two turns on one feature, both shipped green. Neither was reachable
by the checks in place: 0.49.1 was a class that should not have been there,
0.49.0 a class name that never matched. Both needed the thing to actually render.

## 0.49.1 — 2026-07-25 23:49 IST

**Grid view rendered one tile per screen.** Introduced in 0.48.0.

Grid tiles were given the reel's `.card` class purely so `teardown` would keep
finding them — a shortcut. `.card` carries
`height: calc(100vh - var(--bar-h))`, and an explicit height beats
`aspect-ratio`, so every tile was a full viewport tall regardless of the grid
columns around it. The `display: grid; place-items: center; padding: 16px` came
along too.

Tiles no longer borrow the class; cleanup queries `.card, .gtile` instead, which
is what it should have done in the first place.

**The test suite asserted the bug.** It checked that a grid tile *carried*
`.card` — encoding the shortcut as a requirement, so it passed while the feature
was visibly broken. It now asserts the opposite, plus the underlying rule: a grid
tile is sized by aspect ratio and must not pick up a fixed height from anywhere.

## 0.49.0 — 2026-07-25 23:42 IST

**Hover to play in grid view.**

This does not weaken the one-video-alive rule that made grids poster-only in the
first place: only one tile can be hovered, so at most one `<video>` exists in the
grid at any moment. It is the reel's discipline driven by the pointer instead of
by scroll.

Two guards do the real work:

- **A settle delay (220ms).** Dragging the pointer across a grid crosses dozens
  of tiles, and each would otherwise start fetching a whole video file. Nothing
  begins until the pointer stops.
- **A staleness token.** A fetch can land after the pointer has moved on. Without
  the check the video attaches to a tile you already left and plays invisibly,
  holding a decoder and its blob indefinitely. A discarded fetch revokes its own
  blob rather than leaking it.

Also:

- Entering a tile stops the previous preview before starting its own, so the
  handover never has two decoders open.
- Any re-render — filtering, sorting, switching view — kills a live preview,
  which would otherwise outlive the tile it belongs to.
- The preview fades in only once it actually plays, so a slow fetch shows the
  poster rather than a black rectangle, with a small spinner on the tile.
- **Disabled at small size.** Those tiles are for scanning; fetching full videos
  to play them at thumbnail scale is mostly network thrash.
- Fetches go straight to the blob path — a direct `<video src>` to this CDN is
  always refused, so trying it first would cost a failed load per hover.

Fixed in passing: the spinner keyframe was defined only in `sidepanel.css`, and
`browse.css` referenced it. Separate documents — the animation would have
silently done nothing.

## 0.48.0 — 2026-07-25 23:38 IST

### Gallery view

Reel is no longer the only way to look at the archive. **Reel / Grid small /
Grid medium / Grid large**, in the header.

- **Grids render posters only — no `<video>` elements at all.** That is
  deliberate, not an optimisation: the reel's one-video-alive rule is what keeps
  a large feed from exhausting decoders, and a grid of a thousand tiles would
  break it instantly. Playback stays a reel concern; the grid is for finding
  things.
- Clicking a tile opens it in the reel at that position. Clicking its star does
  not open it.
- Tiles carry a `vid` / `img` marker, since a still looks the same either way,
  and the prompt on hover (suppressed at small size, where it wouldn't fit).
- A video whose poster never resolved shows its prompt rather than a blank hole.
- Arrow keys and space are reel-only now — in a grid the browser's own scrolling
  is the right behaviour.

### Header declutter

Eleven controls in one row. Now: wordmark, counter, view, sort, **filters**,
status, **…**, hint.

- The four filters (starred, media type, origin, account) moved into a filters
  popover. Collapsing them would hide whether any are active, so the button
  carries a count badge, and there's a clear-all.
- Export and import moved into an overflow menu — rare actions that were sitting
  at the same visual weight as the filters.
- Opening one popover closes the other; clicking anywhere else closes both.

### Timestamps

Changelog entries carry a date and time from here on.

## 0.47.0

Parallel generation across accounts now actually works, and it exposed a real
bug rather than a missing feature.

**Jobs pin their account for their whole lifetime.** Every API call read the
*live* session at the moment it fired. A video job polls for up to 25 minutes, so
switching accounts mid-flight silently redirected its polling to the new
account's library — where its asset does not exist. The job would time out while
the render succeeded server-side. Each job now captures its auth at start and
uses it for the snapshot, the generate call and all polling; interactive calls
still follow the active session, which is correct for them.

**Concurrency is per account, not global.** The cap was two jobs total, so two
generations on one account blocked a third on another — self-throttling, and
backwards for the whole multi-account workflow. PixVerse limits in-flight
generations per account and doesn't care that a different account is busy, so the
scheduler now mirrors that: two per account, accounts independent. The queue is
walked rather than only its head, so a job blocked on a busy account can't hold
up one behind it for a different account.

**The Generate button stays enabled.** It was disabled for the duration of a
render, which meant the UI serialised work the worker could already do in
parallel — including the submit-switch-submit sequence above.

**Rerun on a still-rendering tile.** The job record carries mode and params from
submission, so nothing has to wait for the render to finish. Load it, switch
account, generate — which is the point when you want the same generation running
in two places. No OPEN button there: there is no URL until it lands.

## 0.46.0

**Frame picker could hang on "Loading…" forever.** Reported on an account with
1000+ generations. Three independent causes, each sufficient on its own:

- **No timeout on the library calls.** The two `asset_source` fetches ran
  sequentially with nothing bounding them, so one stall held the picker open
  indefinitely. They now run in parallel behind an 8s timeout, and a source that
  stalls or fails contributes an empty list rather than blocking. The archive is
  local and always contributes, so a dead API still leaves you a usable picker.
- **Whole archive records crossed the message boundary.** The picker needs a
  preview URL and a storage path; it was being sent every field on every record.
  Tolerable at 50 records, not at a thousand. Slimmed to `{url, path, at}`.
- **`send()` could never settle.** MV3 can terminate the service worker
  mid-request, and `sendMessage`'s promise then simply never resolves — the
  caller waits forever with no error. Every message in both pages now has a 45s
  timeout and rejects with something showable, and the picker catches it instead
  of leaving "Loading…" on screen.

The paste-a-path field stays usable throughout, and the failure messages now say
so.

## 0.45.0

**Backup and restore.** `export` and `import` in the browse header.

Export downloads the archive as dated JSON. That's the artifact worth moving
between machines: prompt, seed, model, settings and account for every
generation, including ones the platform's listing has since forgotten. The media
files carry none of it.

- **Import merges, it does not replace.** Two archives of the same accounts
  overlap heavily, so a restore folds a backup into a live archive without
  discarding anything since: stars survive, a blank field never overwrites a
  known one, a verified status is never downgraded, accounts are unioned, and the
  earliest sighting wins.
- **Keys are re-derived, not trusted.** A backup written before 0.41.0 uses
  filename stems; those re-key to canonical URLs on the way in.
- **Re-importing the same file is a no-op.** Records added from a backup are
  normalised so an imported record is indistinguishable from a natively-archived
  one — otherwise re-import would "change" records it had just added.
- The format and version are validated; a backup from a future version is
  refused rather than half-read.

**Not exported: the credential vault.** Tokens expire in about a month, so a
backup of them is near-worthless by the time you'd restore it, and writing live
bearer tokens into a downloads folder — and from there into whatever syncs it —
is a materially worse exposure than the plaintext-on-disk trade already made.

**Not exported: the swept-accounts list.** Restoring it would tell a fresh
install it had already scanned everything and skip the deep sweep that finds
anything generated since the backup.

Fixed while testing: merging two records that both lacked a `firstSeenAt` stored
`Infinity`, because `Math.min` of two absent values is truthy and the
`|| Date.now()` fallback never fired. It serialised to `null` on the next export.

## 0.44.0

- **Sort control on the browse page** — newest first, oldest first, recently
  archived, shuffle. Applies after the filters, so it sorts whatever the current
  view holds.
- **"Recently archived" is not a synonym for "newest".** `createdAt` is when a
  generation was made; `firstSeenAt` is when this archive first saw it, and a
  deep sweep discovers years-old generations today. Sorting by discovery is how
  you see what the last sweep turned up.
- Shuffle is stable within a session: each record takes one random value at load,
  so re-filtering or starring doesn't reshuffle the feed underneath you.
- Records with no `createdAt` fall back to `firstSeenAt` rather than sorting to
  an arbitrary end.
- Sorts a copy — `allItems` is shared, and the archive's order shouldn't depend on
  what the feed happens to be showing.

## 0.43.2

Docs only — recording context that explains several design decisions.

- **Why the archive isn't over-engineering.** PixVerse have lost user data,
  announced a recovery that proved incomplete, and were unconcerned; the
  community built its own recovery methods. Against that history a local index of
  every generation is the only copy you control, which is the actual
  justification for never pruning, for archiving failed and limbo generations
  alongside good ones, and for capturing assets at generation time.
- **Why there are so many accounts.** Generations went into limbo for 48h+ during
  one period, and concurrent generations are capped — stuck jobs hold the slots,
  so an account with credits left is unusable until they clear. Moving to another
  account is the only lever. Recorded because a large share of the records marked
  unreachable, the `video_status: 7` ones, and the blank `image_url` cases are
  that limbo state showing through rather than parsing failures.
- Noted, and deliberately not asserted, that the vanishing `image_url` *might*
  share a cause with those data problems. It fits; so would other explanations.
- Corrected a stale line still describing the archive as keyed by mp4 basename.
  It has been the canonical URL since 0.41.0.

## 0.43.1

- **Dropped the cross-account note from rerun entirely.** 0.43.0 replaced the
  blocking confirm with an informational readout; that was still solving a
  problem that doesn't exist. The originating account is already shown on the
  browse card you clicked, and the note cost an `auth/status` round-trip on every
  rerun to restate it. Rerun now just loads.

## 0.43.0

**Source paths are portable across accounts — the rerun account-switch prompt was
built on a wrong assumption and is gone.**

An image generated under one account can be used as a source under another, with
no re-upload, and the generation succeeds. 0.22.0 assumed the opposite and put a
blocking `confirm()` in the rerun flow offering to switch accounts first, on the
reasoning that "the source frames live on that account's storage". That was
plausible and never tested.

- The confirm is replaced by an informational note: the readout says which
  account the generation originally came from, and that credits come from the
  active one. No interruption.
- Billing is the only real consequence, and for anyone deliberately spreading
  work across logins it's usually the intent rather than a mistake.
- The frame picker offering every archived image regardless of account — flagged
  as a possible hazard in 0.37.0 — is confirmed correct.

## 0.42.0

- **Uploaded / generated filter on the browse page**, with counts. Composes with
  the media-type, account and starred filters, so "starred generated images from
  one account" works.
- Origin comes from `asset_source` when a live record carries it (0 uploaded, 1
  generated), and from the storage prefix otherwise — `upload/` versus
  `pixverse/…`. A referenced source frame has no `asset_source` at all, so the
  prefix is the only signal there.
- **Derived at read time**, so archives written before origin was recorded filter
  correctly with no migration.
- Only images have an origin — a video is neither uploaded nor generated in this
  sense — so choosing one implicitly narrows to images.
- Same rules as the other filters: hidden when there's nothing to choose between,
  selection restored after a rebuild, handler assigned rather than stacked.

This should have shipped alongside the media-type filter — the `asset_source`
distinction was documented at length and then never surfaced in the UI.

## 0.41.0

**The archive index is the properly-formatted media URL** — `%2F` decoded, query
stripped — for images and videos alike.

It was the filename stem, which collides. That wasn't theoretical: every
placeholder shares the stem `default`, so unrelated records collapsed into one
entry and overwrote each other, and two assets with the same stem under
different prefixes (an upload and an i2i output) would have done the same. A full
URL cannot collide, and the key is directly usable rather than being a fragment
you have to reconstruct from.

- `archiveKeyFor` is now the single definition of identity, used by the merge,
  by verification and by reconciliation — previously each derived a key its own
  way.
- **Migration v9** re-keys the existing archive. Where two old entries map to one
  new key, they're merged rather than last-write-wins: the star is kept, a
  verified status beats a pending one, accounts are unioned.
- `basenameOf` is deleted. Leaving it would have left a second, weaker notion of
  identity for someone to reach for.
- The no-URL fallback is unchanged: generations whose `image_url` and
  `image_path` both come back blank are still keyed by asset id, and still fold
  into the URL-keyed entry when one arrives.

## 0.40.1

- **`%2F` handling audited end to end**, over real encoded fixture URLs rather
  than by inspection. The rule has two halves and reversing either is silent:
  stored and displayed URLs are decoded (`<video src>` and `<img src>` don't
  decode `%2F`), payload URLs are encoded (that's the form PixVerse's own client
  sends), and archive keys must collapse both spellings or one asset files twice.
- Twenty-one checks covering: every slimmer's output decoded, derived source
  frames decoded, paths kept raw, keys identical across spellings, payload
  builders encoding, and a full round trip — encoded URL in, decoded record,
  path derived, repacked, byte-identical to the original.
- Verified the audit can fail: skipping the decode on derived inputs, sending an
  unpacked URL in the i2v payload, and making the archive key spelling-sensitive
  each fail exactly the relevant checks.

No defects found — the paths added in 0.39.0 and 0.40.0 were already correct.
Now they're pinned.

## 0.40.0

**Source frames are archived too.**

Every generation — i2i, i2v, image_text, frames — carries the image it was made
from, with both a storage path and a URL. Those inputs are images in their own
right and drop out of the library like anything else, but only the outputs were
being kept. The data was already in hand on records we were fetching anyway.

- Inputs are extracted from all four field layouts: the paired
  `customer_img_paths[]` / `customer_img_urls[]` arrays (both nested and
  top-level), the singular `customer_img_path` that `image_text` uses, and
  `customer_first_frame` / `customer_last_frame`.
- **Deduplicated per record.** A frames generation lists its two frames under
  *both* the array and the first/last fields, so without this every one would
  archive its inputs twice.
- Archived at generation time as well as during sweeps, so an input survives even
  when its own generation's output URL comes back blank.
- Stripped off the parent records before storing, so the same URL isn't held
  twice.
- **Derived records claim no account.** They are one step removed from a payload
  that names an owner, and guessed attribution is what caused the account-tag
  mess. A direct library sighting still tags them properly.

An input that is also a library asset keys to the same archive entry, so this
enriches existing records rather than duplicating them.

## 0.39.0

**Generations were being lost when the listing came back with a blank URL.**

Some generated images return `image_url` and `image_path` both empty on a later
listing, though the URL was there during generation — no discernible pattern to
which ones. `slimImage` returned `null` for those, so they were dropped before
reaching the archive and disappeared as though they had never happened. Exactly
the failure the archive exists to prevent.

- **Assets are archived at generation time**, straight off the poll result, while
  the URL still exists. Waiting for the next library sweep loses whichever ones
  have gone blank by then, and there is no way to know in advance which those
  are.
- **A record with no URL is kept, not discarded.** It is filed under its asset id
  instead of a media basename. The prompt, seed, model and source frame are worth
  having on their own, and a later sighting can still supply the URL.
- **The two keys can't fork one generation into two entries.** The merge indexes
  by asset id, so an id-keyed placeholder and a basename-keyed record fold
  together in either arrival order, and a star set on the placeholder survives.
- **A blank sighting can no longer erase a URL already recorded.** `url` and
  `path` now fall back to the stored value the way every other field already did
  — previously the spread overwrote them with `null`.

## 0.38.0

- **Media-type filter on the browse page** — All media / Videos / Images, with
  counts. Composes with the account and starred filters, so "starred images from
  one account" works.
- Hidden when the archive holds only one kind, selection restored after a
  rebuild, handler assigned rather than stacked — same rules the account filter
  learned the hard way.
- Records archived before the `kind` tag existed read as video, which is
  accurate: that is all the archive held.
- Empty-result state now distinguishes "nothing starred here" from "nothing
  matches these filters".

## 0.37.1

**Blank browse feed — a bug introduced in 0.36.0.**

The image card added there returns early from the render loop and called
`card.append(star)`, but `star` is declared with `const` further down the same
block. Referencing it first throws a `ReferenceError` from the temporal dead
zone, and because the loop body is a `forEach` callback nothing catches it: the
first image record killed the entire feed render. Accounts holding only videos
still worked, which is why it looked account-specific.

- Badge and star are built by hoisted functions now, initialised before the
  branch, and both card kinds append them. Image cards get their index badge too,
  which they'd been missing.
- Structural tests assert the initialisation order, so a future early return
  can't reintroduce it.

**Account dropdown could name one account while the feed showed another's.**
Rebuilding the options resets a `<select>` to its first entry without firing
`change`, so the visible label and the filter in force drifted apart. The
selection is now restored after a rebuild, falling back to "all" if the
previously-filtered account no longer exists.

**Filter handler was stacking.** `buildAccountFilter` runs on every load and used
`addEventListener`, so one change eventually fired `applyFilter` several times.
Assigned rather than added now.

## 0.37.0

- **The picker shows archived images too, not just what the API currently
  lists.** That is the whole point of having an archive: the API drops old
  generations from its listing while the files stay fetchable, so anything it has
  forgotten is now still pickable. Archive image records already carry `url` and
  `path`, so the picker reads them without special-casing.
- **Dedupe is keyed on the canonical URL**, which is what makes the merge safe.
  The same asset arrives in three field shapes — live uploaded (`url`), live
  generated (`image_url`), archive (`url`) — and `%2F` versus plain slashes, or a
  trailing `?x-oss-process=`, must not split one image into two entries.
- Results are sorted newest-first and capped at 300; thumbnails load lazily,
  since the grid can now run to hundreds.

## 0.36.1

- **Paste-a-path field moved above the image grid.** It's a fixed action, so it
  shouldn't drift up and down with however many images happened to load. Anchored
  at the top it's always in the same place.
- **The grid now fills the remaining panel height** instead of being capped at an
  arbitrary 46vh with dead space beneath it. The picker sheet is a flex column,
  the bar and field keep their natural height, and scrolling belongs to the grid
  rather than the sheet — otherwise the field would scroll away with it.

## 0.36.0

### The whole form is per-tab now, not just the prompt

Picking a frame in one tab changed the selection in the others. 0.34.2 fixed
this for the prompt and left every other control shared — the same bug with a
narrower patch. Each tab now parks and restores its entire form: prompt, both
frame slots (with their thumbnails), seed, count, model, quality, duration,
ratio, and the audio/preview toggles.

### Images are archived alongside videos

Your point about the webp trick was the crux: video survives a missing `url`
because `webp_url` carries the filename, and images have no equivalent.

They don't need one. Both image shapes carry a storage **path** independent of
the URL, so the dependency runs the other way — if the server omits or
placeholders the URL, it's rebuilt from the path. A record is only
unrecoverable when *both* are missing, which is a much smaller hole than video's.

- Swept across both asset sources, deduplicated, stored with `kind` so images
  and videos are distinguishable.
- `basenameOf` widened beyond `.mp4` — image records were keying to `null` and
  would have been dropped silently by the merge. Video keys are unchanged.
- Browse renders an image card without a `<video>` element at all (its poster is
  the asset), and the focus/memory machinery guards on the element being absent.

### Picker

- Tile grid capped at 46vh and scrollable, so a large library can't push the
  paste-a-path field off the panel.
- Fetch raised 24 → 60 now that scrolling makes the extra rows reachable.

## 0.35.1

Generated-image payload captured — a **third** field shape, now covered by tests
rather than assumption.

| record | preview | storage path |
|---|---|---|
| uploaded (`asset_source: 0`) | `url` | `path` |
| generated (`asset_source: 1`) | `image_url` | `image_path` |
| video | derived from `webp_url` | — |

A generated image has **no `url` and no `path` at all**, and its
`customer_img_paths` holds the *input* upload — so a picker reading that field
would show the output and select the source. Deriving the path from the preview
URL already handled this correctly; the capture confirms it rather than leaving
it to luck.

- `image_path` and `path` added to the fallback chain as verified field names,
  behind the URL derivation, for the case where a URL isn't on the media host.
- Fixture plus tests for all three shapes, asserting the invariant that matters:
  the tile you click is the image you get.

## 0.35.0

**`asset_source` separates uploads from generations, and we only ever asked for
one of them.**

Three captured requests isolate it exactly: `tab: "image"` with
`asset_source: 1` returns `total: 0`, and the identical request with
`asset_source: 0` returns the uploaded image. Every library call hardcoded
`asset_source: 1` — correct for video, since every generation is source 1, which
is why that path always worked and this one never did.

- `asset_source` is a parameter now, defaulting to 1 so the video paths are
  unchanged.
- The frame picker queries **both** sources and merges, deduplicating on
  `asset_id`. One source failing doesn't blank the picker.
- The picker's filter shape (`{ video_status: [1] }`) matches what the site's own
  picker sends — not the `{ start_time, end_time }` filter the video sweep uses.
- Fixture and regression tests added: uploads are source 0, the picker queries
  both, and no hardcoded `asset_source` remains.

Uploaded image records carry `path` and `url` directly and have no
`customer_paths` at all — which is why the previous version's field-guessing
couldn't have worked even if the request had been right.

## 0.34.4

Frame picker showed "No images in your library yet" for a library that has them.

- **The message conflated two different failures.** It appeared whenever zero
  tiles were built — both when the API returned nothing and when it returned
  items the picker couldn't read. Those now say different things, and the
  unreadable case logs one raw item to the console so the field shape can be
  reported instead of guessed at.
- **The preview and the storage path could refer to different images.** The
  preview came from `url` (the generated output) while the path came from
  `customer_paths` — which holds that generation's *input*. Picking a tile could
  hand the generate call a different image than the one shown, and uploaded
  images have no `customer_paths` at all, so they fell through to field names
  never verified against a real image payload.
  The path is now derived from the same URL as the preview, so they cannot
  disagree. Handles uploads (`upload/<uuid>.png`) and generations
  (`pixverse/i2i/ori/<uuid>.jpg`) alike, and tolerates the `?x-oss-process=`
  query the CDN appends.

Note: the image library payload has still never been captured, unlike the video
one. If the picker still comes up empty, the console now says whether anything
came back at all.

## 0.34.3

- **Placeholders survive a tab switch.** A render in flight showed its
  placeholder, but leaving the tab and coming back lost it — the reel is rebuilt
  from scratch on every mode switch, and the placeholder existed only in the DOM
  rather than being derived from anything.
  The reel is now a pure function of the job list: in-flight jobs render as
  placeholders the same way finished ones render as tiles. Submitting just
  refreshes the reel, so the separate DOM-only path is gone rather than patched —
  one source of truth, less code than before.

## 0.34.2

- **Each tab keeps its own prompt.** There is one `#prompt` element serving all
  three modes, so a prompt typed in Image appeared in Animate and Frames too —
  and switching tabs mid-compose overwrote whatever was there. Model and quality
  already rebuilt per mode; the prompt never did. Prompts are now parked per
  mode and swapped on switch, so each tab keeps what you left in it.

## 0.34.1

- **Images are probed for existence like videos are.** Completion for image jobs
  shortcut straight to "ready" the moment a URL could be resolved, on the
  assumption that images are written before they are listed. They are not — the
  reel showed a broken tile for a render that had not landed yet. Same mistake
  as the original video readiness bug, left in place for the branch that hadn't
  been reported.
- **Image tiles retry instead of keeping a broken glyph.** The image branch had
  no error handler at all, so a 404 was permanent even once the file appeared.
  It now uses the same fetch-and-retry path as video, with `load()` guarded
  since `<img>` has neither `load()` nor `play()`.

## 0.34.0

**The extension now records account-count drift itself.**

Counts shifted between loads three times, and each time the only evidence was a
screenshot plus my recollection of what had changed — which is how three
consecutive diagnoses each found a real bug that wasn't the cause. Relying on the
user to notice a data bug, and on memory to explain it, is the actual problem.

- After every load, per-account counts are compared with the previous load. Any
  change is logged with what that load actually did: which account was active,
  whether it deep-swept, whether the sweep finished, whether reconciliation ran
  and cleared anything, and how many records came from the library versus local
  job records. Last 20 events kept.
- **The distinction that was missing:** a count changing after a deep sweep of
  that account is expected. A count changing on a plain reload is a bug. The
  header now says `counts drifted unexpectedly - press D` only in the second
  case.
- The drift log is included in the `D` diagnostic, so a single paste shows both
  the current state and the history of how it got there.
- Purge clears the log along with everything else.

Next time this happens there is a recorded answer instead of a theory.

## 0.33.1

- **Archive purge** — `Shift+Backspace` in the browse feed, after a confirm.
  Clears the archive, swept list, and all account tags; everything rebuilds from
  authoritative library data on reload. The credential vault is untouched, so you
  stay signed into every account. A clean slate for the account-tag state without
  re-logging-in.

## 0.33.0

Account counts were still moving. Three previous diagnoses each found a real bug
and none was the cause, so this ships one defensible fix and the means to stop
guessing.

- **Reconciliation now requires a genuinely complete sweep.** The deep sweep has
  three exit conditions and only one means "I saw everything": reaching the
  history floor. Stopping on the 1000-record cap, or on three consecutive empty
  90-day windows (an account dormant for nine months then active before that),
  leaves older generations unseen. Reconciliation argues from absence — "not in
  this account's history, so not this account's" — which is false against a
  truncated sweep, and would strip valid tags from everything it never reached.
  The sweep now reports whether it finished, reconciliation only runs when it
  did, and a truncated sweep is no longer banked as done so it retries next load.
- The header says `partial scan (max)` or `partial scan (gap)` rather than
  letting an incomplete picture look authoritative.
- **Press `D` in the browse feed** for an archive diagnostic — copied to the
  clipboard, printed to the console. It reports tag *provenance*, not just
  counts: how many records are multi-tagged, how many untagged, the sum of tags
  against the record total, per-account breakdown by `accountSource`, the swept
  list, and the archive schema version. Every account-tag bug so far was
  invisible in a count and obvious in provenance.

## 0.32.0

**Added a test suite, and saved the captures it runs against.**

Every payload correction this project made was caught by diffing against a real
captured request — but those captures only ever existed in a chat log, and the
checks were throwaway one-liners that vanished the moment they printed. Losing
the captures would mean re-capturing an undocumented API from scratch.

- `test/fixtures/` holds the real captured requests (`/image/i2i`,
  `/video/i2v`, `/video/frames`), two library records chosen because each
  disproves something (an `image_text` record whose source hides under the
  singular `customer_img_path`; a record with a placeholder `url`, empty
  `video_path` and `video_status: 7` whose mp4 is nonetheless downloadable),
  and the pagination envelopes including the `has_more: true` case.
- `node test/verify.js` — 92 checks, no dependencies, no framework.
- **It exercises the real functions.** background.js registers `chrome.*`
  listeners at import time so it can't be required in node; rather than copy the
  logic into the test (where it would drift and pass while production broke),
  the harness extracts the named functions from the source and evaluates them.
  If one is renamed or removed the suite fails loudly, which is correct.
- **Invariant checks guard the rules, not just behaviour** — that no
  local-account fallback exists, that no `model_name_default` formula remains,
  that `video_status` isn't used to decide existence, that generate payloads use
  the packed URL builder, and that the archive version is ahead of its last
  migration step.
- Verified by regression: reintroducing three past bugs makes the suite fail on
  exactly the relevant check, and reverting returns it to green.

## 0.31.0

**Fixed account counts changing when you switch accounts.** Switching between two
accounts moved the numbers — `unattributed` emptied and one account's count grew
by exactly that much, every time.

0.30.0 cleaned the archive but left the thing that kept dirtying it. Local job
records carry whatever account was active at submit time, and `archiveMerge`
still accepted that as a fallback for any record with no tag. So a record the
migration had just cleared got re-tagged from the same stale data on the very
next load — the repair and the corruption were racing each other, and which one
you saw depended on which account you'd browsed last.

- **Only a library payload can set an account tag now.** Local job records are
  not a valid source even as a fallback — they are the original source of every
  mis-tag in this whole thread. A record the library has never confirmed stays
  unattributed, which is an honest gap; a guess that silently rewrites itself on
  the next load is not.
- **Tag provenance is recorded** (`accountSource`), so a confirmed tag can be
  told from a legacy one without guessing.
- **Migration v8** drops every tag not confirmed by a library payload and clears
  the swept list so the sweep can re-establish them from authoritative data.

Expect counts to look sparser right after upgrading, then fill in — correctly
this time — as each account is browsed once.

## 0.30.0

Repairs the inflated per-account counts. 0.29.0 made the library payload
authoritative, which stops *new* mis-tags — but it only corrects a record when
the API re-confirms it, and sweeping one account returns only that account's own
records, never the strays wrongly tagged with it that belong elsewhere. So the
existing bad data survived a full re-sweep: an account with 2 videos still
showed 13.

Two mechanisms, because the bad records fall into two shapes:

- **Multi-tagged records are corrupt on their face.** A generation has exactly
  one owner, so anything carrying two or more tags is wrong without needing to
  ask the API. **Migration v7** collapses those to the record's own `account`
  field (the most recent sighting, which prefers the library value over a local
  job's), or to unattributed when there isn't one — an honest gap beats a coin
  flip between two tags. Idempotent, and needs no re-fetch.
- **Single-tagged records can still be wrong,** and no amount of collapsing
  catches them. After a *deep* sweep the fetched set is that account's complete
  history, so any record still tagged with it that wasn't returned is mis-tagged
  by definition, and the tag is dropped. Replacement handles "this record's
  owner is X"; this handles "this record is not X's". Migration v7 also clears
  the swept list so the deep sweep this depends on actually runs.

The removal pass only runs after a deep sweep (a recent-window fetch is
incomplete by design and would strip valid tags), only when the fetch succeeded,
and derives the account name from the fetched records rather than the session so
it can't drift from the spelling used in the tags. An empty or mixed-account
result is treated as ambiguous and changes nothing.

The header reports `N mistagged fixed` when a pass clears anything. Each account
reconciles once, on the first Browse under it.

**Note on versioning:** the build carrying these changes shipped labelled
`0.29.1` — a version bump silently failed and went unverified. Same code, wrong
label; corrected here.

## 0.29.0

- **Fixed inflated per-account counts in the browse filter.** An account with 2
  videos was showing 13. `archiveMerge` treated account tags as a set that only
  ever grew, so any tag ever written was permanent — including wrong ones. Local
  job records carry whatever account was active at submit time, and before the
  0.23.0 credential-rotation fix that could be a stale account while the
  generation actually ran under another. Those bad tags got unioned in and could
  never be corrected. (Symptom: per-account counts summed to more than the
  archive size.)
  A generation belongs to exactly **one** account, so the library payload — which
  names the owner on the record itself — is now authoritative and **replaces**
  the tag. A local-only record can still fill the gap when nothing authoritative
  is known.
- **Migration v6** forces one re-sweep so every record the API still returns gets
  its tag corrected. Tags are deliberately not cleared outright: records the API
  has forgotten would become permanently unattributed, and a possibly-stale tag
  beats no tag for those.
- **Stopped double-reporting unreachable records** in the header. `unconfirmed`
  counted everything not yet verified *including* the failed ones, so
  "41 unconfirmed / 41 unreachable" was the same 41 records twice and read like
  82 problems.

## 0.28.2

- **Added `NOTES.md`** — the accumulated knowledge from building this, in one
  place: how the API actually behaves (with the traps), why each architectural
  decision was taken, a table of wrong inferences and what they really were, and
  the deferred work with reasons. Written to be read cold months later. The
  CHANGELOG says what changed when and the README says what the tool does; this
  fills the gap of *why*.

## 0.28.1

Docs only.

- **Upload is deliberately skipped, and the README now says so in full.** The
  flow is entirely reverse-engineered — the Aliyun OSS multipart sequence, the
  `batch_upload_media` registration, the exact request shapes — but the OSS
  requests are signed with Aliyun signature v1 using temporary STS credentials,
  and the `AccessKeySecret` needed to compute a signature is never transmitted.
  The README records the whole flow, the blocker, and a step-by-step for picking
  it up later, including verifying the signature offline before running anything.
  Workaround: upload on the PixVerse site and the image lands in your library,
  where Frame Room already uses it.
- **Corrected two stale README sections** that described behaviour since
  replaced: the "status enum is a guess" item (readiness now probes the CDN, and
  `video_status` is deliberately ignored — 1, 7 and 10 have all been seen on
  working videos), and the old upload note.
- **Documented the credential vault's security posture in the README**, which
  previously described only the memory-only session token and not the plaintext
  multi-account store on disk.
- Recorded the remaining inferred values (`model_name_default` for unverified
  models, `multi_shot`, the 2023 history floor) in one place instead of only in
  code comments.

## 0.28.0

`/image/i2i` verified. All three generate calls now match captured requests
field-for-field.

- **`model_name_default` was missing from the i2i payload** — the same gap both
  video endpoints had.
- **`model_name_default` is not derivable, and our formula was wrong.** Captures
  show `v6` → "PixVerse V6" but `qwen-image` → **"Qwen-image"**, so
  `PixVerse ${model.toUpperCase()}` was producing "PixVerse QWEN-IMAGE" — wrong
  for every image model, since none of them are PixVerse models. Replaced with a
  lookup table.
  - Verified values: `v6`, `qwen-image`.
  - Inferred: `v5`, `v4.5` (PixVerse's own naming pattern), `flux-dev`,
    `seedream` (first-letter capitalisation, following qwen-image). Worth
    replacing with captured values if a call ever rejects one — though the field
    may simply be cosmetic.

Also noted: the i2i response shape differs from the video ones (`success_ids` /
`image_id` / `fail_count`, and a `total_count` of 0 alongside a `success_count`
of 1). Nothing reads it — completion is detected by diffing the asset library —
so the inconsistency is harmless.

## 0.27.0

`/video/frames` verified against a real captured call — it was the last payload
in the extension still built on inference.

**What the inference got right:** the endpoint path, carrying both singular and
array forms (`prompt` + `prompts[]`, `duration` + `durations[]`), and the
`audio` / `preview_mode` / `off_peak` field names. Those three are always
present rather than conditional on the toggles, so the toggles were working.

**What it got wrong:**
- `customer_img_urls` were built with plain slashes; PixVerse sends the `%2F`
  form. Now uses `mediaUrlPacked()`, matching the capture exactly.
- `model_name_default` was missing entirely.

Our payload now matches the capture field-for-field and value-for-value.

Also noted from the capture: the two sources can differ in both prefix and
extension — it mixed an uploaded `.png` with an i2i-generated `.jpg` — so
nothing in the path handling may assume a shape.

With this, every generate call the extension makes (`/image/i2i`, `/video/i2v`,
`/video/frames`) is built from an observed request rather than a guess.

## 0.26.1

- **One vocabulary for generation modes on browse cards.** The archive stores two
  names for the same three things — the API's `create_mode` (`i2v`,
  `image_text`, `transition`) and the panel's own (`animate`, `frames`,
  `image`) — and which one a card showed depended on whether it came from a
  library fetch or a local job record. Since i2v and image_text are both animate
  (same endpoint, same inputs) and transition is frames, the label is now
  normalized. Unrecognized modes still show as-is rather than disappearing.

## 0.26.0

Driven by a captured `/video/i2v` request plus a paginated library response.

- **Confirmed: `image_text` generations use `/video/i2v`.** Last version inferred
  this from the payload shape; the capture proves it. `create_mode` is a label
  the backend assigns, not a separate API — so mapping image_text to Animate is
  correct, and no fourth endpoint exists to find.
- **`customer_img_url` was missing from our i2v payload.** The real call sends it
  alongside `customer_img_path`. An earlier comment claimed "no
  customer_img_urls" — true of the plural array, wrong about the singular field.
- **URLs in payloads use the `%2F` form** (`.../upload%2F<uuid>.jpg`), same quirk
  as the response URLs. Added `mediaUrlPacked()` so we match PixVerse's own
  encoding rather than sending plain slashes.
- **`multi_shot` is now passed through, not hardcoded.** The image_text capture
  sends 1; an earlier animate capture sent 0. What it switches isn't confirmed,
  so a rerun sends back whatever the original record carried and fresh
  generations default to 0 — reproducing the original without guessing at
  semantics.
- Our generated payload now matches the capture field-for-field and
  value-for-value (verified in isolation).

**Pagination validated with real data.** This is the first response seen with
`has_more: true` / `web_next_offset: 50` — the case 0.19.0's cursor fix was
written for without evidence. Replaying the real envelopes confirms it continues
at offset 50, stops when the server says done, and stops on a stalled cursor.

Also: the site's date filter uses variable windows (91 days in one capture, 31 in
another), so our fixed 90-day sweep is a free choice rather than something that
must match. And both records here carry `video_status: 1` while playing fine —
consistent with status being unusable as an existence signal.

## 0.25.0

`image_text` is **not** text-alone generation — it carries one source image plus
a prompt, the same input shape as i2v. 0.24.1's "no rerun · text mode" label was
built on that wrong assumption.

- **Fixed the field-name mismatch behind it.** i2v/transition records store their
  source under `customer_first_frame` / `customer_img_paths[]` (plural array);
  `image_text` uses the **singular** `customer_img_path`. The extractor only read
  the first two, so image_text records were archived with an empty rerun block
  and looked frameless.
- **Rerun now works for image_text**, mapped to Animate mode. No new endpoint
  needed — one source image and a prompt is exactly what i2v takes.
- **Posters fixed for the same records.** `posterFor` read the *top-level*
  `customer_img_url` (empty on image_text) and missed the nested singular one.
  It now reads the nested key, and falls back to the backend's own video frame
  grab (`first_frame`), still guarded against placeholder defaults.
- **The rerun label is now evidence-based, not name-based.** It reports what was
  actually captured — an active `rerun`, `no source image` (scanned, nothing to
  reload), or `rerun pending scan` (archived before inputs were captured) —
  rather than inferring capability from the mode string.
- **Archive migration v5** forces one more re-sweep so existing image_text
  records pick up the source image they always had.

Also: this record has `video_status: 1` and plays fine — a third distinct value
after 7 and 10, both of which also appeared on working videos. Confirms status
stays unusable as an existence signal; only a probe decides.

## 0.24.1

- **Text-to-video cards now say why there's no rerun.** An `IMAGE_TEXT` record
  matched neither branch of the rerun check, so it rendered a blank space where
  a button might be — indistinguishable from a bug. The three cases are now each
  labelled: an active `rerun`, `rerun pending scan` (frame-based, inputs not yet
  re-captured), or `no rerun · text mode`.
- Text-to-video rerun is still **not implemented**. It has no source frames, the
  panel has no text mode, and its generate endpoint hasn't been captured — so
  there's nothing to populate a rerun into. Unblocked by one captured
  text-to-video request.

## 0.24.0

Two fixes that were written up during a tooling outage and never actually
landed — one of them a bug you'd reported.

- **Rerun from browse now populates immediately.** The panel only checked for a
  stashed rerun on load and on `visibilitychange`, and clicking rerun in the
  browse tab fires neither — which is why nothing appeared until you minimized
  and restored the window (that finally triggered `visibilitychange`). The
  background now broadcasts `rerun/ready` the instant a rerun is stashed, and the
  panel applies it on receipt.
- **Submit placeholder.** After hitting Go the reel showed nothing until the
  render finished (minutes for video), so the panel looked inert. A placeholder
  tile now appears immediately with the prompt and a spinner, updates live from
  job broadcasts (`rendering…`, or `queued · N ahead` when the backend reports a
  queue), and is replaced by the finished video when it lands. A failed render
  turns the tile into a `render failed` state instead of spinning forever.

## 0.23.0

Fixes for stale credentials after logging an account out and back in — a
re-login rotates both the token and the `ai-anonymous-id`, and the vault was
serving stale pairs.

- **A new token never inherits the old anon-id.** The two are a matched set from
  one login session. The vault upsert used to fall back to the previous anon-id
  whenever a capture arrived without one — but the anon-id header isn't on every
  request, so a fresh token would get paired with a dead session's anon-id, and
  every call failed. Now the old anon-id is reused only when the token is
  unchanged; a token change forces the anon-id to null until the new session's
  is captured.
- **Capture updates on anon-id change too, not just token.** The tab entry was
  keyed on token only, so an anon-id that arrived (or changed) on a later
  request in the same session was ignored. It's now filled in without discarding
  the token.
- **Manual overrides refresh from the vault.** Picking an account in the
  switcher took a credential snapshot. If you then logged that account out and
  back in, the snapshot went stale and every call under it failed. Before
  serving an override, it's now refreshed from the vault when the vault holds
  newer credentials for that account.
- **Auto-recovery on auth failure.** If an API call fails with what looks like an
  auth rejection while on an override, the override is dropped, credentials are
  re-resolved, and the call retries once. Deliberately loose matching (code or
  message text) since the exact token-rejection ErrCode isn't captured — a false
  positive costs one extra re-resolve, a false negative would strand you on a
  dead token.

Note: the exact ErrCode PixVerse returns for a bad token isn't confirmed. If you
ever capture one, the `isAuthError` check can be tightened from a heuristic to an
exact match.

## 0.22.1

- **Fixed rerun missing on older cards.** Rerun needs source-frame data that's
  only captured by a 0.22+ library fetch — but existing records didn't have it,
  and once an account was marked "swept" it wouldn't re-fetch. So a successful
  Frames video that clearly *should* be rerunnable showed no button. Archive
  migration v4 clears the swept list, forcing every account to re-scan once and
  backfill rerun inputs. The migration now runs before the sweep decision, so it
  takes effect on the same load.
- **Cards awaiting that re-scan now say `rerun pending scan`** (muted) instead of
  showing nothing, so the absence is explained. It becomes an active `rerun`
  link once the account's re-scan reaches that record.
- **Limit worth knowing:** the re-scan can only re-fetch what the API still
  returns within its date windows. A generation the API has fully forgotten
  stays in the archive but can't gain rerun data — those keep the pending label.
- **On "N unconfirmed":** these are archive records whose mp4 a probe couldn't
  reach — the not-yet-or-failed bucket. It shrinks each load as verification
  works through the backlog (60/load), so it's partly self-healing; genuine
  failures (e.g. text-to-video that never rendered) age to hidden after 24h.
  Text-to-video (`IMAGE_TEXT`) rerun is not built — it's a fourth generation
  mode with no captured endpoint yet.

## 0.22.0

- **Rerun from the browse feed.** Each card now has a `rerun` link (when the
  source frames were captured) that loads that generation's settings into the
  compose panel — prompt, model, quality, duration, aspect ratio, seed, and the
  source frame(s). It doesn't submit; you tweak and generate.
- **Mode is detected per record.** Not everything is first+last-frame — the
  archive now stores each generation's inputs and maps `create_mode` to the
  right panel mode: `transition` (or any two-source generation) → Frames, a
  single-source generation → Animate. So a rerun lands in the correct mode with
  the correct number of frame slots filled.
- **Cross-tab + cross-account aware.** Browse is a separate tab and can't touch
  the panel's form directly, so a rerun is stashed and the panel picks it up on
  open or focus. If the generation belongs to a different account than the active
  one, the panel offers to switch first (the source frames live on that account's
  storage) using the credential vault.
- Records archived before this version have no stored inputs and show no rerun
  link; they gain one once re-seen by a library fetch.

## 0.21.2

- **Quieted false errors in the extension Errors tab.** The
  `direct load failed … trying fetch` message (and the fetch-recovery steps
  around it) fired at `warn`/`error` level for *every* video — but they're the
  normal path: the CDN blocks direct `<video src>` loads, so the blob-fetch
  fallback runs on all of them and almost always succeeds. Logging routine
  recovery as warnings made healthy playback look broken. Those steps are now
  `console.debug` (gated behind an `FR_DEBUG` flag, off by default) so they stay
  out of the Errors tab; only a genuine give-up after all retries remains a
  `console.error`. Same change applied to the browse feed.

## 0.21.1

- **Fixed cards seating too high in the browse feed** — a long-standing offset
  where each card sat ~44px under the fixed header. `scroll-snap` snaps to a
  card's edge ignoring the container's top padding, so the header covered the top
  of every card. Added `scroll-padding-top` so snapping accounts for the header.
- **Fixed the star (and index badge) being clipped off the top.** They were
  positioned on `.stage`, which overflows its bounds (`overflow: hidden` on a
  taller-than-visible element), so on portrait videos they sat above the visible
  area — compounded by the snap offset above. Moved both onto `.card`, which is
  viewport-sized and stable, and nudged their insets to align with the stage
  corners.

## 0.21.0

- **Per-account credential vault + switcher.** Tokens (and the `ai-anonymous-id`)
  are now saved per account, keyed by username, as they're captured. The account
  pill in the panel header is a dropdown: it lists every saved account, switches
  to one on click, shows days-to-expiry, and lets you forget one. Switching sets
  the chosen account's token as active for all generation and library calls.

  **Security, stated plainly:** these are live bearer tokens stored in
  **plaintext in `storage.local`** — on disk, surviving restarts (which is the
  point: painless switching across 4–5 logins). Anyone with access to this
  machine or the extension can read every stored token and act as those accounts
  until each expires. This is a deliberate, user-requested trade.

- **Manual override beats tab-following.** Normally the active token follows the
  focused PixVerse tab. Picking an account from the switcher sets an override
  that takes precedence — otherwise the next request would snap back to whatever
  tab is focused. The override clears automatically if its token expires, or when
  you forget that account, falling back to tab-following.

- Only tokens that decode to a username are stored (a nameable account), expired
  entries are hidden from the switcher, and token rotation updates in place
  rather than creating duplicates.

## 0.20.0

- **Star button on every browse card.** Tap ☆ to star, ★ to unstar. The state
  lives on the archive record (keyed by mp4 basename), so a star persists across
  reloads and account switches like everything else in the archive. Toggling is
  optimistic — the UI flips immediately and reverts only if the write fails.
- **"Starred" filter** in the header, composable with the account filter — e.g.
  starred videos from one account. Empty starred view shows a hint rather than a
  blank feed.
- The star write survives archive re-merges: `starred` is a user field, so a
  later API sighting of the same record never clears it.

## 0.19.0

Three fixes from the network trace and the 90-day filter capture.

### Browse was slow (~25s to first paint)
`verifyPending` probed 24 URLs sequentially at ~1s each before the page rendered
anything — visible in the trace as a column of `background.js` fetches one after
another. Now probes run 8-at-a-time via a `mapLimit` helper (~25s → ~3s), and
the per-load cap is raised 24 → 60 since parallelism affords it.

### Pagination ignored the server's cursor
`listAssets` discarded the response envelope and inferred "done" from a short
page, while re-sending `web_offset: 0` on every request. Two failure modes: an
early stop that silently dropped older records when a page came back short with
more remaining, and a possible infinite request loop if `web_offset` is the
operative cursor. It now reads `web_has_more` / `web_next_offset` and advances
the cursor, with three independent stop conditions (server says done, cursor
stalls, or a page adds nothing) so a runaway loop can't happen.

### The list endpoint has a date filter we never sent
Captured from the site: `filter: { start_time, end_time }` in Unix seconds — its
date picker sends a 90-day window. Omitting it lets the server apply its own
default window, the most likely reason old generations stopped appearing (their
files still resolve — they were just outside the default range).
- New loads fetch only the recent 90-day window (fast).
- The **full history is swept once per account** in backward 90-day windows,
  down to a 2023 floor (override with `since` = when the account started).
  Subsequent loads skip it — the archive already holds what the sweep found.
- `forceDeep` message flag re-runs the sweep on demand.
- Header shows `full history scanned` when a deep pass ran.
- Verified in isolation: the windowed sweep captures assets spanning multiple
  windows with no duplicates.

This meaningfully changes the archive's role — much of what the API "forgot" is
recoverable directly, not just from whatever the archive happened to catch.

## 0.18.0

- **Fixed accounts being cross-tagged onto every record.** The filter showed
  45/46/45/46/45 across five accounts against a 47-record archive — arithmetically
  impossible, and account 185's library actually holds 17. Cause: local job
  records name no account, so `archiveMerge` fell back to whoever was signed in,
  and since accounts accumulate into a set, browsing under five logins stamped
  all five onto every local record.
  There is no fallback now. A record is tagged only when it names an account
  itself, and an unknown account stays unknown.
- **Jobs record their account at creation.** Reading it at merge time was always
  wrong — by then the session may belong to a different login.
- **Migration (archive v3) clears every existing account tag.** A correct tag
  and a guessed one are indistinguishable after the fact, and a wrong tag is
  worse than a missing one when filtering by it is the whole point. Tags
  repopulate from library payloads, which are authoritative — so browsing each
  account once restores correct attribution.
- **`unattributed` bucket in the filter** so records without an account (jobs
  from before this version, or whose library hasn't been browsed since) stay
  reachable instead of being stranded outside every option.

Expect the filter to look sparse right after upgrading: tags are cleared, and
each account's share reappears as you browse under it.

## 0.17.0

- **Nothing is filtered out of the browse feed.** Queued, still-rendering, and
  failed generations all get captured and shown. If the webp gives us a
  filename, the record is kept. A card that won't play at least tells you the
  generation existed; a hidden one tells you nothing, and missing a past render
  is the worse outcome. Failures are rare enough that a few dead cards are the
  better trade.
- The only remaining skip is a record with no `webp_url` to derive a filename
  from — there's genuinely nothing to store in that case.
- Cards say which state they're in — `unreachable` (probes keep failing) vs
  `unconfirmed` (not yet verified) — and a card that can't load explains whether
  it's likely still rendering or likely failed, rather than reading as a bug.
- Header reports unreachable as a count, not as "hidden", since nothing is.
- Per-fetch ceiling raised 300 → 1000. The archive only grows from what we
  manage to read, so truncating there would permanently lose old generations
  once the API stops listing them. Paging still stops on the first short page.

## 0.16.1

Correction to 0.16.0 — the `video_status` inference was wrong and would have
cost you videos.

- **`video_status` no longer decides anything.** 0.16.0 treated status 7 as
  failure and retired those records on a single failed probe. But a record with
  status 7, a placeholder `url` and an empty `video_path` had a perfectly good
  mp4 at the webp-derived path — so the status is not evidence, and acting on it
  would have permanently hidden valid renders. Only an actual probe decides now;
  the status is still stored, just not acted on.
- **`mediaExists` no longer trusts a bare HEAD.** A non-OK HEAD is now confirmed
  with a one-byte ranged GET before concluding the file is missing. Object
  stores can reject or mis-answer HEAD while serving GET fine, and a false
  negative there retires a good render.
- **Being marked unreachable is no longer permanent.** Those records are
  re-probed daily and revert to normal the moment one answers — the header
  reports how many recovered. The threshold before marking unreachable also went
  6h → 24h, since queues can be long.
- **One-time archive migration.** Every record previously marked gone is reset
  to unverified so it gets re-probed rather than staying hidden on the strength
  of a bad inference, and the `default` entry (from the placeholder basename
  collision) is deleted.

## 0.16.0

Driven by a payload from a second account (`video_status: 7`, `url` pointing at
`pixverse-preview/mp4/media/default.mp4`, empty `video_path`).

- **Accounts are tagged from the record, not the session.** Records were being
  filed under `auth.username` at fetch time, so anything pulled while the token
  lagged an account switch got the wrong label — which also made a per-account
  filter impossible to trust. The payload carries `nick_name` / `email` /
  `account_id`, so tagging is now per-record and correct regardless of which
  account is signed in.
- **Filter by account** in the browse header — appears once the archive holds
  more than one, with a per-account count. Re-rendering tears down properly
  (disconnects the observer, revokes blobs, detaches the active video), so
  switching filters repeatedly doesn't leak a decoder each time.
- **Placeholder assets are rejected outright.** The backend fills `url` and
  `first_frame` with shared defaults (`.../media/default.mp4`,
  `.../media/default.jpg`) when there's no real output. Every one of those has
  the basename `default`, so they'd have collapsed into a single archive entry
  and clobbered each other. Now filtered from video URLs, image URLs, posters,
  and local job records.
- **Known-failed generations retire immediately.** `video_status: 7` (seen with
  a placeholder url and empty `video_path`) is treated as failure on the first
  probe rather than being retried for six hours. Status is stored per record;
  anything other than the two observed values still gets the time-based
  treatment.

## 0.15.1

Two bugs, one of which was destroying the session.

- **Opening Browse could log you out.** `tokensByTab` lives in the service
  worker's memory, and MV3 terminates that worker after ~30s idle. On restart
  the map is empty — which was indistinguishable from "signed out", so
  `publishActiveAuth` deleted the stored token. Opening Browse (a new tab, and
  an extension page that carries no token of its own) reliably triggered it,
  giving `library call failed — archive only`.
  The map is now persisted to `storage.session` and rehydrated on worker start,
  and an empty lookup **never** clears stored auth — the active tab simply isn't
  always a PixVerse tab, and that's not evidence of anything.
- **Browse never got the blob rescue.** That's the whole reason the side panel
  played videos while the feed showed `could not play`: the panel fetches the
  bytes and plays from a blob, whereas Browse only swapped URL spellings and
  gave up. It now falls back to the same fetch-then-blob path.
  The memory model is preserved — exactly one blob is alive at a time, and
  `detach()` revokes it alongside clearing the video src.
- A blob that itself fails to decode is now reported as a genuine media error
  rather than sending it back around the fallback chain.

## 0.15.0

Three corrections from observed behaviour, plus the archive.

### There is no webp file
`webp_url` is a placeholder emitted alongside every generation; fetching it
404s. Its only value is that its basename matches the mp4's, and unlike
`url`/`video_path` it's constructed rather than looked up — so it never points
at a placeholder video. We use it purely as a filename carrier.
- **Posters repointed.** The browse feed used the webp as a lazy `<img>` poster
  on every card — those would never have loaded. Posters now use the
  generation's own source frame (`customer_first_frame_url` /
  `customer_img_urls`), which are real uploaded files. Text-to-video has none,
  and those cards simply have no poster.
- Local records written by 0.11–0.13 stored a webp URL as their thumb; that's
  now filtered out rather than rendered as a broken image.

### A derivable URL is not a finished render
Both `url` and `webp_url` come back the instant a job is submitted, before any
file exists. The job may queue first, and the site's progress percentage is
theatre — it parks at 95%, and the file is sometimes fetchable before it claims
100%. Readiness was returning true at submit time, so the reel rendered tiles
pointing at nothing, probed once, and froze `HTTP 404` on them — while OPEN
worked, because by then the render had finished.
- Completion is now decided by actually probing the CDN (`HEAD`, falling back to
  a one-byte ranged `GET`).
- Video timeout raised 8 → 25 min to allow for queueing. **Caveat:** an MV3
  service worker can be terminated during a long wait; the job then shows as
  timed out, but the render still completes server-side and appears via Browse.
- Queue position is surfaced when the backend reports one, so a long silence
  doesn't look like a hang.
- Panel tiles retry a 404 with backoff (8s/20s/45s/90s) instead of freezing the
  first result.

### The archive
A persistent local store of every generation seen, keyed by mp4 basename.
- **Survives the API forgetting.** Old generations drop off the listing while
  their files stay downloadable; the archive keeps them.
- **Spans accounts.** `storage.local` isn't cleared on account switch, so
  libraries from several logins consolidate, each record tagged with where it
  was seen. Cards show the account; the header shows the account count.
- Nothing is pruned. A record verified present stays verified. Records still
  missing six hours after first sighting are marked `gone` (a failed
  generation, which 404s forever) and hidden, so they stop costing a probe on
  every load.
- Verification is bounded to 24 least-recently-checked records per load.
- Browse now reads the archive; the live listing only ever adds to it.

Two defaults chosen, both easy to change: accounts are **merged with a label**
rather than filterable, and unconfirmed items are **shown and marked** rather
than hidden — a fresh generation vanishing would look like data loss.

## 0.14.0
- **Both URL spellings are now tried.** I'd been decoding `%2F` → `/` on the
  assumption the clean path is correct — but Chrome's address bar does *not*
  decode `%2F` when navigating, so "it played when I pasted it in a tab" never
  actually confirmed which spelling the CDN wants. The panel and the browse feed
  now try the plain-slash and `%2F` forms in turn and use whichever answers.
  Verified both spellings are generated from either starting form.
- **All logging is plain strings.** `chrome://extensions` renders a logged
  object as `[object Object]`, which hid the HTTP status in exactly the error
  that mattered (`media fetch failed` was the `!res.ok` branch — the status was
  captured and then made unreadable). Statuses, URLs, and blob sizes are now
  interpolated into the message.
- A successful blob recovery logs the content type and byte size, so a 200 that
  still won't play (i.e. a genuine codec problem) is distinguishable from a
  transport problem.
- Dropped the noisy `play() rejected` warning — the error handler beside it
  already does the recovery, so it was reporting a failure that gets fixed
  microseconds later.

## 0.13.1
- **Fixed duplicate cards in the browse feed.** The same asset can arrive as two
  different strings — `.../pixverse%2Fmp4%2F...mp4` from the API and
  `.../pixverse/mp4/...mp4` from our derivation — and the merge keyed its dedupe
  map on the raw URL, so they never collided. Dedupe now runs on a canonical
  form (slashes decoded, query/hash dropped, so a signed variant still matches
  its plain twin).
- Root cause was on the local side: `mp4FromWebp(thumb) ?? r.url` fell through
  to `r.url` for records written before 0.11, which stored the `%2F` form. That
  fallback is now decoded, so old records both play correctly *and* match.
- Added a second dedupe guard to the API pagination loop, keyed on URL. The
  existing guard used asset id alone, so an item without one would slip through
  and appear twice on page overlap.

## 0.13.0
- **Browse feed now merges two sources**: the API library listing *and* this
  extension's own job records. Generations the list call misses — which is the
  case that motivated this — still show up, tagged `local only` in the card
  metadata so you know they won't appear on the website's library page either.
- **Old local records are retroactively cleaned.** Records written before 0.12
  stored a URL built from `url`/`video_path`, which can be a placeholder. They
  also stored `thumb` (the webp), so the mp4 is rebuilt from that instead —
  nothing on disk is rewritten, the correction happens on read.
- Dedupe is by URL. Since every URL is now derived deterministically from the
  webp basename, the URL *is* a stable identity — no id-matching across sources
  that number assets differently.
- When an asset appears in both sources, the library record wins but local fills
  any gaps (prompt, model, quality, duration, seed), since job records carry the
  params you generated with and the list payload doesn't always include them.
- **A failed library call no longer empties the feed** — local records still
  render, and the header says the listing is partial rather than showing zero.
- Header shows a source note (e.g. `3 local-only`) so a count differing from the
  website isn't a mystery.

## 0.12.0
- **Video URLs are now derived from `webp_url` only.** `url` and `video_path`
  are no longer read at all: when the backend can't find the real asset (more
  common on accounts with a lot of generations) it fills those fields with a
  PixVerse placeholder video, so you silently get the placeholder instead of
  your render, with no error to catch. `webp_url` is built from the asset's own
  basename — it either points at your render or isn't there.
  Verified: an item with a placeholder in *both* `url` and `video_path` still
  resolves to the correct mp4.
- Consequence, accepted deliberately: an asset whose webp hasn't been written
  yet resolves to `null` and counts as not-ready, so polling keeps waiting and
  the browse feed skips it. A missing URL is recoverable; a wrong one isn't.
- `isReady()` is now tab-aware — videos gate on the webp, images on their own
  URL fields (they have no webp preview).
- Removed the `URL_KEYS` fallback list entirely, so no code path can reach for
  the placeholder-prone fields by accident later.
- Panel skips any result without a resolvable URL rather than setting a null
  `src`.

## 0.11.0
- **Browse all** button under the reel — opens a full-viewport, scroll-snap
  reels feed (`browse.html`) in a new tab with your whole video library.
- **Memory discipline in the feed** (the design constraint, not an afterthought):
  every card shows only a lightweight animated `webp` poster; `<video>` elements
  carry **no `src`** until their card takes focus. On losing focus we pause,
  strip the `src`, and call `load()` — which is what actually releases the
  decoder and buffers; `removeAttribute` alone doesn't. Exactly one video holds
  a src at any moment. Posters are `loading="lazy"`, and playback stops when the
  tab is hidden.
- Keyboard: ↑/↓ (or j/k) to move, space to pause. Click anywhere to pause.
- **Fixed the video-playback bug for real this time.** The asset payload showed
  the API returns URLs with slashes already percent-encoded
  (`.../pixverse%2Fmp4%2F...mp4`), and `assetUrl()` passed absolute URLs through
  untouched — so `<video src>` got the `%2F` form and failed with code 4, while
  the same URL played in a tab because the address bar decodes `%2F`. URLs are
  now decoded on the way in. (0.8.1 fixed encoding on *our* side; the encoding
  was coming from the server.)
- **`webp_url` fallback**: when a list item's `url` is empty, the mp4 URL is
  derived from the webp preview — same basename, `webp/media/web/<name>.webp` →
  `mp4/media/web/ori/<name>.mp4`. Resolution order is `video_path` → `url` →
  webp-derived. Verified all three converge on the same URL.
- **Fixed `customer_paths` handling in the picker.** It's an object
  (`{ customer_img_paths: [...], customer_first_frame, ... }`), not an array;
  the old `customer_paths?.[0]` was always undefined. Both shapes now handled.
- **Fixed `isReady()`**, which guarded on a `status` field that doesn't exist —
  the real field is `video_status` (observed: `10` on a finished render). It now
  keys off whether a playable URL can be resolved.

## 0.10.0
- **`rerun` button on every tile**, replacing `copy url`. Loads that render's
  full settings back into the form — mode, prompt, model, quality, ratio or
  duration, count, seed, audio/preview toggles, and the source frame(s). It
  deliberately **does not submit**: you get the exact setup to tweak, then fire
  it yourself.
- The seed comes back too, so an untouched rerun reproduces the original — hit
  reroll for a variation on the same settings.
- Job records now persist the full `params` (previously only `prompt` and
  `seed`, which wouldn't have been enough to restore anything). Renders made
  before this version have no stored params, so their tiles show `open` only.
- `useFrame` can now target a slot explicitly and skip its load-probe; rerun uses
  that, since a path from a generation that actually ran is valid for the API
  even when the CDN won't serve a preview.
- Switching mode via rerun only reloads the reel when the mode actually changed,
  so a same-mode rerun doesn't rebuild every tile and re-fetch its blob.
- `open` stays, so the file URL is still one click away.

## 0.9.1
- **Video tiles now fall back to fetching the bytes themselves.** The panel
  console finally named the failure: `play() rejected: Failed to load because no
  supported source was found` — `MediaError` code 4. That code is returned
  identically for CSP blocks, CDN hotlink protection, and redirects to a
  non-allowlisted host, which is why guessing between them (0.8.0, 0.8.1) kept
  missing.
  Now: if the direct `<video src>` load fails, the panel `fetch()`es the URL
  (extension pages hold `host_permissions` for `media.pixverse.ai`, so that
  request is CORS-exempt), wraps the response in a blob URL, and retries. CSP
  updated to allow `blob:` for `media-src`/`img-src`.
- If the fetch itself fails, the tile shows the **real HTTP status** (e.g.
  `HTTP 403`) instead of a generic media error — an actual diagnosis rather than
  another symptom.
- Object URLs are revoked when the reel re-renders, so blobs don't accumulate.
- The open/copy URL controls stay put through all of this.

## 0.9.0
- **Reel capped at 6 renders** (`REEL_LIMIT` at the top of the reel section —
  change the number there to adjust). Results are flattened newest-first across
  jobs and sliced, so the cap counts *renders*, not jobs — a `create_count: 4`
  job fills four of the six slots.
- When more exist, the heading reads `Renders · 6 of N` so it's clear nothing was
  deleted — older records are still held by the worker (last 60), just not drawn.
- Side effect: fewer `<video>` elements created, so the panel stops loading media
  for tiles that aren't on screen.

## 0.8.2
- **Every render tile now shows its URL — open + copy — always, even when
  inline playback fails.** The on-hover-only `<video>` from earlier builds at
  least gave a right-click "Copy URL"; the 0.8.0/0.8.1 error tiles replaced the
  element entirely and took the URL with it. That was a regression in the one
  thing that had to keep working. Now: the media element renders when it can, a
  failed video just dims (`is-broken`) instead of being removed, and an "open /
  copy url" bar sits under every tile regardless. The URL is never out of reach.
- A failed video still logs its `MediaError` code + `src` to the panel console
  for diagnosis, but no longer costs you access to the file.

## 0.8.1
- **Fixed the actual cause of blank videos: mangled URLs.** Result URLs were
  built with `encodeURIComponent()` on the whole storage path, turning every `/`
  into `%2F` — so the CDN got a request for a file literally named
  `pixverse%2Fmp4%2F…mp4` and 404'd. (It played on copy-paste because the address
  bar decodes `%2F` back to `/`; a `<video src>` doesn't.) Now each path segment
  is encoded but the slashes are preserved, and absolute URLs pass through
  untouched. Same fix applied to the panel's paste-a-path preview helper.
- This supersedes the 0.8.0 theory — autoplay/CSP weren't the problem (though
  those changes are correct and stay). The URL was broken before the element
  ever tried to load it.

## 0.8.0
- **Fixed blank video tiles in the reel.** Videos rendered as empty rectangles
  (URL was valid — an `.mp4` that played in a new tab — but the `<video>` never
  painted). Two causes addressed:
  - The element was `muted` + `loop` and played only on hover, with no
    `autoplay`/`playsinline`/`preload`/poster, so nothing ever triggered a load.
    Now: muted + autoplay + `playsInline` + `preload="metadata"`, with a nudging
    `play()` call. Tiles paint frame one without a hover.
  - Added an explicit `content_security_policy` with `media-src` (and `img-src`,
    `connect-src`) allowing `media.pixverse.ai`. The panel's default CSP can
    block video from the CDN even while images from the same host load.
- Video tiles now show a visible "video failed to load" state on a real media
  error instead of a silent black box.

## 0.7.1
- Removed the "credit total may not match the site header" caveat from 0.7.0 —
  it was based on comparing two different accounts' numbers (the `30` header and
  the credits JSON came from separate accounts). The bucket sum is a correct
  reading; no reconciliation needed. Tooltip and docs simplified accordingly.

## 0.7.0
- **Live credit balance** in the header, from `GET /user/credits`. The response
  has no single balance field — the chip sums the spendable buckets
  (`credit_daily + credit_monthly + credit_package`) and the hover tooltip breaks
  each out, plus `renewal_credits` (added at renewal, not spendable now).
- `apiFetch` now supports GET (no body); the page-relay fallback carries the
  method too.
- Balance auto-refreshes when a render finishes (worker sends a `credits/stale`
  nudge).

## 0.6.0
- **Added Animate mode (`/video/i2v`)** — single image → video. Payload matches
  a real captured call field-for-field: `customer_img_path` (singular),
  `multi_shot: 0`, `model_name_default` derived as `PixVerse <MODEL>`, and
  crucially *none* of the fields i2v doesn't send (no `customer_img_urls`, no
  `prompts[]`, no `audio`/`preview_mode`).
- **Mode switch is now three tabs**: Image / Animate / Frames (was Image /
  Video). "Frames" is the old first+last-frame flow, unchanged.
- Job records now carry `mode` + `output` instead of a two-value `kind`; the
  reel filters and renders by media type. Old records still display via a
  fallback.
- **Animate deliberately has no audio/preview toggles.** The create dialog shows
  them, but the captured i2v call omitted both fields (they were off), so the
  real field names for i2v-with-audio are unknown. Left out rather than guessed.
  To add them: capture a `/video/i2v` call with audio/preview ON and read the
  field names.

## 0.5.1
- Show the version in the header, read from `chrome.runtime.getManifest()` so it
  can't drift from the manifest.

## 0.5.0
- **Full i2i aspect-ratio set**: added 5:4, 4:5, 3:2, 2:3, 21:9 (was five ratios).
- **Per-mode quality lists**: image offers 720p/1080p, video keeps
  360p/540p/720p/1080p. Quality dropdown is now populated in `setMode()`
  alongside models rather than hardcoded, so it always matches the active mode.

## 0.4.0
- **Per-tab token binding.** Tokens are keyed by `tabId`; the panel binds to the
  active PixVerse tab's token and re-points on tab/window switch. Fixes the
  incognito↔normal account-mask bug where the last tab to poll won.
- **Removed `content.js` entirely.** It was superseded by webRequest capture and
  had become actively harmful — its `auth/found` handler wrote straight to
  session storage, bypassing the per-tab map and re-introducing the cross-account
  race. Manifest `content_scripts` block and the handler both removed.
- `"incognito": "spanning"` so one extension process sees both normal and
  incognito tabs (still requires "Allow in Incognito" to be ticked).

## 0.3.0
- Full **1s–15s duration** range (was 5s/8s only).
- **Audio** and **Preview Mode** toggles for video, wired to the real
  `audio` / `preview_mode` params (were hardcoded to 0). Both surface in the
  ready-line readout.

## 0.2.0
- **webRequest token capture** replaced localStorage scraping. Fixes "Not
  linked" when the PixVerse tab predated the extension or stored its token
  somewhere a content script couldn't reach.
- **Frame preview** for the manual input: paste a storage path *or* a full image
  URL and it renders in the slot. Image is preloaded before commit, so a bad
  path fails visibly instead of sitting blank.

## 0.1.0
- Initial MV3 side panel: image (i2i) and video (first/last-frame i2v) modes,
  library picker, job queue with library-diff readiness detection, single-line
  readout, worker-side transport (CORS-exempt) with an optional page-relay
  fallback for origin checks.

## Known issues / not yet done
- **Per-run cost isn't shown yet.** `credit_change` in the request is
  client-sent and server-overridden, so it's not a reliable price. A real cost
  estimate needs the pricing rule (which the site applies client-side to render
  the number on its Create button) — capturable from the JS or inferable by
  watching the balance move across a few runs.
- **Upload isn't implemented.** Frames come from your library or a pasted path.
  The i2v capture shows the target shape (`customer_img_path: "upload/<uuid>.jpg"`,
  and the newer picker placeholder suggests `upload/2026/<uuid>...`). Reversing
  it: drop an image with the Network tab open and find the two-step
  (credentials/token call → PUT to object storage) that yields that path.
- **`frames` payload is inferred, not captured.** `customer_img_urls`,
  `prompts[]`, `off_peak`, and the audio/preview field names are guesses.
  Animate (i2v) *is* captured and exact; frames is not. Verify against a real
  `/video/frames` call before relying on it.
- **`isReady()` is a heuristic** ("has a URL" = done). Pin the real status enum
  from DevTools for faster completion and failed-vs-pending distinction.
- **Option validity isn't enforced.** The panel lets you pick any
  model/quality/duration/audio combination and leans on the server to reject
  invalid ones. The site greys out invalid combinations; replicating that needs
  the dependency matrix.
- **`MODELS` list is a placeholder.** Read the real model options off the site.
- **Page-transport mode picks the first PixVerse tab**, which in a multi-account
  setup may not match the active account. Fine while `TRANSPORT === 'worker'`
  (the default); revisit if you switch to `'page'`.
