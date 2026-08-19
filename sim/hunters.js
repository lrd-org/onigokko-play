// The two hunters. They are karts, not homing missiles: every one of them runs
// the same stepBody() the player does, so they gain speed down the same swells,
// bleed it up the same climbs, and fly off the same crests. A chase reads as two
// things riding one landscape rather than a chaser glued to a target.
//
// Everything dangerous about them is bounded and announced:
//   * only ONE may be committed to a damaging lunge at a time
//   * a commit spends its first 0.7 s unable to damage anything, in a posture
//     the view can draw and the audio can sting - and if the committing hunter
//     is offscreen the HUD owes the player a directional wedge, because with a
//     camera that rotates behind you, a threat from behind is invisible
//   * a commit cannot start closer than 22 u, so it is never a spawn-on-top
//   * after a landed hit both of them back off for 1.5 s
//
// None of that is decoration. The tests assert all four.

import { clamp, angleDelta, TAU } from './math.js';
import { KART, makeBody, stepBody, steerToward } from './movement.js';
import { wrapDelta, wrappedDist, wrap, height } from './terrain.js';

export const HUNTER = {
  ...KART,
  cruiseTarget: 45, // flat equilibrium ~42 (patrol)
  catchupTarget: 50, // ~46 (closing)
  commitTarget: 73, // ~65 (the lunge; spec band 64-68)
  turnLow: 2.5,
  turnHigh: 1.15,
  gripLow: 14,
  gripHigh: 5.0,
  bodyRadius: 1.7,
};

export const HUNT = {
  planHz: 4.5, // re-aim 4-5 times a second, not every frame
  reactionDelay: 0.25, // they aim at where you were a quarter second ago
  leadTime: 1.35, // the cutter aims at where that puts you next
  telegraph: 0.7, // wind-up during which the lunge cannot damage
  strike: 1.1, // the part that can
  cooldown: 3.5,
  backoff: 1.5, // both hunters, after any landed hit
  minLaunchDist: 22,
  maxLaunchDist: 42,
  catchupDist: 60,
  // Bodies are r=1.7 and r=1.55, so touching is 3.25 u; a hair over that means
  // a landed hit always looks like contact and never like a near miss.
  hitRadius: 3.6,
  // ... and the SAME reach vertically (M5). Horizontal-only contact meant a
  // hunter could pass ten metres underneath an airborne player and still take
  // 40 hp off them. Combined body reach is 1.7 + 1.55 = 3.25, rounded to 3.3.
  hitVertical: 3.3,
  backoffTarget: 40,
  // --- commit honesty (M4) ------------------------------------------------
  // A commit is a promise to the player that something is coming. It used to be
  // legal to make that promise while DRIFTING AWAY from them: 68% of commits
  // never got within 12 u, which meant two thirds of every warning the game
  // gave - wedge and audio sting alike - was a lie, and the reviewers measured
  // the player learning to ignore all of them.
  // u/s of actual closure required to launch a lunge. 14 is not "greater than
  // zero with a safety margin" - it is the measured knee. A pure tail chase
  // gains about 2 u/s, which is why a hunter sitting on your bumper at cruise
  // no longer promises a lunge it would spend two seconds failing to deliver;
  // what clears 14 is converging GEOMETRY (you turning across it, it cutting
  // your line), which is exactly the situation the warning exists for.
  minClosingSpeed: 14,
  // ...and closure alone is not enough, because "closing at 3 u/s from 40 u
  // away" is still a lunge that cannot possibly arrive. A commit is only
  // allowed if the gap can actually be crossed inside the lunge's own lifetime
  // (telegraph + strike). Requiring merely positive closure moved the measured
  // false-positive rate 68% -> 66%; requiring REACHABILITY is what moves it.
  // The intercept solution below is OPTIMISTIC on purpose - it is a closed form
  // that assumes the hunter is already at lunge speed, holds a perfect line, and
  // that the player never turns. None of those are true, so the answer it gives
  // has to be discounted before it is believed. 0.45 is measured, not guessed:
  // swept in v2fixprobes/f6-reachsweep against the reviewers' own false-positive
  // definition, it is the point where wedges stop being mostly lies (68% -> 22%
  // at the commit gate alone) while the round still threatens the player a
  // couple of times (sting p50 2). Loosening it to 1.0 puts false positives
  // straight back at 63%; tightening it past ~0.48 stops a tail chase from ever
  // being able to lunge at all, which would delete a whole threat vector rather
  // than make it honest.
  reachMargin: 0.5,
  lungeSpeedFrac: 0.9, // commitTarget is a governor set point, not an achieved speed
  // A telegraph that has been outrun is cancelled at the end of the wind-up
  // rather than striking empty air 30-40 u from anyone. STRIKE is never
  // cancelled - once the lunge is committed it is committed.
  escapeGrowth: 8, // u the gap must have grown by since launch
  cancelCooldown: 1.8, // shorter than a spent lunge: nothing was spent
};

