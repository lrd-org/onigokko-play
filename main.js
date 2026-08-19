// Entry point. Owns the render loop, the fixed-step accumulator, and the
// translation from simulation state into the view.
//
// Everything is drawn in PLAYER-RELATIVE space: the render origin is the
// player's world position, so the player is always at (0, y, 0) and every other
// thing is placed at its shortest wrapped offset from them. That is what makes
// an endless torus cost nothing - no seam, no float drift at large coordinates,
// and each object is only ever drawn once because the view distance is well
// under half the period.

import * as THREE from './vendor/three.module.js';

import { Game, FIXED_DT, MAX_FRAME_DT, RULES, hashState } from './sim/game.js';
import {
  wrapDelta, height, gradient, sightBlocked as sightBlockedWorld,
} from './sim/terrain.js';
import { clamp, lerp, wrapAngle, angleDelta } from './sim/math.js';
import { KART } from './sim/movement.js';
import { PHASE_STRIKE, HUNT } from './sim/hunters.js';
import { KO_RULES } from './sim/kos.js';

import { WorldView, PALETTE, VIEW_DISTANCE } from './view/world.js';
import { CreatureField, KO_COLORS } from './view/creatures.js';
import { ChaseCamera } from './view/camera.js';
import { Particles } from './view/fx.js';
import { Hud, screenBearing } from './view/hud.js';
import { Sound } from './view/audio.js';
import { makeHitStop, hitStopTrigger, hitStopStep } from './view/hitstop.js';
import { makeBeatEdge, makeSecondEdge } from './view/countbeat.js';
import { Input, ownsActivation } from './view/input.js';
import { Telemetry, wipeOutcome, consentToggleModel } from './view/telemetry.js';
import { wantsReducedMotion } from './view/motion.js';
import { Save } from './view/save.js';
import { Hold } from './view/hold.js';
import { HoldInput } from './view/holdinput.js';
import { buildRun } from './view/result.js';
import { Session, S_TITLE, S_PAUSED, S_RESULT, S_COUNTDOWN } from './view/session.js';

const PARAMS = new URLSearchParams(location.search);
const MODE = PARAMS.get('mode') === 'kart' ? 'kart' : 'ofa';

