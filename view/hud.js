// Wordless HUD, three clusters and nothing else:
//   top centre    - timer ring, with the three HP pips inside it, the chain
//                   dots under it and the live score under those
//   bottom centre - boost meter
//   screen edges  - a wedge pointing at a hunter that is winding up off-camera
//
// The wedge is not a nicety. The camera swings around behind the direction of
// travel, so a hunter lining up from behind is genuinely invisible; without the
// wedge, the telegraph would be inaudible-to-the-eye and the hit would be
// unsignalled. There is deliberately no speedometer (the camera, the wind and
// the ground grid carry speed) and no minimap.

import { clamp, angleDelta } from '../sim/math.js';

// A bearing the SCREEN can use: 0 = straight ahead, + = screen right, which is
// what every drawer here assumes. The raw delta `worldAngle - cameraYaw` grows
// toward world +X, and under this camera world +X is screen LEFT - the same
// handedness that had A and D swapped at the input boundary. Every bearing
// that ends up on glass or in an ear is produced through this negation;
// consuming the raw delta anywhere re-creates the mirrored wedge this fixed
// (the wedge, the ko hint and the stereo pan all pointed the wrong way, and
// two of them had shipped that way unnoticed). Pinned against THREE's own
// projection in tests/screen-bearing.test.js.
export function screenBearing(worldAngle, cameraYaw) {
  return -angleDelta(worldAngle, cameraYaw);
}

const RING_R = 30;
const PIP_R = 5.5;
// The final-seconds ring breathes at 11 rad/s (1.75 Hz, under the 3 Hz flash
// limit); its phase clock wraps at one period so it never grows.
const URGENT_RATE = 11;
const URGENT_PERIOD = (Math.PI * 2) / URGENT_RATE;
// Below this width the whole top cluster shrinks together: ring, offsets, and
// the score's font. One number, so nothing in the stack can disagree about it.
const SMALL_W = 520;

// The live score, laid out under the chain-dot row. Baselines are offsets from
// the ring's bottom (cy + ringR); the dots sit at +13 with bottoms at ≈+16.3
// under the catch pulse. Digit cap tops land ≈+21 at both breakpoints (15px:
// 32 − 10.8; 13px: 30 − 9.4), keeping ≈4–5px of air above the number — the
// small baseline was first spec'd at +28, which fused digit and dot by ~2px.
const SCORE = {
  dy: 32, dySmall: 30,
  font: 15, fontSmall: 13,
  cupGap: 8, cupR: 4.2,
  restAlpha: 0.6,
};

