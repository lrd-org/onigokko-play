// The blob species, same body plan as the earlier onigokko prototypes: a
// flat-shaded egg, two big white eyes with tracking pupils, two shuffling feet
// and a soft shadow. Player, hunters and kos are all this creature - the
// hunters just wear spikes, an acid glow and a scowl.
//
// Difference from the earlier builds: every part is an InstancedMesh shared
// across all nine creatures, so the whole cast costs SIX draw calls instead of
// seventy-odd. All the charm still lives in the per-frame update - squash and
// stretch, a hop gait that speeds up with the body, lean into the turn, blink,
// and a nose-up pitch while flying.

import * as THREE from '../vendor/three.module.js';
import { clamp, approach, wrapAngle } from '../sim/math.js';

export const SPECIES = {
  player: { color: 0xff8a4c, foot: 0xfff0dc, pupil: 0x2a1c2e, radius: 1.55, eyeScale: 1.0 },
  hunter: { color: 0x4b2a70, foot: 0x2f1a4a, pupil: 0xd6ff3a, radius: 1.7, eyeScale: 0.94, spikes: 4 },
  ko: { color: 0xffd95c, foot: 0xfff6e6, pupil: 0x2a2033, radius: 1.15, eyeScale: 1.14 },
};

export const KO_COLORS = [
  0xffd95c, 0x7fe3c0, 0xffabc8, 0x9ecdff, 0xffc48a, 0xc0b0ff, 0xa8e86a, 0xff9f9f,
];

const HUNTER_ACCENT = 0xd6ff3a;

export class CreatureField {
  /**
   * @param scene
   * @param specs array of {kind:'player'|'hunter'|'ko', color?}
   */
  constructor(scene, specs) {
    this.specs = specs;
    const n = specs.length;
    const spikeTotal = specs.reduce((s, sp) => s + (SPECIES[sp.kind].spikes ?? 0), 0);

    const bodyGeo = new THREE.IcosahedronGeometry(1, 1);
    const eyeGeo = new THREE.SphereGeometry(1, 10, 8);
    const ballGeo = new THREE.SphereGeometry(1, 8, 6);
    const shadowGeo = new THREE.CircleGeometry(1, 18);
    shadowGeo.rotateX(-Math.PI / 2);
    // A flat ring laid on the ground under a ko. The visual review's finding
    // was that a ko at 110-260 u reads as two pixels of yellow and nothing tells
    // you it is the thing you are supposed to chase; a ring on the floor is the
    // universal "this is interactive" mark and it is legible long after the
    // creature itself has stopped being.
    const ringGeo = new THREE.RingGeometry(0.78, 1, 22);
    ringGeo.rotateX(-Math.PI / 2);
    const spikeGeo = new THREE.ConeGeometry(1, 1, 5);
    spikeGeo.translate(0, 0.5, 0);

    const lam = (opts) => new THREE.MeshLambertMaterial({ flatShading: true, ...opts });

    this.bodies = new THREE.InstancedMesh(bodyGeo, lam({}), n);
    this.eyes = new THREE.InstancedMesh(eyeGeo, lam({ color: 0xffffff, flatShading: false }), n * 2);
    this.pupils = new THREE.InstancedMesh(ballGeo, new THREE.MeshBasicMaterial(), n * 2);
    this.feet = new THREE.InstancedMesh(ballGeo, lam({}), n * 2);
    this.spikes = new THREE.InstancedMesh(spikeGeo, lam({ color: HUNTER_ACCENT }), Math.max(1, spikeTotal));
    this.shadows = new THREE.InstancedMesh(
      shadowGeo,
      new THREE.MeshBasicMaterial({ color: 0x1b2b18, transparent: true, opacity: 0.26, depthWrite: false }),
      n
    );

    const koCount = Math.max(1, specs.filter((sp) => sp.kind === 'ko').length);
    this.rings = new THREE.InstancedMesh(
      ringGeo,
      new THREE.MeshBasicMaterial({
        color: 0xfff0a8, transparent: true, opacity: 0.55, depthWrite: false,
        side: THREE.DoubleSide,
      }),
      koCount
    );
    let koSlot = 0;
    for (const sp of specs) sp.ringSlot = sp.kind === 'ko' ? koSlot++ : -1;

    this.parts = [this.bodies, this.eyes, this.pupils, this.feet, this.spikes, this.shadows, this.rings];
    this.group = new THREE.Group();
    for (const p of this.parts) {
      p.frustumCulled = false;
      p.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.group.add(p);
    }
    this.shadows.renderOrder = 1;
    this.rings.renderOrder = 2;
    scene.add(this.group);

    // Per-creature animation state. Seeded off the index so nine creatures do
    // not blink and hop in lockstep.
    this.anim = specs.map((sp, i) => ({
      gait: (i * 2.399) % (Math.PI * 2),
      pulse: 1,
      lean: 0,
      pitch: 0,
      roll: 0,
      blinkTimer: 1.5 + ((i * 7) % 5),
      blinkHold: 0,
      spikeBase: 0,
    }));

    // Fixed per-creature colours, written once.
    const col = new THREE.Color();
    let spikeSlot = 0;
    specs.forEach((sp, i) => {
      const S = SPECIES[sp.kind];
      this.bodies.setColorAt(i, col.set(sp.color ?? S.color));
      this.feet.setColorAt(i * 2, col.set(sp.foot ?? S.foot));
      this.feet.setColorAt(i * 2 + 1, col.set(sp.foot ?? S.foot));
      this.pupils.setColorAt(i * 2, col.set(S.pupil));
      this.pupils.setColorAt(i * 2 + 1, col.set(S.pupil));
      sp.spikeStart = spikeSlot;
      spikeSlot += S.spikes ?? 0;
    });
    for (const p of [this.bodies, this.feet, this.pupils]) {
      if (p.instanceColor) p.instanceColor.needsUpdate = true;
    }

    this._root = new THREE.Object3D();
    this._part = new THREE.Object3D();
    this._m = new THREE.Matrix4();
    this._hidden = new THREE.Matrix4().makeScale(0, 0, 0);
    this._tint = new THREE.Color();

    // Every slot starts hidden. An unwritten instance matrix is the identity,
    // which parks a full-size part at the render origin - i.e. a stray cone
    // sitting on the player in kart mode, where there are no hunters to claim
    // the spike instances.
    for (const part of this.parts) {
      for (let k = 0; k < part.count; k++) part.setMatrixAt(k, this._hidden);
      part.instanceMatrix.needsUpdate = true;
    }
  }

