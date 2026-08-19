# Provenance — Onigokko v0.1

Released under decision record 1787105108 (lrd-org/usas-1).

## Source

| | |
| --- | --- |
| Source repository | `lrd-org/onigokko` (private) |
| Path in that repository | `poc/3-kart-ofa` |
| Commit | `87099c52aba400670c81c93c93ff57654b460024` |
| Export date | 2026-08-19 |
| Test suite at that commit | 407 tests, 407 pass, 0 fail (`node --test tests/*.test.js`, node v24.15.0) |

The build was exported straight from that commit, without checking anything
out:

```
git archive --format=tar 87099c52aba400670c81c93c93ff57654b460024 poc/3-kart-ofa | tar -x -C <scratch>/src
```

## What was copied

Only the playable tree: `index.html`, `main.js`, `sim/`, `view/`, `vendor/`.
The tab icon is an inline `data:` URI inside `index.html`, so there is no
separate icon asset to copy.

Deliberately not copied: `docs/`, `tests/`, `serve.py`, `package.json`, and the
source `README.md` (this repository has its own).

## Transforms applied to the source

Exactly one line of the source was changed.

**1. Page title.** `index.html`, line 12:

```
before:  <title>OFA v2</title>
after:   <title>Onigokko</title>
```

**2. Other working labels — none found, nothing changed.** `index.html` carries
no `<meta name="description">`, no `apple-mobile-web-app-title`, no web app
manifest, and no `aria-label` containing "OFA". The only other occurrence of the
string in the file is `window.__ofaBoot` (line 687), a JavaScript boot-guard
handle, not public copy — left alone.

The string "OFA v2" does not appear in `main.js`, `sim/` or `view/` at all. The
lowercase `ofa` appears there only as (a) source comments, (b) the debug handle
`window.__ofa2`, (c) the internal game-mode identifier `'ofa'`, and (d) the
`localStorage` namespace `onigokko.ofa2.` used by `view/save.js` and
`view/telemetry.js`. All four are debug/internal, none is visible copy, and
changing (d) would silently orphan any existing player's saved best — so all
were left byte-identical.

## Verification that nothing else changed

`diff -r` between the exported source tree and this directory (excluding the
deliberately-not-copied paths above and this repository's own added documents)
reports exactly one differing file and exactly one differing line:

```
12c12
< <title>OFA v2</title>
---
> <title>Onigokko</title>
```

The other 27 playable files (`main.js`, 7 files in `sim/`, 17 in `view/`,
2 in `vendor/`) were compared by SHA-256 and are byte-identical to the source.

## Verification that it runs from a subdirectory and inside an iframe

itch.io serves an HTML project from a random subpath inside an iframe, so both
were reproduced before release.

* Static analysis: no absolute-root paths. Every module specifier and asset
  reference is relative (`./main.js`, `./vendor/three.module.js`,
  `../sim/math.js`). No `fetch(`, no `XMLHttpRequest`, no `WebSocket`, no
  `EventSource`, no `sendBeacon`, no dynamic `import()` in `index.html`,
  `main.js`, `sim/` or `view/`. The single `http://` string in first-party code
  is the SVG XML namespace inside the inline favicon, which is an identifier and
  not a request. `vendor/three.core.js` contains `fetch`/`XMLHttpRequest` inside
  its `FileLoader` and `ImageBitmapLoader` classes and doc-comment links in its
  comments; the game imports no loader and never constructs one, and no request
  to any of those hosts was observed. Runtime confirmation below.
* Runtime: served from `http://localhost:8131/game-abc123/` and loaded in three
  iframes (960 × 600, 390 × 844, 844 × 390) from a parent page at
  `http://localhost:8131/embed.html`.
  * Console messages across all loads: **0** (no errors, no warnings).
  * Network: 88 requests, all `200`, all to the `game-abc123/` subpath. No
    request to any external origin.
  * `document.title` inside each iframe: `Onigokko`.
  * `#gl` and `#hud` canvases present and non-zero in all three
    (960 × 600 CSS → 1920 × 1200 backing store at devicePixelRatio 2).
  * `frames[0].__ofa2` present in all three — the ES module graph resolved from
    the subpath.
  * A round runs: `__ofa2.restart(42); __ofa2.hold(['KeyW']); __ofa2.pump(300, 1/60)`
    → `t 3.48`, `timeLeft 71.52`, `hp 100`, `pips 3`, `speed 38.9`,
    `drawCalls 14`, `triangles 73394`, `fpsSamples 6`. Pumped out to the end of
    a round: `t 75.00`, `state "survived"`, result card shown.
  * The zip's own extracted contents were served from a second subpath
    (`/zip-check/`) and pumped the same way: `t 3.48`, `speed 38.5`,
    `drawCalls 14` — the archive, not just the working directory, plays.

## Release archive

| | |
| --- | --- |
| File | `onigokko-v0.1.zip` |
| Size | 551874 bytes |
| SHA-256 | `3eba5a04a1296563fbd2bf5ac0f4fc0d708e74b20895a32559aee0dbdd42a752` |
| Entries | 30 files — the 28 playable files plus `README.md` and `THIRD_PARTY_NOTICES.txt` (`index.html` at the archive root, as itch.io requires) |
| Contains `__MACOSX` or `.DS_Store` | no |

Built with:

```
cd onigokko-play && zip -r -X ../onigokko-play-release/onigokko-v0.1.zip . \
  -x '.DS_Store' '*/.DS_Store' 'PROVENANCE.md' 'ITCH-PAGE.md' '.gitignore'
```

`PROVENANCE.md` is excluded from the archive because it records that archive's
own SHA-256, which it could not do from inside it; `ITCH-PAGE.md` (the page-copy
draft) and `.gitignore` are repository housekeeping, not part of the game. All
three live in the deploy repository only.

## Known defect at this commit (reported, not fixed)

At a phone-landscape viewport (844 × 390) the title card is 432 px tall and
overflows the 390 px viewport by 66 px; the bottom row of buttons — including
the data-deletion bin — is clipped. The result card overflows by 47 px at the
same size. Phone portrait (390 × 844), 960 × 600 and every viewport at least
about 480 px tall are clean. This is a source-side layout issue and was left
untouched here.
