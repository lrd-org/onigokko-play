// Which screen the player is on, and whether the round is running.
//
// DOM-free and clock-free on purpose: it is handed a frame delta and nothing
// else, so the whole lifecycle - including the blur/visibilitychange double-fire
// that some browsers do on a tab switch - is testable headlessly.
//
// It never touches the sim. Every state except PLAYING simply means main.js does
// not call game.advance() this frame, which is what keeps a paused round and a
// counting-in round byte-identical to the instant they stopped.

import { clamp } from '../sim/math.js';

export const S_TITLE = 'title';
export const S_COUNTDOWN = 'countdown';
export const S_PLAYING = 'playing';
export const S_PAUSED = 'paused';
export const S_RESULT = 'result';

// Three beats 0.5 s apart. Slow enough to read, and at 2 Hz it is well under the
// 3 Hz photosensitivity threshold.
export const BEAT = 0.5;
export const BEATS = 3;
export const COUNT_TIME = BEAT * BEATS;

export class Session {
  constructor() {
    this.state = S_TITLE;
    this.countdown = 0;
  }

  /** In a round, counting in or driving - the states that own the screen. */
  get inRound() { return this.state === S_COUNTDOWN || this.state === S_PLAYING; }

  isPlaying() { return this.state === S_PLAYING; }

  /** The single gate on game.advance(). */
  simRuns() { return this.state === S_PLAYING; }

  hudVisible() { return this.inRound; }

  canPause() { return this.inRound; }

  /**
   * Beats already begun, 1..BEATS while counting in. The epsilon is not
   * cosmetic: ninety subtractions of 1/60 leave the boundary at 1.0000000000004
   * rather than 1, and without it every beat after the first lights one frame
   * late.
   */
  get beatsLit() {
    if (this.state !== S_COUNTDOWN) return 0;
    return clamp(BEATS - Math.ceil((this.countdown - 1e-9) / BEAT) + 1, 0, BEATS);
  }

  /** 1 at the instant a beat lands, decaying to 0 across its first half. */
  get beatPop() {
    if (this.state !== S_COUNTDOWN) return 0;
    const into = (BEAT - (this.countdown % BEAT)) % BEAT;
    return clamp(1 - into / (BEAT * 0.5), 0, 1);
  }

  /** Start a fresh round's count-in. Legal from anywhere; this is also restart. */
  begin() {
    this.state = S_COUNTDOWN;
    this.countdown = COUNT_TIME;
    return true;
  }

  /** Idempotent: the return value is what gates the one-shot side effects. */
  pause() {
    if (!this.canPause()) return false;
    this.state = S_PAUSED;
    this.countdown = 0;
    return true;
  }

  /** Back through the full ramp, never straight into control. */
  resume() {
    if (this.state !== S_PAUSED) return false;
    this.state = S_COUNTDOWN;
    this.countdown = COUNT_TIME;
    return true;
  }

  /** Only a round that is actually running can end. */
  finish() {
    if (this.state !== S_PLAYING) return false;
    this.state = S_RESULT;
    return true;
  }

  home() {
    if (this.state === S_TITLE) return false;
    this.state = S_TITLE;
    this.countdown = 0;
    return true;
  }

  /**
   * Advance the count-in. Returns true on the one frame it completes, which is
   * the only moment control is handed back.
   */
  tick(dt) {
    if (this.state !== S_COUNTDOWN) return false;
    if (!(dt > 0)) return false; // a backwards or non-finite delta must not rewind it
    this.countdown -= dt;
    if (this.countdown > 0) return false;
    this.countdown = 0;
    this.state = S_PLAYING;
    return true;
  }
}
