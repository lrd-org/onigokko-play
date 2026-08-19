// The world is one 1200x1200 tile of open, wavy ground that wraps in both axes.
// There is no edge and no wall: running any direction forever just brings you
// back around, and because every wave component is an INTEGER number of cycles
// per period, the wrap is exact to float precision - no seam to see or to hit.
//
// Height is analytic. The simulation never samples a mesh; the renderer and the
// physics read the same closed-form function, so what you fly off is exactly
// what you saw.

import { TAU, clamp } from './math.js';

export const PERIOD = 1200;

// Each wave is a * sin(TAU * (nx*x + nz*z) / PERIOD + phase) with nx, nz whole
// numbers, which is what makes the tile seamless. Wavelength along the wave's
// own direction is PERIOD / hypot(nx, nz).
//
//   W1..W3  long swells  (166-291 u) - these carry the speed
//   W4..W5  medium chop  ( 67- 79 u) - these are the ramps you launch from
//
// Tuned against the flight survey in tests/.tune-terrain: the swells own the
// grade, the chop owns the curvature. You leave the ground when v^2 * curvature
// beats gravity, but the upward velocity you leave WITH comes from the swell you
// are climbing - so the chop decides HOW OFTEN you fly and the swell decides HOW
// BIG the flight is. An earlier, shorter chop (43-46 u) had so much curvature
// that boosting was 50% airborne chatter; stretching it to 67-79 u traded that
// for fewer, longer, readable flights.
//
// Resulting distribution over the tile: grade p50 0.20, p90 0.32, max 0.47;
// height -18 .. +19.
export const WAVES = [
  { a: 8.4, nx: 4, nz: 1, phase: 0.0 },
  { a: 6.0, nx: -1, nz: 5, phase: 1.31 },
  { a: 2.1, nx: 6, nz: -4, phase: 2.42 },
  { a: 1.6, nx: 14, nz: 6, phase: 0.77 },
  { a: 1.15, nx: -6, nz: 17, phase: 3.05 },
];

// Precomputed angular wavenumbers, so the hot loop does no division.
let K = [];

function compile(waves) {
  // Integer wavenumbers are what guarantee the seam. Anything else would put a
  // visible and drivable-off discontinuity at x=0 and z=0, so refuse it early.
  for (const w of waves) {
    if (!Number.isInteger(w.nx) || !Number.isInteger(w.nz)) {
      throw new Error(`terrain wave must use integer wavenumbers, got ${w.nx},${w.nz}`);
    }
  }
  K = waves.map((w) => ({
    a: w.a,
    kx: (TAU * w.nx) / PERIOD,
    kz: (TAU * w.nz) / PERIOD,
    phase: w.phase,
  }));
}

compile(WAVES);

// Only the tuning pass uses this; the game never re-shapes the world mid-round.
export function setWaves(waves) {
  WAVES.length = 0;
  for (const w of waves) WAVES.push(w);
  compile(WAVES);
}

export function getWaves() {
  return WAVES.map((w) => ({ ...w }));
}

export function wrap(v) {
  const r = v % PERIOD;
  return r < 0 ? r + PERIOD : r;
}

// Shortest signed displacement a - b across the torus. Every chase, every
// distance check and every render offset goes through this.
export function wrapDelta(a, b) {
  let d = (a - b) % PERIOD;
  if (d > PERIOD / 2) d -= PERIOD;
  else if (d < -PERIOD / 2) d += PERIOD;
  return d;
}

export function wrappedDistSq(ax, az, bx, bz) {
  const dx = wrapDelta(ax, bx);
  const dz = wrapDelta(az, bz);
  return dx * dx + dz * dz;
}

export function wrappedDist(ax, az, bx, bz) {
  return Math.sqrt(wrappedDistSq(ax, az, bx, bz));
}

export function height(x, z) {
  let h = 0;
  for (let i = 0; i < K.length; i++) {
    const w = K[i];
    h += w.a * Math.sin(w.kx * x + w.kz * z + w.phase);
  }
  return h;
}

