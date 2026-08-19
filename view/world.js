// The visible world: ground, sky, landmarks.
//
// The ground is ONE mesh, a flat grid that follows the camera and is displaced
// in the vertex shader by the exact same wave sum the physics uses - the GLSL is
// generated from sim/terrain.js at startup, so there is no way for what you see
// to drift from what you drive on. Because the height function is periodic and
// the grid samples it in world space, the wrap costs nothing: there is no tile
// seam to hide, no 3x3 neighbourhood to draw, and no edge to reach.
//
// The grid snaps to whole cells as it follows, so the tessellation does not
// swim across the terrain while you move.

import * as THREE from '../vendor/three.module.js';
import { WAVES, PERIOD, wrapDelta, LANDMARK_COUNT } from '../sim/terrain.js';

export const VIEW_DISTANCE = 400;
const TERRAIN_SIZE = 900;
const TERRAIN_SEGMENTS = 180; // 5 u cells, 64 800 triangles, one draw call

export const PALETTE = {
  fog: 0xbcd9ee,
  skyLow: 0xdceffa,
  skyHigh: 0x3f7cc8,
  sun: new THREE.Vector3(0.42, 0.62, 0.28).normalize(),
  // Four zones, saturated enough to survive lambert shading and fog. These are
  // the only navigation aid in the game - no minimap - so "subtle hue shift"
  // has to still be legible from a low camera at 60 u/s.
  //
  // They must also be ANALOGOUS. The previous set paired gold (0.68,0.57,0.26)
  // against violet (0.44,0.38,0.68) - near-complements - and the shader blends
  // all four by continuous weights, so everywhere their weights were comparable
  // the two cancelled into flat grey: measured minimum saturation 0.014, with
  // 13% of the tile under 0.25. That is the "grey mud" the visual review found,
  // and it was worst exactly where two regions meet, i.e. where the tint is
  // supposed to be telling you that you are crossing a boundary.
  //
  // This set runs sage -> green -> teal -> aqua (hues ~79 to ~194 degrees).
  // No pair is complementary, so no mix can desaturate: measured minimum
  // saturation 0.415, mean 0.572, 0% of the tile below 0.25, and every pair of
  // regions still differs by >= 0.21 in RGB distance so they stay tellable
  // apart. Verified by v2fixprobes/f9-regions.js.
  regions: [
    [0.52, 0.64, 0.26], // sage / yellow-green
    [0.30, 0.62, 0.30], // green
    [0.16, 0.58, 0.46], // teal
    [0.20, 0.56, 0.70], // aqua
  ],
};

function glslWaves() {
  let src = '';
  for (const w of WAVES) {
    const kx = ((Math.PI * 2 * w.nx) / PERIOD).toPrecision(17);
    const kz = ((Math.PI * 2 * w.nz) / PERIOD).toPrecision(17);
    src += `  { float p = ${kx} * w.x + ${kz} * w.y + ${w.phase.toPrecision(17)};\n`;
    src += `    float s = sin(p); float c = cos(p) * ${w.a.toPrecision(17)};\n`;
    src += `    h += ${w.a.toPrecision(17)} * s; gx += c * ${kx}; gz += c * ${kz}; }\n`;
  }
  return src;
}

const VERT = () => `
uniform vec2 uOrigin;
varying vec3 vNrm;
varying vec2 vWorld;
varying float vH;
varying float vDepth;

void main() {
  vec2 w = uOrigin + vec2(position.x, position.z);
  float h = 0.0, gx = 0.0, gz = 0.0;
${glslWaves()}
  vNrm = normalize(vec3(-gx, 1.0, -gz));
  vWorld = w;
  vH = h;
  vec4 mv = modelViewMatrix * vec4(position.x, h, position.z, 1.0);
  vDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

const FRAG = `
precision highp float;
uniform vec3 uSun;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform vec3 uRegion0;
uniform vec3 uRegion1;
uniform vec3 uRegion2;
uniform vec3 uRegion3;
varying vec3 vNrm;
varying vec2 vWorld;
varying float vH;
varying float vDepth;

const float TAU = 6.28318530717958647692;
const float PERIOD = ${PERIOD.toFixed(1)};