// m12: `Number(x) || fallback` threw away ?seed=0 (and ?seed=NaN silently became
// a random round). A pinned seed also has to SURVIVE "play again" - the whole
// point of pinning one is replaying the same world - so it is held here rather
// than consumed once at boot.
function readSeedParam() {
  const raw = PARAMS.get('seed');
  if (raw === null || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}
const PINNED_SEED = readSeedParam();
const randomSeed = () => Date.now() % 100000;
const SEED = PINNED_SEED ?? randomSeed();

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
const canvas = document.getElementById('gl');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
// Capped at 2 (a 3x phone renders 2.25x the pixels for no visible gain), and
// re-read on every resize below - a window dragged to a display of another
// density, or Cmd+/-, changes it, and hud.resize() had always followed while
// the GL canvas kept its boot ratio (soft on the sharper screen, over-rendered
// on the coarser).
const pixelRatio = () => Math.min(window.devicePixelRatio || 1, 2);
renderer.setPixelRatio(pixelRatio());
renderer.setClearColor(PALETTE.fog, 1);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(58, 1, 0.5, VIEW_DISTANCE * 2.6);

const sun = new THREE.DirectionalLight(0xfff3e0, 2.0);
sun.position.copy(PALETTE.sun).multiplyScalar(100);
scene.add(sun);
scene.add(new THREE.HemisphereLight(0xdcefff, 0x4a5a3a, 1.5));

const world = new WorldView(scene);
const fx = new Particles(scene);
const chase = new ChaseCamera(camera);
const hud = new Hud(document.getElementById('hud'));
const sound = new Sound();
const telemetry = new Telemetry();
const save = new Save();
const input = new Input(canvas);

// The high score used to exist only inside the consented runs list. Anyone who
// had telemetry on has their record in there and nowhere else, so the move to a
// key of its own reads as a loss unless the old number is carried across. It
// only ever raises, so running it on every boot is free once the key is there.
try {
  save.absorb(telemetry.best());
} catch {
  /* a corrupt runs list is not worth a boot; the key simply starts where it is */
}

const game = new Game({ seed: SEED, mode: MODE });
// C1: the world owns its landmark group now. It used to be added to the scene
// HERE, from the return value, while beginRound() called buildLandmarks() again
// and dropped the result on the floor - so from the second round on, the poles
// you could see were a dead group left parented in player-relative space (they
// travelled with you) and the poles you could hit were invisible.
world.buildLandmarks(game.landmarks);

// One slot per creature, fixed for the life of the page.
const specs = [{ kind: 'player' }];
for (let i = 0; i < game.hunters.length; i++) specs.push({ kind: 'hunter' });
for (let i = 0; i < game.kos.length; i++) {
  specs.push({ kind: 'ko', color: KO_COLORS[i % KO_COLORS.length] });
}
const creatures = new CreatureField(scene, specs);

// ---------------------------------------------------------------------------
// UI shell (icon-only; see index.html)
// ---------------------------------------------------------------------------
const ui = {
  title: document.getElementById('title'),
  titleCard: document.getElementById('title-card'),
  pause: document.getElementById('pause'),
  pauseCard: document.getElementById('pause-card'),
  pauseBtn: document.getElementById('pause-btn'),
  resume: document.getElementById('resume'),
  restart: document.getElementById('restart'),
  home: document.getElementById('home'),
  toggles: document.getElementById('toggles'),
  result: document.getElementById('result'),
  play: document.getElementById('play'),
  again: document.getElementById('again'),
  consent: document.getElementById('consent'),
  motion: document.getElementById('motion'),
  audioBtn: document.getElementById('audio'),
  wipe: document.getElementById('wipe'),
  resultIcon: document.getElementById('result-icon'),
  resultTime: document.getElementById('result-time'),
  resultTimeRow: document.getElementById('result-time-row'),
  resultScore: document.getElementById('result-score'),
  resultKos: document.getElementById('result-kos'),
  resultChain: document.getElementById('result-chain'),
  resultAir: document.getElementById('result-air'),
  resultBest: document.getElementById('result-best'),
  resultBestRow: document.getElementById('result-best-row'),
  resultSeed: document.getElementById('result-seed'),
  resultSeedRow: document.getElementById('result-seed-row'),
  titleBest: document.getElementById('title-best'),
  titleBestScore: document.getElementById('title-best-score'),
};

// Result glyphs. A survived round used to be a green dot, which is the same
// visual weight as a bullet point - the reviewers' note was that finishing the
// hardest thing in the game reads as less of an event than catching one ko. A
// chequered flag inside a laurel is still wordless and still one glyph, but it
// is unmistakably a WIN.
const ICON_WIN = `
<svg viewBox="0 0 64 64" width="72" height="72" aria-label="survived">
  <path d="M14 16c-6 6-6 20 2 28 3 3 7 5 10 6" fill="none" stroke="#3fae6a" stroke-width="4" stroke-linecap="round"/>
  <path d="M50 16c6 6 6 20-2 28-3 3-7 5-10 6" fill="none" stroke="#3fae6a" stroke-width="4" stroke-linecap="round"/>
  <path d="M26 50h12" stroke="#3fae6a" stroke-width="4" stroke-linecap="round"/>
  <path d="M24 12v34" stroke="#2c4a38" stroke-width="3.4" stroke-linecap="round"/>
  <path d="M24 13h20v13H24z" fill="#f7f2e6"/>
  <path d="M24 13h5v6.5h-5zM34 13h5v6.5h-5zM29 19.5h5V26h-5zM39 19.5h5V26h-5z" fill="#2c4a38"/>
</svg>`;
// The DOWN glyph is the hunter itself - the exact art the title card taught,
// unchanged inside the red ring. A red X said "over" without saying what did
// it; the sim records exactly one cause of going down (`survived: false` is
// only ever pushed by applyHit, i.e. a hunter), so the card can name the
// culprit honestly and wordlessly.
const ICON_DOWN = `
<svg viewBox="0 0 64 64" width="72" height="72" aria-label="caught by hunter">
  <circle cx="32" cy="32" r="28" fill="none" stroke="#d8543f" stroke-width="4.5"/>
  <g transform="translate(32 32) scale(0.58) translate(-168 -39.5)">
    <path d="M154 22l6-11 5 11zM168 18l6-13 6 13zM182 22l6-11 5 11z" fill="#d6ff3a"/>
    <path d="M168 74c-15 0-24-13-24-28s10-30 24-30 24 15 24 30-9 28-24 28z" fill="#4b2a70"/>
    <circle cx="159" cy="35" r="8.5" fill="#fff"/><circle cx="177" cy="35" r="8.5" fill="#fff"/>
    <circle cx="161" cy="37" r="4" fill="#d6ff3a"/><circle cx="179" cy="37" r="4" fill="#d6ff3a"/>
  </g>
</svg>`;

// The OS's stillness ask, held as the live query rather than read once: it
// used to be sampled at boot only, so a player who switched it on mid-session
// (or off) waited for the next load. Resolved against the stored pref by
// view/motion.js - the toggle, once touched, outranks the OS either way.
const motionQuery = window.matchMedia?.('(prefers-reduced-motion: reduce)') ?? null;
const readReducedMotion = () => wantsReducedMotion(telemetry.prefs, !!motionQuery?.matches);
let reducedMotion = readReducedMotion();
let soundOn = telemetry.prefs.sound !== false;
chase.reducedMotion = reducedMotion;

// `row` is the consent row's decision, and it is made in view/telemetry.js
// (consentToggleModel) rather than here - second-member review, round 3: what a
// toggle shows after a press that did not take is a claim about the player's
// data, and main.js is browser wiring no test can load. Every caller but the
// consent press has no attempt to report, so the default is "nothing failed,
// paint the flag as it stands" - which is the disk's value, or the last one
// that was actually observed when the disk stopped answering.
// (Its own name, and no object literal in the signature below: the source-level
// pins find a function's body by its first brace, and a default argument that
// opens one would hand them the wrong block.)
const standingConsentRow = () => consentToggleModel({ ok: true, consent: telemetry.consent });

function syncToggles(row = standingConsentRow()) {
  // Published to the stylesheet, because the in-app toggle is not the media
  // query: CSS can only see the OS setting, and a player who asked for stillness
  // in the game has asked for it just as much.
  document.body.classList.toggle('reduced', reducedMotion);
  ui.consent?.setAttribute('aria-pressed', String(row.pressed));
  // Inverted on purpose: pressed means motion is ON, which is the same direction
  // as the sound toggle next to it. The stored pref is still `reducedMotion`
  // (beside `motionChosen`, which only says whether it was ever touched).
  ui.motion?.setAttribute('aria-pressed', String(!reducedMotion));
  ui.audioBtn?.setAttribute('aria-pressed', String(soundOn));
}
syncToggles();

ui.consent?.addEventListener('click', () => {
  // This press is the deliberate attempt that clears the last one's failure
  // mark - nothing else does, and no timer takes it away (second-member review,
  // round 2: a 0.4 s shake is not a signal for a player who asked for
  // stillness, and a mark that expires is not one for a player who looked away).
  ui.consent?.classList.remove('failed-mark');
  // setConsent() moves the flag only to a value the disk has been read back as
  // holding, and syncToggles() paints that flag - so a grant or a withdrawal
  // the storage refused leaves the toggle exactly where it was rather than
  // showing a privacy state nothing durable agrees with. Second-member review,
  // HIGH.
  //
  // Round 2: the return value is no longer thrown away. Withdrawal is a
  // deletion followed by a flag, in that order, and it reports `ok: false` when
  // the runs would not go - at which point the flag was never written, the
  // repaint below reads the DISK's still-granted truth, and the failure gets
  // the same two channels the wipe's does: the persistent mark for the eye, the
  // live region for the ear. Repainting a toggle the player pressed is not
  // evidence of anything; this is what makes it not a claim.
  //
  // Round 3: the answer goes through the pure row model, so the state painted,
  // the mark worn and the words said are one decision made in one place. The
  // shape it guarantees on a failure is a toggle that stays ON (the disk's
  // flag, or the last one anybody managed to read) wearing the cross - never an
  // OFF toggle with an apology beside it, which is what a repaint from
  // re-derived defaults produced.
  const result = telemetry.setConsent(!telemetry.consent);
  const row = consentToggleModel(result);
  syncToggles(row);
  if (row.failed) {
    ui.consent?.classList.add('failed-mark');
    announceWipe(row.announce);
  }
});
ui.motion?.addEventListener('click', () => {
  reducedMotion = !reducedMotion;
  chase.reducedMotion = reducedMotion;
  // motionChosen: from here on the stored choice stands alone, so an OS that
  // asks for reduce no longer wins back a player who turned motion ON here
  // on the next load (ledger row 20).
  telemetry.savePrefs({ reducedMotion, motionChosen: true });
  syncToggles();
});
// The OS setting changing under a running page: re-resolve, which is a no-op
// once the toggle has been touched. Older WebKit only knows addListener; the
// optional call means the listener is simply not attached there, and the
// boot read still stands.
motionQuery?.addEventListener?.('change', () => {
  reducedMotion = readReducedMotion();
  chase.reducedMotion = reducedMotion;
  syncToggles();
});
ui.audioBtn?.addEventListener('click', () => {
  soundOn = !soundOn;
  sound.setEnabled(soundOn);
  telemetry.savePrefs({ sound: soundOn });
  syncToggles();
});

// ---------------------------------------------------------------------------
// The wipe button (ledger row 25). Destroying every stored byte is the one
// action a stray tap must never reach, so it fires only on a HELD input:
// view/hold.js accumulates real held time, the ring paints it, and letting go
// anywhere short of the threshold costs nothing.
//
// It stays a <button> - focusable, announced by its aria-label - and the
// keyboard holds it the same way a pointer does: a keyboard press is not a
// click, it is one more way to hold. Enter/Space activation (the browser's
// synthetic click) stays dead - the keydown is default-prevented and there is
// no click listener for it to reach - and the SAME keydown, before that,
// arms the same Hold on the same rAF loop. Who owns the hold in flight is
// view/holdinput.js's question; every listener below is a thin translator
// over its arm / cancel / ignore answers.
// ---------------------------------------------------------------------------
const hold = new Hold();
const holdInput = new HoldInput();
const RING_C = 2 * Math.PI * 24; // r=24 in the #wipe ring SVG
const holdRing = ui.wipe?.querySelector('.hold-ring circle');
let holdRaf = 0;
let holdThen = 0;
let wipePopTimer = 0;

// The one polite live region (index.html: #wipe-status, body-level, never
// re-parented - a live region moved around the DOM loses its registration in
// some readers, and the settings row moves between cards). Outcomes only:
// "data reset" or "data not reset" on the fire frame, whichever the storage
// verified (view/telemetry.js wipeOutcome; second-member review, HIGH),
// "consent not changed" when a press of the consent toggle did not take (round
// 2 - the same channel, because it is the same kind of news), and
// "cancelled" for a key hold that had begun
// filling - the player who let go at 1.1 s must learn nothing was lost. No
// progressbar: a 1.2 s gesture is too short for percentages to arrive before
// the outcome does, and when they do arrive they queue. Pointer cancels stay
// silent - the sighted path already has the ring. The text is cleared shortly
// after so the next gesture is a fresh announcement; tracked, like the pop
// timer, so a second outcome inside the window resets the clock instead of
// being blanked by the first one's cleanup.
const wipeStatus = document.getElementById('wipe-status');
const WIPE_STATUS_MS = 1000;
let wipeStatusTimer = 0;

function announceWipe(text) {
  if (!wipeStatus) return;
  clearTimeout(wipeStatusTimer);
  wipeStatus.textContent = text;
  wipeStatusTimer = setTimeout(() => { wipeStatus.textContent = ''; }, WIPE_STATUS_MS);
}

function paintRing() {
  if (holdRing) holdRing.style.strokeDashoffset = String(RING_C * (1 - hold.progress()));
}

function doWipe() {
  // The stillness ask is judged BEFORE the wipe destroys it: clearAll() resets
  // the reducedMotion pref, so reading it after would play the confirmation
  // pop for exactly the player who had asked for none. Review MINOR-4.
  const wasReduced = reducedMotion;
  // Everything under the namespace goes - the best key included, because
  // save.js writes inside the same prefix clearAll() sweeps. Memory has to
  // follow the disk immediately: telemetry re-reads its own copies, save.reset()
  // settles the number paintTitleBest() paints, and the two prefs mirrors are
  // re-derived - so the card reflects the DISK before the finger has lifted.
  //
  // Second-member review, HIGH: both calls now report whether the storage
  // actually let go, and this function may only claim what they verified. It
  // used to announce "data reset" and repaint an empty trophy unconditionally,
  // so a storage that refused every removeItem got the full confirmation - pop,
  // announcement and a blank title - over a disk that still held the consent,
  // the runs and the best.
  //
  // Round 2: both answers are VERDICTS - cleared / remains / unknown - and only
  // "cleared, read back" is a success. A storage that cannot be listed or read
  // used to count as an empty one, so losing enumeration mid-session bought the
  // full confirmation over a disk that still held everything.
  //
  // Round 3: the five lines below repaint the whole settings row from memory,
  // so what they are allowed to read is the other half of this. clearAll()
  // re-derives per key and only from reads that HAPPENED, so on an unknown
  // verdict the prefs and the consent flag are still the ones last observed -
  // and this repaint puts them back exactly as they were. It used to run over
  // the defaults of a clean disk, which meant a wipe correctly reported as
  // failed still snapped the stillness and sound toggles to the wiped state.
  const outcome = wipeOutcome({
    telemetryVerdict: telemetry.clearAll(),
    bestVerdict: save.reset(),
  });
  reducedMotion = readReducedMotion();
  chase.reducedMotion = reducedMotion;
  soundOn = telemetry.prefs.sound !== false;
  sound.setEnabled(soundOn);
  syncToggles();
  // Paints what is TRUE now, which is not always zero: save.reset() re-read the
  // key rather than assuming the sweep took it, so a best that survived a
  // refused wipe is still on the title card - the number is really still there.
  paintTitleBest();
  clearTimeout(wipePopTimer);
  ui.wipe?.classList.remove('wiped', 'wipe-failed', 'failed-mark');
  if (outcome.done) {
    // One wordless beat of confirmation, then the button is just a button again.
    // The timer is tracked so a hold restarted inside the 700ms cannot have its
    // ring stomped empty mid-fill by this cleanup. Review MINOR-6.
    if (!wasReduced) ui.wipe?.classList.add('wiped');
    // A verified wipe supersedes a consent withdrawal that could not delete the
    // runs: the runs are gone now, and a mark still standing there would be the
    // failed toggle telling the player something the disk has stopped agreeing
    // with - the exact class of claim this whole repair is about (live check,
    // this round: the badge sat on the toggle after a wipe that emptied the
    // namespace). Only on the verified side; a failed wipe changes nothing.
    ui.consent?.classList.remove('failed-mark');
  } else {
    // The other outcome, and it must not look like the first one.
    //
    // Second-member review, round 2. The shake below was the WHOLE failure cue
    // and it is motion, disabled under the stillness ask by both switches - so
    // the sighted player who asked for stillness got nothing at all, and the
    // reading the round-1 comment offered them ("the trophy and the toggles
    // staying") is a non-event they would have to already know to look for.
    // The mark is the answer: a shape, not a movement, drawn in CSS on the
    // corner of the bin, no animation, no text. It PERSISTS - no timer clears
    // it, only the next deliberate arm of the hold (armHold) - so a player who
    // looked away still finds out, and a player who never tries again keeps the
    // standing statement that their data is still on this machine.
    ui.wipe?.classList.add('failed-mark');
    // The motion-allowed extra, unchanged: the pop is a claim, so it does not
    // play; the button shakes its head once instead - the same length, the same
    // shape-only register.
    if (!wasReduced) ui.wipe?.classList.add('wipe-failed');
  }
  wipePopTimer = setTimeout(() => {
    ui.wipe?.classList.remove('wiped', 'wipe-failed');
    if (!hold.armed) holdRing?.style.removeProperty('stroke-dashoffset');
  }, 700);
  // Same frame as the repaint above: the outcome, for the player who cannot
  // see the trophy leave the card - or see it stay.
  announceWipe(outcome.announce);
}

function stepHold(now) {
  const dt = (now - holdThen) / 1000;
  holdThen = now;
  if (hold.tick(dt)) {
    paintRing(); // pinned to 1: the ring closes on the fire frame
    // The gesture is spent, whoever held it: the key still down or the finger
    // still planted must not become a second gesture by themselves.
    holdInput.fired();
    doWipe();
    return;
  }
  paintRing();
  if (hold.armed) holdRaf = requestAnimationFrame(stepHold);
}

// One arm for both channels: the same machine, the same rAF chain, the same
// wall-clock measurement. Which channel asked is the arbiter's business, and
// it has already said 'arm' by the time this runs.
function armHold() {
  clearTimeout(wipePopTimer);
  // The next deliberate attempt is the ONLY thing that clears the persistent
  // failure mark (second-member review, round 2). Here rather than on the fire
  // frame on purpose: the player who arms the hold again has seen it and is
  // acting on it, and a hold they then cancel leaves them where a fresh attempt
  // leaves them - with the outcome of the try they actually completed.
  ui.wipe?.classList.remove('wiped', 'wipe-failed', 'failed-mark');
  hold.arm();
  holdThen = performance.now();
  cancelAnimationFrame(holdRaf);
  holdRaf = requestAnimationFrame(stepHold);
}

// One cancel for every route, source-agnostic: whatever is armed, from
// whichever channel, is over. Called bare from the hidden-tab, lost-context and
// row-moving paths, so it also settles the arbiter itself (idempotent: a
// translator that got its own 'cancel' verdict has already reset it, and then
// passes the owner it captured first). Only a KEY hold that had begun filling
// is announced - the ring already told the sighted path.
function cancelWipe(owner = holdInput.source) {
  holdInput.hidden();
  if (!hold.armed) return;
  const begun = hold.progress() > 0;
  hold.cancel();
  cancelAnimationFrame(holdRaf);
  holdRing?.style.removeProperty('stroke-dashoffset');
  if (owner === 'key' && begun) announceWipe('cancelled');
}

// The translator step every listener below ends in: ask the arbiter, do what
// it says. The owner is read BEFORE asking, because a 'cancel' verdict has
// already released it by the time cancelWipe wants to know who to announce for.
function relayHold(ask) {
  const owner = holdInput.source;
  const verdict = ask();
  if (verdict === 'arm') armHold();
  else if (verdict === 'cancel') cancelWipe(owner);
  return verdict;
}

const isHoldKey = (e) => e.key === 'Enter' || e.key === ' ';

ui.wipe?.addEventListener('pointerdown', (e) => {
  // Left/primary only ARMS. Any pointer button armed the hold once, and a
  // right-click's context menu can eat the matching pointerup on some
  // platforms - leaving the ring filling toward a wipe behind an open menu.
  // Review MAJOR-3. (The arbiter still hears a non-primary press: over a
  // key hold it is the other channel landing on the button, and cancels.)
  const primary = e.button === 0 && e.isPrimary;
  if (primary) {
    // A hold is not a drag, a scroll or a focus grab; the button's own
    // touch-action backs this up where preventDefault cannot reach.
    e.preventDefault();
    // Touch pointerdown takes IMPLICIT pointer capture, which suppresses the
    // boundary events - so the drift-off escape below never fired for a
    // finger, only for a mouse, and sliding off the bin kept the ring filling.
    // Release it and pointerleave means the same thing on every input.
    // Review MAJOR-1.
    try { ui.wipe?.releasePointerCapture(e.pointerId); } catch { /* mouse: never captured */ }
  }
  relayHold(() => holdInput.pointerDown(primary));
});
// Drifting off the button IS a release - one more way out for a hold the
// player thinks better of. The pointerdown above releases the implicit touch
// capture so this is true for a finger, not only for a mouse. Boundary events
// are the pointer's own: the arbiter ignores them over a key hold, because a
// mouse wandering across the bin mid-hold is hover, not input.
const pointerRelease = () => relayHold(() => holdInput.pointerUp());
ui.wipe?.addEventListener('pointerup', pointerRelease);
ui.wipe?.addEventListener('pointercancel', pointerRelease);
ui.wipe?.addEventListener('pointerleave', pointerRelease);
// A hidden tab cancels the hold outright: rAF stops while hidden, so the hold
// would hang armed - and a pointerup released over ANOTHER tab is never
// delivered here, which turned "hold, switch tabs, let go" into a wipe that
// fired by itself ~1.1s after coming back. A destructive action does not
// survive losing the screen. Review MAJOR-2. A keyup lost to a hidden tab is
// the keyboard's copy of the same defect, and this is its fix too.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) cancelWipe();
});
// The button owns its keys. Enter/Space: swallow the browser's synthetic click
// activation (belt and braces - no click listener exists to receive one), stop
// the bubble so a focused wipe cannot beginRound() through the window switch
// below (Enter at title/result) or plant Space in view/input.js's held set as
// a boost, and then DRIVE the hold. The first non-repeat press arms it on the
// same rAF loop as a pointer; auto-repeat is ignored - it measures the OS's
// repeat settings, not held intent, MAX_TICK clamps a slow repeat to a crawl,
// and a player who has disabled key repeat could hold forever and never fire.
// The keyup of the arming key is the release. Escape ends a key hold and is
// consumed ONLY then: idle, or over a pointer hold, it belongs to the window
// (pause / resume / home), and one keypress must not carry two meanings.
ui.wipe?.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (relayHold(() => holdInput.escape()) === 'cancel') e.stopPropagation();
    return;
  }
  if (!isHoldKey(e)) return;
  e.preventDefault();
  e.stopPropagation();
  relayHold(() => holdInput.keyDown(e.key, e.repeat));
});
ui.wipe?.addEventListener('keyup', (e) => {
  if (!isHoldKey(e)) return;
  // Space activates on keyup in some engines: same synthetic click, same swallow.
  e.preventDefault();
  relayHold(() => holdInput.keyUp(e.key));
});
// Focus gone - Tab away, or the window losing focus to another app - and the
// keyup that would end a key hold lands where nobody can hear it, while the
// rAF loop keeps filling: MAJOR-2 by another channel. A destructive action does
// not survive losing the player's attention. A pointer hold is unaffected by
// THIS blur - the arbiter ignores an in-page focus move for it, its release
// still arrives on the button - but the window losing focus is another matter
// (below, beside autoPause).
ui.wipe?.addEventListener('blur', () => relayHold(() => holdInput.blur()));

