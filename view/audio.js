// Procedural WebAudio. No files, no network - one noise buffer generated at
// startup and a handful of oscillators.
//
// The context is only created after a real user gesture, so nothing is ever
// constructed against a suspended context and no browser has to warn about it.
//
// The wind is the important one: it is the speedometer. Its gain and its filter
// both open with speed, and it lifts an octave the moment the ground leaves.

import { clamp } from '../sim/math.js';

// The proximity channel's two curves, pure and exported because the Sound class
// needs a browser AudioContext and these do not - the mapping from the state
// the HUD already shows to a level and a pan is the part worth holding still in
// a test.
//
// The band is the hunters' own geometry, not taste: catch-up behaviour begins
// at 60 u (HUNT.catchupDist), a lunge may only launch 22-42 u out, and contact
// is 3.6 u. So the bed is silent where a hunter is scenery, a murmur across the
// commit window, and only finds its full (still small) voice inside it.
// Squared, because this is information rather than alarm: the ear should find
// it when it goes looking, and only be found BY it when the gap is nearly gone.
export const THREAT_FAR = 60;
export const THREAT_NEAR = 12;
export function threatCloseness(dist) {
  const n = clamp((THREAT_FAR - dist) / (THREAT_FAR - THREAT_NEAR), 0, 1);
  return n * n;
}

// Bearing (radians, 0 = where the camera looks, + = right) -> stereo pan. sin,
// because a pan cannot say front-or-back - dead ahead and dead behind are both
// centre, and the sides carry the direction. Scaled to 0.8 rather than 1: a
// voice pinned entirely into one ear reads as a hardware fault, not a bearing.
export function threatPan(bearing) {
  return clamp(Math.sin(bearing) * 0.8, -1, 1);
}

// The two levels every other voice is measured against, named so a test can
// hold the ordering still instead of repeating the numbers: the sting's lead
// voice is the loudest transient the game is allowed to make outside a hit,
// and the threat bed's ceiling is the whisper that "must never win the mix,
// only colour it". A retune of either moves the ceilings with it.
export const STING_LEAD_GAIN = 0.13;
export const THREAT_BED_GAIN = 0.05;

// The clock's voices, exported for the same reason the threat curves are: the
// Sound class needs a browser AudioContext, these numbers do not, and the
// claim worth pinning is their ORDER against the mix that exists, not their
// taste. All triangle/sine - the informational family (chime, landing bell,
// win arpeggio), never square (the warning family: sting, hit) - because a
// count-in that sounds like a warning teaches the player to flinch at round
// start. "Aural cyan": the same channel hud.js draws the beats and the GO
// ring in.
//
// Beats: ticks, not notes - shorter than the visual pop's 0.25 s decay so the
// attack is the alignment point, one step under the sting so the warning
// channel keeps the loudest transient. GO: an octave up, the MK contour and
// the build's own "up = good" vocabulary; EQUAL to the sting's lead, never
// above it - hunters are live from t=0 and a sting can follow GO within
// frames, and at equal gain two square voices still win over one triangle,
// which is the right priority. The sparkle keeps GO bright without raising
// its level. 440/880 sit clear of the chime's C-major (523.25) and the
// sting's 196/277, so no shared pitch class blurs two meanings.
export const COUNT_BEAT_VOICE = { freq: 440, type: 'triangle', dur: 0.10, gain: 0.10 };
export const GO_VOICE = { freq: 880, type: 'triangle', dur: 0.35, gain: STING_LEAD_GAIN };
export const GO_SPARKLE_VOICE = { freq: 1760, type: 'sine', dur: 0.25, gain: 0.05 };
// The final-seconds tick: the quietest one-shot in the build, at the threat
// bed's own ceiling, and pitched above everything else in the game on purpose
// - the bed lives at 88-158 Hz, three octaves down, and the sting's
// information is a 196/277 clash over 0.34 s that a 60 ms whisper at 1500 Hz
// cannot mask. Separation is spectral as much as level.
export const TICK_VOICE = { freq: 1500, type: 'sine', dur: 0.06, gain: THREAT_BED_GAIN };

