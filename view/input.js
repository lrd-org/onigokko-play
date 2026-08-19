// Keyboard and touch, flattened to one {throttle, steer, boost} the sim can eat.
//
// Touch is not a virtual d-pad: throttle is automatic, a drag anywhere on the
// left of the screen steers by how far you have pulled from where your thumb
// went down, and there is one boost pad on the right. Wordless, and it leaves
// the middle of the screen unobstructed.

import { clamp } from '../sim/math.js';

// The keys whose browser default is taken while a round wants them: Space
// would scroll the page or press a focused button, the arrows would scroll.
// W/A/S/D and Shift have no default worth stopping and are never prevented.
const CAPTURED = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'];

/**
 * Does this keydown target own its own activation key? Inside a <button> the
 * browser is about to click it on Enter (keydown) or Space (keyup), so a shell
 * shortcut on the same key must yield or the press fires twice: Play/Again
 * would begin two rounds, a toggle would flip AND a round would start. The
 * same convention the wipe applies to itself with stopPropagation, phrased
 * from the shortcut's side for the buttons that do not own a listener.
 * Tolerates a bare window/document target (no `closest`): nothing owns those.
 */
export function ownsActivation(target) {
  return !!target?.closest?.('button');
}

export class Input {
  constructor(target) {
    this.keys = new Set();
    this.throttle = 0;
    this.steer = 0;
    this.boost = false;
    this.touch = false;
    this.dragId = null;
    this.dragX = 0;
    this.dragSteer = 0;
    this.boostId = null;
    // Which pointers are physically on the glass, and which half each one landed
    // on: pointerId -> 'steer' | 'boost'. release() drops what the GAME is
    // holding, but a thumb does not leave the screen because the game stopped
    // listening to it, and this map is the only record that it is still there.
    // The role is fixed at touch-down and never re-read from a later position -
    // a thumb parked on the boost pad stays a boost thumb even if it wanders
    // left, which is what stops it from being picked up as the wheel.
    this.down = new Map();
    this.onFirstGesture = null;
    this._fired = false;
    // Whether Space and the arrows are TAKEN - default-prevented at the window,
    // whatever the target - or left to the browser. On by default so the game
    // drives out of the box; the shell turns it off while a card is up
    // (main.js syncSession: `session.inRound`), because a default-prevented
    // Space keydown cancels a focused button's activation in every engine, and
    // that made Play, Resume, Again and the toggles unpressable with Space
    // (Enter worked, which is why nobody noticed). Only the default action is
    // gated: the key is still registered either way, so a Space held across a
    // pause card is still held by the round when it comes back.
    this.captureKeys = true;

    const gesture = () => {
      if (this._fired) return;
      this._fired = true;
      if (this.onFirstGesture) this.onFirstGesture();
    };

    // `keys` is physical truth - which keys are down on the keyboard right now,
    // kept by keydown/keyup and nothing else - the way `down` is for pointers.
    // The set is emptied only when a keyup can no longer reach this listener:
    // the window losing focus (`blur`) and the tab going hidden. It is NOT
    // emptied by release(): a pause, a restart or the way home changes what the
    // game is doing, not what the hand is doing, and a key the player never let
    // go of sends no second keydown to announce itself afterwards. Auto-repeat
    // is not that announcement either - typematic repeat is one key at a time
    // (the last one pressed) and any other keypress, Esc/P/R included, ends it
    // for good - which is why the earlier design (clear on release(), let the
    // repeat put the key back) came back from Esc/Esc with W and D both dead.
    window.addEventListener('keydown', (e) => {
      // Registered before the repeat guard: a repeat is a keydown, and it may be
      // the first one this listener sees for a key that was already down when a
      // blur or a hidden tab emptied the set. The round no longer depends on it.
      this.keys.add(e.code);
      if (this.captureKeys && CAPTURED.includes(e.code)) e.preventDefault();
      // A repeat is not a gesture, though: it must not stand in for the first
      // real press that unlocks audio.
      if (e.repeat) return;
      gesture();
    });
    // keyup reaches this listener on EVERY screen - the pause card, the result,
    // the title - so a key let go of under a card leaves the set the moment it
    // is let go of, and is not driving when the round comes back. This is also
    // what keeps a Space that PRESSES Resume from boosting the resumed round:
    // Space activates a focused button on keyup, and the button's synthetic
    // click is that keyup's default action, dispatched after every keyup
    // listener has run (main.js's wipe cancels exactly that click with
    // preventDefault() on keyup, which is only possible because the listener
    // runs first) - so Space is already out of the set when doResume() runs.
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    // The two places a keyup is lost. Focus gone: the release lands in another
    // window. Tab hidden: the page receives no key events until it is shown
    // again, so a key let go of behind another tab would come back as a stuck
    // key with the set kept - cleared here exactly as blur clears it. main.js's
    // own visibilitychange handler pauses; this one only forgets the hand.
    // Guarded because the module has no `document` under the test harness.
    window.addEventListener('blur', () => this.keys.clear());
    const doc = globalThis.document;
    doc?.addEventListener?.('visibilitychange', () => {
      if (doc.hidden) this.keys.clear();
    });
    // The play surface has no context menu: a right-click menu open over the
    // canvas mid-round eats the keyups released under it (a stuck W drives on
    // until blur or its next press), and it is not something a game canvas
    // ever wants. Genre-standard, one line.
    target.addEventListener('contextmenu', (e) => e.preventDefault());

    target.addEventListener('pointerdown', (e) => {
      gesture();
      if (e.pointerType === 'mouse') return;
      this.touch = true;
      const right = e.clientX > window.innerWidth * 0.62;
      this.down.set(e.pointerId, right ? 'boost' : 'steer');
      if (right && this.boostId === null) {
        this.boostId = e.pointerId;
      } else if (!right && this.dragId === null) {
        // `!right` matters when a SECOND finger lands on the pad while the first
        // one already owns the boost: without it that finger fell through to
        // here and became the steering drag, so a pull entirely inside the boost
        // pad steered the car. The right half never steers, whichever finger it
        // is and whether or not it is the one boosting.
        this.dragId = e.pointerId;
        this.dragX = e.clientX;
      }
      target.setPointerCapture?.(e.pointerId);
      e.preventDefault();
    }, { passive: false });

    target.addEventListener('pointermove', (e) => {
      // Re-adoption, the touch side of the held-hand problem (the keyboard side
      // needs none: release() keeps `keys`). release() drops dragId while the
      // thumb stays exactly where it was, and a finger that is already down
      // sends no second pointerdown - so a round resumed mid-drag came back
      // with auto-throttle on and no steering at all until the player lifted
      // and re-placed. Re-anchoring dragX at the CURRENT position is what keeps
      // that from handing back a wheel cranked over: the drag restarts from
      // zero, wherever the thumb happens to be.
      //
      // Only a thumb that went down on the STEER half is picked back up. A pause
      // clears boostId along with everything else, so "is this the boost
      // pointer?" stops being answerable the moment it matters - the pad finger
      // only had to drift a little to the left to be adopted as the wheel. The
      // role recorded at touch-down is the answer that survives the pause.
      if (this.dragId === null && this.down.get(e.pointerId) === 'steer') {
        this.dragId = e.pointerId;
        this.dragX = e.clientX;
        this.dragSteer = 0;
        e.preventDefault();
        return;
      }
      if (e.pointerId !== this.dragId) return;
      const span = Math.max(60, Math.min(window.innerWidth * 0.28, 190));
      this.dragSteer = clamp((this.dragX - e.clientX) / span, -1, 1);
      e.preventDefault();
    }, { passive: false });

    const release = (e) => {
      this.down.delete(e.pointerId);
      if (e.pointerId === this.dragId) {
        this.dragId = null;
        this.dragSteer = 0;
      }
      if (e.pointerId === this.boostId) this.boostId = null;
    };
    target.addEventListener('pointerup', release);
    target.addEventListener('pointercancel', release);

    this.gesture = gesture;
  }

