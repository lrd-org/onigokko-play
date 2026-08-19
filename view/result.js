// The round summary, read off the sim at the moment a roundEnd event is
// drained. DOM-free on purpose: this one object is what the result card paints
// and what the runs list stores, and building it here is what lets its numbers
// be tested without a browser.

/**
 * `duration` is the seconds the round actually ran, and it comes from the
 * sim's own play clock: `game.time` advances only inside a PLAYING step, so a
 * pause or a count-in can never inflate it. It is deliberately NOT
 * `roundTime - timeLeft` - `timeLeft` is mode-scoped and stops wherever a
 * death left it. Whole seconds, because the card answers "how long did I
 * last", not a lap timer. It used to be nowhere in this payload at all, and
 * the only seconds figure on the card was accumulated AIR time - a 56 s death
 * whose flights totalled 5 s read as "5s".
 */
export function buildRun(game, survived) {
  return {
    seed: game.seed,
    survived,
    duration: Math.round(game.time),
    score: game.score,
    kos: game.koState.caught,
    bestChain: game.bestChain,
    hits: game.hits,
    flights: game.flights,
    airTime: +game.airTimeTotal.toFixed(1),
    topSpeed: +game.topSpeed.toFixed(1),
  };
}
