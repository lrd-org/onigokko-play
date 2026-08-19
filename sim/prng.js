// One seeded generator for the whole simulation. Nothing that affects state may
// call Math.random(); if it is not cosmetic it comes from here, so the same seed
// always replays the same round.

// sfc32: small, fast, well-distributed, and trivially portable between runs.
export function makePrng(seed = 1) {
  let a = 0x9e3779b9;
  let b = seed >>> 0;
  let c = (seed * 0x85ebca6b) >>> 0;
  let d = ((seed ^ 0xc2b2ae35) + 0x27d4eb2f) >>> 0;

  function next() {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    const t = (a + b | 0) + d | 0;
    d = d + 1 | 0;
    a = b ^ (b >>> 9);
    b = c + (c << 3) | 0;
    c = (c << 21) | (c >>> 11);
    c = c + t | 0;
    return (t >>> 0) / 4294967296;
  }

  // Discard the first few so nearby seeds do not start with similar values.
  for (let i = 0; i < 12; i++) next();

  return {
    next,
    range(lo, hi) { return lo + (hi - lo) * next(); },
    int(lo, hi) { return lo + Math.floor(next() * (hi - lo + 1)); },
    pick(arr) { return arr[Math.floor(next() * arr.length)]; },
    // Snapshot/restore so a caller can fork a deterministic sub-sequence.
    save() { return [a, b, c, d]; },
    load(s) { a = s[0]; b = s[1]; c = s[2]; d = s[3]; },
  };
}