// dh/dx and dh/dz, written into `out` so nothing allocates per step.
export function gradient(x, z, out) {
  let gx = 0;
  let gz = 0;
  for (let i = 0; i < K.length; i++) {
    const w = K[i];
    const c = w.a * Math.cos(w.kx * x + w.kz * z + w.phase);
    gx += c * w.kx;
    gz += c * w.kz;
  }
  out.x = gx;
  out.z = gz;
  return out;
}

export function heightAndGradient(x, z, out) {
  let h = 0;
  let gx = 0;
  let gz = 0;
  for (let i = 0; i < K.length; i++) {
    const w = K[i];
    const p = w.kx * x + w.kz * z + w.phase;
    h += w.a * Math.sin(p);
    const c = w.a * Math.cos(p);
    gx += c * w.kx;
    gz += c * w.kz;
  }
  out.h = h;
  out.x = gx;
  out.z = gz;
  return out;
}

// The terrain interface the physics consumes. Tests swap in flat or constant
// slope versions of this shape to isolate one behaviour at a time.
export const worldTerrain = {
  period: PERIOD,
  height,
  grad: gradient,
  heightAndGrad: heightAndGradient,
  wrap,
  delta: wrapDelta,
};

export function makeFlatTerrain(y = 0) {
  return {
    period: 0,
    height: () => y,
    grad: (x, z, out) => { out.x = 0; out.z = 0; return out; },
    heightAndGrad: (x, z, out) => { out.h = y; out.x = 0; out.z = 0; return out; },
    wrap: (v) => v,
    delta: (a, b) => a - b,
  };
}

// Constant grade running along +z (so heading 0 climbs, heading PI descends).
export function makeRampTerrain(grade) {
  return {
    period: 0,
    height: (x, z) => z * grade,
    grad: (x, z, out) => { out.x = 0; out.z = grade; return out; },
    heightAndGrad: (x, z, out) => { out.h = z * grade; out.x = 0; out.z = grade; return out; },
    wrap: (v) => v,
    delta: (a, b) => a - b,
  };
}

// A single named swell, for scripted flight tests: one sine along +z.
export function makeSwellTerrain(amp, wavelength) {
  const k = TAU / wavelength;
  return {
    period: 0,
    height: (x, z) => amp * Math.sin(k * z),
    grad: (x, z, out) => { out.x = 0; out.z = amp * k * Math.cos(k * z); return out; },
    heightAndGrad: (x, z, out) => {
      out.h = amp * Math.sin(k * z);
      out.x = 0;
      out.z = amp * k * Math.cos(k * z);
      return out;
    },
    wrap: (v) => v,
    delta: (a, b) => a - b,
  };
}

// ---------------------------------------------------------------------------
// Regions: four broad tinted zones so a runner circling the torus can tell
// where they are without a minimap. The blend weights are themselves periodic,
// so the tint crosses the seam as smoothly as the ground does.
// ---------------------------------------------------------------------------

export const REGION_COUNT = 4;

export function regionWeights(x, z, out) {
  const wx = 0.5 + 0.5 * Math.sin((TAU * x) / PERIOD);
  const wz = 0.5 + 0.5 * Math.sin((TAU * z) / PERIOD);
  out[0] = (1 - wx) * (1 - wz);
  out[1] = wx * (1 - wz);
  out[2] = (1 - wx) * wz;
  out[3] = wx * wz;
  return out;
}

export function regionAt(x, z) {
  const wx = Math.sin((TAU * x) / PERIOD) >= 0 ? 1 : 0;
  const wz = Math.sin((TAU * z) / PERIOD) >= 0 ? 1 : 0;
  return wx + wz * 2;
}

// ---------------------------------------------------------------------------
// Landmarks: sparse orientation aids, never a maze. Two kinds (banner poles,
// monoliths), small collision radii, scattered by the seeded PRNG with a
// minimum spacing so they read as isolated dots on an open field.
// ---------------------------------------------------------------------------

export const LANDMARK_COUNT = 38;
export const LANDMARK_MIN_SPACING = 95;

