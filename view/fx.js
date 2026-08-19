// Particles: one pooled Points object, one draw call. Landing puffs, boost
// sparks and catch chimes all come out of the same pool - they only differ in
// colour, size and how fast they fall.
//
// Allocation: the hot path here really does allocate nothing per frame
// (iteration 7 measured `Particles.update` at 0.1 B/frame, the harness's own
// floor) - unlike the loop that calls it, which allocates 90-350 B a frame
// across seven sites; see README's Performance section and the ledger's
// Verified-good block, which are where that range is measured and dated.
// (This line said 87-330 until the iteration-7 review, MINOR-1: the discovery's
// pre-fix numbers, left pointing at two documents that both say 90-350.)
// `emit()` allocates whatever its caller's `opts` literal costs, a few times a
// second at most.
//
// The pool is PER-ROUND state, and says so: `clear()` is called from
// main.js's beginRound(), because a restart teleports the player to a new spawn
// and the render-origin shift the loop hands `update()` would throw the last
// round's debris to an arbitrary point in render space rather than carry it
// honestly (iteration 7, G4).
//
// `live` is the number of slots with `life > 0`, maintained by emit/update/
// clear. It exists so a pool with nothing to say stops uploading three vertex
// attributes to the GPU on every frame of the title and the result (iteration 7,
// G5: 13 440 B/frame of the frame's 26 348). NOT the pause card, though this
// said so: a paused frame's `viewDt` is 0, so a burst frozen under the card
// never decays, the pool never empties and the gate never engages - it keeps
// uploading its 21 308 B until the round resumes (iteration-7 review, MINOR-3).
// Title and result drain, because their `hudDt` is the real frame delta.

import * as THREE from '../vendor/three.module.js';

const MAX = 420;

const VERT = `
attribute float aSize;
attribute float aLife;
attribute vec3 aColor;
varying vec3 vColor;
varying float vLife;
void main() {
  vColor = aColor;
  vLife = aLife;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * (300.0 / max(1.0, -mv.z));
  gl_Position = projectionMatrix * mv;
}
`;

const FRAG = `
precision mediump float;
varying vec3 vColor;
varying float vLife;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r = dot(d, d);
  if (r > 0.25) discard;
  float a = vLife * (1.0 - r * 4.0);
  gl_FragColor = vec4(vColor, a);
}
`;