input.onFirstGesture = () => {
  sound.start();
  sound.setEnabled(soundOn);
};
// The activation-time nudge (view/audio.js activate()). onFirstGesture fires
// from pointerdown/keydown - the events view/input.js can register a gesture
// on - and WebKit does not honour a pointerdown as an activation for audio,
// so the resume() start() issues there can stay pending; the tap's own
// pointerup (and a key's keyup) is what WebKit honours, and it arrives 50-150
// ms later, inside the guard the pending resume holds. These two listeners
// hand that activation to the machine. Chrome: the context is already running
// after the pointerdown and activate() reads three fields and returns - the
// canvas and the window each pay one no-op per release. Not on input.js's
// gesture(): a re-fired gesture() re-drives nothing (iter-6 discovery G4).
canvas.addEventListener('pointerup', () => sound.activate());
window.addEventListener('keyup', () => sound.activate());

// Which control glyphs the title card shows. Decided up front from the pointer
// capabilities rather than waiting for a touch, because the glyphs are on the
// screen the player reads BEFORE they touch anything - and a phone was being
// told to press WASD. Upgraded on the first real touch too, for the devices
// that lie about it.
function markTouch() {
  document.body.classList.add('touch');
}
if (window.matchMedia?.('(hover: none) and (pointer: coarse)').matches
  || (navigator.maxTouchPoints ?? 0) > 0) {
  markTouch();
}
window.addEventListener('touchstart', markTouch, { once: true, passive: true });

// ---------------------------------------------------------------------------
// Session shell. The state machine itself is in view/session.js and is DOM-free;
// everything below is the DOM and the side effects hung off its transitions.
// ---------------------------------------------------------------------------
const session = new Session();

function syncSession() {
  const s = session.state;
  // No hold can be legitimate while a round is up: both cards that host the
  // bin are hidden, so a release can only land where the bin no longer is
  // (a key hold on the title's bin + a pointer tap on Play, or a pointer hold
  // + Enter - integration review MINOR-3). The row-move cancel below covers
  // the pause card; this covers the title card, whose row stays put.
  if (session.inRound) cancelWipe();
  ui.title?.classList.toggle('hidden', s !== S_TITLE);
  ui.pause?.classList.toggle('hidden', s !== S_PAUSED);
  ui.result?.classList.toggle('hidden', s !== S_RESULT);
  // A control focused inside a card that just hid must not keep focus: Space
  // is down on Play or Again, Enter or R starts the round before the keyup,
  // and an engine that leaves focus on the display:none button delivers that
  // keyup there - a click on a hidden button, a second beginRound() one frame
  // into the count-in (iteration-5 review N-5). Chromium moves focus to body
  // at its next rendering opportunity; this does it now, for every engine.
  const focused = document.activeElement;
  if (focused && focused !== document.body && focused.closest?.('.screen.hidden')) focused.blur();
  // The one hook the corner pause glyph hangs on, and the reason the glyph can
  // never be up on a screen that already owns its own buttons.
  document.body.classList.toggle('playing', session.inRound);
  // Space and the arrows are the input layer's only while a round wants them.
  // On a card they are the browser's again, so a focused Play / Resume / Again
  // / toggle can be pressed with Space - a default-prevented Space keydown
  // cancels the activation in every engine (Enter still worked, which is why
  // nobody noticed). In a round nothing changes: the corner pause glyph, if
  // focused, still hears Space as boost, the same as every other target.
  input.captureKeys = session.inRound;
  // Re-parented, never copied: whichever card is up owns the single live toggle
  // row, so its aria-pressed state cannot fork.
  const host = s === S_PAUSED ? ui.pauseCard : ui.titleCard;
  if (ui.toggles && host && ui.toggles.parentNode !== host) {
    // The row is leaving the card the hold began on (P or R at the pause
    // card, Escape over a pointer hold). Neither channel's release can reach
    // the bin from here: the pointer's lands on whatever is under it now, and
    // focus is lost without a blur in some engines - so an armed hold would
    // keep filling behind the transition. Same rule as a hidden tab, through
    // the same source-agnostic cancel.
    cancelWipe();
    host.appendChild(ui.toggles);
  }
  paintTitleBest();
}

