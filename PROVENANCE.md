# Provenance — Onigokko v0.1.1

Released under decision records 1787105108 and 1787143882
(`lrd-org/usas-1`).

## Source

| | |
| --- | --- |
| Source repository | `lrd-org/onigokko` (private) |
| Path in that repository | `poc/3-kart-ofa` |
| Commit | `b0313a7c5062ecdb1625e0f221e3b0ea0b1cba38` |
| Export date | 2026-08-19 |
| Test suite at that commit | 409 tests, 409 pass, 0 fail (`node --test tests/*.test.js`, Node v24.15.0) |

The build was exported straight from that commit, without checking anything
out:

```
git archive --format=tar b0313a7c5062ecdb1625e0f221e3b0ea0b1cba38 \
  poc/3-kart-ofa/index.html poc/3-kart-ofa/main.js \
  poc/3-kart-ofa/sim poc/3-kart-ofa/view poc/3-kart-ofa/vendor \
  | tar -x -C <scratch>
```

## What was copied

Only the 28 playable files: `index.html`, `main.js`, `sim/`, `view/`, and
`vendor/`. The deploy repository adds its `README.md` and the full Three.js r185
MIT text in `THIRD_PARTY_NOTICES.txt`.

Deliberately not copied: source `docs/`, `tests/`, `serve.py`, `package.json`,
and source `README.md`.

## Transform applied

Exactly one source line changed:

```
before:  <title>OFA v2</title>
after:   <title>Onigokko</title>
```

Recursive comparison proves `main.js`, all 7 `sim/` files, all 17 `view/`
files, and both `vendor/` files are byte-identical to the source commit. The
only `index.html` difference is the title line above.

## Runtime verification

The deploy tree was served top-level and inside a cross-origin itch-like iframe
with a click-to-run overlay and fullscreen button. Chromium ran both modes at
960×600, 844×390, and 390×844:

- Six loads, zero application console errors or page errors.
- Requests went only to the two loopback test origins; no external request.
- `document.title` was `Onigokko`; `window.__ofa2` was present in every game
  frame.
- `restart(42)`, held throttle, and 300 pumped frames advanced every run from
  `t=0`, `timeLeft=75` to `t=3.48`, `timeLeft=71.52`, speed 38.9, draw calls 14.
- Cross-origin click-to-run entered fullscreen in all three iframe cases.
- Both canvases filled the viewport with DPR 2 backing stores: 1920×1200,
  1688×780, and 780×1688 respectively.
- No horizontal overflow. Exact-source card measurements with the worst-case
  trophy row: at 844×390 title 248 px and pause 134 px; at 568×320 title 248 px.
  Active controls were at least 48×48 px. Portrait and 960×600 remained on the
  original one-column layout.

Headless Chromium emitted its environmental `GL Driver Message ... GPU stall
due to ReadPixels` warning four times on the first top-level 960×600 load; no
game code logged a warning or error, and the warning did not recur in the other
five runs.

The archive was extracted and CRC-tested separately; its 30 files are the same
deploy tree described here, with `index.html` at the root and no `.git`,
`__MACOSX`, or `.DS_Store` entry.

## Release archive

| | |
| --- | --- |
| File | `onigokko-v0.1.1.zip` |
| Size | 553538 bytes |
| SHA-256 | `8f36eb8b492f6430acd2ccfc340806309e855ded782f6d5ef7d156e93a02bad1` |
| Entries | 30 files — 28 playable files plus `README.md` and `THIRD_PARTY_NOTICES.txt` |
| Root entry | `index.html` |
| Contains `.git`, `__MACOSX`, or `.DS_Store` | no |

Built with the v0.1.x manual path:

```
zip -r -X onigokko-v0.1.1.zip . \
  -x '.DS_Store' '*/.DS_Store' '.git' '.git/*' \
     'PROVENANCE.md' 'ITCH-PAGE.md' '.gitignore'
```

`PROVENANCE.md` is excluded because it records the archive's own digest;
`ITCH-PAGE.md` and `.gitignore` are repository housekeeping.

## Residual gate

The landscape fix is browser-verified but still has no real-device evidence.
The owner's phone/Safari probe remains required before that parity-ledger row is
closed. The itch upload is owner-only; the v0.1.1 package should be uploaded
with **Mobile friendly ON**.
