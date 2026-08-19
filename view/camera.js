// Follow-behind chase camera, Mario Kart shape: it sits behind and above and
// swings around to your travel direction rather than snapping to it. The swing
// is the whole trick - a camera that tracks heading instantly makes carving feel
// like the world is rotating around a stationary kart, and all the sensation
// disappears. Lagging it means the corner APPEARS as you turn into it.
//
// FOV opens with speed and opens further in the air. That, the wind, and the
// ground grid are the only speedometer this game has.

import * as THREE from '../vendor/three.module.js';
import { clamp, approach, angleDelta, wrapAngle } from '../sim/math.js';
import { height } from '../sim/terrain.js';

// Tuned by eye in the browser, not from the brief's starting numbers. A camera
// 26 up and 34 back turns the swells into a relief map and kills the sensation
// of speed; sitting low and close puts the ground in the bottom of the frame
// where it can rush past, which is where all the speed actually comes from.
export const CAM = {
  back: 21,
  up: 8.2,
  lookAhead: 15,
  lookAheadSpeed: 0.26,
  lookUp: 2.8,
  yawRate: 3.4, // how fast the camera swings to your travel direction
  yawRateReduced: 1.6,
  posRate: 11,
  fovBase: 58,
  fovSpeed: 9, // + at full speed
  fovAir: 4, // + while flying
  fovReduced: 62,
  minGroundClearance: 3.2,
  shakeDecay: 6,
  // The shake's two axes, in radians per second of SHAKE time (see update):
  // the 0.061 and 0.083 rad per wall-millisecond it used to be, so nothing
  // about how a kick looks changed - only whose clock it runs on.
  shakeRateX: 61,
  shakeRateY: 83,
  shakeRest: 0.001, // below this the shake is over (an offset under 0.0005 u)
  // How fast the camera's idea of "we are flying" catches up with the fact.
  // This used to be infinite: `s.airborne ? 2.5 : 0` is a STEP, and a step in
  // the camera's target position is an impulse. The review measured camera jerk
  // at takeoff and landing at 26x the cruise median - a visible snap at exactly
  // the two moments the player most wants to watch. 4/s spreads the same 2.5 u
  // rise over roughly a third of a second, which is under the duration of the
  // shortest flight the game can now produce.
  airBlendRate: 4,
  airUp: 2.5, // extra height while flying
  airLookUp: 1.5, // extra look-target height while flying
};

export class ChaseCamera {
  constructor(camera) {
    this.camera = camera;
    this.yaw = 0;
    this.pos = new THREE.Vector3();
    this.look = new THREE.Vector3();
    this.fov = CAM.fovBase;
    this.shake = 0;
    // The shake's own clock, in seconds, advanced by dt and only while a shake
    // is live. It used to be performance.now(): a wall clock, which kept
    // moving through the frames main.js hands in as dt = 0 - the hit-stop and
    // the pause - so the one thing in a "held" world still jittering was the
    // camera, at ±0.45 u, and a hit read as a hitch instead of a beat. Frame
    // time is the world's time; the shake now runs on it like everything else
    // (dt = 0 ⇒ the offset holds), and pump() drives it deterministically.
    this.shakeT = 0;
    this.airBlend = 0; // 0 = planted, 1 = fully in the air
    this.reducedMotion = false;
    this._want = new THREE.Vector3();
    this._wantLook = new THREE.Vector3();
    this.initialised = false;
    // Armed by reset(): the next update() places every smoothed quantity AT
    // its target instead of lerping there. Not the constructor's flag - the
    // boot's first frame still swings in from the origin as it always has.
    this._snap = false;
  }

  kick(amount) {
    if (this.reducedMotion) return;
    this.shake = Math.min(1.4, this.shake + amount);
  }