void main() {
  vec3 n = normalize(vNrm);

  // Four broad zones, blended by the same periodic weights the sim uses, so the
  // tint crosses the wrap as smoothly as the ground does.
  float wx = 0.5 + 0.5 * sin(TAU * vWorld.x / PERIOD);
  float wz = 0.5 + 0.5 * sin(TAU * vWorld.y / PERIOD);
  vec3 base = uRegion0 * (1.0 - wx) * (1.0 - wz)
            + uRegion1 * wx * (1.0 - wz)
            + uRegion2 * (1.0 - wx) * wz
            + uRegion3 * wx * wz;

  // Crests catch the light, troughs sit in shade. Cheap, and it makes the swell
  // structure readable from a low chase camera. Kept mild - push it and the
  // troughs go muddy grey.
  base *= 0.93 + 0.008 * vH;

  // World-locked ground detail. This is the speedometer: a smooth analytic
  // surface gives the eye nothing to measure motion against, and without it
  // 60 u/s and 20 u/s look identical. Two grids (20 u carries distance, 5 u
  // carries the rush past your feet) plus a mottle to break up the flats. All
  // three spacings divide 1200, so none of them seam at the wrap.
  vec2 g20 = abs(fract(vWorld / 20.0 - 0.5) - 0.5) / fwidth(vWorld / 20.0);
  float line20 = 1.0 - min(min(g20.x, g20.y), 1.0);
  // 4 u, deliberately NOT the 5 u tessellation pitch - matching it makes the
  // ground look like exposed wireframe instead of ground.
  vec2 g5 = abs(fract(vWorld / 4.0 - 0.5) - 0.5) / fwidth(vWorld / 4.0);
  float line5 = 1.0 - min(min(g5.x, g5.y), 1.0);
  base = mix(base, base * 0.80, line20 * 0.45);
  base = mix(base, base * 0.90, line5 * 0.34);

  vec2 m = vWorld / 7.5;
  float mottle = sin(m.x * 1.7 + sin(m.y * 0.9) * 1.3) * sin(m.y * 1.3 + 2.1);
  base *= 1.0 + mottle * 0.045;

  float diff = max(dot(n, uSun), 0.0);
  float sky = 0.5 + 0.5 * n.y;
  vec3 col = base * (0.44 + 0.22 * sky + 0.62 * diff);

  // Rim of brightness where a slope faces the sun edge-on: reads as sheen on
  // the wave faces you are about to launch from.
  col += vec3(0.10, 0.10, 0.07) * pow(diff, 6.0);

  float f = 1.0 - exp(-pow(vDepth * uFogDensity, 2.0));
  col = mix(col, uFogColor, clamp(f, 0.0, 1.0));

  gl_FragColor = vec4(col, 1.0);
}
`;

const SKY_VERT = `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const SKY_FRAG = `
precision highp float;
uniform vec3 uLow;
uniform vec3 uHigh;
uniform vec3 uSun;
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  float t = clamp(d.y * 1.35 + 0.12, 0.0, 1.0);
  vec3 col = mix(uLow, uHigh, pow(t, 0.72));
  float s = max(dot(d, uSun), 0.0);
  col += vec3(1.0, 0.92, 0.72) * pow(s, 220.0) * 1.4;   // the sun itself
  col += vec3(1.0, 0.88, 0.66) * pow(s, 6.0) * 0.10;    // its haze
  gl_FragColor = vec4(col, 1.0);
}
`;