export const PHASE_CHASE = 'chase';
export const PHASE_TELEGRAPH = 'telegraph';
export const PHASE_STRIKE = 'strike';
export const PHASE_COOLDOWN = 'cooldown';
export const PHASE_BACKOFF = 'backoff';

export function makeHunter(role, opts = {}) {
  const b = makeBody({ ...opts, radius: HUNTER.bodyRadius });
  b.role = role; // 'pressure' (from behind) | 'cut' (across your nose)
  b.phase = PHASE_CHASE;
  b.phaseTimer = 0;
  b.cooldownTimer = 0;
  b.planTimer = 0;
  b.aimX = b.x;
  b.aimZ = b.z;
  b.committed = false; // telegraph or strike - the state the token guards
  b.menace = 0; // 0..1, drives the view's posture and glow
  b.params = { ...HUNTER };
  b.distToPlayer = Infinity;
  return b;
}

// A short history of the player, so hunters aim at a slightly stale target.
// This is the single biggest reason they feel like they are reacting to you
// instead of predicting you.
export function makeTrail(steps) {
  return {
    x: new Float64Array(steps),
    z: new Float64Array(steps),
    vx: new Float64Array(steps),
    vz: new Float64Array(steps),
    n: steps,
    head: 0,
    filled: 0,
  };
}

export function pushTrail(trail, x, z, vx, vz) {
  trail.head = (trail.head + 1) % trail.n;
  trail.x[trail.head] = x;
  trail.z[trail.head] = z;
  trail.vx[trail.head] = vx;
  trail.vz[trail.head] = vz;
  if (trail.filled < trail.n) trail.filled++;
}

export function sampleTrail(trail, stepsBack, out) {
  const back = Math.min(stepsBack, trail.filled - 1);
  let i = (trail.head - Math.max(0, back)) % trail.n;
  if (i < 0) i += trail.n;
  out.x = trail.x[i];
  out.z = trail.z[i];
  out.vx = trail.vx[i];
  out.vz = trail.vz[i];
  return out;
}

const _s = { x: 0, z: 0, vx: 0, vz: 0 };

/**
 * Plan + drive both hunters for one step.
 *
 * @param state  {hunters, trail, commitToken, backoffTimer}
 * @param player player body
 * @param terrain
 * @param dt
 * @param events
 * @returns index of the hunter that landed a hit this step, or -1
 */
