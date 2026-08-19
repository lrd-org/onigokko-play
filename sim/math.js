// Small shared scalar helpers. No Three.js, no allocation in the hot paths.

export const TAU = Math.PI * 2;

// NaN-safe by construction (m10). The old form `v < lo ? lo : v > hi ? hi : v`
// returned NaN unchanged, because NaN fails both comparisons - so a single
// non-finite input could walk straight through every clamp in the build and
// poison a body permanently. Anything non-finite now collapses to the low end;
// +/-Infinity still saturate to the bound they are heading for.
export function clamp(v, lo, hi) {
  if (v <= lo) return lo;
  if (v >= hi) return hi;
  return Number.isFinite(v) ? v : lo;
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

// Frame-rate independent exponential approach. rate is "per second".
export function approach(current, target, rate, dt) {
  return current + (target - current) * (1 - Math.exp(-rate * dt));
}

// Fold an angle into (-PI, PI].
export function wrapAngle(a) {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}

// Shortest signed rotation from `from` to `to`.
export function angleDelta(to, from) {
  return wrapAngle(to - from);
}

export function sign(v) {
  return v < 0 ? -1 : v > 0 ? 1 : 0;
}

export function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}