// How long one suspend()/resume() transition may stay in flight before the
// settle machine stops waiting for its promise. Not a tuning: on Chrome both
// promises settle in a few milliseconds and this never fires. It exists for the
// WebKit paths docs/audit-safari-audio.md §3a names - a resume() issued while
// the context is 'interrupted' (a call, Siri) or a page being frozen can leave
// its promise pending FOREVER, and a machine that only clears `_settling` from
// the promise handler would then refuse every later intent for the rest of the
// session. Long past any honest settle, short of a player noticing.
export const SETTLE_TIMEOUT_MS = 500;

export class Sound {
  constructor() {
    this.ctx = null;
    this.enabled = true;
    this.ready = false;
    this.windLevel = 0;
    // Whether the page currently WANTS silence, independent of what the context
    // has managed to do about it yet. See suspend()/resume()/_settle().
    this.wantSuspended = false;
    this._settling = false;
    // The transition `_settling` is waiting on - its once-guard and its timeout
    // - so activate() can abandon it from outside. See _settle()/activate().
    this._flight = null;
    // The one-shot timers roundEnd()/newBest() have in flight, so a restart can
    // take back the notes that have not been built yet. See cancelPending().
    this._pending = new Set();
  }

  start() {
    if (this.ctx) {
      // Through resume(), so that starting audio is an intent like any other and
      // cannot quietly contradict a suspend that is still in flight.
      this.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;
    // The platform moves the context on its own too - iOS parks it at
    // 'interrupted' for a call and hands it back 'running' when the call ends,
    // whatever the page wanted meanwhile - so every state change re-drives the
    // intent. Without this, an interruption that ends behind a hidden tab
    // leaves the context RUNNING while `wantSuspended` is true and nothing ever
    // asks again: row 10's own defect back through a door Chrome does not have
    // (docs/audit-safari-audio.md §3b). Idempotent: _settle() does nothing when
    // the state already matches, and yields to a transition already in flight.
    ctx.onstatechange = () => this._settle();

    this.master = ctx.createGain();
    this.master.gain.value = 0.55;
    this.master.connect(ctx.destination);

    // One second of white noise, reused by everything noisy.
    const n = Math.floor(ctx.sampleRate * 1.0);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    this.noise = buf;

    // --- wind bed ---------------------------------------------------------
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'bandpass';
    this.windFilter.frequency.value = 320;
    this.windFilter.Q.value = 0.7;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    src.connect(this.windFilter).connect(this.windGain).connect(this.master);
    src.start();
    this.windSrc = src;

    // --- engine / roll bed --------------------------------------------------
    // Wind alone is a poor speedometer: it is broadband noise, and the ear
    // measures PITCH far better than it measures hiss. A soft low tone whose
    // frequency tracks speed gives the same information in the channel the ear
    // is good at. Two detuned oscillators through a lowpass so it sits under
    // everything as a body hum rather than a note.
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;
    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = 'lowpass';
    this.engineFilter.frequency.value = 420;
    this.engineFilter.Q.value = 0.5;
    this.engineFilter.connect(this.engineGain).connect(this.master);

    this.engineOscs = [];
    for (const [type, detune] of [['triangle', 0], ['sawtooth', 7]]) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = 40;
      o.detune.value = detune;
      const g = ctx.createGain();
      g.gain.value = type === 'sawtooth' ? 0.35 : 1;
      o.connect(g).connect(this.engineFilter);
      o.start();
      this.engineOscs.push(o);
    }

    // --- threat / proximity bed --------------------------------------------
    // A continuous readout of the distance the HUD's wedge and the hunters on
    // screen already show: two triangles a rough minor second apart, so the
    // detune BEATS - and because both frequencies climb as the gap closes, the
    // beat quickens with them. Urgency lives in the roughness as much as the
    // level, which is what lets the peak gain stay at a whisper. Panned by
    // bearing where the platform has StereoPannerNode; where it does not, it
    // degrades to mono silently - a missing direction, never a missing warning.
    this.threatGain = ctx.createGain();
    this.threatGain.gain.value = 0;
    this.threatPanner = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    if (this.threatPanner) this.threatGain.connect(this.threatPanner).connect(this.master);
    else this.threatGain.connect(this.master);
    this.threatOscs = [];
    for (const ratio of [1, 1.06]) {
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = 88 * ratio;
      o.connect(this.threatGain);
      o.start();
      this.threatOscs.push(o);
    }

    this.ready = true;
    // A context is not always born running, even inside a gesture: WebKit can
    // hand one over 'suspended' from a touch, and this branch never resumed it
    // - only the ctx-already-exists branch above did - so a ?mode=kart boot
    // whose first input was a touch stayed silent until the player found a
    // real button (docs/audit-safari-audio.md §4). Chase the intent once here,
    // exactly as every later call does: `wantSuspended` is false at boot, so
    // this is a resume - and it is still a suspend if a hide arrived before the
    // first gesture, which a blind resume() would have contradicted.
    this._settle();
  }

