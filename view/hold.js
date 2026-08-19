// Hold-to-confirm, as a state machine.
//
// The wipe button destroys every stored byte, so a tap cannot be enough: the
// gesture that fires it has to be long enough to be unmistakably deliberate,
// and releasing at ANY point short of that has to cost nothing. DOM-free and
// clock-free like view/session.js - it is handed frame deltas and nothing else
// - so "fires only at the threshold", "an early release loses nothing" and "a
// stalled frame cannot jump-cut the gesture" are ordinary unit tests.

// 1.2 s: long enough that no fidget or mis-tap survives it, short enough that a
// player who means it never doubts the button heard them.
export const HOLD_TIME = 1.2;

// One late frame must not teleport the ring. The threshold is a length of REAL
// held time, and a background tab or a GC stall handing over one giant delta is
// not the player pressing harder - so a single tick can only ever advance the
// gesture by a frame-sized amount.
export const MAX_TICK = 0.1;

export class Hold {
  constructor(threshold = HOLD_TIME) {
    this.threshold = threshold;
    this.held = 0;
    this.armed = false;
    this.fired = false;
  }

  /** Pointer down. A fresh gesture, whatever came before. */
  arm() {
    this.armed = true;
    this.fired = false;
    this.held = 0;
  }

  /** Pointer up / leave / cancel short of the threshold. Nothing is owed. */
  cancel() {
    this.armed = false;
    this.held = 0;
  }

  /**
   * A frame of held time. Returns true on exactly the tick that crosses the
   * threshold - once per arm(), never before, and never again after.
   */
  tick(dt) {
    if (!this.armed || this.fired) return false;
    this.held += Math.min(Math.max(dt, 0), MAX_TICK);
    if (this.held < this.threshold) return false;
    this.fired = true;
    this.armed = false;
    return true;
  }

  /** 0..1 for the ring. Pinned to 1 once fired, so the ring closes fully. */
  progress() {
    if (this.fired) return 1;
    return Math.min(this.held / this.threshold, 1);
  }
}