  /**
   * @param i      creature slot
   * @param s      {x,y,z,heading,drift,speed,slopeX,slopeZ,airborne,vy,visible,
   *                menace,flash,scale,lookX,lookZ}
   * @param dt     seconds since last frame (cosmetic only)
   */
  set(i, s, dt) {
    const spec = this.specs[i];
    const S = SPECIES[spec.kind];
    const a = this.anim[i];
    const r = (S.radius) * (s.scale ?? 1);

    if (s.visible === false) {
      this.bodies.setMatrixAt(i, this._hidden);
      this.eyes.setMatrixAt(i * 2, this._hidden);
      this.eyes.setMatrixAt(i * 2 + 1, this._hidden);
      this.pupils.setMatrixAt(i * 2, this._hidden);
      this.pupils.setMatrixAt(i * 2 + 1, this._hidden);
      this.feet.setMatrixAt(i * 2, this._hidden);
      this.feet.setMatrixAt(i * 2 + 1, this._hidden);
      this.shadows.setMatrixAt(i, this._hidden);
      if (spec.ringSlot >= 0) this.rings.setMatrixAt(spec.ringSlot, this._hidden);
      for (let k = 0; k < (S.spikes ?? 0); k++) this.spikes.setMatrixAt(spec.spikeStart + k, this._hidden);
      return;
    }

    const sf = clamp(s.speed / 62, 0, 1.3);

    // Gait: faster body, faster and higher hop - except in the air, where the
    // feet tuck and the hop freezes.
    const air = s.airborne ? 1 : 0;
    a.gait += dt * (3.0 + sf * 11) * (1 - air * 0.85);
    const hop = Math.abs(Math.sin(a.gait)) * (1 - air);
    const hopHeight = r * (0.05 + sf * 0.40);

    a.pulse = approach(a.pulse, 1, 9, dt);
    if (s.pulse) a.pulse = s.pulse;

    // Lean into the turn from the heading-vs-travel gap, and pitch nose-up on
    // the way up / nose-down on the way down when flying.
    const wantRoll = clamp(-(s.drift ?? 0) * 1.5, -0.5, 0.5) + Math.sin(a.gait) * 0.05 * sf;
    const wantPitch = s.airborne
      ? clamp(-(s.vy ?? 0) * 0.022, -0.5, 0.55)
      : clamp(sf * 0.16 + (s.slopeAlong ?? 0) * 0.5, -0.5, 0.6);
    a.roll = approach(a.roll, wantRoll, 8, dt);
    a.pitch = approach(a.pitch, wantPitch, 7, dt);

    // Blink.
    a.blinkTimer -= dt;
    if (a.blinkTimer <= 0) {
      a.blinkTimer = 2.5 + (i * 1.7) % 4.5;
      a.blinkHold = 0.12;
    }
    if (a.blinkHold > 0) a.blinkHold -= dt;

    const root = this._root;
    root.position.set(s.x, s.y + hop * hopHeight, s.z);
    root.rotation.set(a.pitch, s.heading, a.roll, 'YXZ');
    root.updateMatrix();

    const stretch = clamp((1 + Math.cos(a.gait * 2) * 0.07 * (0.4 + sf)) * a.pulse, 0.45, 1.85);
    const wide = 1 / Math.sqrt(stretch);

    // --- body ---------------------------------------------------------------
    this._place(this.bodies, i, 0, r * 1.02 * stretch, 0, r * wide, r * 0.94 * stretch, r * wide);

    // Hunters glow toward acid yellow as a lunge winds up; the player flashes
    // white on a hit. Both are just a body tint.
    //
    // Written UNCONDITIONALLY, and that is the fix, not a style preference. The
    // flash write used to sit behind `else if (s.flash)`, so the last value the
    // instance colour ever received was whatever the flash was at the moment it
    // stopped being written. Death freezes the sim (step() early-returns), which
    // freezes hitFlash at 0.5 - i.e. flash 1.0, i.e. pure white - and since
    // nothing wrote the colour again, the player stayed white for the rest of
    // that round AND every round after it. A tint that can be turned on has to
    // be a tint that is turned off by the same line.
    const baseColor = spec.color ?? S.color;
    if (spec.kind === 'hunter') {
      this._tint.set(baseColor).lerp(_ACCENT, clamp(s.menace ?? 0, 0, 1) * 0.55);
    } else {
      this._tint.set(baseColor).lerp(_WHITE, clamp(s.flash ?? 0, 0, 1));
    }
    this.bodies.setColorAt(i, this._tint);
    this.bodies.instanceColor.needsUpdate = true;

    // --- eyes + pupils ------------------------------------------------------
    const eyeY = r * 1.32 * stretch;
    const eyeX = r * 0.4 * wide;
    const eyeZ = r * 0.78 * wide;
    const eyeR = r * 0.36 * S.eyeScale;
    const lid = a.blinkHold > 0 ? 0.14 : 1;
    // Pupils swing toward whatever the creature is worried about, clamped so
    // they stay on the visible front of the eye.
    const lookAng = s.look === undefined ? 0 : clamp(wrapAngle(s.look - s.heading), -1.2, 1.2);
    for (let e = 0; e < 2; e++) {
      const ex = e === 0 ? -eyeX : eyeX;
      this._place(this.eyes, i * 2 + e, ex, eyeY, eyeZ, eyeR, eyeR * lid, eyeR);
      this._place(
        this.pupils,
        i * 2 + e,
        ex + Math.sin(lookAng) * eyeR * 0.6,
        eyeY,
        eyeZ + Math.max(0.2, Math.cos(lookAng)) * eyeR * 0.62,
        eyeR * 0.42 * (a.blinkHold > 0 ? 0.2 : 1),
        eyeR * 0.42 * lid,
        eyeR * 0.42
      );
    }

    // --- feet ---------------------------------------------------------------
    const stride = r * (0.2 + sf * 0.62) * (1 - air * 0.7);
    for (let f = 0; f < 2; f++) {
      const ph = a.gait + f * Math.PI;
      const swing = Math.sin(ph) * (1 - air * 0.8);
      this._place(
        this.feet,
        i * 2 + f,
        (f === 0 ? -1 : 1) * r * 0.44 * wide,
        r * 0.2 + Math.max(0, swing) * r * 0.24 - air * r * 0.1,
        swing * stride,
        r * 0.3,
        r * 0.22,
        r * 0.34
      );
    }

    // --- spikes (hunters only) ---------------------------------------------
    // A CROWN, not a back ridge. Spikes along the spine are invisible from in
    // front, which is precisely the angle a hunter is at while it winds up a
    // lunge at you - the telegraph has to be legible head-on or it is not a
    // telegraph. On top of the head they flare upward with menace and read from
    // every direction.
    const nSpikes = S.spikes ?? 0;
    if (nSpikes) {
      const flare = 0.6 + (s.menace ?? 0) * 1.05;
      for (let k = 0; k < nSpikes; k++) {
        const t = (k / (nSpikes - 1)) * 2 - 1; // -1..1 across the crown
        const mid = 1 - Math.abs(t);
        this._part.position.set(
          t * r * 0.46 * wide,
          r * (1.62 + 0.16 * mid) * stretch,
          -r * 0.06 + Math.abs(t) * r * 0.04
        );
        this._part.rotation.set(-0.16, 0, t * 0.62);
        this._part.scale.set(r * 0.15, r * (0.44 + 0.40 * mid) * flare, r * 0.15);
        this._part.updateMatrix();
        this._m.multiplyMatrices(root.matrix, this._part.matrix);
        this.spikes.setMatrixAt(spec.spikeStart + k, this._m);
      }
    }

    // --- shadow -------------------------------------------------------------
    // Sits on the ground under the creature, not under the hop, and shrinks as
    // it gets further away - which is what sells the height of a flight.
    //
    // It must be LAID ON the slope, not left flat: a flat disc on a 30% grade
    // buries half of itself in the terrain and what is left reads as a hard
    // straight edge under the creature.
    const lift = clamp((s.y - (s.groundY ?? s.y)) / 8, 0, 1);
    const p = this._part;
    p.position.set(s.x, (s.groundY ?? s.y) + 0.12, s.z);
    _n.set(-(s.groundGx ?? 0), 1, -(s.groundGz ?? 0)).normalize();
    p.quaternion.setFromUnitVectors(_UP, _n);
    const sh = r * (1.25 - hop * 0.25) * (1 - lift * 0.45);
    p.scale.set(sh, 1, sh);
    p.updateMatrix();
    this.shadows.setMatrixAt(i, p.matrix);

    // --- ko ring ------------------------------------------------------------
    // Same plane as the shadow, slightly above it, breathing gently so it reads
    // as "come and get me" rather than as scenery. Kept on the GROUND, not on
    // the creature, so it stays visible when the ko is hidden behind a swell.
    if (spec.ringSlot >= 0) {
      a.ringPhase = (a.ringPhase ?? i * 0.9) + dt * 2.2;
      const breathe = 1 + Math.sin(a.ringPhase) * 0.12;
      const rr = r * 2.1 * breathe;
      p.position.set(s.x, (s.groundY ?? s.y) + 0.2, s.z);
      p.scale.set(rr, 1, rr);
      p.updateMatrix();
      this.rings.setMatrixAt(spec.ringSlot, p.matrix);
    }
  }

  _place(mesh, idx, lx, ly, lz, sx, sy, sz) {
    const p = this._part;
    p.position.set(lx, ly, lz);
    p.rotation.set(0, 0, 0);
    p.scale.set(sx, sy, sz);
    p.updateMatrix();
    this._m.multiplyMatrices(this._root.matrix, p.matrix);
    mesh.setMatrixAt(idx, this._m);
  }

  flush() {
    for (const p of this.parts) p.instanceMatrix.needsUpdate = true;
  }
}

const _ACCENT = new THREE.Color(HUNTER_ACCENT);
const _WHITE = new THREE.Color(0xffffff);
const _UP = new THREE.Vector3(0, 1, 0);
const _n = new THREE.Vector3();