  /** Has the player touched anything yet? False through the whole boot. */
  get engaged() { return this._fired; }

  /**
   * Drop what the GAME derived from the player's hands, and nothing the hands
   * are still doing. Called on pause, restart and the way home. Zeroed: the
   * `throttle/steer/boost` readouts and the touch derivations - the steering
   * drag (`dragId/dragX/dragSteer`, so a resume never hands back a wheel still
   * cranked over from where the thumb was three minutes ago) and the boost
   * pointer (`boostId`: a thumb parked on the pad stays dead until it is lifted
   * and pressed again - a still finger emits no move to re-adopt on, and a
   * surprise boost is worse than a missing one).
   *
   * Kept, deliberately: `keys` and `down`. Both are physical truth, not game
   * state - which keys are down and which pointers are on the glass - and the
   * layer's own listeners keep them true (keyup / pointerup, blur, hidden). A
   * key held straight through a pause card, a restart's count-in or the title
   * is still held when a round next reads it: W and D through Esc/Esc drive on,
   * W through R throttles the new round from GO, a Shift or Space never let go
   * of boosts again after the count-in. A key let go of while the card is up
   * left the set on its keyup, so nothing stale comes back. The keyboard side
   * needs no re-adoption; the touch side keeps its (steer-only, see
   * pointermove) - a planted thumb's next move picks it up, re-anchored.
   *
   * The next read() re-derives everything from what is kept, so the zeroing
   * here is what a caller that inspects the readouts between release() and
   * the next frame sees, not a state the round ever resumes into. The sim
   * only consumes read() while `session.simRuns()` (main.js frame()), which is
   * false under every card and through the count-in - a held throttle is read,
   * and goes nowhere, until GO.
   */
  release() {
    this.dragId = null;
    this.dragX = 0;
    this.dragSteer = 0;
    this.boostId = null;
    this.throttle = 0;
    this.steer = 0;
    this.boost = false;
  }

  read() {
    const k = this.keys;
    let throttle = 0;
    let steer = 0;
    if (k.has('KeyW') || k.has('ArrowUp')) throttle += 1;
    if (k.has('KeyS') || k.has('ArrowDown')) throttle -= 1;
    // Sim handedness: positive steer rotates heading toward +X, which the
    // chase camera (looking along +Z) shows as screen-LEFT. Human "right"
    // therefore maps to NEGATIVE steer, here and in the touch drag below.
    if (k.has('KeyA') || k.has('ArrowLeft')) steer += 1;
    if (k.has('KeyD') || k.has('ArrowRight')) steer -= 1;
    let boost = k.has('ShiftLeft') || k.has('ShiftRight') || k.has('Space');

    if (this.touch) {
      // Auto-throttle: on a phone you are always going, you only choose where.
      if (throttle === 0) throttle = 1;
      if (steer === 0) steer = this.dragSteer;
      boost = boost || this.boostId !== null;
    }

    this.throttle = throttle;
    this.steer = clamp(steer, -1, 1);
    this.boost = boost;
    return this;
  }
}
