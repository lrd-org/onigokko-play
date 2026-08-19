// Device-only telemetry. Default OFF, written only after the player turns the
// toggle on, kept exclusively under the onigokko.ofa2.* localStorage namespace,
// and readable and deletable from window.__ofa2.telemetry. Nothing leaves the
// machine - there is no network code anywhere in this build.

import { readBest } from './save.js';
import { CLEARED, REMAINS, UNKNOWN, asVerdict, worse } from './verdict.js';

const NS = 'onigokko.ofa2.';
const K_CONSENT = `${NS}consent`;
const K_RUNS = `${NS}runs`;
const K_PREFS = `${NS}prefs`;
const MAX_RUNS = 60;

// M2. JSON.parse succeeding is not the same as the value being what we asked
// for: '5', '"x"', 'null', 'true' and '{}' all parse cleanly, and every one of
// them used to come straight back as if it were a run list or a prefs object.
// A stored 'null' then made `telemetry.prefs.reducedMotion` throw at module
// scope, which is before ANY of the game exists - a white screen, from one bad
// localStorage key that the player can neither see nor clear.
//
// So every read is validated against an expected SHAPE, and anything that does
// not match is treated exactly like an absent key.
const isArray = (v) => Array.isArray(v);
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isBool = (v) => v === true || v === false;

//
// Second-member review, round 3 (HIGH). A read has to say whether it HAPPENED,
// not only what it found. `observed: false` is the one answer that means
// nothing was learned - getItem threw, so the key holds whatever it held and
// this call has no opinion about it. Every other outcome IS an observation: an
// absent key, a truncated string and a poisoned shape are all things the reader
// LOOKED at and found unusable, and reading them as the fallback is a
// measurement, not a guess.
//
// The old shape returned the fallback for all four and made them
// indistinguishable, which is how a wipe that correctly answered `unknown`
// still repainted consent and every preference as a clean disk's defaults.
function observe(key, fallback, shape) {
  let raw;
  try {
    raw = localStorage.getItem(key);
  } catch {
    return { observed: false, value: fallback }; // storage disabled entirely
  }
  if (raw === null) return { observed: true, value: fallback };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { observed: true, value: fallback }; // truncated / not JSON at all, e.g. '['
  }
  return { observed: true, value: shape(parsed) ? parsed : fallback };
}

// For the callers that want a value whatever happened - the game-facing readers
// below, which never write memory from what they get back.
function read(key, fallback, shape) {
  return observe(key, fallback, shape).value;
}

// motionChosen: whether the motion toggle has ever been touched. While false
// the OS's prefers-reduced-motion decides; once true the stored reducedMotion
// stands alone (view/motion.js). Absent in every object stored before it
// existed, which normalises to false - the reading those objects always had.
const DEFAULT_PREFS = { reducedMotion: false, motionChosen: false, sound: true };

// Even a well-shaped prefs object can hold junk in its fields, so the three
// the game actually reads are normalised to booleans here rather than at each
// use.
function normalisePrefs(p) {
  return {
    ...p,
    reducedMotion: p.reducedMotion === true,
    motionChosen: p.motionChosen === true,
    sound: p.sound !== false,
  };
}

// Second-member review, HIGH. A write that failed and a write that landed used
// to be the same event here: setItem threw, the catch swallowed it, and the
// caller then changed memory as though the disk had agreed. For a preference
// that is a small lie. For CONSENT and for DELETION it is this build's whole
// contract - optional, revocable, deletable - reported as kept when it was not:
// reproduced with a storage that accepts the first writes and then refuses,
// after which memory said consent was withdrawn and the runs were gone while a
// reload read consent granted and the run still there.
//
// So a durable operation is done only when the storage CONFIRMS it. Both of
// these attempt, then re-read the key and compare - a try/catch alone cannot
// see a storage that accepts a call and keeps the old value, and that storage
// is not hypothetical (a full quota that silently no-ops, a shim). Reads keep
// their own try/catch: an unreadable storage must never cost a boot.
function write(key, value) {
  const json = JSON.stringify(value);
  try {
    localStorage.setItem(key, json);
    return localStorage.getItem(key) === json;
  } catch {
    return false; // storage disabled or full: telemetry is never worth breaking the game
  }
}

/**
 * What the disk says about `key` RIGHT NOW: CLEARED when it reads back absent,
 * REMAINS when it reads back present, UNKNOWN when it cannot be read at all.
 * The third is the one round 2 is about - it used to be folded into one of the
 * other two, and either fold is a lie.
 */
function keyState(key) {
  try {
    return localStorage.getItem(key) === null ? CLEARED : REMAINS;
  } catch {
    return UNKNOWN;
  }
}

