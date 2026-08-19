# Onigokko

**Play it:** https://lrd-game.itch.io/onigokko

鬼ごっこ — ことばのいらない、ひとりで遊ぶブラウザゲーム。

A wordless, solo browser game. You drive a small round creature across an open
green world of rolling swells, ride the crests into the air, and try to stay
away from the two hunters chasing you while you run down the friendly yellow
creatures for points. A round lasts 75 seconds. There is no text to read
anywhere in the game — the title card, the controls, the pause screen and the
result card are all pictures.

## Controls

Keyboard: **W** / **↑** throttle, **S** / **↓** brake, **A** **D** / **←** **→**
steer, **Shift** or **Space** boost, **Esc** or **P** pause, **R** retry.

Touch: throttle is automatic. Drag anywhere on the left of the screen to steer —
how far you pull from where your thumb landed is how hard you turn. The right
side of the screen is a boost pad. There is no on-screen d-pad, and the middle
of the screen stays clear.

## What is saved

Your personal best and your own settings (sound, motion, and whether anonymous
play counters are kept). They are stored in your browser, on your device only.
Nothing is sent anywhere — the game makes no network requests of any kind once
the page has loaded. The bin icon on the title card deletes everything the game
has stored; hold it to confirm.

Onigokko itself sends no play or settings data: up to four `onigokko.ofa2.*` records remain in this browser, run-history withdrawal removes the runs record, and the in-game wipe or browser site-data clearing removes all four.

## Running it locally

There is no build step. Serve the folder with any static file server and open
the root — ES modules will not load from `file://`.

```
python3 -m http.server 8000
```

then open <http://localhost:8000/>.

## Release

The release zip is what is published on itch.io: the same files, with
`index.html` at the root of the archive. Published 2026-08-19 as v0.1 at
https://lrd-game.itch.io/onigokko. v0.1.1, prepared from source commit
`b0313a7c5062ecdb1625e0f221e3b0ea0b1cba38`, makes the title, pause, and result
cards fit phone-landscape screens without changing gameplay.

### Verify a GitHub Release

From a clean clone, use Node.js 20 or later with network access to GitHub:

```sh
node tools/verify-release.mjs v0.1.1
```

The verifier downloads the tag's zip and `.sha256` assets from the GitHub
Release. It checks the Release tag and title, GitHub's asset digest and size,
the checksum asset, the matching `PROVENANCE.md` record, and the archive's exact
file manifest against the tagged repository tree. It also requires
`index.html` and `THIRD_PARTY_NOTICES.txt` at the archive root and the exact
HTML title element `Onigokko`, regular-file/directory modes in the ZIP, regular
Git blob modes, and valid CRC-32 for every file. Set `GITHUB_TOKEN` only when
API rate limits or a private repository require authentication; the game itself
performs no network calls.

Run the dependency-free tool tests with:

```sh
node --test tools/tests/*.test.mjs
```

### Reproduce the embed environment

The embed harness serves the build and an itch-like parent page from different
origins. It puts a click-to-run activation layer over a 960 x 600 iframe and
provides a fullscreen control:

```sh
node tools/embed-harness/serve.mjs
```

Open <http://127.0.0.1:4174/>. The game is served from
<http://127.0.0.1:4173/>. Test another extracted release directory or viewport
without modifying it:

```sh
node tools/embed-harness/serve.mjs \
  --game-dir /path/to/extracted-release --width 390 --height 844
```

Use `--game-port` and `--parent-port` when those ports are occupied. The two
ports must differ. The harness accepts loopback bind hosts only and cannot be
redirected to a remote game through the parent URL. It has no dependencies,
does not modify the build, and does not introduce any network code into the
game.

## Licence

Third-party components and their licences are listed in
[THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt) — three.js (r185, MIT) is the
only dependency.

All other material in this repository is first-party Onigokko material.
All rights reserved.