export function stepHunters(state, player, terrain, dt, events, prng, playerInvuln) {
  const hunters = state.hunters;
  const delaySteps = Math.round(HUNT.reactionDelay / dt);
  sampleTrail(state.trail, delaySteps, _s);

  if (state.backoffTimer > 0) state.backoffTimer -= dt;

  let hitBy = -1;

  for (let i = 0; i < hunters.length; i++) {
    const h = hunters[i];
    const dx = wrapDelta(player.x, h.x);
    const dz = wrapDelta(player.z, h.z);
    const dist = Math.sqrt(dx * dx + dz * dz);
    h.distToPlayer = dist;
    // Rate at which the gap is actually shrinking, from the two velocities
    // rather than from frame-to-frame distance: positive means this hunter is
    // gaining on the player right now. This is the single fact the old commit
    // gate never asked for.
    const closing = closingSpeed(h, player, dx, dz, dist);
    h.closingSpeed = closing;
    // ... and the same question asked about the lunge this hunter is deciding
    // whether to start: at the speed a lunge actually reaches, against the
    // player's current escape, does the gap close to contact before the lunge
    // expires?
    h.canReach = lungeReaches(h, player, dx, dz, dist);

    // ---- phase machine ----------------------------------------------------
    h.phaseTimer -= dt;
    if (h.cooldownTimer > 0) h.cooldownTimer -= dt;

    if (state.backoffTimer > 0 && h.phase !== PHASE_BACKOFF) {
      if (h.committed) releaseToken(state, i);
      h.phase = PHASE_BACKOFF;
      h.phaseTimer = state.backoffTimer;
      h.committed = false;
    }

    switch (h.phase) {
      case PHASE_BACKOFF:
        if (h.phaseTimer <= 0) {
          h.phase = PHASE_COOLDOWN;
          h.phaseTimer = 0;
          h.cooldownTimer = Math.max(h.cooldownTimer, 0.8);
        }
        break;

      case PHASE_CHASE:
        if (
          state.commitToken === -1 &&
          state.backoffTimer <= 0 &&
          h.cooldownTimer <= 0 &&
          dist >= HUNT.minLaunchDist &&
          dist <= HUNT.maxLaunchDist &&
          closing >= HUNT.minClosingSpeed &&
          h.canReach
        ) {
          state.commitToken = i;
          h.committed = true;
          h.phase = PHASE_TELEGRAPH;
          h.phaseTimer = HUNT.telegraph;
          h.launchDist = dist;
          if (events) events.push({ type: 'sting', hunter: i, dist });
        }
        break;

      case PHASE_TELEGRAPH:
        if (h.phaseTimer <= 0) {
          // Did they get away during the wind-up? Both conditions have to hold:
          // the gap has grown clear of the band the lunge was launched in AND
          // it is still growing. A player who turned back into the hunter, or
          // who is merely far but closing, still gets struck at.
          const escaped = dist > (h.launchDist ?? 0) + HUNT.escapeGrowth && closing <= 0;
          if (escaped) {
            releaseToken(state, i);
            h.committed = false;
            h.phase = PHASE_COOLDOWN;
            h.cooldownTimer = HUNT.cancelCooldown;
            if (events) events.push({ type: 'commitCancel', hunter: i, dist });
          } else {
            h.phase = PHASE_STRIKE;
            h.phaseTimer = HUNT.strike;
          }
        }
        break;

      case PHASE_STRIKE:
        if (h.phaseTimer <= 0) {
          releaseToken(state, i);
          h.committed = false;
          h.phase = PHASE_COOLDOWN;
          h.cooldownTimer = HUNT.cooldown;
        }
        break;

      case PHASE_COOLDOWN:
        if (h.cooldownTimer <= 0) h.phase = PHASE_CHASE;
        break;

      default:
        h.phase = PHASE_CHASE;
    }

    // ---- aim (4-5 Hz, on stale player data) --------------------------------
    h.planTimer -= dt;
    if (h.planTimer <= 0) {
      h.planTimer = 1 / HUNT.planHz;
      planAim(h, state, dist, prng);
    }

    // ---- drive -------------------------------------------------------------
    const tx = wrapDelta(h.aimX, h.x);
    const tz = wrapDelta(h.aimZ, h.z);
    const len = Math.hypot(tx, tz) || 1;
    const committed = h.phase === PHASE_TELEGRAPH || h.phase === PHASE_STRIKE;
    const steer = steerToward(h, tx / len, tz / len, committed ? 2.7 : 2.1);

    const p = h.params;
    if (h.phase === PHASE_BACKOFF) p.cruiseTarget = HUNT.backoffTarget;
    else if (h.phase === PHASE_TELEGRAPH || h.phase === PHASE_STRIKE) p.cruiseTarget = HUNTER.commitTarget;
    else if (dist > HUNT.catchupDist) p.cruiseTarget = HUNTER.catchupTarget;
    else p.cruiseTarget = HUNTER.cruiseTarget;

    stepBody(h, { throttle: 1, steer, boost: false }, terrain, p, dt, events);

    // Menace drives the silhouette: spikes flare and the eyes brighten through
    // the telegraph so the wind-up is legible even without the audio.
    const wantMenace =
      h.phase === PHASE_TELEGRAPH ? 1 - Math.max(0, h.phaseTimer) / HUNT.telegraph
        : h.phase === PHASE_STRIKE ? 1
          : 0;
    h.menace += (wantMenace - h.menace) * (1 - Math.exp(-9 * dt));

    // ---- damage ------------------------------------------------------------
    // Contact is a SPHERE, not a column (M5). Flight is supposed to be evasive;
    // it cannot be, if a hunter skimming the trough beneath you counts as
    // touching you.
    if (h.phase === PHASE_STRIKE && !playerInvuln && hitBy === -1) {
      const rr = HUNT.hitRadius + player.radius * 0.35;
      if (dist < rr && Math.abs(player.y - h.y) <= HUNT.hitVertical) hitBy = i;
    }
  }

  return hitBy;
}

// Positive = the gap is closing. Derived from the two velocity vectors rather
// than from differencing distance, so it is exact and needs no history.
function closingSpeed(h, player, dx, dz, dist) {
  if (dist < 1e-6) return 0;
  const hvx = Math.sin(h.moveDir) * h.speed;
  const hvz = Math.cos(h.moveDir) * h.speed;
  const pvx = Math.sin(player.moveDir) * player.speed;
  const pvz = Math.cos(player.moveDir) * player.speed;
  return ((hvx - pvx) * dx + (hvz - pvz) * dz) / dist;
}

