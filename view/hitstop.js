// Impact hit-stop: on a landed hit the world sits still for a few frames, so
// the frame the damage happened on is the frame the eye gets to keep. Render
// layer only - the sim is never told anything; main.js simply does not call
// advance() while the hold is on, the same way a pause does not.
//
// DOM-free and clock-free on purpose, like session.js: it is handed the frame
// delta and whether the round is PLAYING, so the timings nobody can reproduce
// by hand - a pause landing mid-hold, a kill on the same step as the hit - are
// ordinary unit tests.

// ~3 held frames at 60 Hz (4 rendered still, counting the trigger frame's own
// render), so about 67 ms between sim steps. The ledger marks anything over
// 0.1 s an owner call; this stays a third under that line, and the tests
// assert the margin so a retune cannot drift over it unnoticed.
export const HITSTOP_TIME = 0.05;
export const HITSTOP_CAP = 0.1;

export function makeHitStop() {
  return { t: 0, holding: false, released: false };
}

/**
 * Arm the hold. The overwrite IS the retrigger policy, and it is safe by
 * construction: the sim does not step while the hold is on, so a second hit
 * cannot even be generated mid-hold. The only same-instant retrigger is two
 * hit events out of one fixed step, and overwriting with the same value is a
 * no-op. A hit landing on the first step after a release starts a fresh hold,
 * which is the right reading: each hit gets its beat.
 */
export function hitStopTrigger(s) {
  s.t = Math.min(HITSTOP_TIME, HITSTOP_CAP);
}

/**
 * One frame of bookkeeping, mutating `s` in place because the loop allocates
 * nothing. `holding` = the world (sim advance included) sits still this frame;
 * `released` = the hold just ended, and the caller must re-base its frame
 * clock the same way the count-in handback does - the release frame itself
 * still holds (and draws at the held alpha: the caller keeps its accumulator's
 * residue, so the first moving frame steps on from where the hold began rather
 * than from a boundary the eye would see as a jump).
 *
 * Anything that is not PLAYING clears the hold outright rather than banking
 * it: the pause card, auto-pause, the result and the title all outrank a
 * hit-stop, and a resumed round should not owe a freeze from before its pause.
 * A cancel is deliberately not a release - no clock re-base is owed, because
 * the pause and result paths already own their own.
 */
export function hitStopStep(s, dt, playing) {
  s.released = false;
  if (!playing || s.t <= 0) {
    s.t = 0;
    s.holding = false;
    return s;
  }
  const next = s.t - (dt > 0 ? dt : 0);
  // The epsilon is session.js's trick: three subtractions of 1/60 land 4e-18
  // short of 0.05, and without it the hold runs a whole frame long.
  s.t = next <= 1e-6 ? 0 : next;
  s.holding = true;
  s.released = s.t === 0;
  return s;
}