  /**
   * Forget the last round. main.js calls this from beginRound() - a restart,
   * never a resume (a resumed round keeps its camera). Until iteration 6 a
   * restart only re-armed the yaw snap, so the count-in for a retry opened on
   * whatever the previous round left: `pos`/`look` lerping in from the old
   * camera (~40 u away in the probe: a ~0.3 s swing around a kart that is
   * standing still, ~0.5 s under reduced motion), the fov zooming in from boost
   * speed (66.7 → 58.9 over the first half second), and a shake still decaying under
   * the result card riding into the count-in (a reflex R 100 ms after a
   * killing hit carried 0.478, at rest 28 frames in). Now the shake is dropped
   * here and the next frame is a SETTLED frame: yaw, position, look target,
   * air blend and fov all at their targets. Nothing else is touched -
   * `reducedMotion` is the player's, not the round's.
   */
  reset() {
    this.initialised = false;
    this._snap = true;
    this.shake = 0;
    this.shakeT = 0;
  }

  /**
   * @param s {x,y,z,moveDir,heading,speed,airborne,drift} in RENDER space
   *          (the player sits at x=0,z=0; only y is a real world height)
   * @param originX/originZ the player's world position, for terrain lookups
   */
  update(dt, s, originX, originZ) {
    const reduced = this.reducedMotion;

    const yawRate = reduced ? CAM.yawRateReduced : CAM.yawRate;
    // Track the direction of TRAVEL, not the nose, so a drifting kart keeps the
    // camera pointed where it is actually going.
    const target = s.moveDir;
    if (!this.initialised) {
      this.yaw = target;
      this.initialised = true;
    }
    this.yaw = wrapAngle(this.yaw + angleDelta(target, this.yaw) * (1 - Math.exp(-yawRate * dt)));

    // The frame after reset(): every lerp below lands on its target outright,
    // whatever dt is (a count-in that was auto-paused before its first frame
    // still shows the new round's camera, not the old round's).
    const snap = this._snap;
    this._snap = false;

    // One scalar carries "how airborne are we", and everything the flight
    // changes about the camera is scaled by it. Nothing steps.
    this.airBlend = snap
      ? (s.airborne ? 1 : 0)
      : approach(this.airBlend, s.airborne ? 1 : 0, CAM.airBlendRate, dt);
    const air = this.airBlend;

    const speedN = clamp(s.speed / 62, 0, 1.25);
    const back = CAM.back + speedN * 5.5;
    const up = CAM.up + speedN * 2.2 + air * CAM.airUp;

    this._want.set(
      s.x - Math.sin(this.yaw) * back,
      s.y + up,
      s.z - Math.cos(this.yaw) * back
    );

    // Never let a swell eat the camera.
    const groundHere = height(originX + this._want.x - s.x, originZ + this._want.z - s.z);
    this._want.y = Math.max(this._want.y, groundHere + CAM.minGroundClearance);

    const rate = reduced ? CAM.posRate * 0.55 : CAM.posRate;
    const k = 1 - Math.exp(-rate * dt);
    if (snap) this.pos.copy(this._want);
    else this.pos.lerp(this._want, k);

    const ahead = CAM.lookAhead + s.speed * CAM.lookAheadSpeed;
    this._wantLook.set(
      s.x + Math.sin(this.yaw) * ahead,
      s.y + CAM.lookUp + air * CAM.airLookUp,
      s.z + Math.cos(this.yaw) * ahead
    );
    if (snap) this.look.copy(this._wantLook);
    else this.look.lerp(this._wantLook, 1 - Math.exp(-(reduced ? 8 : 14) * dt));

    this.camera.position.copy(this.pos);

    if (this.shake > 0) {
      // Exponential decay never reaches 0 on its own, and a shake that is
      // "live" at 1e-28 would keep its clock and its sub-pixel offset running
      // for the rest of the session; below the floor it is at rest.
      this.shake = Math.max(0, this.shake - CAM.shakeDecay * dt * this.shake);
      if (this.shake < CAM.shakeRest) this.shake = 0;
      this.shakeT += dt;
      const m = this.shake * 0.5;
      this.camera.position.x += (Math.sin(this.shakeT * CAM.shakeRateX) * m);
      this.camera.position.y += (Math.sin(this.shakeT * CAM.shakeRateY) * m);
    }

    this.camera.lookAt(this.look);

    const wantFov = reduced
      ? CAM.fovReduced
      : CAM.fovBase + speedN * CAM.fovSpeed + air * CAM.fovAir;
    this.fov = snap ? wantFov : approach(this.fov, wantFov, 4.5, dt);
    if (Math.abs(this.camera.fov - this.fov) > 0.01) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
  }
}
