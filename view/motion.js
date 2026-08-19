// Whether the game should reduce motion, from the stored preference and the
// OS. DOM-free, so the resolution main.js applies at boot, on the toggle, on
// a wipe and on an OS change is one function with tests, not four inline
// expressions.
//
// The stored pref is two booleans (view/telemetry.js `normalisePrefs`):
//   reducedMotion  - the player asked for stillness in-app
//   motionChosen   - the player has touched the toggle at all
// While `motionChosen` is false the OS's `prefers-reduced-motion` decides;
// once the toggle has been touched, the stored choice stands on its own. That
// third state is the fix for a real seam: the pref used to be one boolean
// read as `reducedMotion || OS`, so a player whose OS asks for reduce and who
// turns motion ON in-app got it back only until the next load. Old stored
// objects have no `motionChosen`, normalise to false, and read exactly as
// they did before - the OS still decides for them.
export function wantsReducedMotion(prefs, osReduced) {
  if (prefs.reducedMotion === true) return true;
  if (prefs.motionChosen === true) return false;
  return osReduced === true;
}