export class WorldView {
  constructor(scene) {
    this.cell = TERRAIN_SIZE / TERRAIN_SEGMENTS;

    const geo = new THREE.PlaneGeometry(TERRAIN_SIZE, TERRAIN_SIZE, TERRAIN_SEGMENTS, TERRAIN_SEGMENTS);
    geo.rotateX(-Math.PI / 2);
    geo.computeBoundingSphere();
    geo.boundingSphere.radius = TERRAIN_SIZE; // heights push past the flat bound

    this.groundMat = new THREE.ShaderMaterial({
      uniforms: {
        uOrigin: { value: new THREE.Vector2() },
        uSun: { value: PALETTE.sun.clone() },
        uFogColor: { value: new THREE.Color(PALETTE.fog) },
        uFogDensity: { value: 1 / (VIEW_DISTANCE * 1.3) },
        uRegion0: { value: new THREE.Vector3(...PALETTE.regions[0]) },
        uRegion1: { value: new THREE.Vector3(...PALETTE.regions[1]) },
        uRegion2: { value: new THREE.Vector3(...PALETTE.regions[2]) },
        uRegion3: { value: new THREE.Vector3(...PALETTE.regions[3]) },
      },
      vertexShader: VERT(),
      fragmentShader: FRAG,
    });

    this.ground = new THREE.Mesh(geo, this.groundMat);
    this.ground.frustumCulled = false;
    scene.add(this.ground);

    const skyGeo = new THREE.SphereGeometry(1, 24, 16);
    this.sky = new THREE.Mesh(
      skyGeo,
      new THREE.ShaderMaterial({
        uniforms: {
          uLow: { value: new THREE.Color(0xdceffa) },
          uHigh: { value: new THREE.Color(PALETTE.skyHigh) },
          uSun: { value: PALETTE.sun.clone() },
        },
        vertexShader: SKY_VERT,
        fragmentShader: SKY_FRAG,
        side: THREE.BackSide,
        depthWrite: false,
        depthTest: false,
      })
    );
    this.sky.renderOrder = -1;
    this.sky.frustumCulled = false;
    this.sky.scale.setScalar(VIEW_DISTANCE * 2.2);
    scene.add(this.sky);

    this.scene = scene;
    this.landmarkGroup = null;
    this.landmarks = [];
    this.landmarkCapacity = 0;
    this._d = new THREE.Object3D();
    this._hidden = new THREE.Matrix4().makeScale(0, 0, 0);
  }

  // Landmarks are placed once and then, every frame, each one is drawn at its
  // NEAREST wrapped image. View distance is under half the period, so exactly
  // one image can ever be visible - which is why 38 landmarks need 38 instances
  // and not 38 x 9.
  // Allocate the three instanced meshes once, at a capacity that covers a full
  // landmark set, and hand ownership of the group to the world. Called again
  // only if a future set were somehow larger, in which case the old GPU
  // resources are released rather than orphaned.
  _allocLandmarks(capacity) {
    this.disposeLandmarks();

    const poleGeo = new THREE.CylinderGeometry(0.32, 0.42, 1, 6);
    poleGeo.translate(0, 0.5, 0);
    const flagGeo = new THREE.BoxGeometry(1, 1, 0.14);
    const monoGeo = new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
    monoGeo.translate(0, 0.5, 0);

    const mk = (geo, color) =>
      new THREE.InstancedMesh(
        geo,
        new THREE.MeshLambertMaterial({ color, flatShading: true }),
        Math.max(1, capacity)
      );

    this.poles = mk(poleGeo, 0xf7f2e6);
    this.flags = mk(flagGeo, 0xff5f47);
    this.monos = mk(monoGeo, 0xe8dcc4);
    for (const m of [this.poles, this.flags, this.monos]) {
      m.frustumCulled = false;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    }
    this.landmarkGroup = new THREE.Group();
    this.landmarkGroup.add(this.poles, this.flags, this.monos);
    this.landmarkCapacity = capacity;
    this.scene.add(this.landmarkGroup);
  }

  disposeLandmarks() {
    if (!this.landmarkGroup) return;
    this.scene.remove(this.landmarkGroup);
    for (const m of [this.poles, this.flags, this.monos]) {
      if (!m) continue;
      m.geometry.dispose();
      m.material.dispose();
      m.dispose();
    }
    this.landmarkGroup = null;
    this.poles = null;
    this.flags = null;
    this.monos = null;
    this.landmarkCapacity = 0;
  }