  // Pause lifecycle. Suspending the context stops the wind and engine beds dead
  // without touching their gains, so resuming brings them back at exactly the
  // level they left at rather than ramping up from silence.
  //
  // These record an INTENT and then chase it, rather than reading ctx.state and
  // acting once. State is the wrong thing to branch on because suspend/resume
  // settle asynchronously: a hide, a show and a hide again inside one tick used
  // to leave the context RUNNING while the page was hidden - the second hide
  // read 'suspended' (the show had not landed yet), did nothing, and then the
  // show's promise resolved into a hidden tab. Measured at a 0 ms gap on the
  // title and the result; a gap of 30 ms or more happened to self-correct.
  // Whichever intent arrived LAST is the one that wins.
  suspend() {
    this.wantSuspended = true;
    this._settle();
  }

  resume() {
    this.wantSuspended = false;
    this._settle();
  }

  /**
   * Drive the context towards `wantSuspended`, one transition at a time. If the
   * intent flips while a transition is in flight, the settle handler starts the
   * next one - so the flap costs an extra round trip and still ends up right.
   *
   * The transition is raced against SETTLE_TIMEOUT_MS. A promise that settles
   * late is fine - the flap just costs its round trip - but one that never
   * settles at all (WebKit, resume() during an 'interrupted' context) used to
   * leave `_settling` true for the rest of the session, and every later
   * suspend()/resume() returned at the guard below: permanent silence with no
   * error anywhere. Whichever comes first - promise or timeout - runs the
   * handler once; the loser is a no-op, so a promise resolving after its
   * timeout cannot reach into a transition that has since started. The
   * handler re-checks the intent, not the state: `ctx.onstatechange` (start())
   * is what re-drives the machine when the platform finally moves.
   *
   * The once-guard and the timer live on `this._flight` rather than in the
   * closure alone, so activate() can retire a transition from outside: a
   * retired flight's handler is the same no-op as the loser of the race.
   */
  _settle() {
    const ctx = this.ctx;
    if (!ctx || this._settling) return; // no context yet: nothing to be silent
    const want = this.wantSuspended;
    if (want === (ctx.state !== 'running')) return; // already where it should be
    this._settling = true;
    // A transition that THROWS synchronously (a polyfill, a pre-standard
    // webkitAudioContext without the method) must not leave the guard up
    // forever and must not escape into the visibilitychange handler that
    // asked: it is treated as a transition that returned nothing - settled as
    // is, guard released, the intent re-checked (integration review N-6).
    let done = null;
    try {
      done = want ? ctx.suspend() : ctx.resume();
    } catch {
      done = null;
    }
    const flight = { handled: false, timer: 0 };
    this._flight = flight;
    const after = () => {
      if (flight.handled) return;
      flight.handled = true;
      clearTimeout(flight.timer);
      this._settling = false;
      if (this.wantSuspended !== want) this._settle();
    };
    if (done && typeof done.then === 'function') {
      flight.timer = setTimeout(after, SETTLE_TIMEOUT_MS);
      done.then(after, after);
    } else {
      after();
    }
  }