// The number to beat, on the screen where beating it is the offer. Every route
// to the title comes through syncSession(), and the value is held in memory, so
// this costs one string per transition and can never show a stale record.
function paintTitleBest() {
  if (!ui.titleBest) return;
  const b = save.best();
  ui.titleBest.classList.toggle('hidden', b <= 0);
  if (ui.titleBestScore) ui.titleBestScore.textContent = String(b);
}

function beginRound(seed) {
  game.reset(seed ?? PINNED_SEED ?? randomSeed());
  world.buildLandmarks(game.landmarks);
  game.start();
  // The camera forgets the last round with it: yaw, position, look, fov and
  // air blend all land on the new kart's targets on the first count-in frame,
  // and a shake still decaying under the result card is dropped rather than
  // carried in. Only `initialised = false` lived here before, so a reflex R
  // opened every count-in on a ~0.3 s swing around a stationary kart.
  chase.reset();
  // The one place the fixed-step accumulator is zeroed. The two clock re-bases
  // in frame() (count-in handback, hit-stop release) deliberately leave its
  // residue alone - see there.
  accumulator.value = 0;
  input.release();
  // Asking for a round is itself an interaction, even when it was a mouse on the
  // play button and view/input.js never saw it. Without this the auto-pause
  // guard below would stay disarmed for a player who started with the pointer
  // and had not yet touched a key. Boot does not come through here - kart mode
  // starts its count-in directly - so the unfocused-load case stays covered.
  input.gesture();
  session.begin();
  // The beat detector learns a new count-in from an EDGE in beatsLit - which a
  // restart inside beat 1's own window (R within the first half-second) never
  // produces: the count rewinds 1 -> 1, so the new count's first beat would
  // sound nothing while its dot pops. A non-counting feed is how the detector
  // forgets; hand it one here, at the one place every fresh count-in begins.
  beatEdge.feed(false, 0);
  // And the HUD's one-shots go the same way. The hidden frame (title/result)
  // already forgets them, but R mid-round has no hidden frame - a non-killing
  // hit's fading vignette or a chain ring rode into that restart's count-in
  // (iter-4 review N-6). Belt and braces: the hidden-frame forget stays.
  hud.forgetPulses();
  // And the particle pool, the last member of the same class. A burst alive at
  // the moment of an R survived every reset above (47 live particles measured
  // across a restart), and then the first frame of the new round handed
  // fx.update() the render-origin delta - which across a restart is not a MOVE
  // but a teleport to a new spawn - so the debris was shifted bodily by it
  // (-208.10, -319.66 on the measured case). Neither kept honestly nor
  // dropped: thrown to an arbitrary point in render space, and in 5 of 300
  // restarts that point was inside the new spawn's ±60 u, up to 42 particles
  // streaming out of nothing over the count-in (iteration 7, G4). Disclosed:
  // a burst no longer finishes across an R - the same reading chase.reset()
  // and hud.forgetPulses() above already give.
  fx.clear();
  // The fps ring is per-round state of exactly the same kind - see forgetPerf().
  forgetPerf();
  syncSession();
  sound.start();
  sound.resume();
  // A new round starts from a standing start, so its beds must too - otherwise
  // the count-in for a restart is scored with the wind of the round you just
  // abandoned. Not on the resume path, which is meant to come back at level.
  sound.resetBeds();
  // And its count-in must not be scored with the last round's ENDING either: a
  // reflex R on the result card lands beat 1 under the notes of the win/lose
  // arpeggio still waiting on their timers. Take back the ones not built yet.
  sound.cancelPending();
  sound.setEnabled(soundOn);
}

function doPause() {
  if (!session.pause()) return; // idempotent: blur and visibilitychange both land here
  input.release();
  sound.suspend();
  syncSession();
}

function doResume() {
  if (!session.resume()) return;
  sound.resume();
  syncSession();
}

function goHome() {
  if (!session.home()) return;
  input.release();
  // The title is not a place a car idles at revs: wind() stops being driven the
  // moment the round is not PLAYING, so without this the beds hold whatever the
  // last frame asked for. Ramp them to standing still, the way threat(null)
  // ramps its bed out on the same screens.
  sound.restBeds();
  syncSession();
}

ui.play?.addEventListener('click', () => beginRound());
ui.again?.addEventListener('click', () => beginRound());
ui.pauseBtn?.addEventListener('click', doPause);
ui.resume?.addEventListener('click', doResume);
ui.restart?.addEventListener('click', () => beginRound());
ui.home?.addEventListener('click', goHome);

// Nothing here is a driving key, and view/input.js never reads any of them, so
// the two keydown listeners cannot fight over a code.
window.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  switch (e.code) {
    case 'Escape':
    case 'KeyP':
      if (session.state === S_PAUSED) doResume();
      else if (session.canPause()) doPause();
      else if (e.code === 'Escape' && session.state === S_RESULT) goHome();
      break;
    case 'KeyR':
      // Also from the result, where Enter already replays: R is the retry key
      // everywhere else in the loop, and a player who learns it in a round
      // should not have to learn a second one to use it again.
      if (session.inRound || session.state === S_PAUSED || session.state === S_RESULT) beginRound();
      break;
    case 'Enter':
    case 'NumpadEnter':
      // The focused control owns its activation key. The browser is about to
      // click it on this same press, so the shortcut yields: focused Play or
      // Again would otherwise begin two rounds, and a focused toggle - the
      // owner's own case, click the sound toggle then press Enter to play -
      // flipped AND started a round. Slice 4's convention for the wipe
      // (stopPropagation at the button), from the shortcut's side for every
      // other button, none of which owns a key listener. R/Esc/P are
      // untouched: none of them is an activation key.
      if (ownsActivation(e.target)) break;
      if (session.state === S_RESULT || session.state === S_TITLE) beginRound();
      break;
    default:
      break;
  }
});

// A round must not be left running behind a tab the player cannot see. Both
// events, because browsers disagree about which fires on a window switch, and
// some fire both - session.pause() is idempotent so the pair costs one pause.
// Coming BACK never auto-resumes: the ramp is the player's to ask for.
const autoPause = () => {
  // Nothing is at stake before the player has touched anything: ?mode=kart in a
  // window that never had focus used to open on the pause card, because the boot
  // count-in was already running and a blur arrived before any gesture. After
  // the first input this guard is inert forever.
  if (!input.engaged) return;
  if (session.canPause()) doPause();
};
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    autoPause();
    // Wider than the pause on purpose. The pause path already suspends, but the
    // title and the result CANNOT be paused - canPause() is false there - and a
    // hidden tab was left with the wind bed of the last round still blowing at
    // an audible level. Silence belongs to the page being gone, not to the
    // round being stopped. Scoped to visibility: `blur` is not in here, because
    // an unfocused window is still on screen and still rendering.
    sound.suspend();
  } else {
    // A hidden tab is not a slow frame. rAF is suspended while we are away, so
    // NO frames were rendered - but `wallDt` is `(now - last)` and the three
    // re-base sites are all inside frame() (:838 normal, the count-in handback,
    // the hit-stop release), so the first frame back used to charge the whole
    // gap to itself. The perf block reads the unclamped delta by design, so one
    // alt-tab wrote a single seconds-long "frame" into the ring and
    // `__ofa2.info.fpsWorst` - the field README's owner-probe says to read -
    // reported 0.4 fps for the next ~30 s of clean play, until the 60-window
    // ring evicted it (iteration-7 review, MAJOR-2). Charging the gap to a frame
    // is a category error, which is what the old 10 fps floor used to hide.
    // Re-based here, unconditionally, ahead of the resume guard below: the sim
    // cannot move on it - hiding auto-pauses, a paused frame's hudDt is 0, and
    // everything the player can see takes the CLAMPED frameDt, whose expression
    // is untouched. Where the guard IS relevant (the player never engaged, so
    // autoPause() returned early), it now also stops the away-time being paid
    // to the sim as a catch-up burst, which MAX_FRAME_DT could only cap at 0.1 s.
    last = performance.now();
    if (session.state !== S_PAUSED && !glLostUp) {
      // Back on screen with nothing waiting on the player's own resume. A paused
      // round stays silent until they ask for the ramp; ctx null is a no-op, so
      // this never creates a context behind an autoplay policy. Not under the
      // context-loss overlay either: silence belongs to the world being gone,
      // and a hide/show with the cracked screen up must not bring the last
      // round's wind back over it. Review F4.
      sound.resume();
    }
  }
});
window.addEventListener('blur', autoPause);
// The window losing focus with the mouse still down on the bin - Alt-Tab
// mid-hold: the pointer never leaves the button (no pointerleave), the page
// stays visible (no visibilitychange), the pointerup is delivered to the
// other window, and the hold's own rAF chain keeps filling. Same shape as
// MAJOR-2 of the row-25 review, for the pointer; the key hold's blur above
// covers only the focused element. Either source, cancelled outright.
window.addEventListener('blur', () => cancelWipe());

