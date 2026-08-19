// The personal best, as SAVE DATA.
//
// It lives here and not in view/telemetry.js because it is not telemetry. The
// runs list is a consented, deletable record of what the player did; a high
// score is part of the game, in the same class as the prefs key - which already
// persists whatever the consent flag says.
//
// The measured bug this module exists to fix: the trophy on the result card was
// `Math.max(telemetry.best(), run.score)`, and telemetry is OFF by default, so
// recordRun() early-returned, best() was always 0, and the trophy silently meant
// THIS RUN (500 then 100 showed 100). On top of that, setConsent(false) calls
// clearRuns(), so the analytics toggle deleted the high score of anyone who had
// ever turned it on.
//
// So: its own key, written whatever consent says, and never touched by the
// consent toggle. Same namespace, the same shape-checking discipline as prefs,
// and the same rule that a storage failure is never worth a round over.

import { CLEARED, REMAINS, UNKNOWN } from './verdict.js';

const NS = 'onigokko.ofa2.';
export const K_BEST = `${NS}best`;

// Everything JSON.parse accepts that is not a score is treated exactly like an
// absent key: '"x"', 'null', '{}', a hand-edited '-5', and '1e999', which parses
// to Infinity rather than failing. Scores are whole numbers (baseScore ×
// multiplier), so a fractional stored value is floored rather than trusted.
function normalise(v) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return 0;
  return Math.floor(v);
}

/**
 * What is on disk, or null when the disk cannot be read at all. The two are
 * different answers and the caller has to be able to tell them apart: an absent
 * key is a KNOWN zero, and an unreadable storage is knowing nothing - and
 * treating the second as a zero is how a session would throw away its own best
 * the first time a read failed. Exported for telemetry.dump(), which shows the
 * player everything under the namespace and must read this key the way the
 * game does, not raw.
 */
export function readBest() {
  let raw;
  try {
    raw = localStorage.getItem(K_BEST);
  } catch {
    return null; // storage disabled entirely
  }
  if (raw === null) return 0; // absent, which is a real and knowable "no best"
  try {
    return normalise(JSON.parse(raw));
  } catch {
    return 0; // truncated / not JSON at all
  }
}

/**
 * Whether the KEY is there, which is not the same question as what it is worth.
 * readBest() reads a present-but-poisoned key as 0 - correct for a score, and
 * wrong for a deletion, which would have called a surviving `"x"` a clean wipe.
 * CLEARED / REMAINS / UNKNOWN, the same three answers the sweep gives
 * (view/verdict.js); UNKNOWN when the key cannot be read at all.
 */
function bestState() {
  try {
    return localStorage.getItem(K_BEST) === null ? CLEARED : REMAINS;
  } catch {
    return UNKNOWN;
  }
}

/**
 * Whether the value actually landed - read back, not assumed. `saved` is taken
 * as the truth about the disk by _sync(), so a storage that accepts a setItem
 * and keeps the old value would retire a debt that is still owed and then, one
 * round later, let the else-branch drop the best to the stale disk number.
 * Same law as view/telemetry.js's write(): verify by re-read.
 */
function writeBest(v) {
  const json = JSON.stringify(v);
  try {
    localStorage.setItem(K_BEST, json);
    return localStorage.getItem(K_BEST) === json;
  } catch {
    return false; // quota, private mode, storage off
  }
}

export class Save {
  constructor() {
    const disk = readBest();
    // Two numbers, because they can legitimately disagree. `value` is the best
    // this session has seen and the one the player is shown; `saved` is what the
    // disk is believed to hold, or null when it could not be read. They differ
    // exactly when a write failed and is still OWED, and that debt is the only
    // thing that distinguishes a phantom from a wipe made from outside.
    this.value = disk ?? 0;
    this.saved = disk;
  }

  /**
   * The number to show. A plain accessor with no I/O: it is called on every
   * screen transition, and the disk is reconciled at round end instead (_sync).
   */
  best() {
    return this.value;
  }

  /**
   * A finished round's score. Returns the number to show and whether THIS run
   * is what set it, which is the whole of the new-best moment. Never throws:
   * the result screen is the caller's one job that matters.
   */
  submit(score) {
    const isNew = this._raise(score);
    return { best: this.value, isNew };
  }