  /**
   * An activation-time nudge, called from the events WebKit honours as a user
   * activation for audio - `pointerup` and `keyup` (main.js, beside
   * `onFirstGesture`) - and NOT part of the intent machine: it records no
   * wish and takes no side in suspend-vs-resume. It exists because of the
   * order a tap arrives in. `onFirstGesture` fires from `pointerdown`, so the
   * context is created and its first `resume()` issued there; on WebKit that
   * pointerdown is not an activation, the promise stays PENDING (audit §3a/§4),
   * and `_settle()` holds `_settling` for it until the promise or the 500 ms
   * timeout - so a second `resume()` from the tap's own pointerup, 50-150 ms
   * later and the activation WebKit DOES honour, was refused at the guard every
   * time on exactly the platform it is for (iteration-6 discovery G4; the
   * audit's "gesture() on pointerup" line cannot work as written for the same
   * reason - a re-fired gesture() re-drives nothing).
   *
   * Contract. A no-op - it reads three fields and touches nothing - unless the
   * context exists, the page wants sound (`!wantSuspended`: a hidden tab keeps
   * its silence, whatever the player presses under it) and the state is not
   * 'running'. On Chrome the context is running from the pointerdown on, so
   * every pointerup/keyup of the session ends at the first line. When it does
   * act: a transition in flight is RETIRED - its once-guard flipped from here,
   * its timer cleared, so its late settle is the loser-of-the-race no-op and
   * can never clear the guard under the transition issued next - the guard is
   * released, and `_settle()` is run, which issues this activation's own
   * `resume()` as an ordinary tracked transition (its own timeout, its own
   * once-guard, the same handler chasing a flipped intent). One `resume()` per
   * activation while the state stays not-running - bounded by physical
   * releases, and a resume() against a context already resuming is idempotent
   * for the browser; zero once it runs. Nothing else in the file changes: the
   * intent, `_live()`, `onstatechange` and the beds are exactly as before.
   */
  activate() {
    if (!this.ready || this.wantSuspended || this.ctx.state === 'running') return;
    if (this._settling) {
      const f = this._flight;
      if (f && !f.handled) {
        f.handled = true;
        clearTimeout(f.timer);
      }
      this._settling = false;
    }
    this._settle();
  }

  /**
   * Snap the beds back to standing still. The beds are only driven while a round
   * is PLAYING, so a restart out of a moving round counted in over the wind and
   * engine of a car that no longer exists - measured at windGain 0.037 under a
   * count-in whose car is stationary. Values here are exactly what wind() asks
   * for at speed 0 on the ground, so the first driving frame continues the ramp
   * instead of contradicting it.
   *
   * Restart only. Resuming from a pause must KEEP its levels: the suspended
   * context is what made it silent, and the round comes back at the speed it
   * left at.
   */
  resetBeds() {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const set = (param, v) => {
      param.cancelScheduledValues(t);
      param.setValueAtTime(v, t);
    };
    set(this.windGain.gain, 0);
    set(this.windFilter.frequency, 240);
    if (this.engineOscs) {
      set(this.engineGain.gain, 0.05);
      set(this.engineFilter.frequency, 300);
      for (const o of this.engineOscs) set(o.frequency, 34);
    }
    // Standing still, nobody close: the threat bed's zero is actual silence.
    if (this.threatOscs) {
      set(this.threatGain.gain, 0);
      set(this.threatOscs[0].frequency, 88);
      set(this.threatOscs[1].frequency, 88 * 1.06);
      if (this.threatPanner) set(this.threatPanner.pan, 0);
    }
  }

  /**
   * RAMP the beds to standing still - the finish/home counterpart of the
   * restart snap above. wind() is driven only while a round is PLAYING, so on
   * the frame the round ends both beds simply stop being told anything and
   * hold: the wind at its last level, and the engine at its last PITCH - a car
   * idling at boost revs under the result card, for as long as you sit there.
   * threat(null) already ramps its bed out on those screens for exactly this
   * reason; this is the same courtesy for the other two.
   *
   * The ramp is wind()'s own speed-0-on-the-ground frame, not a second set of
   * numbers: same targets, same time constants, so the rest it reaches is byte
   * for byte the rest resetBeds() snaps to, and a restart out of the result
   * card continues it rather than contradicting it. Not on the pause path -
   * a pause keeps its levels (the suspended context is what silences it).
   */
  restBeds() {
    this.wind(0, false, 0);
  }