// ---------------------------------------------------------------------------
// Ledger row 23: a lost WebGL context used to be a blank world with the round
// still running - and still killable - underneath. three.js's own listener
// calls preventDefault(), which is what keeps a restore possible; this pair
// only reacts. Loss goes through autoPause(), the exact hidden-tab machinery
// (engaged-guard and all), so a lost round and a backgrounded round stop the
// same way. Restore resumes ONLY the round this handler itself paused, and
// through doResume(), so it comes back the only way any round does: count-in
// first. A pause the player asked for before the loss stays theirs to lift.
// ---------------------------------------------------------------------------
const glLost = document.getElementById('gl-lost');
const glRetry = document.getElementById('gl-retry');
// How long a restore is waited for before reload is offered. Restores that
// come at all come quickly; 5 s is long past hope but short of abandonment.
const GL_RETRY_AFTER = 5000;
let glLostUp = false;
let glLostPausedRound = false;
let glRetryTimer = 0;

canvas.addEventListener('webglcontextlost', () => {
  const wasInRound = session.canPause();
  // Not autoPause(): its engaged-guard exists for the unfocused ?mode=kart
  // boot, where a blur before any gesture must not open the pause card - and
  // a context loss is not a focus event, the world is GONE. beginRound()'s own
  // gesture() arms the guard for every real round anyway, so this only closes
  // the sliver the guard left (loss before any input at all) instead of
  // leaning on that side effect. Review F1.
  if (wasInRound) doPause();
  // Wider than the pause, same as visibilitychange: silence belongs to the
  // world being gone, whichever screen it was gone from.
  sound.suspend();
  // And an armed wipe dies with the world, same as the hidden-tab path above.
  // stepHold runs on its own rAF chain, so the hold keeps filling behind the
  // overlay - and the release that would cancel it lands on the overlay, or on
  // the capture-phase keydown swallow, or nowhere at all. A destructive action
  // must not survive on incidental event delivery. Review F2.
  cancelWipe();
  glLostPausedRound = wasInRound && session.state === S_PAUSED;
  glLostUp = true;
  glLost?.classList.remove('hidden');
  glLost?.classList.remove('stalled');
  clearTimeout(glRetryTimer);
  glRetryTimer = setTimeout(() => glLost?.classList.add('stalled'), GL_RETRY_AFTER);
});

canvas.addEventListener('webglcontextrestored', () => {
  clearTimeout(glRetryTimer);
  glLostUp = false;
  glLost?.classList.add('hidden');
  glLost?.classList.remove('stalled');
  // A restore in a hidden tab hands nothing back. Resuming here would set the
  // round - and the wind bed at its pre-pause level - running behind a tab the
  // player cannot see, the exact defect row 10 closed; and "coming back never
  // auto-resumes" already promises the round waits for them. Review F3.
  if (document.hidden) { glLostPausedRound = false; return; }
  if (glLostPausedRound && session.state === S_PAUSED) doResume();
  else if (session.state !== S_PAUSED) sound.resume();
  glLostPausedRound = false;
});

glRetry?.addEventListener('click', () => location.reload());

// Capture-phase, so Escape, R and Enter cannot resume or restart a round into
// a world that cannot draw - the overlay already swallows every pointer, and
// this closes the keyboard route around it without touching the listener below.
window.addEventListener('keydown', (e) => {
  if (!glLostUp) return;
  e.stopImmediatePropagation();
}, { capture: true });

if (MODE === 'kart') {
  // The kart-feel checkpoint: no title, no hunters, no clock. Just the world
  // and the movement, which is the thing that had to be right first.
  game.start();
  session.begin();
}
syncSession();

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------
const accumulator = { value: 0 };
let last = performance.now();
let originX = game.player.x;
let originZ = game.player.z;

const perf = { frames: 0, fpsAccum: 0, fps: 0, samples: [], median: 0, worst: 0 };

// A round's frame times are that round's. `samples` is a 60-long ring nothing
// used to clear, so `fpsWorst` read after a retry still carried the previous
// round's worst window - including the restart frame itself (0.4 ms, the
// landmark re-roll: invisible in play, and the worst frame in the ring). The
// derived readouts go with it, or "the last round's worst" simply moves from
// `samples` into `worst` (iteration 7, G6). `info.fpsSamples` is how a console
// tells a fresh, empty readout from a genuine 0.
//
// The other end of the same claim is in the perf block itself: sampling is
// gated on PLAYING, so a round's readings are frozen at the round's end rather
// than slowly flushed out of the ring by result and title frames (second-member
// review, MEDIUM). This is still the only place the ring is emptied.
function forgetPerf() {
  perf.frames = 0;
  perf.fpsAccum = 0;
  perf.fps = 0;
  perf.samples.length = 0;
  perf.median = 0;
  perf.worst = 0;
}
const view = {
  x: 0, y: 0, z: 0, heading: 0, moveDir: 0, speed: 0, drift: 0,
  airborne: false, vy: 0, slopeAlong: 0, groundY: 0, look: 0,
};
const grad = { x: 0, z: 0 };
const _v = new THREE.Vector3();
const _dir = new THREE.Vector3();
let boostTicker = 0;
let wasBoosting = false;
const countView = { lit: 0, pop: 0 };
const hitStop = makeHitStop();
// The clock's two audible edges, main.js-fed like `wasBoosting` above: the
// audio module never reads the session, so a slow tone cannot move the count.
const beatEdge = makeBeatEdge();
const secondEdge = makeSecondEdge();