/**
 * Attempt the removal, then ask the disk. The throw is not the answer and the
 * lack of one is not either: a storage can refuse the call and not hold the key
 * (another tab took it), and it can accept the call and keep it. Only the
 * re-read decides, and when the re-read cannot happen the answer is UNKNOWN.
 */
function remove(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    // Fall through: the state of the key is measured below, not inferred here.
  }
  return keyState(key);
}

/**
 * Every key under this build's namespace, or null when the storage cannot be
 * listed at all. The two are different answers and the sweep has to tell them
 * apart: "no keys left" is evidence, "I cannot see" is not.
 */
function namespaceKeys() {
  const out = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(NS)) out.push(k);
    }
  } catch {
    return null;
  }
  return out;
}

// The two things the wipe button is allowed to say, and the only text channel
// this build has (the polite live region; ledger row 25, row 19's aria
// exception). "cancelled" is the third and belongs to the hold, not here.
export const WIPE_DONE = 'data reset';
export const WIPE_FAILED = 'data not reset';
// Round 2's one added string, on the same channel: the consent toggle can fail
// the same way the bin can, and until now it failed in silence while the row
// repainted as though it had worked. Said in either direction (a grant that
// could not be stored, a withdrawal whose runs would not go), because both are
// the same fact for the player - the press did not take. Rendered-but-clipped
// like the other three, so row 19's VISIBLE-character budget is unchanged.
export const CONSENT_KEPT = 'consent not changed';

/**
 * What the hold-to-confirm wipe may claim, from the only two answers that are
 * evidence: the namespace sweep's verdict (Telemetry.clearAll) and the best
 * key's (Save.reset). Pure, and here rather than inline in main.js because
 * main.js is browser wiring nothing can load headlessly - this decision is what
 * the announcement and the confirmation pop rest on, and it has to be testable.
 *
 * Round 2: the inputs are verdicts, not booleans, and `done` needs CLEARED from
 * both. asVerdict() reads anything else - `undefined` from a caller that forgot
 * to return, a leftover `true` from the old protocol - as UNKNOWN, so the only
 * way to a success is for two re-reads to have actually seen absence. `verdict`
 * is carried out for the caller that wants to know WHICH kind of not-done it
 * was; nothing may be claimed from it.
 */
export function wipeOutcome({ telemetryVerdict, bestVerdict }) {
  const verdict = worse(asVerdict(telemetryVerdict), asVerdict(bestVerdict));
  const done = verdict === CLEARED;
  return { done, verdict, announce: done ? WIPE_DONE : WIPE_FAILED };
}

/**
 * What the consent ROW should show after an attempt: the state to paint, the
 * mark to wear, and the words to say. Pure, and here beside wipeOutcome() for
 * the same reason - main.js is browser wiring nothing can load headlessly, and
 * "what does the toggle show when the press did not take" is exactly the
 * decision the second member's round-3 finding is about. It must be assertable
 * without a DOM.
 *
 * `pressed` is setConsent()'s reported flag, which is only ever a value the
 * disk was read back as holding or the last one that WAS observed - never the
 * intent. So a withdrawal whose runs could not be deleted paints the toggle ON
 * (true) and wears the failure mark: the data is still there, the flag is still
 * granted, and the mark says the press did not take. The forbidden shape is the
 * other one - an OFF toggle with a mark beside it, which is a completed
 * withdrawal wearing an apology.
 */
export function consentToggleModel(result) {
  const r = result && typeof result === 'object' ? result : {};
  const ok = r.ok === true;
  return { pressed: r.consent === true, failed: !ok, announce: ok ? null : CONSENT_KEPT };
}

export class Telemetry {
  constructor() {
    this._load();
  }

  /**
   * Memory, taken from the disk at BOOT - the one place a default is honest,
   * because nothing has been observed yet and an unreadable storage and an
   * empty one are the same standing start. A storage nobody can read costs a
   * claim here, never a boot.
   *
   * Every LATER re-derivation goes through _refresh(). Once a value has been
   * observed, replacing it with a default is inventing an observation.
   */
  _load() {
    this.consent = read(K_CONSENT, false, isBool) === true;
    this.prefs = normalisePrefs(read(K_PREFS, DEFAULT_PREFS, isObject));
  }