// Can a lunge started right now physically arrive?
//
// The first version of this asked only whether the gap was shrinking fast
// enough along the line between the two bodies, and it changed nothing (68% ->
// 66% false positives) because it scores a player running SIDEWAYS as trivially
// catchable - when sideways is in fact the hardest case, since the hunter has to
// cover the lateral displacement as well and has a finite turn rate.
//
// So solve the actual interception: the smallest t > 0 at which a body moving
// at the lunge speed from here meets a player holding their current velocity.
//   |r + vp t| = s t   ->   (|vp|^2 - s^2) t^2 + 2 (r.vp) t + |r|^2 = 0
// No positive root means this lunge can never arrive, whatever it does. The
// turn the hunter still has to make is charged on top, at its high-speed turn
// rate - a lunge that would need a 150 degree pivot first is not a lunge.
function interceptTime(h, player, dx, dz, dist) {
  const s = HUNTER.commitTarget * HUNT.lungeSpeedFrac;
  const vx = Math.sin(player.moveDir) * player.speed;
  const vz = Math.cos(player.moveDir) * player.speed;
  const a = vx * vx + vz * vz - s * s;
  const b = 2 * (dx * vx + dz * vz);
  const c = dist * dist;

  let t;
  if (Math.abs(a) < 1e-6) {
    if (Math.abs(b) < 1e-9) return Infinity;
    t = -c / b;
  } else {
    const disc = b * b - 4 * a * c;
    if (disc < 0) return Infinity;
    const rt = Math.sqrt(disc);
    const t1 = (-b - rt) / (2 * a);
    const t2 = (-b + rt) / (2 * a);
    t = Math.min(t1 > 1e-6 ? t1 : Infinity, t2 > 1e-6 ? t2 : Infinity);
  }
  if (!(t > 0) || !Number.isFinite(t)) return Infinity;

  // The pivot the hunter owes before it can fly down that line.
  const wantHeading = Math.atan2(dx + vx * t, dz + vz * t);
  const turn = Math.abs(angleDelta(wantHeading, h.heading));
  return t + turn / HUNTER.turnHigh;
}

function lungeReaches(h, player, dx, dz, dist) {
  if (dist < 1e-6) return true;
  return interceptTime(h, player, dx, dz, dist)
    <= (HUNT.telegraph + HUNT.strike) * HUNT.reachMargin;
}

function releaseToken(state, i) {
  if (state.commitToken === i) state.commitToken = -1;
}

function planAim(h, state, dist, prng) {
  const s = _s;
  // A little seeded scatter so the two of them do not stack into one dot.
  const jitter = prng ? (prng.next() - 0.5) * 6 : 0;

  if (h.phase === PHASE_BACKOFF) {
    // Run away from where the player was, not where they are: still readable,
    // still not a teleport.
    const ax = wrapDelta(h.x, s.x);
    const az = wrapDelta(h.z, s.z);
    const L = Math.hypot(ax, az) || 1;
    h.aimX = wrap(h.x + (ax / L) * 70);
    h.aimZ = wrap(h.z + (az / L) * 70);
    return;
  }

  // Everything is extrapolated from the STALE sample, never the live player.
  // The reactionDelay term only buys back the staleness - it puts the aim point
  // at roughly where the player is now IF they held their line. Turn, and the
  // hunter is aiming at empty ground. That is the whole counterplay.
  let lead = HUNT.reactionDelay;
  if (h.role === 'cut') {
    lead += h.phase === PHASE_TELEGRAPH || h.phase === PHASE_STRIKE ? HUNT.leadTime * 0.55 : HUNT.leadTime;
  } else {
    lead += dist > HUNT.catchupDist ? 0.55 : 0.12;
  }
  h.aimX = wrap(s.x + s.vx * lead + jitter);
  h.aimZ = wrap(s.z + s.vz * lead + jitter);
}

// Placement that never drops a hunter in the player's lap.
export function placeHunter(h, prng, player, minDist = 70, maxDist = 120) {
  const ang = prng.next() * TAU;
  const d = minDist + prng.next() * (maxDist - minDist);
  h.x = wrap(player.x + Math.sin(ang) * d);
  h.z = wrap(player.z + Math.cos(ang) * d);
  h.y = height(h.x, h.z);
  h.speed = 30;
  h.heading = Math.atan2(wrapDelta(player.x, h.x), wrapDelta(player.z, h.z));
  h.moveDir = h.heading;
  h.aimX = player.x;
  h.aimZ = player.z;
  return h;
}

export { wrappedDist };