function frame(now, forcedDt) {
  if (forcedDt === undefined) requestAnimationFrame(frame);

  // Clamped at BOTH ends. The upper clamp is the usual stall guard; the lower
  // one matters because a timestamp can go backwards (tab restore, clock
  // adjustment, or a debug pump running ahead of the real clock), and a
  // negative dt runs every decaying animation in reverse until it explodes.
  //
  // `wallDt` is that same delta WITHOUT the stall guard, and it has exactly one
  // reader: the perf block at the bottom of this function. Everything the
  // player can see - the sim, the camera, the beds, the HUD - takes frameDt,
  // and MAX_FRAME_DT keeps its meaning and its home in sim/game.js. The lower
  // clamp is on both, because a backwards timestamp is not a slow frame.
  const wallDt = forcedDt !== undefined ? forcedDt : Math.max(0, (now - last) / 1000);
  const frameDt = forcedDt !== undefined
    ? forcedDt
    : clamp(wallDt, 0, MAX_FRAME_DT);
  if (forcedDt === undefined) last = now;

  input.read();
  cmd.throttle = input.throttle;
  cmd.steer = input.steer;
  cmd.boost = input.boost;

  // Control comes back HERE and nowhere else. Re-basing `last` at the END of
  // the ramp is what stops the wall time spent paused from being paid back as
  // a catch-up burst; doing it at pause time instead would leave the whole
  // pause still owed. The accumulator is left ALONE: its residue is under one
  // fixed step (1/120 s), pre-dates the pause, and is the alpha the paused
  // world and the whole count-in were drawn at - so the handback frame draws
  // the same picture and the first driving frame steps on from the residue
  // (two or three steps, no jump). It used to be zeroed here too, and that
  // drew the handback frame at alpha 0: every body one snapshot BACK for one
  // frame, on the frame the GO ring flashes (iteration 6, G3). A fresh round's
  // count-in never feeds the accumulator (advance() is its only feeder and
  // simRuns() gates that), so a fresh handback still sees acc = 0 - beginRound()
  // is the one place it is zeroed, and tests/loop-rebase.test.js pins both.
  // This frame's delta was spent on the ramp, so it is NOT also spent on the
  // sim - the first driving frame is the next one, which is why t is exactly 0
  // at the end of a round's count-in.
  const handback = session.tick(frameDt);
  if (handback) {
    last = performance.now();
    hud.pulseGo();
    // GO's tone rides the same branch as its flash: one frame, one ring, one
    // tone, so the pair cannot drift apart. No detector needed - handback IS
    // the edge.
    sound.go();
  }

  // The impact hit-stop, stepped BEFORE the sim so a hold simply skips
  // advance() - the accumulator is only fed inside advance(), so the held
  // frames' wall time never enters it and there is nothing to catch up on.
  // The release still re-bases the frame clock exactly like the count-in
  // handback above (proof against a stall landing on the release frame) and,
  // like it, keeps the accumulator's residue: the release frame is itself a
  // held frame and draws at the held alpha, and the first moving frame steps
  // on from the residue. Zeroing it here - as this site did until iteration 6 -
  // drew the release frame at alpha 0, the kart hitching a fraction of a step
  // AGAINST its travel on the very frame the shake starts (G3). hitStopStep()
  // clears itself the moment the round is not PLAYING, which is what makes the
  // pause card, auto-pause and the result all outrank an active hold for free.
  hitStopStep(hitStop, frameDt, session.isPlaying());
  if (hitStop.released) last = performance.now();

  const alpha = session.simRuns() && !handback && !hitStop.holding
    ? game.advance(frameDt, cmd, accumulator)
    : accumulator.value / FIXED_DT;

  // --- render origin follows the player, wrapped ----------------------------
  const p = game.player;
  const prevOriginX = originX;
  const prevOriginZ = originZ;
  originX = p.x;
  originZ = p.z;
  const shiftX = wrapDelta(originX, prevOriginX);
  const shiftZ = wrapDelta(originZ, prevOriginZ);

  drainEvents();

  // Cosmetics stop with the round: a paused world whose bodies still bobbed and
  // whose camera still drifted would not read as stopped. The count-in keeps
  // them, so the world is alive while you wait for it.
  const hudDt = session.state === S_PAUSED ? 0 : frameDt;
  // A hit-stop holds EVERYTHING in the world - particles mid-air, the camera
  // and the shake it was just kicked with - because a freeze that still shakes
  // reads as a hitch, not a beat. That last clause was a claim before it was
  // true: the shake's phase ran on performance.now() until iteration 5, so the
  // camera jittered with wall time through every held frame; it runs on the
  // dt handed in here now (view/camera.js `shakeT`), and `update(0, …)` is
  // pinned to leave position, yaw and fov byte-identical. Decided after
  // drainEvents() on purpose: the frame that drains the hit is the frame the
  // hold starts, so the burst is spawned and then held with everything else,
  // and the shake begins on release. The HUD keeps its real dt: the damage
  // vignette flashing over a held world is the one thing still moving, which
  // is what makes the stop read as impact rather than dropped frames.
  const worldHeld = session.isPlaying() && (hitStop.holding || hitStop.t > 0);
  const viewDt = worldHeld ? 0 : hudDt;
  // The bodies' own dt, one gate tighter: title and result freeze them like the
  // pause card does. The sim stops stepping the frame a round ends, but the
  // gait is cosmetic and ran at the frozen `view.speed` - `p.boosting` freezes
  // true at a round end reached mid-boost (movement.js writes it every step,
  // step() early-returns once finished) - so the kart hopped on the spot at
  // boost pace under the result card and then under the title, the visual
  // twin of the engine idling at boost revs that iteration 5 rested for the
  // ear (row 7). The count-in stays alive per the comment above; the camera
  // and fx keep viewDt so a shake settles and particles finish under the card.
  // Disclosed: the boot title's kos stop their idle hop too - a still world
  // behind the title, the reading the pause card already gives.
  const creatureDt = session.inRound ? viewDt : 0;

  // --- player -------------------------------------------------------------
  // `view` and `TMP` are reused every frame, which is why they exist. That is
  // NOT the same as "this loop allocates nothing", which is what this comment
  // used to say and iteration 7 measured as false: the loop allocates 90-350 B
  // a frame across seven sites, the largest of them the 19-property hud.draw
  // payload two hundred lines below. Reusing these two is worth doing and is
  // not a claim about the rest - see README's Performance section for the
  // measurement and for why none of it is worth changing.
  fillView(view, p, alpha, originX, originZ);
  view.flash = p.hitFlash > 0 ? Math.min(1, p.hitFlash * 2) : 0;
  view.look = nearestThreatAngle();
  creatures.set(0, view, creatureDt);

  // --- hunters and kos ----------------------------------------------------
  // ?mode=kart has no round, so the hunters and kos its sim carries just
  // stand frozen at spawn - which row 21 called decoration and fresh eyes
  // called a bug: creatures that never move read as broken, not ambient. The
  // checkpoint shows the world and the movement, nothing else.
  const creaturesLive = MODE !== 'kart';
  let slot = 1;
  for (const h of game.hunters) {
    const s = fillView(TMP, h, alpha, originX, originZ);
    s.menace = h.menace;
    s.look = Math.atan2(-s.x, -s.z); // they never take their eyes off you
    s.visible = creaturesLive && Math.abs(s.x) < VIEW_DISTANCE && Math.abs(s.z) < VIEW_DISTANCE;
    creatures.set(slot++, s, creatureDt);
  }
  for (const k of game.kos) {
    const s = fillView(TMP, k, alpha, originX, originZ);
    s.look = k.fleeing > 0.3 ? Math.atan2(-s.x, -s.z) : s.heading;
    s.visible = creaturesLive && k.alive && Math.abs(s.x) < VIEW_DISTANCE && Math.abs(s.z) < VIEW_DISTANCE;
    creatures.set(slot++, s, creatureDt);
  }
  creatures.flush();

  // --- world, camera, fx ---------------------------------------------------
  world.update(originX, originZ);
  chase.update(viewDt, view, originX, originZ);
  world.setSkyPosition(camera);
  sun.position.copy(PALETTE.sun).multiplyScalar(200).add(camera.position);

  // Gated on PLAYING like the wind below, and for the same reason: `p.boosting`
  // is sim state that stops updating the moment the sim does, so without the
  // gate a round ended (or paused, then resumed into its count-in) mid-boost
  // kept streaming sparks toward the camera off a kart that was not moving.
  if (p.boosting && !reducedMotion && session.isPlaying()) {
    boostTicker += viewDt;
    if (boostTicker > 0.03) {
      boostTicker = 0;
      fx.boost(view.x, view.y, view.z, Math.sin(view.moveDir), Math.cos(view.moveDir));
    }
  }
  if (p.boosting && !wasBoosting) sound.boostSurge();
  wasBoosting = p.boosting;

  fx.update(viewDt, shiftX, shiftZ);
  // Left alone while paused, so the beds hold the level they had and come back
  // on resume without a ramp - the suspended context is what makes it silent.
  if (session.isPlaying()) sound.wind(p.speed, p.airborne, frameDt);
  // The proximity bed, by contrast, is driven on every frame: outside a live
  // ofa round (title, result, count-in, kart mode's decorative hunters) it is
  // handed null and ramps itself out. See threat() for why it may not simply
  // hold like the wind does.
  sound.threat(MODE !== 'kart' && session.isPlaying() ? threatMix() : null);

  // --- hud ------------------------------------------------------------------
  if (session.state === S_COUNTDOWN) {
    countView.lit = session.beatsLit;
    countView.pop = session.beatPop;
  }
  // The beats' audio, off the same `beatsLit` the dots draw from, fed every
  // frame (a non-counting frame is how the detector learns the count is over,
  // so the next one - a resume included - starts again from beat 1).
  if (beatEdge.feed(session.state === S_COUNTDOWN, session.beatsLit)) sound.countBeat();
  hud.draw(hudDt, {
    // ?mode=kart has no clock and nothing that can hurt you, so it gets no
    // clock and no pips. It used to be handed RULES.roundTime and a constant 3,
    // which drew a timer ring that never moved and three HP pips that could
    // never be lost - chrome that was simply lying about the mode.
    round: MODE !== 'kart',
    timeLeft: game.timeLeft,
    timeTotal: RULES.roundTime,
    pips: game.hpPips,
    maxPips: 3,
    boost: p.boost,
    boostArmed: p.boostArmed,
    boosting: p.boosting,
    threat: threatMarker(),
    // No hint toward a creature the mode just hid: with kart's kos invisible,
    // an edge dot pointing at one would be the same lie the clock was.
    koHint: creaturesLive ? koMarker() : null,
    // Driven by the session now, not by game.finished - which was false in
    // 'ready' and therefore painted a live timer ring over the title card.
    hidden: !session.hudVisible(),
    // Which hidden: a paused round hides the HUD too, and must NOT forget its
    // pulses (the cup, the wedge's ping) - only a finished one does.
    paused: session.state === S_PAUSED,
    count: session.state === S_COUNTDOWN ? countView : null,
    reduced: reducedMotion,
    // The live score and the bar it is played against: two reads the view
    // already owns (game.score is a getter over koState, save.best() is the
    // in-memory record). What to draw of them is the HUD's call, every frame.
    score: game.score,
    best: save.best(),
    // The chain window, read where the sim keeps it. chainTimer has no getter
    // and is not in info() - sim/ is frozen, so none is added - but it is
    // canonical hashed state (game.js hashState folds it), so this is the
    // sim's own truth, not a view-side estimate. Kart never runs stepKos, so
    // there it stays 0 and the readout stays null.
    chainTimer: game.koState.chainTimer,
    chainWindow: KO_RULES.chainWindow,
    chain: game.chain,
  });
  // The final-seconds tick: the audible reading of the ring the payload above
  // just drew urgent (`timeLeft < 10`), gated exactly as threat() is - kart
  // mode has no clock and must have no tick. The detector fires at most once a
  // frame, so a stall-clamped frame that crosses several integers is one tick,
  // not a burst; and it forgets its last reading on any non-playing frame, so
  // a pause, a death or a fresh round never replays or dumps a crossing.
  if (secondEdge.feed(MODE !== 'kart' && session.isPlaying(), game.timeLeft)) sound.tick();

  renderer.render(scene, camera);

  // --- perf -----------------------------------------------------------------
  // The denominator is WALL time (`wallDt`), not the sim's clamped delta. It
  // used to be frameDt, which stops growing at MAX_FRAME_DT - so the readout
  // divided the frame count by a number that could not exceed 0.1 s a frame and
  // had an arithmetic FLOOR at 1 / MAX_FRAME_DT = 10 fps. A machine running the
  // game at half a frame a second reported a healthy-looking 10.0; 60 Hz with a
  // one-second stall every second reported 60.0; every stall the owner could
  // ever call in was exactly the case the instrument flattened (iteration 7,
  // G6). The clamp is untouched and still guards the sim: this reads the same
  // frame, it just measures how long it really took.
  //
  // Second-member review, MEDIUM: and it is the ROUND's frame time. The block
  // used to run on every rAF after beginRound() cleared the ring, so the result
  // card and the title kept feeding it - about 30 s sitting on a result is 60
  // half-second windows, exactly the ring's length, and the round the owner had
  // just played was gone from the numbers that call themselves the round's
  // (README's probe, `__ofa2.info.fpsMedian`/`.fpsWorst`). Gated on PLAYING, and
  // deliberately not `inRound`: the count-in is a fixed ramp with the sim frozen
  // and nobody driving, which is not the thing being measured. A pause simply
  // stops adding - the frames on either side of it are both played frames, and
  // no wall time from the gap enters, because only a sampled frame's wallDt is
  // ever summed. At round end the ring FREEZES and `__ofa2.info` keeps reporting
  // the round that was played, until beginRound() forgets it (forgetPerf).
  if (session.isPlaying()) {
    perf.frames++;
    perf.fpsAccum += wallDt;
    if (perf.fpsAccum >= 0.5) {
      perf.fps = perf.frames / perf.fpsAccum;
      perf.samples.push(perf.fps);
      if (perf.samples.length > 60) perf.samples.shift();
      const sorted = [...perf.samples].sort((a, b) => a - b);
      perf.median = sorted[sorted.length >> 1];
      perf.worst = sorted[0];
      perf.frames = 0;
      perf.fpsAccum = 0;
    }
  }
}

const TMP = {
  x: 0, y: 0, z: 0, heading: 0, moveDir: 0, speed: 0, drift: 0,
  airborne: false, vy: 0, slopeAlong: 0, groundY: 0, look: 0,
};
const cmd = { throttle: 0, steer: 0, boost: false };

