// Kart movement. This file is the whole point of the build: everything that
// moves - player, hunters, kos - runs through stepBody(), so a chase is two
// karts riding the same waves rather than one thing chasing another thing.
//
// Three ideas do all the work:
//
//  1. GRIP LAG. Heading turns instantly-ish under steering, but the direction
//     you are actually travelling chases the heading at a finite rate, and that
//     rate drops as you speed up. That single lag gives you carving arcs at low
//     speed and a controllable slide at high speed, with no special drift mode.
//
//  2. GRAVITY EXCHANGE. Gravity is projected along the ground slope you are
//     travelling on and added straight to your speed. Downhill you gain,
//     uphill you bleed, and because the engine is a soft governor rather than a
//     hard clamp, the terrain genuinely decides how fast you are going. Riding
//     the swells is measurably faster than driving a flat line.
//
//  3. LEAVING THE GROUND IS A CONSEQUENCE, NOT A BUTTON. Each step we ask
//     whether letting go would put us above the ground next step. If the crest
//     falls away faster than gravity can pull us into it, we are airborne. No
//     ramps, no jump key - the world launches you when you take a crest fast.
//
// Ground gravity and air gravity are deliberately different constants. The pull
// down a slope is heavy (it should shove you), the arc through the air is
// floaty (it should hang). That 2:1 split is the arcade lie that makes the
// whole thing feel like a kart game instead of a physics demo.

import { TAU, clamp, wrapAngle, angleDelta } from './math.js';

export const KART = {
  // --- engine: a soft governor, so slopes actually move the achieved speed ---
  cruiseTarget: 43, // governor set point; flat equilibrium lands near 40
  boostTarget: 70, // ... and near 62 under boost
  governor: 1.2, // accel per (u/s) of error
  accelMax: 26, // launch punch, and the cap on governor authority
  engineBrakeMax: 6, // how hard the governor pulls you back down
  rollDrag: 0.0022, // quadratic drag; sets the downhill terminal speed
  rollResist: 1.6, // constant coast-down
  brakeDecel: 46,
  maxSpeed: 88,

  // --- steering ---
  turnLow: 2.75, // rad/s at a standstill: tight, twitchy
  turnHigh: 1.22, // rad/s at boost speed: wide, committed
  turnRefSpeed: 62,
  steerLerp: 11, // input smoothing, so no instant flicks
  airSteerScale: 0.26,
  gripLow: 15, // travel-direction catch-up at low speed (planted)
  gripHigh: 5.2, // ... and at high speed (slides)
  airGrip: 20,

  // --- the waves ---
  slopeGravity: 42, // heavy: this is the thing you feel
  // RETUNED (review finding "flight reads as hovering"): the old shape was
  // median peak 2.5 u over 1.14 s with 22% of a boosted weave spent airborne
  // and a flight every 3 s. That is not a jump, it is a hover, and because it
  // happened constantly it never read as an event. The three levers below were
  // swept together (v2fixprobes/f2-sweep, f3-refine, 24 seeds x 75 s each) for
  // "rare, high, smooth": 8-12% airborne, one flight every 10-15 s, median peak
  // >= 7 u, median duration >= 1.4 s, and still zero sub-0.1 s chatter.
  // Measured at these values under boosted weaving: 9.8% airborne, flight every
  // 11.3 s, median peak 7.19 u, median duration 1.79 s, chatter 0%.
  flightGravity: 17, // floaty: this is the thing you enjoy (was 21)
  // takeoffDemand used to BE flightGravity - the same number decided both "how
  // hard does the crest have to fall away before contact breaks" and "how heavy
  // is the arc once it has". They pull in opposite directions: a lighter arc
  // (good) also meant an easier takeoff (bad, more hovering). Splitting them is
  // what lets flight be simultaneously rarer and bigger.
  takeoffDemand: 28,
  // The one honest lie in the flight model. Physically correct takeoffs off
  // these swells are LONG but they skim: the ground falls away underneath at
  // nearly the rate you do, so a 1.3 s flight peaks under a metre up and reads
  // as hovering rather than jumping. A speed-scaled kick at the moment contact
  // breaks buys the arc its height back.
  takeoffPop: 9, // was 4.5
  // Coupled to the retune above, not an independent choice. Air drag is charged
  // per second, so making flights ~60% longer would have made every flight cost
  // ~60% more speed - turning the payoff of the build into a tax on using it.
  // Scaled down by the same ratio (0.0016 * 1.14/1.79) so the speed a flight
  // costs END TO END is where it was: ~3.5% by apex.
  airDrag: 0.0010,
  airborneMinVy: 4.0, // below this we stay stuck to the ground (no chatter; was 2.5)
  landCleanTol: 0.2, // rad of mismatch that still counts as a clean landing
  landMaxLoss: 0.42,
  landCleanBonus: 1.6,

  // --- boost ---
  boostCapacity: 100,
  boostDrain: 100 / 2.2, // 45.45/s -> 2.2 s of boost from full
  boostRegen: 100 / 4.5, // 22.22/s -> 4.5 s back to full
  boostRearm: 34, // drained to zero? no boost until the meter climbs back here

  bodyRadius: 1.55,
};