export function makeLandmarks(prng, count = LANDMARK_COUNT) {
  const list = [];
  let attempts = 0;
  while (list.length < count && attempts < count * 60) {
    attempts++;
    const x = prng.next() * PERIOD;
    const z = prng.next() * PERIOD;
    let ok = true;
    for (let i = 0; i < list.length; i++) {
      if (wrappedDistSq(x, z, list[i].x, list[i].z) < LANDMARK_MIN_SPACING * LANDMARK_MIN_SPACING) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const banner = prng.next() < 0.55;
    list.push({
      x,
      z,
      y: height(x, z),
      kind: banner ? 'banner' : 'monolith',
      radius: banner ? 1.15 : 1.8,
      height: banner ? prng.range(11, 16) : prng.range(6, 9.5),
      spin: prng.range(0, TAU),
      region: regionAt(x, z),
      tint: prng.next(),
    });
  }
  return list;
}

// A landmark is a nudge, not a wall: you get pushed clear and lose a little
// speed. Returns the speed multiplier to apply (1 = untouched).
export function resolveLandmarks(body, landmarks, bodyRadius) {
  let mult = 1;
  let moved = false;
  for (let i = 0; i < landmarks.length; i++) {
    const L = landmarks[i];
    const dx = wrapDelta(body.x, L.x);
    const dz = wrapDelta(body.z, L.z);
    const rr = L.radius + bodyRadius;
    const d2 = dx * dx + dz * dz;
    if (d2 >= rr * rr) continue;
    const d = Math.sqrt(d2) || 1e-4;
    const push = (rr - d) / d;
    body.x = wrap(body.x + dx * push);
    body.z = wrap(body.z + dz * push);
    mult = Math.min(mult, 0.78);
    moved = true;
  }
  // m7. The shove moves the body in x/z AFTER stepBody has already planted it
  // on the ground it found at the old position, so a grounded body was left
  // standing at a height that belonged somewhere else - up to a metre out on a
  // steep face. That stale y is then what the next step's takeoff test measures
  // against, which is where the spurious "launched while driving past a pole"
  // takeoffs came from. Re-read the ground we were actually pushed onto.
  if (moved && !body.airborne) body.y = height(body.x, body.z);
  return mult;
}

// m8. Is the straight line from an eye to a target buried in the ground?
//
// The fairness model used to equate "inside the camera frustum" with "the
// player can see it", and on a wavy world those are very different claims: a
// hunter behind the crest you are about to launch off projects perfectly inside
// the frustum and is completely invisible. For warning purposes, occluded has
// to count as offscreen.
//
// Everything is in WORLD space. Eight samples is enough at these wavelengths -
// the shortest wave here is 67 u and the sight lines are tens of units long -
// and it allocates nothing.
export function sightBlocked(ex, ey, ez, tx, ty, tz, samples = 8) {
  for (let i = 1; i < samples; i++) {
    const f = i / samples;
    const rx = ex + (tx - ex) * f;
    const rz = ez + (tz - ez) * f;
    const ry = ey + (ty - ey) * f;
    if (height(rx, rz) > ry) return true;
  }
  return false;
}

// Diagnostic used by the tests and the tuning pass: the steepest grade anywhere
// on the tile, sampled on a grid.
export function maxGrade(step = 3) {
  const g = { x: 0, z: 0 };
  let max = 0;
  for (let x = 0; x < PERIOD; x += step) {
    for (let z = 0; z < PERIOD; z += step) {
      gradient(x, z, g);
      const m = Math.sqrt(g.x * g.x + g.z * g.z);
      if (m > max) max = m;
    }
  }
  return max;
}

export function heightRange(step = 3) {
  let lo = Infinity;
  let hi = -Infinity;
  for (let x = 0; x < PERIOD; x += step) {
    for (let z = 0; z < PERIOD; z += step) {
      const h = height(x, z);
      if (h < lo) lo = h;
      if (h > hi) hi = h;
    }
  }
  return { lo, hi };
}

export { clamp };
