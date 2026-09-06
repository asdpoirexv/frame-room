/**
 * flag-probe — find which field marks an asset as policy-flagged, WITHOUT
 * showing anyone your library.
 *
 * NOT a node script. Paste it into the Frame Room service worker console:
 *   chrome://extensions -> Frame Room -> "Service worker"
 * It uses the token already in the vault, so you do not need a PixVerse tab open
 * and you do not need to be signed in on the site.
 *
 * WHY IT EXISTS
 * -------------
 * NOTES 1.14l establishes that moderation is applied AFTER a render completes:
 * the file lands on the CDN and is then flagged. NOTES 1.14m found the three
 * fields in the raw library record that could carry that flag —
 * `media_locked`, `is_hidden`, `block_remake` — but could not tell which,
 * because the account available at the time held one clean asset and nothing
 * flagged to compare against.
 *
 * One request from an account that HAS flagged assets settles it.
 *
 * WHAT IT PRINTS, AND WHAT IT REFUSES TO PRINT
 * --------------------------------------------
 * Output is a whitelist, not a redaction pass, because a denylist is only as
 * good as the list. It prints:
 *
 *   - field NAMES
 *   - values only when they are boolean, null, or a number under 1e6
 *   - counts
 *
 * Anything else — every string, every object, every array — is reported as its
 * type and nothing more. So prompts, URLs, paths, emails, nicknames, account
 * ids, seeds and asset ids cannot appear in the output even by accident, and
 * you can verify that by reading `safe()` below rather than trusting this
 * comment.
 *
 * The result is a line like:
 *
 *   media_locked      clean: {0: 40}      flagged: {1: 37, 0: 3}
 *
 * which is the answer, and which says nothing about what you generated.
 */

(async () => {
  const API = 'https://app-api.pixverse.ai/creative_platform';

  // The vault already holds a token for whichever account is active.
  const { auth } = await chrome.storage.session.get('auth');
  if (!auth?.token) {
    console.log('No token in session. Open the panel once, then re-run.');
    return;
  }

  const list = async (statuses) => {
    const res = await fetch(`${API}/asset/library/list`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        token: auth.token,
        'workspace-id': '0',
        'x-platform': 'Web',
        'ai-anonymous-id': auth.anonId ?? '',
      },
      // video_status is a whitelist filter (NOTES 1.14m).
      body: JSON.stringify({
        tab: 'video', asset_source: 1, offset: 0, limit: 50,
        filter: { video_status: statuses },
      }),
    });
    const j = await res.json();
    if (j?.ErrCode) { console.log('API said:', j.ErrMsg); return []; }
    return j?.Resp?.data ?? [];
  };

  // The whole privacy guarantee lives here. Read it before running this.
  const safe = (v) => {
    if (v === null || typeof v === 'boolean') return v;
    if (typeof v === 'number') return Math.abs(v) < 1e6 ? v : '<big number>';
    return `<${Array.isArray(v) ? 'array' : typeof v}>`;
  };

  const tally = (rows, field) => {
    const counts = {};
    for (const r of rows) {
      const k = JSON.stringify(safe(r[field]));
      counts[k] = (counts[k] ?? 0) + 1;
    }
    return counts;
  };

  const groups = {
    clean: await list([1]),
    flagged: await list([7]),
    failed: await list([8]),
  };

  console.log('counts:', Object.fromEntries(
    Object.entries(groups).map(([k, v]) => [k, v.length]),
  ));

  if (!groups.flagged.length && !groups.failed.length) {
    console.log('No status-7 or status-8 assets on this account — nothing to compare.');
    return;
  }

  // Every field seen anywhere, then only those that actually differ between a
  // clean asset and a flagged one. A field that reads the same in both is not
  // the flag.
  const fields = new Set();
  for (const rows of Object.values(groups)) {
    for (const r of rows) for (const k of Object.keys(r)) fields.add(k);
  }

  const differs = [];
  for (const f of [...fields].sort()) {
    const row = Object.fromEntries(
      Object.entries(groups).map(([g, rows]) => [g, tally(rows, f)]),
    );
    const shapes = Object.values(row).map((c) => JSON.stringify(Object.keys(c).sort()));
    if (new Set(shapes).size > 1) differs.push({ field: f, ...row });
  }

  console.log(`${differs.length} fields differ between clean and flagged:`);
  console.table(differs);
  console.log(
    'Paste the table. It contains field names, small numbers and booleans only — '
    + 'no prompts, urls, ids or account details.',
  );
})();