  /**
   * Re-derive memory from the disk after an operation - PER KEY, and only from
   * reads that actually happened.
   *
   * Second-member review, round 3 (HIGH). This used to be _load(), which reads
   * a throwing getItem as the fallback: so a wipe that correctly returned
   * `unknown` still flipped `consent` to false and `prefs` to the defaults, and
   * main.js then repainted the settings row from them. The verdict was honest
   * and the screen was not - a failed wipe wearing a cross badge over toggles
   * that had all snapped to the wiped state, with the real values coming back
   * at the next reload. The same contradiction the original HIGH prohibited,
   * reached by a different door.
   *
   * So an unreadable key changes nothing: memory keeps the last value that was
   * genuinely seen. An absent or poisoned key still yields its default - that
   * is a read that happened. Returns which keys were observed, for a caller
   * that wants to say so.
   */
  _refresh() {
    const consent = observe(K_CONSENT, false, isBool);
    if (consent.observed) this.consent = consent.value === true;
    const prefs = observe(K_PREFS, DEFAULT_PREFS, isObject);
    if (prefs.observed) this.prefs = normalisePrefs(prefs.value);
    return { consent: consent.observed, prefs: prefs.observed };
  }

  /**
   * Turn the consented recording on or off. Returns a structured result:
   * `{ ok, reason, consent }`, where `consent` is what the DISK says once the
   * dust settles - never the intent.
   *
   * The flag in memory only ever moves to a value localStorage has been read
   * back as holding, which cuts both ways: a grant that did not persist is not
   * treated as granted (recordRun() stays shut, so nothing is written under a
   * consent that no reload will find), and a withdrawal that did not persist
   * does not leave memory claiming a privacy state the disk contradicts.
   *
   * Second-member review, round 2 (HIGH). Withdrawal is TWO durable operations
   * and round 1 did them in the wrong ORDER: the flag went first and the runs
   * second, so a storage that accepted writes and refused removals ended with
   * `consent === false` and the whole run history still on the disk. The return
   * value said `false`, but main.js ignored it and repainted the now-off
   * toggle - a complete-looking withdrawal over data that was never deleted.
   *
   * So the DELETION goes first and the flag follows it. A run list that is not
   * verifiably gone stops the withdrawal dead: the flag is not written, memory
   * is re-read from the disk (so the toggle repaints ON, which is the truth),
   * and the caller is handed the reason. Nothing can then present a failed
   * deletion as a completed withdrawal, because at that moment nothing about
   * the withdrawal has happened at all.
   *
   * The one asymmetry, deliberate: if the runs DO go and the flag write then
   * fails, the runs stay deleted and the flag stays granted. That errs toward
   * less stored data, and the toggle still shows what the disk holds.
   */
  setConsent(on) {
    return on ? this._grant() : this._withdraw();
  }

  _grant() {
    if (!write(K_CONSENT, true)) {
      // Memory follows the disk, never the intent - and only where the disk
      // could actually be READ (round 3): a grant that failed on a storage
      // nobody can look into leaves the flag exactly as it was last observed.
      this._refresh();
      return { ok: false, reason: 'consent-unwritten', consent: this.consent };
    }
    this.consent = true;
    return { ok: true, reason: 'granted', consent: true };
  }

  _withdraw() {
    // Deletion first, and it must be VERIFIED gone - not attempted, not
    // un-thrown. Until this says CLEARED there is no withdrawal to report.
    const runs = this.clearRuns();
    if (runs !== CLEARED) {
      // Round 3: _refresh(), not _load(). On `runs-unknown` NOTHING about this
      // storage was observed, and _load() answered that with consent=false -
      // so the caller got `ok:false` and a flag that read as withdrawn anyway,
      // which is the toggle snapping off under its own failure mark.
      this._refresh();
      return {
        ok: false,
        reason: runs === REMAINS ? 'runs-remain' : 'runs-unknown',
        consent: this.consent,
      };
    }
    if (!write(K_CONSENT, false)) {
      this._refresh();
      return { ok: false, reason: 'consent-unwritten', consent: this.consent };
    }
    this.consent = false;
    return { ok: true, reason: 'withdrawn', consent: false };
  }

  /**
   * Preferences are settings, not tracking: they are stored either way, and
   * still only in this namespace. Memory takes the new value whether or not the
   * disk did - a player who turns the sound off on a full disk HAS turned the
   * sound off for this session, and a toggle is not a claim about durability
   * the way consent and the wipe are. The return value is that claim, for a
   * caller that wants it.
   *
   * Round 3, the distinction this whole round turns on, stated once: what is
   * forbidden is memory being replaced by a DEFAULT that no read produced -
   * "the disk did not answer, so assume a clean one". A player's own press is
   * the opposite of that; it is the one thing in this module that is allowed to
   * move memory without the disk, because a sound toggle that refuses to mute
   * until storage recovers is a broken button rather than an honest one. It
   * merges into the values already held, so the keys the player did NOT touch
   * keep whatever was last observed, and nothing here re-derives anything.
   */
  savePrefs(prefs) {
    this.prefs = normalisePrefs({ ...this.prefs, ...prefs });
    return write(K_PREFS, this.prefs);
  }

