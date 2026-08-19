// Kos: the friendly blobs. They are the reason to leave a safe line - the only
// scoring in the game is running one down, and the chain window means the good
// play is to string them together while two hunters are trying to make you stop.
//
// They ride the same waves as everything else, just slower, and they respawn
// somewhere else on the tile when caught so the world never empties out.

import { TAU, clamp } from './math.js';
import { KART, makeBody, stepBody, steerToward } from './movement.js';
import { wrap, wrapDelta, height } from './terrain.js';

export const KO = {
  ...KART,
  cruiseTarget: 33, // flat equilibrium ~31 - always slower than the player
  turnLow: 2.9,
  turnHigh: 1.6,
  gripLow: 16,
  gripHigh: 7,
  bodyRadius: 1.15,
};

export const KO_RULES = {
  count: 6,
  fleeRadius: 24,
  catchRadius: 2.7,
  respawnDelay: 1.2,
  respawnMinDist: 110,
  respawnMaxDist: 260,
  wanderRetarget: 3.4,
  chainWindow: 6.0,
  baseScore: 100,
  maxMultiplier: 6,
};

export function makeKo(prng, opts = {}) {
  const k = makeBody({ ...opts, radius: KO.bodyRadius });
  k.alive = true;
  k.respawnTimer = 0;
  k.wanderTimer = 0;
  k.aimX = k.x;
  k.aimZ = k.z;
  k.fleeing = 0; // 0..1, drives ear-flatten / eye-widen in the view
  k.hue = prng.next();
  k.params = { ...KO };
  return k;
}

export function scatterKo(k, prng, player) {
  const ang = prng.next() * TAU;
  const d = KO_RULES.respawnMinDist + prng.next() * (KO_RULES.respawnMaxDist - KO_RULES.respawnMinDist);
  k.x = wrap(player.x + Math.sin(ang) * d);
  k.z = wrap(player.z + Math.cos(ang) * d);
  k.y = height(k.x, k.z);
  k.speed = 12;
  k.heading = prng.next() * TAU;
  k.moveDir = k.heading;
  k.vy = 0;
  k.airborne = false;
  k.alive = true;
  k.respawnTimer = 0;
  k.wanderTimer = 0;
  k.aimX = k.x;
  k.aimZ = k.z;
  return k;
}

/**
 * Step every ko. Returns the number caught this call; catches are pushed as
 * events with the score they earned.
 *
 * @param state {kos, chain, chainTimer, score}
 */
export function stepKos(state, player, terrain, dt, events, prng) {
  const kos = state.kos;
  let caught = 0;

  if (state.chainTimer > 0) {
    state.chainTimer -= dt;
    if (state.chainTimer <= 0) state.chain = 0;
  }

  for (let i = 0; i < kos.length; i++) {
    const k = kos[i];

    if (!k.alive) {
      k.respawnTimer -= dt;
      if (k.respawnTimer <= 0) scatterKo(k, prng, player);
      continue;
    }

    const dx = wrapDelta(player.x, k.x);
    const dz = wrapDelta(player.z, k.z);
    const dist = Math.sqrt(dx * dx + dz * dz);

    // --- pick somewhere to be -------------------------------------------
    const scared = dist < KO_RULES.fleeRadius;
    k.fleeing += ((scared ? 1 : 0) - k.fleeing) * (1 - Math.exp(-7 * dt));

    k.wanderTimer -= dt;
    if (scared) {
      // Straight away from the player, refreshed every step: panic, not a plan.
      const L = dist || 1;
      k.aimX = wrap(k.x - (dx / L) * 60);
      k.aimZ = wrap(k.z - (dz / L) * 60);
      k.wanderTimer = 0;
    } else if (k.wanderTimer <= 0) {
      k.wanderTimer = KO_RULES.wanderRetarget * (0.6 + prng.next() * 0.8);
      const ang = prng.next() * TAU;
      const d = 60 + prng.next() * 140;
      k.aimX = wrap(k.x + Math.sin(ang) * d);
      k.aimZ = wrap(k.z + Math.cos(ang) * d);
    }

    const tx = wrapDelta(k.aimX, k.x);
    const tz = wrapDelta(k.aimZ, k.z);
    const L2 = Math.hypot(tx, tz) || 1;
    const steer = steerToward(k, tx / L2, tz / L2, 2.0);
    const throttle = scared ? 1 : 0.72;
    stepBody(k, { throttle, steer, boost: false }, terrain, k.params, dt, null);

    // --- caught? ---------------------------------------------------------
    if (dist < KO_RULES.catchRadius + player.radius * 0.2) {
      k.alive = false;
      k.respawnTimer = KO_RULES.respawnDelay;
      caught++;
      state.chain = state.chainTimer > 0 ? state.chain + 1 : 1;
      state.chainTimer = KO_RULES.chainWindow;
      const mult = Math.min(state.chain, KO_RULES.maxMultiplier);
      const gained = KO_RULES.baseScore * mult;
      state.score += gained;
      state.caught++;
      if (events) {
        events.push({ type: 'ko', index: i, chain: state.chain, multiplier: mult, score: gained, x: k.x, z: k.z, y: k.y });
      }
    }
  }

  return caught;
}

export { clamp };