// Interpolate a body between its previous and current fixed steps, in
// render space. Positions lerp along the SHORTEST wrapped path so crossing the
// seam is not a teleport.
function fillView(out, b, alpha, ox, oz) {
  const cx = wrapDelta(b.x, ox);
  const cz = wrapDelta(b.z, oz);
  const px = b.px === undefined ? cx : cx - wrapDelta(b.x, b.px);
  const pz = b.pz === undefined ? cz : cz - wrapDelta(b.z, b.pz);
  out.x = lerp(px, cx, alpha);
  out.z = lerp(pz, cz, alpha);
  out.y = lerp(b.py ?? b.y, b.y, alpha);
  out.heading = wrapAngle((b.pheading ?? b.heading) + angleDelta(b.heading, b.pheading ?? b.heading) * alpha);
  out.moveDir = wrapAngle((b.pmoveDir ?? b.moveDir) + angleDelta(b.moveDir, b.pmoveDir ?? b.moveDir) * alpha);
  out.speed = lerp(b.pspeed ?? b.speed, b.speed, alpha);
  out.drift = b.drift;
  out.airborne = b.airborne;
  out.vy = b.vy;
  out.slopeAlong = b.slope;
  out.scale = 1;
  out.visible = true;
  out.menace = 0;
  out.flash = 0;
  // Where the ground is under them, and which way it tilts, so the shadow can
  // lie on the slope instead of cutting into it.
  const wx = ox + out.x;
  const wz = oz + out.z;
  out.groundY = height(wx, wz);
  gradient(wx, wz, grad);
  out.groundGx = grad.x;
  out.groundGz = grad.z;
  return out;
}

function nearestThreatAngle() {
  const t = game.threat;
  if (!t) return view.heading;
  return Math.atan2(wrapDelta(t.x, originX), wrapDelta(t.z, originZ));
}

// The committed hunter's bearing relative to where the camera looks, for the
// sting's stereo pan. 0 - which pans centre - if nothing is committed by drain
// time. Last frame's camera matrices are fine at pan precision; the wedge's m6
// staleness fix was about an on/off-screen verdict, not an ear's worth of angle.
function threatBearing() {
  const t = game.threat;
  if (!t) return 0;
  const worldAngle = Math.atan2(wrapDelta(t.x, originX), wrapDelta(t.z, originZ));
  return screenBearing(worldAngle, cameraYaw());
}

// Nearest hunter for the proximity bed: distance and camera-relative bearing,
// the same arithmetic the wedge and the creature slots already do - the bed is
// a readout, so it must not invent its own idea of where a hunter is. One
// reused object - cheap, and one fewer of the seven per-frame allocation sites
// iteration 7 measured (the loop's total is 90-350 B/frame; see README's
// Performance section). It is not evidence that the loop allocates nothing:
// threatMarker() and koMarker() just below return fresh literals every frame,
// deliberately.
const THREAT_MIX = { dist: 0, bearing: 0 };
function threatMix() {
  let bestD2 = Infinity;
  let bx = 0;
  let bz = 0;
  for (const h of game.hunters) {
    const dx = wrapDelta(h.x, originX);
    const dz = wrapDelta(h.z, originZ);
    const d2 = dx * dx + dz * dz;
    if (d2 < bestD2) {
      bestD2 = d2;
      bx = dx;
      bz = dz;
    }
  }
  if (bestD2 === Infinity) return null;
  THREAT_MIX.dist = Math.sqrt(bestD2);
  THREAT_MIX.bearing = screenBearing(Math.atan2(bx, bz), cameraYaw());
  return THREAT_MIX;
}

// The wedge: only drawn when the committed hunter is off-camera, which with a
// camera that swings behind you is exactly when you would otherwise have no
// warning at all.
//
// Three corrections from the fairness review:
//  m6 - the projection ran against LAST frame's camera matrices (they are only
//       refreshed inside renderer.render), so the on/off-screen verdict was one
//       frame stale and, on frame 1, taken against an identity matrix.
//  m8 - "on screen" is not the same as "visible". A hunter behind the crest you
//       are about to launch off projects perfectly inside the frustum and is
//       completely invisible. Occluded now counts as offscreen, i.e. it earns a
//       wedge.
//  M4 - a wedge is a warning about something INBOUND. It used to stay up while
//       the hunter that had already blown past you drove away: 44.5% of all
//       wedge-frames had the attacker receding at that instant, and 62.4% had
//       it more than 30 u away. Both of those are now the sim's own closing
//       speed, so the wedge means "coming at you" and nothing else.
function threatMarker() {
  const t = game.threat;
  if (!t) return null;
  if (!(t.closingSpeed > 0)) return null;

  camera.updateMatrixWorld(true);
  const dx = wrapDelta(t.x, originX);
  const dz = wrapDelta(t.z, originZ);
  const ty = height(t.x, t.z) + 2;
  _v.set(dx, ty, dz).project(camera);
  let onScreen = _v.z < 1 && Math.abs(_v.x) < 0.92 && Math.abs(_v.y) < 0.92;
  if (onScreen && sightBlocked(dx, ty, dz)) onScreen = false;

  // screenBearing, not the raw delta: the raw delta is + toward world +X,
  // which is screen LEFT - the wedge spent its whole life so far mirrored,
  // pointing right at a hunter closing from the left. Measured before the fix
  // (seed 42): hunter at NDC x -0.575, wedge angle +38.3 deg.
  const worldAngle = Math.atan2(dx, dz);
  return {
    angle: screenBearing(worldAngle, cameraYaw()),
    onScreen,
    urgency: t.phase === PHASE_STRIKE ? 1 : clamp(1 - t.phaseTimer / HUNT.telegraph, 0, 1),
  };
}

// The nearest live ko, if it is off-camera. This is the only thing in the build
// that ever tells the player where the points are: a ko respawns 110-260 u away
// and at that range it is two pixels of yellow against a green field, so the
// goal of the game was, in the visual review's words, undiscoverable. Kept
// deliberately weaker than the threat wedge - the danger channel must always
// win the eye.
function koMarker() {
  let best = null;
  let bestD2 = Infinity;
  for (const k of game.kos) {
    if (!k.alive) continue;
    const dx = wrapDelta(k.x, originX);
    const dz = wrapDelta(k.z, originZ);
    const d2 = dx * dx + dz * dz;
    if (d2 < bestD2) {
      bestD2 = d2;
      best = k;
    }
  }
  if (!best) return null;
  camera.updateMatrixWorld(true);
  const dx = wrapDelta(best.x, originX);
  const dz = wrapDelta(best.z, originZ);
  _v.set(dx, best.y + 1.4, dz).project(camera);
  let onScreen = _v.z < 1 && Math.abs(_v.x) < 0.94 && Math.abs(_v.y) < 0.94;
  // m8, same as the wedge: "in the frustum" is not "seen". The ring asserts
  // "visibly right here" with the ko sitting in its hole - drawn over the dune
  // that hides it, that is a ring around empty sand. An occluded ko earns the
  // direction dot instead. Review F5.
  if (onScreen && sightBlocked(dx, best.y + 1.4, dz)) onScreen = false;
  if (onScreen) {
    // This used to return null, as if "on screen" meant "seen". But a ko
    // inside the frustum at respawn range is a couple of pixels of yellow, so
    // the frustum test was passing exactly when the player was blindest. An
    // on-screen ko now hands the HUD its projected point and its range, and
    // the HUD decides how loudly to ring it (koBeaconShape in view/hud.js).
    return { onScreen: true, ndx: _v.x, ndy: _v.y, dist: Math.sqrt(bestD2) };
  }
  return { angle: screenBearing(Math.atan2(dx, dz), cameraYaw()), onScreen: false };
}

// m9: the wedge points relative to where the camera is actually LOOKING, not to
// chase.yaw. Those differ by the whole position-lerp lag - up to ~20 degrees in
// a hard corner, which is the difference between "behind left" and "behind".
function cameraYaw() {
  camera.getWorldDirection(_dir);
  return Math.atan2(_dir.x, _dir.z);
}

// m8: does the terrain get in the way between the eye and the target? The
// sampling itself lives in sim/terrain.js so it can be tested headlessly; this
// only lifts render space into world space for it.
function sightBlocked(tx, ty, tz) {
  return sightBlockedWorld(
    originX + camera.position.x, camera.position.y, originZ + camera.position.z,
    originX + tx, ty, originZ + tz
  );
}

// ---------------------------------------------------------------------------
// Events out of the sim -> sound, particles, camera kicks, HUD pulses
// ---------------------------------------------------------------------------
function drainEvents() {
  const ev = game.events;
  for (let i = 0; i < ev.length; i++) {
    const e = ev[i];
    switch (e.type) {
      case 'takeoff':
        if (e.body === game.player) {
          sound.takeoff(e.speed);
          if (!reducedMotion) fx.takeoff(0, game.player.y, 0);
        }
        break;
      case 'land':
        if (e.body === game.player) {
          if (e.airTime > 0.18) {
            const big = e.airTime >= 0.8;
            sound.landing(e.quality, e.speed, e.airTime);
            if (!reducedMotion) {
              fx.landing(0, game.player.y, 0, e.quality, e.speed);
              // The contact itself, not just the puff: a flat ring of dust
              // thrown outward from the point the body actually met the ground.
              if (big) fx.landingSlam(0, game.player.y, 0, e.quality, e.speed);
            }
            // Rescaled (review finding). The old formula multiplied by
            // (1.25 - quality), and median landing quality is 0.93 - so a
            // typical GOOD landing produced a kick of 0.13 out of a possible
            // 1.4, i.e. nothing. A clean landing is the reward the whole flight
            // model exists to hand out; it has to be felt. Size now comes from
            // how long you were up (that is what the player earned) and only
            // the extra jolt comes from landing badly.
            chase.kick(landingKick(e.airTime, e.quality));
          }
        }
        break;
      case 'bump':
        if (e.body === game.player) {
          sound.bump();
          chase.kick(0.25);
        }
        break;
      case 'sting':
        sound.sting(threatBearing());
        break;
      case 'ko': {
        sound.chime(e.chain);
        hud.pulseChain(e.multiplier);
        const kx = wrapDelta(e.x, originX);
        const kz = wrapDelta(e.z, originZ);
        if (!reducedMotion) fx.catchBurst(kx, e.y, kz);
        break;
      }
      case 'hit':
        sound.hit();
        hud.pulseHit();
        chase.kick(0.9);
        // Gated like the takeoff and landing bursts above; the vignette and
        // the hit-stop still carry the hit under reduced motion.
        if (!reducedMotion) fx.hitBurst(0, game.player.y, 0);
        // The hold starts on this very frame - see the viewDt block - and a
        // killing hit costs nothing: finishRound() below moves the session off
        // PLAYING, which cancels the hold before it can delay the result.
        hitStopTrigger(hitStop);
        break;
      case 'roundEnd':
        finishRound(e.survived);
        break;
      default:
        break;
    }
  }
  ev.length = 0;
}

