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
https://lrd-game.itch.io/onigokko.

## Licence

Third-party components and their licences are listed in
[THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt) — three.js (r185, MIT) is the
only dependency.

All other material in this repository is first-party Onigokko material.
All rights reserved.
