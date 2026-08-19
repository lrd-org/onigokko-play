// The round. Fixed 1/120 s steps, one seeded PRNG, no clocks, no DOM, no
// Three.js - hand it a seed and an input stream and it replays exactly.
//
// Two modes, and the split is deliberate. 'kart' runs the world and the
// movement and nothing else: it is the mode the whole build was verified in
// first, because the owner's direction was that this has to feel like a kart
// game BEFORE it is a survival game. 'ofa' adds the hunters, the kos and the
// clock on top of an unchanged kart core.

import { clamp, TAU } from './math.js';
import { makePrng } from './prng.js';
import { KART, makeBody, stepBody, applyBump } from './movement.js';
import {
  worldTerrain, PERIOD, height, wrap, wrapDelta, wrappedDist,
  makeLandmarks, resolveLandmarks, regionAt,
} from './terrain.js';
import {
  HUNT, makeHunter, makeTrail, pushTrail, stepHunters, placeHunter,
  PHASE_TELEGRAPH, PHASE_STRIKE,
} from './hunters.js';
import { KO_RULES, makeKo, scatterKo, stepKos } from './kos.js';

export const FIXED_DT = 1 / 120;
export const MAX_FRAME_DT = 0.1;
export const MAX_CATCHUP_STEPS = 12;

export const RULES = {
  roundTime: 75,
  playerHp: 100,
  hunterDamage: 40,
  controlLoss: 0.45,
  invuln: 1.0,
  hpPerPip: 40, // 100 hp / 40 dmg -> three pips, down in three
};

export const STATE_READY = 'ready';
export const STATE_PLAYING = 'playing';
export const STATE_SURVIVED = 'survived';
export const STATE_DOWN = 'down';

export class Game {
  constructor(opts = {}) {
    this.seed = opts.seed ?? 1;
    this.mode = opts.mode ?? 'ofa'; // 'kart' | 'ofa'
    this.terrain = opts.terrain ?? worldTerrain;
    this.events = [];
    this.reset(this.seed);
  }

  reset(seed = this.seed) {
    this.seed = seed;
    this.prng = makePrng(seed);
    this.time = 0;
    this.steps = 0;
    this.state = this.mode === 'kart' ? STATE_PLAYING : STATE_READY;

    this.landmarks = makeLandmarks(this.prng);

    const px = this.prng.next() * PERIOD;
    const pz = this.prng.next() * PERIOD;
    this.player = makeBody({ x: px, z: pz, heading: this.prng.next() * TAU });
    this.player.y = height(px, pz);
    this.player.hp = RULES.playerHp;
    this.player.stun = 0;
    this.player.invuln = 0;
    this.player.hitFlash = 0;

    this.trail = makeTrail(96);

    this.hunterState = {
      hunters: [makeHunter('pressure'), makeHunter('cut')],
      trail: this.trail,
      commitToken: -1,
      backoffTimer: 0,
    };
    for (const h of this.hunterState.hunters) placeHunter(h, this.prng, this.player);

    this.koState = { kos: [], chain: 0, chainTimer: 0, score: 0, caught: 0 };
    for (let i = 0; i < KO_RULES.count; i++) {
      const k = makeKo(this.prng, {});
      scatterKo(k, this.prng, this.player);
      this.koState.kos.push(k);
    }

    this.timeLeft = RULES.roundTime;
    this.hits = 0;
    this.bestChain = 0;
    this.airTimeTotal = 0;
    this.flights = 0;
    this.distance = 0;
    this.topSpeed = 0;
    this.events.length = 0;
    return this;
  }

  start() {
    // The hit flash is frozen wherever it was when the round ended, because
    // step() early-returns once the round is over. Clearing it here as well as
    // in reset() means no path can begin a round with the player still lit up
    // from the death that ended the last one.
    this.player.hitFlash = 0;
    if (this.state === STATE_READY) this.state = STATE_PLAYING;
    return this;
  }