// Landing weight. A 1.5 s flight (the new median) landed cleanly lands at
// ~0.50; a scrappy one at the same duration reaches ~0.75; a short hop stays
// near 0.15. Capped below the 1.4 shake ceiling so a hit still outranks it.
function landingKick(airTime, quality) {
  const size = clamp((airTime - 0.15) * 0.42, 0.04, 0.62);
  return clamp(size * (0.85 + (1 - quality) * 1.2), 0.04, 0.95);
}

// M3. Everything here is ordered so that SHOWING THE RESULT cannot be lost.
// The old shape ran `telemetry.recordRun(run)` inline, above the DOM writes, so
// one throw out of localStorage (quota, a poisoned key, Safari private mode)
// left the player looking at a frozen world with no panel, no button and no way
// back to the title. Persistence and audio are now both optional side effects
// of a transition that always happens.
function finishRound(survived) {
  // Ledger row 32, history: the sim USED TO push two roundEnd events out of a
  // single fixed step - the last HP going on the same step the clock expired -
  // drained back to back, and the second one was not a second round. Fixed at
  // the source in 97848f5 (game.js gates the clock on `!this.finished`; one
  // step, one ending, pinned in tests/round.test.js). This guard predates that
  // fix and STAYS as belt and braces: showResult() was already hardened
  // against painting twice, but a record made that harmless guard
  // insufficient - a second call would submit the SAME score, be correctly
  // told it no longer beats the best (it is the best), and strip the sparkle
  // off a result that had just earned it. One round ends once, here too.
  if (session.state === S_RESULT) return;

  const run = buildRun(game, survived);

  // The save comes first and on its own, because unlike the runs list it is
  // something the RESULT SCREEN needs: the trophy line and the record moment are
  // both read off it. It cannot throw - Save swallows storage failures - and the
  // catch is here anyway so that the one thing that must happen still happens.
  let record = { best: 0, isNew: false };
  try {
    record = save.submit(run.score);
  } catch {
    /* an unwritable best is a missing trophy, never a missing result */
  }

  try {
    // The car stops with the round. This is the last frame wind() drives the
    // beds from, so left alone they would hold the wind and the engine PITCH
    // of the final moment under the result card for as long as it is up; the
    // ramp to standing still is the one goHome() runs, on the frame the
    // arpeggio starts. (A restart snaps them from wherever the ramp has got to
    // - resetBeds() - which is the same resting values.)
    sound.restBeds();
    sound.roundEnd(survived);
    // Over the top of roundEnd() on purpose: a record set in a round you lost is
    // still a record, and both facts are true at once.
    if (record.isNew) sound.newBest();
    telemetry.recordRunSafe(run);
  } catch {
    /* nothing about a round's bookkeeping is worth the result screen */
  } finally {
    showResult(survived, run, record);
  }
}

function showResult(survived, run, record) {
  // The transition goes first, on the same M3 principle as finishRound(): the
  // screen change is the part that must never be lost, and everything under it
  // is decoration painted on top of a card that is already on its way up.
  //
  // Gated on the return value, because the DOM sync is only correct when this
  // call is the one that made the transition. Historically the sim could emit
  // two roundEnd events out of a single fixed step (last HP lost on the same
  // step the timer expired - fixed at the source in 97848f5, see finishRound);
  // a second finish() returns false with the state already RESULT, and syncing
  // on it would have hidden the result card over a frozen world. The gate is
  // kept: it costs nothing and is what makes the DOM sync correct by
  // construction, whatever the caller does.
  if (session.finish()) syncSession();
  if (ui.resultIcon) {
    ui.resultIcon.innerHTML = survived ? ICON_WIN : ICON_DOWN;
    ui.resultIcon.className = survived ? 'big ok' : 'big bad';
  }
  // How long the run lasted, only when it was cut short: a survived round is
  // always the full clock, and a number that never varies is noise.
  if (ui.resultTime) ui.resultTime.textContent = `${run.duration}s`;
  if (ui.resultTimeRow) ui.resultTimeRow.classList.toggle('hidden', survived);
  if (ui.resultScore) ui.resultScore.textContent = String(run.score);
  if (ui.resultKos) ui.resultKos.textContent = String(run.kos);
  if (ui.resultChain) ui.resultChain.textContent = String(run.bestChain);
  if (ui.resultAir) ui.resultAir.textContent = `${run.airTime}s`;
  // The trophy is the best there has ever been, and nothing else - the star in
  // the stats row above is this run. Hidden while there is no best at all, so a
  // first round that scores nothing does not get handed a trophy reading 0.
  if (ui.resultBest) ui.resultBest.textContent = String(record.best);
  if (ui.resultBestRow) {
    ui.resultBestRow.classList.toggle('hidden', record.best <= 0);
    // Removed and re-added rather than toggled: back-to-back records would
    // otherwise leave the class in place and the sparkle would never restart.
    ui.resultBestRow.classList.remove('record');
    if (record.isNew) {
      void ui.resultBestRow.offsetWidth; // reflow, so the animation runs again
      ui.resultBestRow.classList.add('record');
    }
  }
  // Ledger row 23, from iteration 2's note: a best the disk did not take is a
  // fact the player can act on (their record dies with the tab), so the card
  // says so. Save already keeps the debt - value ahead of saved for exactly as
  // long as a write is owed - and this only reads it. Toggled both ways, so a
  // storage that comes back takes the mark down with the debt.
  ui.resultBestRow?.classList.toggle('owed', record.best > 0 && save.saved !== save.value);
  // The round's seed, survived or DOWN alike: the number that turns "that
  // round felt unfair" into ?seed=N. Off the run payload, not the boot
  // constant - an unpinned "play again" draws a fresh seed, and the card
  // names the round it ends. Hidden rather than "0" for a seed that is not a
  // finite number: a card never wears a seed it does not have.
  if (ui.resultSeed) ui.resultSeed.textContent = String(run.seed);
  ui.resultSeedRow?.classList.toggle('hidden', !Number.isFinite(run.seed));
}

// ---------------------------------------------------------------------------
function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  // Ratio before size: setSize sizes the drawing buffer at the ratio in force.
  renderer.setPixelRatio(pixelRatio());
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  hud.resize();
}
window.addEventListener('resize', resize);
resize();

// Debug surface.
window.__ofa2 = {
  sim: { Game, FIXED_DT, hashState, KART },
  game,
  renderer,
  world,
  camera,
  creatures,
  fx,
  telemetry,
  save,
  chase,
  session,
  sound,
  input,
  // Exposed so a live probe can read the pulses (bestPulse, chainPulse) that
  // the pane's pixel counts cannot name.
  hud,
  // The clock's audio edge detectors, so a live probe can read `heard`/`prev`
  // beside the voice count it wraps around sound._tone.
  beatEdge,
  secondEdge,
  // The hit-stop's state, so a probe can tell a held frame (`holding`) from a
  // live one while it reads camera.position and chase.shakeT (row 27).
  hitStop,
  get info() {
    const i = game.info();
    i.fps = +perf.fps.toFixed(1);
    i.fpsMedian = +(perf.median || 0).toFixed(1);
    i.fpsWorst = +(perf.worst || 0).toFixed(1);
    // How many half-second windows the three numbers above are made of - all of
    // them the round's own PLAYING frames, and none of them added since it
    // ended (the perf block's gate). A fresh round reads 0 here, and 0 is the
    // one reading that means "nothing measured yet" rather than "0 fps" - which
    // matters now that beginRound() forgets the ring (G6), and matters most to
    // the owner-probe this exists for: play a round on your own machine, then
    // read fpsMedian and fpsWorst, at your leisure on the result card.
    i.fpsSamples = perf.samples.length;
    i.drawCalls = renderer.info.render.calls;
    i.triangles = renderer.info.render.triangles;
    i.programs = renderer.info.programs?.length ?? 0;
    i.geometries = renderer.info.memory.geometries;
    i.textures = renderer.info.memory.textures;
    i.hash = hashState(game);
    return i;
  },
  restart: beginRound,
  // Drive the loop by hand. requestAnimationFrame is suspended in headless and
  // background tabs, so this is the only way to verify motion, flight and frame
  // cost without a visible window.
  pump(frames = 1, dt = 1 / 60) {
    for (let i = 0; i < frames; i++) frame(0, dt);
  },
  hold(codes, down = true) {
    for (const c of [].concat(codes)) {
      if (down) input.keys.add(c);
      else input.keys.delete(c);
    }
  },
  // The wipe hold, observable: the machine, its source arbiter, and its own
  // stepper - which runs on a rAF chain of its own, so pump() above never
  // reaches it. pumpHold() ticks it by hand from the arm time, the way the
  // pane's rAF-shimmed measurements did (row 25); it stops at a fire.
  wipeHold: hold,
  wipeHoldInput: holdInput,
  stepHold,
  // Debug-only, like restart(): this drives the destructive gesture from the
  // console, and after a partial pump holdThen is a synthetic time, so the
  // live rAF chain's next dt is clamped by MAX_TICK. Never call it in play.
  pumpHold(seconds = 1.3, step = 1 / 30) {
    let t = holdThen;
    for (let s = 0; s < seconds - 1e-9 && hold.armed; s += step) {
      t += step * 1000;
      stepHold(t);
    }
    return { armed: hold.armed, progress: hold.progress(), source: holdInput.source };
  },
};

requestAnimationFrame((t) => { last = t; frame(t); });

// The boot guard in index.html stands down on this call and no other signal:
// the whole module evaluated, so the play button it watches over is really
// wired. Optional-chained because the guard is the page's, not this module's.
window.__ofaBoot?.ok();