export class Particles {
  constructor(scene) {
    this.n = MAX;
    this.pos = new Float32Array(MAX * 3);
    this.vel = new Float32Array(MAX * 3);
    this.size = new Float32Array(MAX);
    this.life = new Float32Array(MAX);
    this.maxLife = new Float32Array(MAX);
    this.color = new Float32Array(MAX * 3);
    this.grav = new Float32Array(MAX);
    this.head = 0;
    // Slots with life > 0. Never read from the arrays to recompute it in the
    // hot path - emit() and update() are its only writers, and tests/fx.test.js
    // re-derives it from `life` after every kind of call to hold them honest.
    this.live = 0;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1));
    geo.setAttribute('aLife', new THREE.BufferAttribute(this.life, 1));
    geo.setAttribute('aColor', new THREE.BufferAttribute(this.color, 3));
    geo.setDrawRange(0, MAX);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.geo = geo;
    this.points = new THREE.Points(
      geo,
      new THREE.ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: FRAG,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      })
    );
    this.points.frustumCulled = false;
    scene.add(this.points);
  }

  emit(x, y, z, count, opts) {
    const spread = opts.spread ?? 4;
    const up = opts.up ?? 3;
    const life = opts.life ?? 0.6;
    const size = opts.size ?? 2.4;
    const c = opts.color ?? [1, 1, 1];
    const grav = opts.grav ?? 14;
    for (let i = 0; i < count; i++) {
      const j = this.head;
      this.head = (this.head + 1) % this.n;
      // The ring overwrites the oldest slot whether or not it had died, so a
      // burst that laps the pool must not double-count what it replaces.
      if (this.life[j] <= 0) this.live++;
      const a = Math.random() * Math.PI * 2;
      const rr = Math.random();
      this.pos[j * 3] = x + Math.sin(a) * rr * (opts.radius ?? 1);
      this.pos[j * 3 + 1] = y + Math.random() * 0.5;
      this.pos[j * 3 + 2] = z + Math.cos(a) * rr * (opts.radius ?? 1);
      this.vel[j * 3] = Math.sin(a) * spread * rr + (opts.vx ?? 0);
      this.vel[j * 3 + 1] = up * (0.4 + Math.random() * 0.9);
      this.vel[j * 3 + 2] = Math.cos(a) * spread * rr + (opts.vz ?? 0);
      this.maxLife[j] = life * (0.7 + Math.random() * 0.6);
      this.life[j] = this.maxLife[j];
      this.size[j] = size * (0.6 + Math.random() * 0.8);
      this.grav[j] = grav;
      this.color[j * 3] = c[0];
      this.color[j * 3 + 1] = c[1];
      this.color[j * 3 + 2] = c[2];
    }
    // aColor is written HERE and nowhere else, so this is the only place it can
    // ever differ from what the GPU already holds. It used to be flagged from
    // update() on every frame - 5 040 B/frame, 302 KB/s, of bytes the card
    // already had.
    this.geo.attributes.aColor.needsUpdate = true;
  }

  /**
   * Drop every particle: the pool is per-round state, and a restart is a
   * teleport, not a move (see the header). Zeroing `size` as well as `life` is
   * what makes the frame after this one draw nothing - `size` is the attribute
   * the shader scales the point by - and the flags go up ONCE, here, because
   * the update() below will decline to raise them for an empty pool.
   *
   * `position` is deliberately NOT flagged: clear() does not write it, and a
   * slot left at a stale position contributes nothing to the image anyway. The
   * guarantee is `aLife`, not `aSize`: GL CLAMPS `gl_PointSize` into
   * `ALIASED_POINT_SIZE_RANGE`, whose lower bound is at most 1 on essentially
   * every driver, so a size-0 slot is not dropped - it is rasterised at a stale
   * position as a ~1 px point (the fragment shader's only `discard` is
   * `r > 0.25`, and r is the point's own coord) - but this zeroes and flags `life`
   * too, and the fragment alpha is `vLife * (1 - 4r)`, so under AdditiveBlending
   * (SrcAlpha/One, depthWrite false) it adds exactly zero. Both attributes are
   * load-bearing: dropping the `life.fill(0)` in the belief that `size` alone
   * carries it would leave stale points drawing. (This docstring named the size
   * as the reason until the iteration-7 review, N-2: right outcome, wrong
   * reason.) Its bytes go up again on the first update() after the next emit().
   */
  clear() {
    this.life.fill(0);
    this.size.fill(0);
    this.head = 0;
    this.live = 0;
    this.geo.attributes.aSize.needsUpdate = true;
    this.geo.attributes.aLife.needsUpdate = true;
  }

  /** dx/dz shift every live particle when the render origin moves with the player. */
  update(dt, shiftX, shiftZ) {
    // An empty pool has nothing to move and nothing to say. update() can only
    // ever LOWER `live` (life decays, nothing is born here), so `live === 0` on
    // entry means the last update that had work already zeroed the sizes and
    // uploaded them: every byte the GPU holds is a byte we would re-send.
    // Costs 0 B/frame instead of 8 400 on every frame with an empty pool: the
    // title, the result, and the stretches of a round with nothing in the air
    // (iteration 7, G5). The pause card is NOT on that list, though this said
    // so: the caller hands a paused frame `viewDt = 0`, so `life[j] -= 0` and a
    // burst frozen under the card never drains - it keeps its slots and keeps
    // uploading until the round resumes (iteration-7 review, MINOR-3).
    if (this.live === 0) return;
    const pos = this.pos;
    const vel = this.vel;
    const life = this.life;
    let live = 0;
    for (let j = 0; j < this.n; j++) {
      if (life[j] <= 0) {
        this.size[j] = 0;
        continue;
      }
      life[j] -= dt;
      const j3 = j * 3;
      vel[j3 + 1] -= this.grav[j] * dt;
      pos[j3] += vel[j3] * dt - shiftX;
      pos[j3 + 1] += vel[j3 + 1] * dt;
      pos[j3 + 2] += vel[j3 + 2] * dt - shiftZ;
      if (life[j] <= 0) this.size[j] = 0;
      else live++;
    }
    this.live = live;
    // The frame that empties the pool still uploads - that is the frame the
    // zeroed sizes have to reach the GPU on.
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.aSize.needsUpdate = true;
    this.geo.attributes.aLife.needsUpdate = true;
  }

  landing(x, y, z, quality, speed) {
    this.emit(x, y, z, quality > 0.7 ? 16 : 10, {
      spread: 5 + speed * 0.08,
      up: 3.5,
      life: 0.55,
      size: 3.2,
      radius: 1.4,
      color: quality > 0.7 ? [1.0, 0.95, 0.75] : [0.82, 0.78, 0.68],
      grav: 16,
    });
  }

  /**
   * The impact of a real flight coming down: a wide, flat, fast ring of dust
   * thrown OUTWARD along the ground rather than up into the air. Low `up` and
   * low gravity are what make it read as a shockwave across the surface instead
   * of a second puff.
   */
  landingSlam(x, y, z, quality, speed) {
    this.emit(x, y + 0.15, z, 22, {
      spread: 13 + speed * 0.14,
      up: 0.9,
      life: 0.5,
      size: 3.8,
      radius: 1.9,
      color: quality > 0.7 ? [1.0, 0.96, 0.82] : [0.86, 0.8, 0.7],
      grav: 5,
    });
  }

  /**
   * Boost spray.
   *
   * The old version emitted 1.6 u BEHIND the body at y+0.8 - which is exactly
   * where the chase camera cannot see, because the chase camera is behind the
   * body looking forward, so the kart's own silhouette covers the entire
   * emission point. The effect existed and was invisible.
   *
   * Now it comes out low and to BOTH SIDES, at wheel height, and streams
   * backward past the camera. Sideways offsets are the perpendicular of the
   * travel direction, so the spray stays glued to the body through a drift.
   */
  boost(x, y, z, dirX, dirZ) {
    const sideX = dirZ;
    const sideZ = -dirX;
    for (const s of [-1, 1]) {
      this.emit(
        x + sideX * s * 1.15 + dirX * 0.3,
        y + 0.18,
        z + sideZ * s * 1.15 + dirZ * 0.3,
        1,
        {
          spread: 1.1,
          up: 1.3,
          life: 0.46,
          size: 2.8,
          radius: 0.45,
          vx: -dirX * 11 + sideX * s * 2.4,
          vz: -dirZ * 11 + sideZ * s * 2.4,
          color: [1.0, 0.62, 0.25],
          grav: 2,
        }
      );
    }
  }

  takeoff(x, y, z) {
    this.emit(x, y, z, 12, {
      spread: 6, up: 2.0, life: 0.5, size: 3.0, radius: 1.6,
      color: [0.95, 0.97, 1.0], grav: 8,
    });
  }

  catchBurst(x, y, z) {
    this.emit(x, y + 1.2, z, 20, {
      spread: 6, up: 7, life: 0.85, size: 3.4, radius: 0.9,
      color: [1.0, 0.9, 0.4], grav: 12,
    });
  }

  hitBurst(x, y, z) {
    this.emit(x, y + 1.4, z, 22, {
      spread: 8, up: 5, life: 0.7, size: 3.8, radius: 1.0,
      color: [0.85, 1.0, 0.28], grav: 14,
    });
  }
}