export function makeBody(opts = {}) {
  return {
    x: opts.x ?? 0,
    z: opts.z ?? 0,
    y: opts.y ?? 0,
    vy: 0,
    speed: opts.speed ?? 0,
    heading: opts.heading ?? 0,
    moveDir: opts.heading ?? 0,
    steer: 0,
    drift: 0, // signed heading-vs-travel gap, for the visual lean
    slope: 0, // dh/ds along travel, for HUD/AI/audio
    airborne: false,
    airTime: 0,
    lastAirTime: 0,
    lastAirPeak: 0,
    airPeak: 0,
    takeoffY: 0,
    boost: KART.boostCapacity,
    boostArmed: true,
    boosting: false,
    landQuality: 1,
    bumped: false,
    radius: opts.radius ?? KART.bodyRadius,
  };
}

const _g = { x: 0, z: 0, h: 0 };

export const EV_TAKEOFF = 'takeoff';
export const EV_LAND = 'land';
export const EV_BUMP = 'bump';

/**
 * Advance one body by one fixed step.
 *
 * @param b       body state (mutated)
 * @param ctl     {throttle:-1..1, steer:-1..1, boost:bool}
 * @param terrain {height, grad, heightAndGrad, wrap}
 * @param P       tuning table (KART or a variant)
 * @param dt      fixed timestep
 * @param events  optional array; cosmetic events are pushed here
 */