  /**
   * Take back every one-shot still waiting on a timer. roundEnd()/newBest()
   * schedule their arpeggios on setTimeout, and a reflex restart from the
   * result card - R inside the first half-second - lands the new count-in's
   * beat 1 under the tail of the win/lose figure. Notes already built keep
   * their (≤ 0.6 s) decay; notes not yet built are not built. Restart only,
   * beside resetBeds(): a hidden tab needs nothing from this - the suspended
   * context already refuses every deferred voice through _live().
   */
  cancelPending() {
    for (const id of this._pending) clearTimeout(id);
    this._pending.clear();
  }

  /** setTimeout, remembered until it fires or cancelPending() takes it back. */
  _later(fn, ms) {
    const id = setTimeout(() => {
      this._pending.delete(id);
      fn();
    }, ms);
    this._pending.add(id);
    return id;
  }

  setEnabled(on) {
    this.enabled = on;
    if (this.master) this.master.gain.value = on ? 0.55 : 0;
    // The wind and engine beds are driven from wind(), which returns early when
    // sound is off - so without this they would hold their last gain and come
    // back at full level the moment sound is re-enabled.
    if (!on && this.ready) {
      const t = this.ctx.currentTime;
      this.windGain.gain.setTargetAtTime(0, t, 0.05);
      this.engineGain?.gain.setTargetAtTime(0, t, 0.05);
      this.threatGain?.gain.setTargetAtTime(0, t, 0.05);
    }
  }

  /**
   * Called every frame with the player's state. This is the speedometer.
   *
   * The old curve put cruise (40 u/s) at gain 0.098 and full boost (62) at
   * 0.164 - a swing of 0.066 across the entire usable speed range, which is
   * roughly the difference between two rooms and not something you notice while
   * driving. The range that matters is 40 -> 62, so that is the range the ramp
   * is built on now, and it swings about three times as far. It is still a bed,
   * not a racing sim: the peak is deliberately under a quarter of master.
   */
  wind(speed, airborne, dt) {
    if (!this.ready || !this.enabled) return;
    const t = this.ctx.currentTime;
    // 0 at 34 u/s, 1 at 62 u/s, a little past 1 while boosting downhill.
    const n = Math.min(Math.max((speed - 34) / 28, 0), 1.3);
    const shaped = n * n * (3 - 2 * Math.min(n, 1)); // smoothstep, so the low end stays quiet
    const g = shaped * (airborne ? 0.34 : 0.22);
    this.windGain.gain.setTargetAtTime(g, t, 0.09);
    this.windFilter.frequency.setTargetAtTime(
      240 + n * 1150 + (airborne ? 460 : 0),
      t,
      0.12
    );

    // Engine: pitch rises with speed, and it drops away in the air because
    // nothing is touching the ground. That contrast is most of what makes a
    // flight feel like a flight with the eyes closed.
    if (this.engineOscs) {
      const f = 34 + n * 62;
      for (const o of this.engineOscs) o.frequency.setTargetAtTime(f, t, 0.08);
      this.engineFilter.frequency.setTargetAtTime(300 + n * 520, t, 0.1);
      this.engineGain.gain.setTargetAtTime(
        (0.05 + shaped * 0.085) * (airborne ? 0.28 : 1),
        t,
        airborne ? 0.06 : 0.12
      );
    }
  }

  /**
   * The proximity bed, driven on every rendered frame - not, like wind(), only
   * on the playing ones. `mix` is {dist, bearing} for the nearest hunter, or
   * null whenever nothing is hunting (the title, the result, a count-in, kart
   * mode), and null RAMPS the bed out rather than holding it: a threat readout
   * with nothing hunting behind it is misinformation. (The wind and engine
   * used to sit at their last level under a result card as ambience; since
   * restBeds() they come to rest there too - by a ramp on finish/home, the
   * same courtesy, on the same frame.) Pause needs no case of its own - the
   * suspended context silences this bed exactly as it does the others, and
   * resume brings it back at the level it left.
   */
  threat(mix) {
    if (!this.ready || !this.enabled || !this.threatOscs) return;
    const t = this.ctx.currentTime;
    const n = mix ? threatCloseness(mix.dist) : 0;
    // Peak 0.05 against the wind's 0.22 and the sting's 0.13: the bed must
    // never win the mix, only colour it.
    this.threatGain.gain.setTargetAtTime(n * THREAT_BED_GAIN, t, 0.12);
    const f = 88 + n * 70;
    this.threatOscs[0].frequency.setTargetAtTime(f, t, 0.1);
    this.threatOscs[1].frequency.setTargetAtTime(f * 1.06, t, 0.1);
    // The pan only moves while there is a bearing to point at; on null it
    // keeps its last value and fades out pointing where the threat last was.
    if (this.threatPanner && mix) {
      this.threatPanner.pan.setTargetAtTime(threatPan(mix.bearing), t, 0.08);
    }
  }

