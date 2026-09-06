/**
 * credit-ledger — what does a generation actually cost, including the ones that
 * fail?
 *
 * NOT a node script. Paste it into the Frame Room service worker console:
 *   chrome://extensions -> Frame Room -> "Service worker"
 *
 * WHY
 * ---
 * The cost of a REJECTED submit is not knowable from the outside. Observed
 * behaviour: i2i appears to charge, frames sometimes charges and sometimes does
 * not, and no amount of watching the number by hand across a few tries
 * separates those cases from the daily refresh and from other jobs on the same
 * account.
 *
 * So `run()` now records the balance immediately before submitting, immediately
 * after the submit is accepted, at failure, and at settle. This reads those back
 * and groups them. A few dozen real jobs and the pattern is measured rather than
 * argued about.
 *
 * THE DELTA IS NOISY, AND THAT IS HANDLED RATHER THAN IGNORED
 * -----------------------------------------------------------
 * The balance moves for reasons that have nothing to do with a given job: the
 * daily credit refresh, another tab generating, another Frame Room job on the
 * same account. Only jobs that had the account to themselves at submit time
 * (`soloAtStart`) can have a delta attributed to them, so those are reported
 * separately and everything else is reported as unattributable. A confident
 * average over contaminated samples would be worse than no number.
 *
 * Nothing here leaves the machine, and it prints no prompts.
 */

(async () => {
  const { jobs = [] } = await chrome.storage.local.get('jobs');
  const withLedger = jobs.filter((j) => j.creditsBefore != null);

  console.log(`${jobs.length} jobs stored, ${withLedger.length} with a credit reading.`);
  if (!withLedger.length) {
    console.log('None yet — the ledger only records jobs run since this build. Generate a few.');
    return;
  }

  const solo = withLedger.filter((j) => j.soloAtStart);
  const contended = withLedger.filter((j) => !j.soloAtStart);

  // Submit cost: before -> immediately after the submit call returned.
  // A job that threw at submit has no creditsAfterSubmit, so its failure
  // reading stands in — that is precisely the rejected-submit case.
  const submitDelta = (j) => {
    const after = j.creditsAfterSubmit ?? j.creditsAtFailure;
    return after == null ? null : after - j.creditsBefore;
  };
  const totalDelta = (j) => (j.creditsFinal == null ? null : j.creditsFinal - j.creditsBefore);

  const rows = solo.map((j) => ({
    mode: j.mode,
    model: j.params?.model ?? '',
    quality: j.params?.quality ?? '',
    duration: j.params?.duration ?? '',
    count: j.params?.count ?? 1,
    outcome: j.state,
    // Rejected at submit, versus ran and then failed. The distinction is the
    // whole point: only the first could ever have been avoided by a pre-check.
    rejectedAtSubmit: j.state === 'failed' && j.creditsAfterSubmit == null,
    error: j.error ? String(j.error).slice(0, 60) : '',
    atSubmit: submitDelta(j),
    total: totalDelta(j),
  }));

  console.log('\nAttributable jobs (account was idle at submit):');
  console.table(rows);

  // The question that started this.
  const rejected = rows.filter((r) => r.rejectedAtSubmit && r.total != null);
  if (rejected.length) {
    const byMode = {};
    for (const r of rejected) {
      (byMode[r.mode] = byMode[r.mode] ?? []).push(r.total);
    }
    console.log('\nDoes a REJECTED SUBMIT cost credits?');
    for (const [mode, deltas] of Object.entries(byMode)) {
      const charged = deltas.filter((d) => d < 0);
      console.log(
        `  ${mode}: ${deltas.length} rejected, ${charged.length} charged`
        + (charged.length ? ` (${[...new Set(charged)].join(', ')})` : ' — all free'),
      );
    }
  } else {
    console.log('\nNo rejected submits recorded yet on an idle account.');
  }

  if (contended.length) {
    console.log(
      `\n${contended.length} job(s) excluded: another job was running on the same `
      + 'account, so their deltas cannot be attributed. Not a defect — run jobs one '
      + 'at a time per account if you want more usable samples.',
    );
  }
})();