  /**
   * One-time migration off the consented runs list. A player who turned
   * telemetry on and scored 40000 under the old build has that number recorded
   * only inside the runs list; moving the best to its own key must not read as
   * losing it. Idempotent - it only ever raises - so calling it on every boot is
   * free once the key exists.
   */
  absorb(previousBest) {
    return this._raise(previousBest);
  }

  _raise(score) {
    // Settle up with the disk BEFORE judging the score, never after: a score
    // measured against a number this object has since had to abandon would be
    // called a record and then quietly not be one.
    this._sync();
    const s = normalise(score);
    // Zero is not an achievement. A first-ever round that survives without
    // catching anything must not light a trophy, and must not write a key that
    // then has to be explained.
    if (s <= 0 || s <= this.value) return false;
    this.value = s;
    if (writeBest(s)) this.saved = s;
    return true;
  }

  /**
   * A deliberate wipe made from inside the game (the hold-to-confirm button).
   * telemetry.clearAll() has just swept the whole namespace, this key included,
   * so this settles what MEMORY should now say - `value` is what
   * paintTitleBest() paints, and without it the title keeps showing a best the
   * player just watched themselves destroy until some round end happens to
   * _sync(). Any write still owed dies here too: the player asked for zero, and
   * a debt honoured after a wipe would put the old number straight back.
   *
   * Returns the half of the wipe's verdict that belongs to save data
   * (view/telemetry.js wipeOutcome()): CLEARED, REMAINS or UNKNOWN.
   */
  reset() {
    const state = bestState();
    if (state === UNKNOWN) {
      // Second-member review, round 2 (HIGH). This used to be `value = 0;
      // return true` - "storage cannot be read at all, which is also the
      // storage no verified writeBest() could ever have reached, so there is
      // no number out there". Both halves were wrong: an unreadable storage
      // can be holding a best written a minute ago by a readable one, and it
      // says nothing about whether the key is gone. So nothing is claimed and
      // nothing is thrown away - `value` keeps what the last successful read
      // showed, which is the number the title is already painting, and `saved`
      // goes back to the null that means "unread" (the constructor's own
      // marker, and what stops _sync() settling anything).
      this.saved = null;
      return UNKNOWN;
    }
    const disk = readBest();
    // Second-member review, HIGH. `value = 0` used to be unconditional, so a
    // sweep the disk refused took the trophy off the title anyway - the number
    // was still there, and _sync() put it back at the next round end. Memory
    // takes what the disk HOLDS: 0 when the key is gone, and the surviving
    // number when it is not, which is also what the caller shows and what
    // stops a phantom debt re-writing a wiped best. Round 2: the number and the
    // VERDICT come from different reads on purpose - `disk` is what the key is
    // worth (0 for a poisoned one), `state` is whether the key is there at all,
    // and only the second may be reported as a deletion.
    this.saved = disk;
    this.value = disk ?? 0;
    return state;
  }

  /**
   * Make memory and disk agree, once per round end. Without this the in-memory
   * copy is allowed to outrank reality forever: a write that failed (quota,
   * private mode) used to leave a 5000 in memory over a 900 on disk, and every
   * later round was then measured against the 5000 - so a genuine 1000, with
   * storage working again, beat nothing and was never written. The 5000 was a
   * phantom that outlived the failure that made it.
   *
   * Reading first also picks up a best raised by the same profile in another
   * tab, and - the case that has no debt behind it - a wipe made from the
   * console, which must be allowed to actually take effect rather than being
   * blocked by the copy this object is holding.
   */
  _sync() {
    const disk = readBest();
    if (disk === null) return; // unreadable: nothing can be settled either way
    if (disk > this.value) {
      // Somebody got there first - another tab on the same profile.
      this.value = disk;
      this.saved = disk;
      return;
    }
    if (disk === this.value) {
      this.saved = disk;
      return;
    }
    // The disk is BEHIND memory, which is either a write still owed or a change
    // made from outside. The debt is what tells them apart.
    if (this.value > 0 && this.saved !== this.value) {
      if (writeBest(this.value)) this.saved = this.value;
    } else {
      this.value = disk;
      this.saved = disk;
    }
  }
}