  // Every one-shot goes through _tone or _noiseBurst, and both refuse to build a
  // voice against a stopped context. roundEnd() is why: it schedules its
  // arpeggio on setTimeout, so a round that ends as the tab is hidden would
  // otherwise queue three oscillators against a frozen currentTime and play them
  // as a ghost tail the moment the player came back.
  //
  // Intent as well as state: suspend() records `wantSuspended` and then chases
  // it, and the chase settles asynchronously - so for the frames between a
  // hide and the context actually stopping, `ctx.state` still reads 'running'
  // while the page has already asked for silence. A voice built in that sliver
  // plays into a hidden tab (a count-in beat is the concrete case: the count
  // keeps ticking under a hide, and its edge lands on exactly such a frame).
  // Intent leads state everywhere else in this file; the refusal follows it.
  _live() {
    return this.ready && this.enabled && !this.wantSuspended && this.ctx.state === 'running';
  }

  _noiseBurst(dur, f0, f1, gain, type = 'bandpass', q = 1.2) {
    if (!this._live()) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const s = ctx.createBufferSource();
    s.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.Q.value = q;
    f.frequency.setValueAtTime(f0, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(40, f1), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    s.connect(f).connect(g).connect(this.master);
    s.start(t);
    s.stop(t + dur + 0.02);
  }

  _tone(freq, dur, gain, type = 'sine', slideTo = null, pan = 0) {
    if (!this._live()) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    let out = o.connect(g);
    // A panned voice gets a panner of its own, built and discarded with it like
    // every other node here; without platform support the voice simply plays
    // in mono - a missing direction, never a missing sound.
    if (pan && ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = clamp(pan, -1, 1);
      out = out.connect(p);
    }
    out.connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  takeoff(speed) {
    if (!this.ready || !this.enabled) return;
    this._noiseBurst(0.42, 380, 2400, 0.22 * Math.min(1, speed / 55));
  }

  landing(quality, speed, airTime = 0) {
    if (!this.ready || !this.enabled) return;
    // A real flight coming down gets a THUMP - lower, longer, louder - so the
    // ear can tell a landing from a bump without looking. Short hops keep the
    // old, lighter tap.
    const big = airTime >= 0.8;
    if (big) {
      this._tone(64, 0.4, 0.42, 'sine', 26);
      this._noiseBurst(0.3, 1100, 90, 0.24 + (1 - quality) * 0.2, 'lowpass', 0.7);
    } else {
      this._tone(92, 0.24, 0.32, 'sine', 38);
      this._noiseBurst(0.18, 900, 180, 0.18 + (1 - quality) * 0.16, 'lowpass', 0.8);
    }
    // The clean-landing chime is the reward beat; it gets brighter the longer
    // you were up.
    if (quality > 0.75) {
      this._tone(720, big ? 0.22 : 0.16, big ? 0.11 : 0.07, 'triangle', 1080);
      if (big) this._tone(1080, 0.18, 0.05, 'sine', 1440);
    }
  }

  boostSurge() {
    if (!this.ready || !this.enabled) return;
    this._tone(150, 0.34, 0.14, 'sawtooth', 620);
    this._noiseBurst(0.3, 500, 1800, 0.12);
  }

  sting(bearing = 0) {
    if (!this.ready || !this.enabled) return;
    // Two clashing notes: recognisable, unpleasant, unmistakably a warning.
    // Panned to the committed hunter's side, because the sting fires exactly
    // when the camera most likely cannot see it.
    const pan = threatPan(bearing);
    this._tone(196, 0.34, STING_LEAD_GAIN, 'square', 174, pan);
    this._tone(277, 0.34, 0.10, 'square', 262, pan);
  }

  hit() {
    if (!this.ready || !this.enabled) return;
    this._tone(70, 0.34, 0.36, 'square', 34);
    this._noiseBurst(0.24, 1600, 120, 0.24, 'lowpass', 0.7);
  }

  chime(step) {
    if (!this.ready || !this.enabled) return;
    // Rises with the chain, so a streak is audible without looking.
    const base = 523.25 * Math.pow(2, Math.min(step, 6) / 12);
    this._tone(base, 0.26, 0.13, 'triangle');
    this._tone(base * 1.5, 0.22, 0.08, 'triangle');
    this._tone(base * 2, 0.18, 0.05, 'sine');
  }

  bump() {
    if (!this.ready || !this.enabled) return;
    this._noiseBurst(0.12, 700, 200, 0.14, 'lowpass', 0.8);
  }

  // The clock's three voices. All bodied in _tone() and nothing else - no
  // setTimeout, unlike roundEnd()/newBest(): every one fires on the frame that
  // detects its edge (view/countbeat.js, fed by main.js), so there is not even
  // a deferred path for a hidden tab to catch. _live() refuses each of them
  // against a stopped context, and the detectors advance regardless, which is
  // why a beat refused into a hide never replays on return.

  /** One count-in beat: fired by main.js on each `beatsLit` edge, resume included. */
  countBeat() {
    if (!this.ready || !this.enabled) return;
    const v = COUNT_BEAT_VOICE;
    this._tone(v.freq, v.dur, v.gain, v.type);
  }

  /**
   * GO: fired on the one frame the count-in hands control back, beside
   * hud.pulseGo() - one frame, one flash, one tone, so the pair cannot drift.
   */
  go() {
    if (!this.ready || !this.enabled) return;
    const v = GO_VOICE;
    const s = GO_SPARKLE_VOICE;
    this._tone(v.freq, v.dur, v.gain, v.type);
    this._tone(s.freq, s.dur, s.gain, s.type);
  }

  /**
   * One final-seconds tick: fixed pitch, fixed gain, no acceleration and no
   * crescendo - the urgency escalation already exists and is visual (the
   * ring's pulse); this only makes the last seconds countable with eyes on
   * the road. main.js fires it at most once per frame.
   */
  tick() {
    if (!this.ready || !this.enabled) return;
    const v = TICK_VOICE;
    this._tone(v.freq, v.dur, v.gain, v.type);
  }

  // The arpeggios' timers are tracked (_later) so a restart can take back the
  // notes still waiting - see cancelPending(); the deferred voices themselves
  // still go through _tone(), so a hidden tab builds none of them either way.
  roundEnd(survived) {
    if (!this.ready || !this.enabled) return;
    if (survived) {
      [523.25, 659.25, 783.99].forEach((f, i) => this._later(() => this._tone(f, 0.5, 0.13, 'triangle'), i * 130));
    } else {
      [392, 311, 233].forEach((f, i) => this._later(() => this._tone(f, 0.6, 0.14, 'sawtooth'), i * 150));
    }
  }

  /**
   * A record. Deliberately not a variation on roundEnd(), because it plays ON
   * TOP of one - most records are set in a round you also lost - so it has to be
   * recognisable against both the rising win arpeggio and the falling down one.
   * It is faster (70 ms apart against 130-150), it climbs past the top of both,
   * and each step carries an octave above it so the whole thing glitters.
   *
   * setTimeout is safe here for the same reason it is in roundEnd(): every voice
   * is built inside _tone(), which refuses a context that is not running, so a
   * record set as the tab is hidden queues nothing to play back later - and the
   * timers are tracked, so a restart takes back what has not sounded yet.
   */
  newBest() {
    if (!this.ready || !this.enabled) return;
    [784, 1046.5, 1318.5, 1568].forEach((f, i) => this._later(() => {
      this._tone(f, 0.26, 0.10, 'triangle');
      this._tone(f * 2, 0.18, 0.035, 'sine');
    }, 60 + i * 70));
  }
}
