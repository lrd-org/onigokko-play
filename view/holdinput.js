// Who owns the hold-to-confirm gesture: the source arbiter behind the wipe.
//
// view/hold.js measures held time and knows nothing about where the holding
// comes from - a finger, a mouse and a key all look like frame deltas to it.
// Once a keyboard can hold as well as a pointer, a question appears that the
// machine cannot answer: which channel owns the gesture in flight, and what
// each new input means against it. That question lives here, DOM-free like the
// machine, so the seam rules are ordinary unit tests and main.js's listeners
// are translators: each names the abstract input, this answers `'arm'`,
// `'cancel'` or `'ignore'`, and the listener does exactly that and nothing else.
//
// The rule (spec-wipe-keyboard §4): one gesture, one unambiguous source. Any
// arming input from the OTHER channel while a hold is armed cancels outright -
// no transfer, no restart - because two channels claiming one destructive
// gesture is an ambiguity whose safe reading is "neither"; a fresh, unambiguous
// gesture costs the player one more press. Ownership also scopes what must NOT
// cancel: a mouse wandering across the button during a key hold is hover, not
// input, and the other channel's release is as inert as its hover. Only the
// owning channel's release, and the source-agnostic events (a hidden tab, a
// lost world, a fire), end a hold.

export const POINTER = 'pointer';
export const KEY = 'key';

export class HoldInput {
  constructor() {
    /** `'pointer'` | `'key'` | `null`: who owns the armed hold, if anyone. */
    this.source = null;
    /** The key that armed a key hold. Only ITS release is a release. */
    this.key = null;
  }

  get armed() {
    return this.source !== null;
  }

  _arm(source, key = null) {
    this.source = source;
    this.key = key;
    return 'arm';
  }

  _cancel() {
    this.source = null;
    this.key = null;
    return 'cancel';
  }

  /**
   * Enter or Space went down on the button. `repeat` is the OS auto-repeat
   * flag: a repeat is the same press still down, never a new one, so it is
   * noise whatever is armed - the rAF loop measures the hold, not the
   * keyboard's repeat rate, and a player who has disabled key repeat holds
   * exactly as long as anyone else.
   */
  keyDown(key, repeat = false) {
    if (repeat) return 'ignore';
    if (this.source === null) return this._arm(KEY, key);
    // A fresh press while a hold is already armed: the pointer's hold, or a
    // second key over an armed key hold. Either way a second claim on the one
    // gesture, and the answer to that is neither.
    return this._cancel();
  }

  /** Enter or Space came up. Only the arming key's release ends a key hold. */
  keyUp(key) {
    if (this.source === KEY && key === this.key) return this._cancel();
    return 'ignore';
  }

  /**
   * A pointer went down on the button. `primary` is left/primary-button; only
   * that can ARM (a context menu can eat the pointerup - review MAJOR-3). But
   * ANY pointer landing on the button mid-key-hold cancels: it is the other
   * channel claiming the gesture, and a context menu eats the keyup that would
   * end a key hold as readily as it eats a pointerup.
   */
  pointerDown(primary = true) {
    if (this.source === KEY) return this._cancel();
    if (!primary) return 'ignore';
    // Idle, or a primary press over an already-armed pointer hold: a fresh
    // gesture, whatever came before - the machine's own arm() semantics.
    return this._arm(POINTER);
  }

  /** pointerup / pointercancel / pointerleave: the pointer's own release or drift-off. */
  pointerUp() {
    return this.source === POINTER ? this._cancel() : 'ignore';
  }

  /** Escape: ends a key hold, and is consumed only then. Idle or pointer-owned, it is not ours. */
  escape() {
    return this.source === KEY ? this._cancel() : 'ignore';
  }

  /** The button lost focus: a key hold's keyup would now land where nobody can hear it. */
  blur() {
    return this.source === KEY ? this._cancel() : 'ignore';
  }

  /**
   * The screen went away - a hidden tab, a lost world, the row moving out from
   * under the hold. Nobody's hold survives it, whichever channel carried it.
   */
  hidden() {
    return this.source === null ? 'ignore' : this._cancel();
  }

  /** The hold fired: the gesture is spent, whoever held it. The next press starts fresh. */
  fired() {
    this.source = null;
    this.key = null;
  }
}
