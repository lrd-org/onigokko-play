// Edge detectors for the two audible clock readouts: the count-in beats and
// the final-seconds tick. main.js feeds them state the HUD already draws from
// (`session.beatsLit`, `game.timeLeft`) and calls a Sound one-shot on each
// edge - the same split as `wasBoosting` -> `sound.boostSurge()`. The audio
// module never reads the session, so a slow or missing tone cannot move the
// count-in by construction.
//
// DOM-free and clock-free like session.js: handed values, never time. What
// makes these worth a module rather than two `let`s in the frame loop is that
// the cases nobody can reproduce by hand - a restart inside a count-in, a
// pause that lands between two beats, a stall-clamped frame that crosses three
// integer seconds at once - are ordinary unit tests here.

/**
 * The count-in beats. `feed(counting, lit)` -> 1 on the frame a new beat has
 * begun, 0 otherwise. `heard` is the highest beat this count-in has already
 * sounded, so a beat is an edge in `lit`, not a level: the same lit value fed
 * ninety times is one beat.
 *
 * Rules, in the order they are checked:
 * - not counting -> forget everything (`heard = 0`). Handback, pause, title:
 *   the next count-in starts from beat 1 whatever this one reached, which is
 *   what makes a resume replay all three, matching the three dots the player
 *   watches relight.
 * - `lit < heard` -> a restart mid-count. `begin()` is legal from anywhere
 *   and rewinds `beatsLit` (2 -> 1 with no non-counting frame in between), so
 *   the rewind itself is the reset, and the new count-in's first beat sounds.
 * - `lit > heard` -> a beat. Record it, say so.
 *
 * `heard` advances whether or not a voice was actually built: `_tone()` may
 * refuse a beat into a suspended context (a hidden tab), and on return
 * NOTHING replays - the edge was consumed silently. Beats never double-fire.
 */
export function makeBeatEdge() {
  return {
    heard: 0,
    feed(counting, lit) {
      if (!counting) {
        this.heard = 0;
        return 0;
      }
      if (lit < this.heard) this.heard = 0;
      if (lit > this.heard) {
        this.heard = lit;
        return 1;
      }
      return 0;
    },
  };
}

// The nine seconds that tick: the round's last integer boundaries, 9 down to
// 1. Below 10 because that is where the HUD's ring already turns urgent
// (hud.js: `urgent = s.timeLeft < 10`) - the tick voices that state, it does
// not invent a threshold of its own. Not at 0: the roundEnd arpeggio owns that
// instant, and a tick under its first note is clutter.
export const TICK_FROM = 9;
export const TICK_TO = 1;

/**
 * The final-seconds tick. `feed(playing, timeLeft)` -> true on a frame that
 * crossed at least one of the nine ticking boundaries while the clock is still
 * above zero. At most ONE tick per frame by construction: a stall-clamped
 * frame that crosses several integers (the alarm-spam failure mode) is one
 * edge, not a burst - three ticks in one frame carry no more information
 * than one.
 *
 * `prev` is forgotten (null) whenever the round is not playing, and re-based
 * on the first playing frame without firing. That is what keeps a pause at
 * 7 s from replaying 8's crossing on resume, a death from ticking under the
 * losing arpeggio, and a fresh round (4.2 -> 75) from being read as a
 * crossing at all. Kart mode feeds `playing = false` forever: no clock, no
 * tick.
 */
export function makeSecondEdge() {
  return {
    prev: null,
    feed(playing, timeLeft) {
      if (!playing) {
        this.prev = null;
        return false;
      }
      const prev = this.prev;
      this.prev = timeLeft;
      if (prev === null) return false;
      const from = Math.floor(prev);
      const to = Math.floor(timeLeft);
      // The integers this frame crossed are to+1 .. from; a tick is owed when
      // that run overlaps TICK_TO .. TICK_FROM and the clock has not hit 0.
      return from > to && timeLeft > 0 && to < TICK_FROM && from >= TICK_TO;
    },
  };
}