export function stepBody(b, ctl, terrain, P, dt, events) {
  // Sanitise at the boundary (m10). A NaN steer used to survive clamp() and
  // then infect heading -> moveDir -> x/z within one step, and nothing
  // downstream could ever recover the body. Non-finite means "no input".
  const throttleIn = ctl.throttle ?? 0;
  const steerRaw = ctl.steer ?? 0;
  const throttle = clamp(Number.isFinite(throttleIn) ? throttleIn : 0, -1, 1);
  const steerIn = clamp(Number.isFinite(steerRaw) ? steerRaw : 0, -1, 1);

  // ---- boost reserve -------------------------------------------------------
  let wantBoost = !!ctl.boost && b.boostArmed && b.boost > 0 && !b.airborne;
  if (wantBoost) {
    b.boost -= P.boostDrain * dt;
    if (b.boost <= 0) {
      b.boost = 0;
      b.boostArmed = false; // hard floor: must climb back to boostRearm
      wantBoost = false;
    }
  } else {
    b.boost = Math.min(P.boostCapacity, b.boost + P.boostRegen * dt);
    if (!b.boostArmed && b.boost >= P.boostRearm) b.boostArmed = true;
  }
  b.boosting = wantBoost;

  // ---- steering: heading turns, travel direction lags ----------------------
  b.steer += (steerIn - b.steer) * (1 - Math.exp(-P.steerLerp * dt));
  const speedFrac = clamp(b.speed / P.turnRefSpeed, 0, 1.25);
  const turnRate = P.turnLow + (P.turnHigh - P.turnLow) * speedFrac;
  const steerScale = b.airborne ? P.airSteerScale : 1;
  b.heading = wrapAngle(b.heading + b.steer * turnRate * steerScale * dt);

  const grip = b.airborne
    ? P.airGrip
    : P.gripLow + (P.gripHigh - P.gripLow) * clamp(b.speed / P.turnRefSpeed, 0, 1);
  const gap = angleDelta(b.heading, b.moveDir);
  b.moveDir = wrapAngle(b.moveDir + gap * (1 - Math.exp(-grip * dt)));
  b.drift = gap;

  const dirX = Math.sin(b.moveDir);
  const dirZ = Math.cos(b.moveDir);

  // ---- the slope we are standing on ---------------------------------------
  terrain.grad(b.x, b.z, _g);
  const slope = _g.x * dirX + _g.z * dirZ; // dh/ds along travel
  b.slope = slope;

  // ---- speed ---------------------------------------------------------------
  let a = 0;
  if (b.airborne) {
    a -= P.airDrag * b.speed * b.speed;
  } else {
    const target = wantBoost ? P.boostTarget : P.cruiseTarget;
    if (throttle > 0) {
      const err = target - b.speed;
      a += clamp(err * P.governor, -P.engineBrakeMax, P.accelMax) * throttle;
    } else if (throttle < 0) {
      a += P.brakeDecel * throttle;
    } else {
      a -= P.rollResist;
    }
    a -= P.rollDrag * b.speed * b.speed;
    // Gravity exchange. Divided by the slope length so a vertical wall would
    // not hand out infinite speed; over our grades this is a ~5% correction.
    a -= (P.slopeGravity * slope) / Math.sqrt(1 + slope * slope);
  }
  b.speed = clamp(b.speed + a * dt, 0, P.maxSpeed);

  // ---- integrate position on the torus ------------------------------------
  b.x = terrain.wrap(b.x + dirX * b.speed * dt);
  b.z = terrain.wrap(b.z + dirZ * b.speed * dt);

  const hNext = terrain.height(b.x, b.z);

  // ---- ground / air --------------------------------------------------------
  if (!b.airborne) {
    // b.vy is the vertical speed the ground handed us last step; vyFollow is
    // what it wants to hand us now. The difference is the vertical acceleration
    // the ground is demanding. If holding us down would take more than gravity
    // has to give, contact breaks and we fly.
    //
    // Testing the ACCELERATION rather than "would a ballistic step end up above
    // the ground" matters: the naive ballistic form carries a factor-of-two
    // discretisation leniency and launches on every mild crest, which turns the
    // medium chop into a constant 0.02 s chatter instead of real flights.
    const vyFollow = (hNext - b.y) / dt;
    const demanded = (vyFollow - b.vy) / dt;
    if (demanded < -(P.takeoffDemand ?? P.flightGravity) && b.vy > P.airborneMinVy) {
      b.airborne = true;
      b.airTime = 0;
      b.takeoffY = b.y;
      b.takeoffVy = b.vy;
      b.airPeak = 0;
      b.vy += P.takeoffPop * clamp(b.speed / P.turnRefSpeed, 0.35, 1.15);
      b.vy -= P.flightGravity * dt;
      b.y = b.y + b.vy * dt;
      if (b.y < hNext) b.y = hNext; // never start a flight underground
      if (events) events.push({ type: EV_TAKEOFF, speed: b.speed, vy: b.vy, body: b });
    } else {
      b.y = hNext;
      b.vy = vyFollow;
    }
  } else {
    b.vy -= P.flightGravity * dt;
    b.y += b.vy * dt;
    b.airTime += dt;
    const rise = b.y - hNext;
    if (rise > b.airPeak) b.airPeak = rise;

    if (b.y <= hNext) {
      // Landing: how close was the flight path to the ground it met?
      const terrAngle = Math.atan(slope);
      const velAngle = Math.atan2(b.vy, Math.max(b.speed, 1e-3));
      const mismatch = Math.abs(velAngle - terrAngle);
      let quality = 1;
      if (mismatch <= P.landCleanTol) {
        b.speed = Math.min(P.maxSpeed, b.speed + P.landCleanBonus);
      } else {
        const f = clamp((mismatch - P.landCleanTol) / 1.05, 0, 1);
        quality = 1 - f;
        b.speed *= 1 - f * P.landMaxLoss;
      }
      b.y = hNext;
      b.vy = b.speed * slope;
      b.airborne = false;
      b.lastAirTime = b.airTime;
      b.lastAirPeak = b.airPeak;
      b.landQuality = quality;
      if (events) {
        events.push({
          type: EV_LAND,
          quality,
          airTime: b.airTime,
          peak: b.airPeak,
          speed: b.speed,
          body: b,
        });
      }
      b.airTime = 0;
    }
  }

  return b;
}

// Apply a speed multiplier from a landmark nudge, and flag it for the view.
export function applyBump(b, mult, events) {
  if (mult >= 1) {
    b.bumped = false;
    return;
  }
  b.speed *= mult;
  if (!b.bumped && events) events.push({ type: EV_BUMP, body: b, speed: b.speed });
  b.bumped = true;
}

// Steering command that turns a body toward a world direction, used by every AI.
export function steerToward(b, targetDirX, targetDirZ, gain = 1.9) {
  const want = Math.atan2(targetDirX, targetDirZ);
  return clamp(angleDelta(want, b.heading) * gain, -1, 1);
}

export { TAU };