export class Hud {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.dpr = 1;
    this.w = 0;
    this.h = 0;
    this.chainPulse = 0;
    this.chainValue = 0;
    this.hitPulse = 0;
    this.wedgePulse = 0;
    this.wedgeWasUp = false;
    this.rearmPulse = 0;
    this.goPulse = 0;
    this.koPulse = 0;
    // The final-seconds ring's pulse phase, in seconds of HUD time. It was
    // performance.now() - the last wall clock in the view once the camera
    // shake moved onto frame time - which made every pump()ed frame differ
    // from the last by however long the machine took between them. Frame time
    // in, like rearmPulse and koPulse beside it.
    this.urgentT = 0;
    // The passing-best cup: the transition frame is detected here (the
    // wedgeWasUp pattern), the entrance is one decaying pulse, and it can be
    // owed - a crossing under a live wedge waits for the danger to leave.
    this.bestWasPassed = false;
    this.bestPulse = 0;
    this.bestDeferred = false;
    this.scoreSize = SCORE.font;
    this.scoreFont = '';
    this.digitW = 0;
    this.safe = { top: 0, right: 0, bottom: 0, left: 0 };
    this.resize();
  }

  // The notch and the home indicator are CSS's business, not canvas's, so the
  // insets are read once from a probe element that declares them and then used
  // as ordinary numbers. Without this the timer ring sits under the notch and
  // the boost meter sits under the home indicator on every modern phone.
  readSafeArea() {
    const probe = document.getElementById('safe-probe');
    if (!probe) return;
    const cs = getComputedStyle(probe);
    const px = (v) => {
      const n = parseFloat(v);
      return Number.isFinite(n) ? n : 0;
    };
    this.safe.top = px(cs.paddingTop);
    this.safe.right = px(cs.paddingRight);
    this.safe.bottom = px(cs.paddingBottom);
    this.safe.left = px(cs.paddingLeft);
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.dpr = dpr;
    this.w = this.canvas.clientWidth;
    this.h = this.canvas.clientHeight;
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.readSafeArea();
    // Tabular by construction, not by font: system-ui makes no promise about
    // digit advances, and a centred number whose digits vary in width shivers
    // on every score change. `0` is the widest-or-equal digit in every metric
    // font, so its advance is the cell every digit is centred in. Measured
    // once per resize, which is the only time the breakpoint (and so the font)
    // can change.
    this.scoreSize = this.w < SMALL_W ? SCORE.fontSmall : SCORE.font;
    this.scoreFont = `600 ${this.scoreSize}px system-ui`;
    this.ctx.font = this.scoreFont;
    this.digitW = this.ctx.measureText('0').width;
  }

  /**
   * Drop every one-shot the last round left in flight. Called on a hidden
   * frame that is NOT a pause (title/result) - the pause card hides the HUD
   * too, and there the pulses must survive, frozen, for the resume. The cup's
   * latch and the wedge's arrival memory go too, so the next round's first
   * crossing and first wedge are events again. Called from two places: the
   * round-over hidden frame (title/result), and beginRound() itself since
   * iteration 6 - so an R mid-round, which has no hidden frame, no longer
   * rides a fading vignette or a chain ring into its own count-in.
   */
  forgetPulses() {
    this.chainPulse = 0;
    this.chainValue = 0;
    this.hitPulse = 0;
    this.wedgePulse = 0;
    this.wedgeWasUp = false;
    this.goPulse = 0;
    this.bestWasPassed = false;
    this.bestPulse = 0;
    this.bestDeferred = false;
  }

  pulseChain(mult) {
    this.chainPulse = 1;
    this.chainValue = mult;
  }

  pulseHit() {
    this.hitPulse = 1;
  }

  /** The GO flash, thrown at the instant the count-in hands control back. */
  pulseGo() {
    this.goPulse = 1;
  }

  /**
   * @param s {round, timeLeft, timeTotal, pips, maxPips, boost, boostArmed, threat,
   *           score, best, chainTimer, chainWindow, chain}
   *          round  = false in ?mode=kart: no clock, no pips and no score exist to draw
   *          threat = {angle (radians, relative to camera yaw), onScreen, urgency}
   *          count  = {lit, pop} while counting in, else null
   *          score  = the running score, best = the saved personal best (0 = none)
   *          chainTimer / chainWindow / chain = the sim's own chain state: seconds
   *                   left in the window, the window's length, the live chain
   */
  draw(dt, s) {
    const ctx = this.ctx;
    const w = this.w;
    const h = this.h;
    ctx.clearRect(0, 0, w, h);

    // The result card is a translucent panel, so anything still drawn on the
    // HUD reads THROUGH it - a live timer ring hanging over a finished round,
    // which is both wrong and distracting. When the round is over the HUD has
    // nothing to say - and nothing to carry into the next round: the one-shots
    // decay only in the block below, so a killing hit's vignette (pulseHit on
    // the frame the round ended) would otherwise sit at 1 under the result
    // card and paint the NEXT round's first count-in frames green - every
    // retry after a knockdown opening on the last death's flash. Forgotten
    // here, on the round-over frame, so every way in through a title or a
    // result card (Enter, R on the result, the play button) starts clean.
    if (s.hidden) {
      // Hidden is not the same as over: the pause card hides the HUD too
      // (hudVisible() is inRound, and PAUSED is not), and a paused round must
      // come back with the cup it earned and the wedge it had already pinged -
      // forgetting there replayed both on every resume, including the
      // auto-pause of a tab switch (integration review MAJOR-1). So the
      // payload says which hidden this is, and only a finished round forgets.
      if (!s.paused) this.forgetPulses();
      return;
    }

    // Clamped to 0..1 rather than just floored: these drive stroke radii, and a
    // pulse that ever exceeded 1 would ask the canvas for a negative arc.
    this.chainPulse = clamp(this.chainPulse - dt * 1.1, 0, 1);
    this.hitPulse = clamp(this.hitPulse - dt * 1.6, 0, 1);
    this.wedgePulse = clamp(this.wedgePulse - dt * 2.6, 0, 1);
    this.goPulse = clamp(this.goPulse - dt * 2.4, 0, 1);
    this.rearmPulse = (this.rearmPulse + dt) % 1;
    this.koPulse = (this.koPulse + dt * 0.8) % 1;
    this.urgentT = (this.urgentT + dt) % URGENT_PERIOD;

    const small = w < SMALL_W;
    const ringR = small ? RING_R * 0.82 : RING_R;
    const cx = w / 2;
    const cy = this.safe.top + (small ? 34 : 44) + ringR * 0.2;
    // Decided once, up here, because two drawers need it: the wedge itself
    // (below) and the score's cup, whose entrance yields to a live wedge.
    const wedgeUp = !!(s.threat && !s.threat.onScreen);

    // --- damage vignette ----------------------------------------------------
    if (this.hitPulse > 0) {
      const g = ctx.createRadialGradient(cx, h / 2, Math.min(w, h) * 0.25, cx, h / 2, Math.max(w, h) * 0.7);
      g.addColorStop(0, 'rgba(190,255,40,0)');
      g.addColorStop(1, `rgba(150,230,30,${0.32 * this.hitPulse})`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }

    // --- timer ring and HP pips ---------------------------------------------
    // Both are round-only. ?mode=kart has no clock and nothing that can hurt
    // you, and a ring that never moves over three pips that can never be lost
    // is chrome lying about the mode it is drawn in.
    ctx.lineCap = 'round';
    if (s.round !== false) {
      this.drawClock(cx, cy, ringR, s);
      // The score is round-only for the same reason: kart steps no kos, and a
      // frozen 0 would be a readout of a system the mode does not run.
      this.drawScore(dt, cx, cy + ringR + (small ? SCORE.dySmall : SCORE.dy), s, wedgeUp);
    }

    // --- boost meter --------------------------------------------------------
    const bw = Math.min(190, w * 0.42);
    const bh = 9;
    const bx = cx - bw / 2;
    const by = h - this.safe.bottom - (small ? 30 : 42);

    roundRect(ctx, bx, by, bw, bh, bh / 2);
    ctx.fillStyle = 'rgba(12,22,34,0.30)';
    ctx.fill();

    const bf = clamp(s.boost / 100, 0, 1);
    if (bf > 0.005) {
      roundRect(ctx, bx, by, Math.max(bh, bw * bf), bh, bh / 2);
      ctx.fillStyle = !s.boostArmed
        ? 'rgba(120,140,160,0.75)'
        : s.boosting
          ? '#ffd45e'
          : '#7fe3ff';
      ctx.fill();
    }
    if (!s.boostArmed) {
      // Rearm threshold, so the hard floor is visible rather than mysterious.
      // It PULSES while locked out: a static tick next to a dead button reads
      // as decoration, and the one thing the player needs to know is that the
      // button is coming back.
      const rx = bx + bw * 0.34;
      const p = 0.45 + 0.55 * Math.abs(Math.sin(this.rearmPulse * Math.PI));
      ctx.fillStyle = `rgba(255,255,255,${0.35 + p * 0.55})`;
      ctx.fillRect(rx - 1, by - 3 - p * 2, 2, bh + 6 + p * 4);
    }

    // --- threat wedge -------------------------------------------------------
    // With a camera that swings behind the direction of travel, this is the
    // threat channel 91% of the time - so it is chrome, and it has to look like
    // chrome. It was drawn at 0.36 of the short side in acid yellow-green: an
    // inset radius over a green world, in a hue the world already uses, which
    // the review read as a ground pickup rather than a warning. It now sits
    // near the screen edge, is half again as big, wears a dark outline that no
    // terrain colour can swallow, pulses once on appearance, and is in the
    // hunters' own violet/magenta - the only place that hue family appears.
    if (wedgeUp && !this.wedgeWasUp) this.wedgePulse = 1;
    this.wedgeWasUp = wedgeUp;
    if (wedgeUp) {
      const inset = 46 + Math.max(this.safe.left, this.safe.right);
      const r = Math.min(
        Math.min(w, h) * 0.46,
        Math.min(w / 2 - inset, h / 2 - inset - this.safe.top)
      );
      this.drawWedge(cx, h / 2, Math.max(60, r), s.threat.angle, s.threat.urgency, s.reduced);
    }

    // --- nearest ko hint ----------------------------------------------------
    // Deliberately much quieter than the wedge and a different SHAPE as well as
    // a different hue, so the two can never be confused: a small friendly dot
    // rather than an arrowhead. Kos respawn 110-260 u away, where they are two
    // pixels of yellow, and without this nothing in the game tells you which way
    // the points are.
    //
    // Two readouts of the same fact, split by the frustum. Off-camera: the edge
    // dot. On-camera: an open ring AROUND the projected sprite - open so the ko
    // sits in its hole and is never painted over, a ring so that with no colour
    // vision at all it still cannot be read as the filled dot or the threat
    // arrowhead. How the ring sizes and fades against range lives in
    // koBeaconShape, where it is testable without a canvas.
    if (s.koHint) {
      if (s.koHint.onScreen) {
        const b = koBeaconShape(s.koHint.dist);
        if (b) {
          this.drawKoBeacon(
            ((s.koHint.ndx + 1) / 2) * w,
            ((1 - s.koHint.ndy) / 2) * h,
            b.r, b.alpha, s.reduced
          );
        }
      } else {
        this.drawKoHint(cx, h / 2, Math.min(w, h) * 0.40, s.koHint.angle);
      }
    }

    // --- count-in ------------------------------------------------------------
    // Three dots filling left to right, then a ring thrown outward on GO. It is
    // the whole reason the round now STARTS rather than simply being under way,
    // and it is the same beat coming back off a pause, so the two are one thing
    // to learn. Beats land 0.5 s apart (2 Hz, well under the 3 Hz flash limit);
    // reduced motion drops the scale pop and keeps the beats, and holds the GO
    // ring at rest (below) while it fades.
    //
    // Cyan, not the accent orange they were first drawn in: three orange dots in
    // a row sat on screen at the same time as the three orange HP pips inside
    // the ring, and at a glance the count-in read as a health bar. Cyan is the
    // ready/go channel (the boost meter and the GO ring), and the dark outline
    // is the wedge's trick - no terrain or sky colour can swallow the shape.
    const cdy = h * 0.4;
    if (s.count) {
      for (let i = 0; i < 3; i++) {
        const x = cx + (i - 1) * 36;
        const lit = i < s.count.lit;
        const pop = lit && i === s.count.lit - 1 && !s.reduced ? s.count.pop : 0;
        const r = 12 + pop * 5;
        ctx.beginPath();
        ctx.arc(x, cdy, r, 0, Math.PI * 2);
        if (lit) {
          ctx.fillStyle = '#7fe3ff';
          ctx.fill();
        }
        ctx.strokeStyle = lit ? 'rgba(12,22,34,0.72)' : 'rgba(12,22,34,0.42)';
        ctx.lineWidth = lit ? 3.5 : 3;
        ctx.stroke();
      }
    }
    // The GO ring under reduced motion: at rest - its birth radius and weight,
    // alpha the only thing that decays. Drop the movement, keep the
    // distinction; the same rule the count-in pop and the score pop follow.
    if (this.goPulse > 0) {
      const p = this.goPulse;
      const q = s.reduced ? 1 : p; // geometry follows q, alpha follows p
      ctx.beginPath();
      ctx.arc(cx, cdy, 24 + (1 - q) * 105, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(127,227,255,${p * 0.8})`;
      ctx.lineWidth = 6 * q + 1;
      ctx.stroke();
    }
  }

  /** Timer ring, the chain pulse that rides on it, and the HP pips inside it. */
  drawClock(cx, cy, ringR, s) {
    const ctx = this.ctx;
    const frac = clamp(s.timeLeft / s.timeTotal, 0, 1);

    ctx.beginPath();
    ctx.arc(cx, cy, ringR, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(12,22,34,0.30)';
    ctx.lineWidth = 7;
    ctx.stroke();

    const urgent = s.timeLeft < 10;
    const pulse = urgent ? 0.72 + 0.28 * Math.sin(this.urgentT * URGENT_RATE) : 1;
    ctx.beginPath();
    ctx.arc(cx, cy, ringR, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
    ctx.strokeStyle = urgent ? `rgba(255,120,90,${pulse})` : 'rgba(255,255,255,0.92)';
    ctx.lineWidth = 5.5;
    ctx.stroke();

    // The chain window, while a chain is alive: a thin gold arc at the catch
    // pulse's own birth radius (ringR + 6) draining in step with the sim's
    // chainTimer, and the multiplier dots holding at rest under the ring. Every
    // catch visibly leaves the arc full as the pulse departs from it - the
    // refill and the celebration share an origin, which is what teaches what
    // the arc is without a word. Arc length is chainTimer/chainWindow every
    // frame, no tween: the sim snaps to full on a catch, so the arc snaps.
    // Nothing here is reduced-motion gated - the drain is state, not
    // decoration, and it never pings, blinks or changes colour, so the red
    // final-seconds ring inside it always wins by width, alpha and animation.
    // Inner edge ≈ ringR + 5.1 against the 7px backing ring's outer edge at
    // ringR + 3.5: a 1.6px gap, and a different hue.
    const cw = chainWindowReadout(s.chainTimer, s.chainWindow, s.chain);
    const dy = cy + ringR + 13;
    if (cw) {
      ctx.beginPath();
      ctx.arc(cx, cy, ringR + 6, -Math.PI / 2, -Math.PI / 2 + cw.frac * Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,214,80,0.55)';
      ctx.lineWidth = 1.75;
      ctx.stroke();
      for (let i = 0; i < cw.dots; i++) {
        ctx.beginPath();
        ctx.arc(cx + (i - (cw.dots - 1) / 2) * 9, dy, 2.4, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,226,120,0.5)';
        ctx.fill();
      }
    }

    // The catch celebration. Under reduced motion it plays at rest: the ring
    // sits on its birth radius (the chain arc's own, ringR + 6) at its birth
    // weight and the pulse dots at their birth size, and alpha is the only
    // thing that decays - the catch is still marked, nothing expands. Row 35's
    // spec left the chainPulse un-gated as out of its scope; iteration 5's
    // reduced-motion pass brought it in under the build's own rule (drop the
    // movement, keep the distinction).
    if (this.chainPulse > 0) {
      const p = this.chainPulse;
      const q = s.reduced ? 1 : p; // geometry follows q, alpha follows p
      ctx.beginPath();
      ctx.arc(cx, cy, ringR + 6 + (1 - q) * 16, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(255,214,80,${p * 0.85})`;
      ctx.lineWidth = 3 * q + 0.5;
      ctx.stroke();
      // The multiplier, as a row of dots rather than a word: the brighter,
      // larger version laid over the resting row for the ~1s after a catch.
      // Gated on the same live-chain result as the row it rides on, so a
      // hunter hit inside that second takes both at once - a pulse row that
      // outlived its chain would show a multiplier the sim had already zeroed.
      // The celebration ring above is not gated: it marks the catch, which
      // did happen.
      if (cw) {
        const n = Math.min(this.chainValue, 6);
        for (let i = 0; i < n; i++) {
          const dx = cx + (i - (n - 1) / 2) * 9;
          ctx.beginPath();
          ctx.arc(dx, dy, 2.6 * q + 0.7, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(255,226,120,${p})`;
          ctx.fill();
        }
      }
    }

    // HP pips, inside the ring.
    const maxPips = s.maxPips ?? 3;
    const pipGap = PIP_R * 2.9;
    for (let i = 0; i < maxPips; i++) {
      const px = cx + (i - (maxPips - 1) / 2) * pipGap;
      ctx.beginPath();
      ctx.arc(px, cy, PIP_R, 0, Math.PI * 2);
      if (i < s.pips) {
        ctx.fillStyle = this.hitPulse > 0 ? '#fff' : '#ff8a4c';
        ctx.fill();
      } else {
        ctx.strokeStyle = 'rgba(12,22,34,0.4)';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }
  }

  /**
   * The live score, centred under the chain dots, and the passing-best cup at
   * its left. Numerals only, ink-outlined white: achromatic, small, screen-fixed
   * in the cluster the eye already visits for the clock, and it never pings -
   * built unable to win the eye from the wedge, by every dimension the wedge
   * uses. What to show is decided in scoreReadout, where it is testable.
   */
  drawScore(dt, cx, baseline, s, wedgeUp) {
    const ctx = this.ctx;
    const r = scoreReadout(s.score, s.best);

    // Cup state, every frame the score is drawable (so a fresh round, whose
    // score is 0, resets it by construction - no per-round latch). The crossing
    // is once per round because score never decreases and best is stable
    // mid-round; its entrance is OWED rather than played if the wedge is up,
    // and paid on the first frame the danger is down. Reduced motion pays it
    // at rest: the cup appears, nothing moves.
    const passed = !!(r && r.bestPassed);
    if (passed && !this.bestWasPassed) this.bestDeferred = true;
    this.bestWasPassed = passed;
    if (!passed) { this.bestDeferred = false; this.bestPulse = 0; }
    if (this.bestDeferred && !wedgeUp) {
      this.bestDeferred = false;
      this.bestPulse = s.reduced ? 0 : 1;
    }
    this.bestPulse = clamp(this.bestPulse - dt * 1.1, 0, 1);

    if (!r) return;

    // Digits at a fixed advance (see resize), the block centred on cx. The
    // catch pop rides chainPulse - one thing decays - and reduced motion drops
    // the pop and keeps the value change, the count-in's own rule.
    const yc = baseline - this.scoreSize * 0.36; // visual centre of the cap height
    const total = r.digits.length * this.digitW;
    const x0 = cx - total / 2;
    const pop = s.reduced ? 1 : 1 + 0.12 * this.chainPulse;

    ctx.save();
    ctx.font = this.scoreFont;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.lineJoin = 'round';
    ctx.translate(cx, yc);
    ctx.scale(pop, pop);
    ctx.translate(-cx, -yc);
    for (let i = 0; i < r.digits.length; i++) {
      const dx = x0 + (i + 0.5) * this.digitW;
      // Outline first and wide, the wedge's trick, so no sky or terrain colour
      // can swallow a digit.
      ctx.strokeStyle = 'rgba(12,22,34,0.55)';
      ctx.lineWidth = 3;
      ctx.strokeText(r.digits[i], dx, baseline);
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.fillText(r.digits[i], dx, baseline);
    }
    ctx.restore();

    // The cup: above your record, and staying up for the rest of the round -
    // a marker that vanished would un-say a fact that is still true. Silent:
    // row 18's chime marks the round-end record moment and is not spent here.
    if (passed && !this.bestDeferred) {
      const p = this.bestPulse;
      // Entrance: scale 1.4→1 while fading in over the ~0.9s the pulse lasts.
      // The fade is eased so the first third of the entrance is not spent
      // invisible; it lands on the rest alpha as the scale settles.
      const alpha = SCORE.restAlpha * (1 - p * p);
      const scale = 1 + 0.4 * p;
      this.drawCup(x0 - SCORE.cupGap - SCORE.cupR * 1.6, yc, scale, alpha);
    }
  }

  /** ~10px trophy in row 18's record gold over the standard dark outline. */
  drawCup(x, y, scale, alpha) {
    const ctx = this.ctx;
    const R = SCORE.cupR;
    ctx.save();
    // The path below spans y −3.2..4.7; the 0.7 puts its middle on the digits'.
    ctx.translate(x, y - 0.7);
    ctx.scale(scale, scale);
    ctx.lineJoin = 'round';
    // Bowl, stem, foot as one path: the dark outline goes on first and wide so
    // the gold reads as a shape over any ground colour, not as a smear.
    ctx.beginPath();
    ctx.moveTo(-R, -3.2);
    ctx.lineTo(R, -3.2);
    ctx.arc(0, -3.2, R, 0, Math.PI); // the bowl, hanging from the rim
    ctx.closePath();
    ctx.rect(-0.8, R - 3.2, 1.6, 2.4);
    ctx.rect(-2.8, R - 0.9, 5.6, 1.4);
    ctx.strokeStyle = `rgba(12,22,34,${alpha * 0.9})`;
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.fillStyle = `rgba(192,132,23,${alpha})`;
    ctx.fill();
    // Handles: two thin ears, the detail that makes a bowl on a stem a cup.
    ctx.beginPath();
    ctx.arc(-R - 0.6, -1.9, 1.7, Math.PI * 0.5, Math.PI * 1.5);
    ctx.moveTo(R + 0.6, -1.9 - 1.7);
    ctx.arc(R + 0.6, -1.9, 1.7, -Math.PI * 0.5, Math.PI * 0.5);
    ctx.strokeStyle = `rgba(192,132,23,${alpha})`;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();
  }

  drawWedge(cx, cy, r, angle, urgency, reduced) {
    const ctx = this.ctx;
    // angle: 0 = straight ahead (up the screen), + = to the right.
    const a = angle - Math.PI / 2;
    const pulse = this.wedgePulse;
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r;
    // Under reduced motion the arrival is alpha-only: the wedge sits at its
    // resting size (no 35% pop, which the ping's radius rides on - a "resting"
    // ring on a shrinking wedge would still move) and the ping holds its birth
    // radius and weight while it fades. The alpha lift stays: the arrival is
    // still louder than the resting wedge, it just does not grow.
    const pop = reduced ? 0 : pulse;
    const size = (22 + urgency * 17) * (1 + pop * 0.35);
    const alpha = Math.min(1, 0.5 + urgency * 0.45 + pulse * 0.2);

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(a);

    // Appearance ping: a ring that expands and fades, so the wedge ARRIVES
    // rather than simply being there.
    if (pulse > 0) {
      const q = reduced ? 1 : pulse; // geometry follows q, alpha follows pulse
      ctx.beginPath();
      ctx.arc(0, 0, size * (1.1 + (1 - q) * 1.5), 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(226,86,214,${pulse * 0.55})`;
      ctx.lineWidth = 3 * q + 0.5;
      ctx.stroke();
    }

    ctx.beginPath();
    ctx.moveTo(size, 0);
    ctx.lineTo(-size * 0.55, size * 0.72);
    ctx.lineTo(-size * 0.2, 0);
    ctx.lineTo(-size * 0.55, -size * 0.72);
    ctx.closePath();
    // Dark outline first and wide, so the shape keeps a hard edge over any
    // ground colour underneath it.
    ctx.strokeStyle = `rgba(26,10,38,${alpha})`;
    ctx.lineWidth = 5;
    ctx.lineJoin = 'round';
    ctx.stroke();
    const g = ctx.createLinearGradient(-size * 0.55, 0, size, 0);
    g.addColorStop(0, `rgba(150,60,190,${alpha})`);
    g.addColorStop(1, `rgba(240,96,220,${alpha})`);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.strokeStyle = `rgba(255,205,250,${alpha * 0.85})`;
    ctx.lineWidth = 1.6;
    ctx.stroke();
    ctx.restore();
  }

  drawKoHint(cx, cy, r, angle) {
    const ctx = this.ctx;
    const a = angle - Math.PI / 2;
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r;
    ctx.save();
    // A soft halo under it, because at 50% alpha over a bright sky the dot
    // washed out to a grey pebble and stopped reading as "friendly, over here".
    ctx.beginPath();
    ctx.arc(x, y, 9, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,217,92,0.16)';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, y, 5.5, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,214,74,0.78)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(60,44,20,0.5)';
    ctx.lineWidth = 1.6;
    ctx.stroke();
    ctx.restore();
  }

  drawKoBeacon(x, y, r, alpha, reduced) {
    const ctx = this.ctx;
    // A slow breathe (0.8 Hz, +-8%) so a far ring stirs against a busy field
    // without competing with the wedge's arrival ping. Reduced motion holds it
    // still - the ring itself is the signal, the breathe is only garnish.
    const rr = reduced ? r : r * (1 + 0.08 * Math.sin(this.koPulse * Math.PI * 2));
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, rr, 0, Math.PI * 2);
    // Dark outline first and wide - the wedge's trick - then the ko's own
    // yellow on top, so no ground or sky colour can swallow the ring.
    ctx.strokeStyle = `rgba(60,44,20,${alpha * 0.7})`;
    ctx.lineWidth = 4.5;
    ctx.stroke();
    ctx.strokeStyle = `rgba(255,214,74,${alpha})`;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
  }
}

// The on-screen ko ring against horizontal range, pure numbers in and out so
// the curve is testable without a canvas. Thresholds, in world units:
//   gone (30)   - ring fully off. fleeRadius is 24: by the time the ko plays
//                 its flee animation - the loudest "chase me" signal the game
//                 has - the ring has already left, so nothing ever hangs over
//                 the sprite during the approach and the catch.
//   full (60)   - full strength. Inside this the sprite is several times its
//                 respawn-range size and findable on its own; the band down to
//                 `gone` is a linear fade rather than a popping toggle.
//   farCap (240)- growth stops. From `full` out to here the ring widens so a
//                 ko at the far end of the 110-260 u respawn band - where the
//                 sprite is the two pixels row 3 is about - stays findable,
//                 without the ring ever dwarfing the screen.
export const KO_BEACON = { gone: 30, full: 60, farCap: 240, rNear: 10, rFar: 16, alpha: 0.65 };

export function koBeaconShape(dist) {
  const B = KO_BEACON;
  // The negated comparison also swallows NaN and undefined: a range the sim
  // never produced should draw nothing, not a ring at a lie.
  if (!(dist > B.gone)) return null;
  const fade = clamp((dist - B.gone) / (B.full - B.gone), 0, 1);
  const grow = clamp((dist - B.full) / (B.farCap - B.full), 0, 1);
  return { r: B.rNear + (B.rFar - B.rNear) * grow, alpha: B.alpha * fade };
}

// What the score readout shows, pure numbers in and a plain object out, so the
// judgement is testable without a canvas: null means draw nothing.
//   - Zero is hidden. Row 16's rule applied to a readout: zero is not a score,
//     the number is born with the first catch, and it never decreases in the
//     frozen sim so it cannot flicker back out. A first-time player staring at
//     a dead 0 for a round is noise, and it keeps the count-in area clean.
//   - Digits only, floored: a score is a sum of integer gains, so a fraction is
//     corruption (save.js's own precedent) and is never rounded UP into a
//     number the sim did not produce. NaN, Infinity and negatives draw nothing;
//     the negated comparison swallows NaN, as the beacon's does, and the
//     safe-integer check is what makes "digits only" true by construction -
//     String() of a huge float grows an exponent, which is letters.
//   - bestPassed is strict, exactly as save.submit() rejects `s <= value`: a
//     tie is not a record, and passing a zero best is not a pass - "zero is
//     not a best" (row 16), so a first-ever run never earns the cup.
export function scoreReadout(score, best) {
  if (!(score > 0)) return null;
  const n = Math.floor(score);
  // Judged AFTER the floor: 0.5 floors to 0, and zero is hidden whatever it
  // was before the floor - a "0" for a quantity in (0, 1) would be the one
  // number the readout must never show (integration review MINOR-1).
  if (!(n > 0) || !Number.isSafeInteger(n)) return null;
  return { digits: String(n), bestPassed: best > 0 && n > best };
}

// The chain-window readout: how much of the window is left, as a fraction, and
// how many multiplier dots to hold, or null for "no chain, draw nothing". Pure
// numbers in, plain object out, testable without a canvas.
//   - chainTimer <= 0 is a dead chain, whatever `chain` says; NaN, undefined
//     and Infinity in any argument draw nothing (the beacon's negated
//     comparison for the timer, an explicit finite check for the window).
//   - chain < 1 with a live timer is a state the sim cannot produce (kos.js
//     sets and resets both together) and is drawn nowhere.
//   - frac is clamped to 1: chainTimer > chainWindow is impossible, and a
//     defensive clamp beats asking the canvas for more than a full turn.
//   - dots is the display clamp the sim itself applies to the multiplier
//     (min(chain, maxMultiplier), maxMultiplier 6) and the pulse row already
//     uses; the literal 6 is pinned against KO_RULES in tests/hud.test.js.
export function chainWindowReadout(chainTimer, chainWindow, chain) {
  if (!(chainTimer > 0) || !Number.isFinite(chainTimer)) return null;
  if (!Number.isFinite(chainWindow) || !(chainWindow > 0)) return null;
  if (!(chain >= 1) || !Number.isFinite(chain)) return null;
  return { frac: clamp(chainTimer / chainWindow, 0, 1), dots: Math.min(Math.floor(chain), 6) };
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}