  /** Whether the run is now on the disk. */
  recordRun(run) {
    if (!this.consent) return false;
    // Round 3, the same root on the WRITE side: an unreadable list used to
    // arrive here as an empty one, and appending to that would have written a
    // one-entry history over however many runs the storage was still holding -
    // a silent deletion performed by the recorder. A list that could not be
    // read is not a list to append to. (An absent or poisoned key IS observed,
    // and starting from [] there is the same decision it always was.)
    const seen = observe(K_RUNS, [], isArray);
    if (!seen.observed) return false;
    const runs = seen.value;
    // Belt and braces on top of the shape check: this is the one write path,
    // and a `.push` on a non-array is the throw that used to eat the whole
    // result panel.
    if (!Array.isArray(runs)) return false;
    runs.push({ ...run, at: Date.now() });
    while (runs.length > MAX_RUNS) runs.shift();
    return write(K_RUNS, runs);
  }

  /**
   * M3. The end of a round has exactly one job that matters - show the player
   * what they scored - and recording it is strictly less important than that.
   * This can never throw, so the caller's result panel can never be lost to a
   * storage failure. Returns whether the run was actually stored.
   */
  recordRunSafe(run) {
    try {
      return this.recordRun(run);
    } catch {
      return false;
    }
  }

  runs() {
    const list = read(K_RUNS, [], isArray);
    // Entries are validated too: a hand-edited '[null, 5]' would otherwise blow
    // up best() on `r.score`.
    return list.filter(isObject);
  }

  best() {
    let best = 0;
    for (const r of this.runs()) {
      if (typeof r.score === 'number' && Number.isFinite(r.score) && r.score > best) best = r.score;
    }
    return best;
  }

  /** CLEARED / REMAINS / UNKNOWN for the runs list, from a re-read. */
  clearRuns() {
    return remove(K_RUNS);
  }

  /**
   * Remove every key this build has ever written, and say what the disk did
   * about it: the sweep re-reads each key it removed and then re-lists the
   * namespace, so a removal the storage accepted and ignored is caught as well
   * as one that threw. Returns the least confident verdict of the lot - one
   * key that would not go, or one read that could not happen, is the answer for
   * the whole sweep.
   */
  clearAll() {
    const doomed = namespaceKeys();
    let verdict = CLEARED;
    if (doomed === null) {
      // Second-member review, round 2 (HIGH). This branch used to be `ok =
      // true`, reasoning that a storage that cannot be listed is a storage
      // none of this build's verified writes could ever have reached, so there
      // is nothing under the namespace to delete. That is an inference from
      // silence, and the reviewer disproved it in one run: a storage holding
      // consent, a run and best=500 that THEN loses enumeration reports a
      // clean wipe, announces `data reset` - and when it comes back, all three
      // keys are exactly where they were. This build's own writes are not the
      // only way a key gets there (another tab, a restored profile, an earlier
      // version), and even if they were, "I cannot look" is not "it is gone".
      verdict = UNKNOWN;
    } else {
      for (const k of doomed) verdict = worse(verdict, remove(k));
      const left = namespaceKeys();
      if (left === null) verdict = worse(verdict, UNKNOWN);
      else if (left.length > 0) verdict = worse(verdict, REMAINS);
    }
    // Memory is RE-READ rather than assigned the defaults a clean disk would
    // have. After a sweep that only half landed, those defaults would be a
    // second lie on top of the first: the toggle row would snap back to a
    // stranger's idea of the truth while the disk still held the player's
    // consent, and the next reload would put it all back.
    //
    // Round 3 (HIGH): the re-read has to be observation-aware, or the UNKNOWN
    // branch above walks straight into the defaults it was written to avoid.
    // _load() reads a throwing getItem AS the default, so the reviewer's
    // reproduction - consent=true, sound=false, reducedMotion=true, then a
    // storage that cannot be looked at - correctly returned `unknown` and then
    // repainted the whole settings row as reset. _refresh() assigns only what
    // it actually managed to read; an unreadable key leaves memory alone.
    this._refresh();
    return verdict;
  }

  /**
   * Everything stored, for the player to look at. The best is save data, not
   * telemetry (see save.js), but it lives under the same namespace and
   * clearAll() takes it, so a dump that omitted it would be showing less than
   * the wipe erases. Read through save.js's own reader: 0 when absent or
   * poisoned, null when storage cannot be read at all.
   */
  dump() {
    // Round 3: `runs` follows the same convention `best` has had since iter 5 -
    // null when the key could not be READ, as opposed to the empty list that
    // means "looked, and there is nothing there". A player checking what this
    // machine still holds must not be shown an empty history by a storage that
    // simply would not answer.
    const seen = observe(K_RUNS, [], isArray);
    return {
      namespace: NS,
      consent: this.consent,
      prefs: this.prefs,
      best: readBest(),
      runs: seen.observed ? seen.value.filter(isObject) : null,
    };
  }
}