  get hunters() { return this.hunterState.hunters; }
  get kos() { return this.koState.kos; }
  get score() { return this.koState.score; }
  get chain() { return this.koState.chain; }
  get hpPips() { return Math.max(0, Math.ceil(this.player.hp / RULES.hpPerPip)); }
  get finished() { return this.state === STATE_SURVIVED || this.state === STATE_DOWN; }

  /** The committed hunter, if any is currently winding up or striking. */
  get threat() {
    const i = this.hunterState.commitToken;
    if (i < 0) return null;
    const h = this.hunterState.hunters[i];
    return h.phase === PHASE_TELEGRAPH || h.phase === PHASE_STRIKE ? h : null;
  }

  /** One fixed step. `input` is {throttle, steer, boost}. */
  step(input) {
    const dt = FIXED_DT;
    const p = this.player;
    const ev = this.events;

    if (this.state !== STATE_PLAYING) {
      // Frozen, but the world still holds still rather than jumping when we
      // resume: nothing integrates.
      return;
    }

    // --- control loss ------------------------------------------------------
    let ctl = input;
    if (p.stun > 0) {
      p.stun -= dt;
      ctl = STUNNED;
    }
    if (p.invuln > 0) p.invuln -= dt;
    if (p.hitFlash > 0) p.hitFlash = Math.max(0, p.hitFlash - dt);

    const beforeX = p.x;
    const beforeZ = p.z;
    const wasAir = p.airborne;

    stepBody(p, ctl, this.terrain, KART, dt, ev);
    applyBump(p, resolveLandmarks(p, this.landmarks, p.radius), ev);

    this.distance += Math.hypot(wrapDelta(p.x, beforeX), wrapDelta(p.z, beforeZ));
    if (p.speed > this.topSpeed) this.topSpeed = p.speed;
    if (p.airborne) this.airTimeTotal += dt;
    if (p.airborne && !wasAir) this.flights++;

    pushTrail(this.trail, p.x, p.z, Math.sin(p.moveDir) * p.speed, Math.cos(p.moveDir) * p.speed);

    if (this.mode === 'ofa') {
      const hitBy = stepHunters(this.hunterState, p, this.terrain, dt, ev, this.prng, p.invuln > 0);
      if (hitBy >= 0) this.applyHit(hitBy, ev);

      stepKos(this.koState, p, this.terrain, dt, ev, this.prng);
      if (this.koState.chain > this.bestChain) this.bestChain = this.koState.chain;

      // Only a round that is still live has a clock. A hit landed above can
      // already have ended it, and the clock must not get a second opinion: it
      // used to run anyway, and a death on the very last step overwrote DOWN
      // with SURVIVED and pushed a second, winning roundEnd behind the losing
      // one. Whichever ending comes first in the step is the ending.
      if (!this.finished) {
        this.timeLeft -= dt;
        if (this.timeLeft <= 0) {
          this.timeLeft = 0;
          this.state = STATE_SURVIVED;
          ev.push({ type: 'roundEnd', survived: true, score: this.score });
        }
      }
    }

    this.time += dt;
    this.steps++;
  }

  applyHit(hunterIndex, ev) {
    const p = this.player;
    p.hp = Math.max(0, p.hp - RULES.hunterDamage);
    p.stun = RULES.controlLoss;
    p.invuln = RULES.invuln;
    p.hitFlash = 0.5;
    p.speed *= 0.55;
    this.hits++;

    // Both of them give you room; nobody piles on a player who just took one.
    this.hunterState.backoffTimer = HUNT.backoff;
    this.koState.chain = 0;
    this.koState.chainTimer = 0;

    ev.push({ type: 'hit', hunter: hunterIndex, hp: p.hp, pips: this.hpPips });

    if (p.hp <= 0) {
      this.state = STATE_DOWN;
      ev.push({ type: 'roundEnd', survived: false, score: this.score });
    }
  }