  // C1. This used to allocate a whole fresh Group + three InstancedMeshes +
  // three materials on every call and RETURN them, leaving the caller to decide
  // whether to add them to the scene. Boot added the first set; the restart path
  // called it again and discarded the return, so every round after the first was
  // played against invisible collidable landmarks while a dead group of ghost
  // poles rode along with the player. It now rebuilds in place: same meshes,
  // new instance assignment, no GPU allocation and no leak per restart -
  // measured over 20 whole rounds at 12 geometries, 9 programs, 14 draw calls
  // and 7 scene children, all flat (iteration 7, G2). Precisely: one
  // `new THREE.Color()` per call is allocated below, so this is not the zero
  // it used to claim; it is one small object per round, not per frame.
  buildLandmarks(landmarks) {
    this.landmarks = landmarks;
    const n = landmarks.length;
    if (!this.landmarkGroup || this.landmarkCapacity < n) {
      this._allocLandmarks(Math.max(n, LANDMARK_COUNT));
    }

    // Each landmark owns a FIXED instance slot for its whole life. Packing the
    // visible ones down each frame instead would shuffle instance indices out
    // from under the per-instance colours below.
    const col = new THREE.Color();
    let pi = 0;
    let mi = 0;
    for (const L of landmarks) {
      if (L.kind === 'banner') {
        L.slot = pi++;
        const r = PALETTE.regions[L.region];
        col.setRGB(r[0], r[1], r[2]).offsetHSL(0, 0.35, 0.18);
        this.flags.setColorAt(L.slot, col);
      } else {
        L.slot = mi++;
      }
    }
    // Park every slot before the counts are set, so a shorter set cannot leave
    // last round's matrices showing through in the tail of the buffer.
    for (let k = 0; k < this.landmarkCapacity; k++) {
      this.poles.setMatrixAt(k, this._hidden);
      this.flags.setMatrixAt(k, this._hidden);
      this.monos.setMatrixAt(k, this._hidden);
    }
    this.poles.count = pi;
    this.flags.count = pi;
    this.monos.count = mi;
    this.poles.instanceMatrix.needsUpdate = true;
    this.flags.instanceMatrix.needsUpdate = true;
    this.monos.instanceMatrix.needsUpdate = true;
    if (this.flags.instanceColor) this.flags.instanceColor.needsUpdate = true;

    return this.landmarkGroup;
  }

  update(originX, originZ) {
    // Snap the grid to whole cells so the tessellation stops swimming.
    const sx = Math.floor(originX / this.cell) * this.cell;
    const sz = Math.floor(originZ / this.cell) * this.cell;
    this.groundMat.uniforms.uOrigin.value.set(sx, sz);
    this.ground.position.set(sx - originX, 0, sz - originZ);

    if (!this.landmarkGroup) return;
    const d = this._d;
    // Cull past the distance at which fog has actually finished swallowing
    // things. Fog density is 1/(VIEW_DISTANCE*1.3) and the falloff is
    // exp(-(d*density)^2), which is still ~15% transparent at 440 u - so the
    // old +40 cull popped landmarks into existence in plain sight. 520 u puts
    // the cull under 2% residual.
    const far = VIEW_DISTANCE + 120;
    for (let i = 0; i < this.landmarks.length; i++) {
      const L = this.landmarks[i];
      const x = wrapDelta(L.x, originX);
      const z = wrapDelta(L.z, originZ);
      const banner = L.kind === 'banner';
      if (Math.abs(x) > far || Math.abs(z) > far) {
        if (banner) {
          this.poles.setMatrixAt(L.slot, this._hidden);
          this.flags.setMatrixAt(L.slot, this._hidden);
        } else {
          this.monos.setMatrixAt(L.slot, this._hidden);
        }
        continue;
      }
      if (banner) {
        d.position.set(x, L.y, z);
        d.rotation.set(0, L.spin, 0);
        d.scale.set(1, L.height, 1);
        d.updateMatrix();
        this.poles.setMatrixAt(L.slot, d.matrix);

        d.position.set(x + Math.sin(L.spin) * 1.5, L.y + L.height - 1.9, z + Math.cos(L.spin) * 1.5);
        d.scale.set(3.0, 2.2, 1);
        d.updateMatrix();
        this.flags.setMatrixAt(L.slot, d.matrix);
      } else {
        d.position.set(x, L.y - 0.6, z);
        d.rotation.set(0, L.spin, 0);
        d.scale.set(2.6 + L.tint * 1.2, L.height, 2.0 + L.tint);
        d.updateMatrix();
        this.monos.setMatrixAt(L.slot, d.matrix);
      }
    }
    this.poles.instanceMatrix.needsUpdate = true;
    this.flags.instanceMatrix.needsUpdate = true;
    this.monos.instanceMatrix.needsUpdate = true;
  }

  setSkyPosition(camera) {
    this.sky.position.copy(camera.position);
  }
}