  /**
   * Advance by a wall-clock delta with a fixed-step accumulator.
   * Returns the 0..1 interpolation alpha for rendering.
   */
  advance(frameDt, input, accumulator) {
    // m11: clamped at BOTH ends. Math.min alone let a negative frameDt through
    // (a backwards timestamp on tab restore or a clock adjustment), which walks
    // the accumulator backwards and stalls the sim until it climbs out - and a
    // non-finite one poisoned the accumulator permanently.
    let acc = accumulator.value + clamp(frameDt, 0, MAX_FRAME_DT);
    let steps = 0;
    while (acc >= FIXED_DT && steps < MAX_CATCHUP_STEPS) {
      this.snapshotPrev();
      this.step(input);
      acc -= FIXED_DT;
      steps++;
    }
    if (steps >= MAX_CATCHUP_STEPS) acc = 0; // give up rather than spiral
    accumulator.value = acc;
    return acc / FIXED_DT;
  }

  /** Copy the render-relevant fields so the view can interpolate. */
  snapshotPrev() {
    snap(this.player);
    for (const h of this.hunterState.hunters) snap(h);
    for (const k of this.koState.kos) snap(k);
  }

  info() {
    const p = this.player;
    return {
      mode: this.mode,
      state: this.state,
      seed: this.seed,
      t: +this.time.toFixed(2),
      timeLeft: +this.timeLeft.toFixed(2),
      speed: +p.speed.toFixed(1),
      slope: +p.slope.toFixed(3),
      airborne: p.airborne,
      airTime: +p.airTime.toFixed(2),
      lastFlight: +p.lastAirTime.toFixed(2),
      lastPeak: +p.lastAirPeak.toFixed(2),
      boost: +p.boost.toFixed(0),
      hp: p.hp,
      pips: this.hpPips,
      score: this.score,
      chain: this.chain,
      hits: this.hits,
      flights: this.flights,
      airTimeTotal: +this.airTimeTotal.toFixed(1),
      region: regionAt(p.x, p.z),
      pos: [+p.x.toFixed(1), +p.z.toFixed(1), +p.y.toFixed(1)],
      threat: this.threat ? this.threat.role : null,
    };
  }
}

const STUNNED = { throttle: 0, steer: 0, boost: false };

function snap(b) {
  b.px = b.x;
  b.pz = b.z;
  b.py = b.y;
  b.pheading = b.heading;
  b.pmoveDir = b.moveDir;
  b.pspeed = b.speed;
  b.pdrift = b.drift;
}

// ---------------------------------------------------------------------------
// Deterministic state fingerprint. Hashes raw float bits, so it catches any
// divergence at all rather than agreeing to within a rounding tolerance.
// ---------------------------------------------------------------------------
const _f64 = new Float64Array(1);
const _u32 = new Uint32Array(_f64.buffer);

export function hashState(game) {
  let h = 2166136261 >>> 0;
  const fold = (v) => {
    _f64[0] = v;
    h = (Math.imul(h ^ _u32[0], 16777619) >>> 0);
    h = (Math.imul(h ^ _u32[1], 16777619) >>> 0);
  };
  const body = (b) => {
    fold(b.x); fold(b.z); fold(b.y); fold(b.vy);
    fold(b.speed); fold(b.heading); fold(b.moveDir); fold(b.steer);
    fold(b.boost); fold(b.airTime);
    fold(b.airborne ? 1 : 0);
  };
  body(game.player);
  fold(game.player.hp); fold(game.player.stun); fold(game.player.invuln);
  for (const hn of game.hunterState.hunters) {
    body(hn);
    fold(hn.phaseTimer); fold(hn.cooldownTimer); fold(hn.aimX); fold(hn.aimZ);
  }
  fold(game.hunterState.commitToken);
  fold(game.hunterState.backoffTimer);
  for (const k of game.koState.kos) {
    body(k);
    fold(k.alive ? 1 : 0); fold(k.respawnTimer); fold(k.aimX); fold(k.aimZ);
  }
  fold(game.koState.score); fold(game.koState.chain); fold(game.koState.chainTimer);
  fold(game.timeLeft); fold(game.steps);
  return h >>> 0;
}

export { PERIOD, wrapDelta, wrappedDist, height, wrap, clamp };
