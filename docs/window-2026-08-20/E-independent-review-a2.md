# Lane E independent review (lrd-a2)

Reviewed exact head: `45779de8f3fe069436be82c1f4d65b446abdd585`

Verdict: **BLOCKED - one CONFIRMED media mismatch remains.**

## Finding

### E-R1 - The phone-landscape title screenshot is not a touch-device capture

Severity: MEDIUM. Disposition: **CONFIRMED, blocking.**

`itch/README.md` labels `screenshots/landscape-844x390.png` as a "phone
landscape title" capture. Visual inspection shows the card teaching WASD and
SHIFT. Those controls are the desktop `.key-only` row, not the `.touch-only`
row a phone receives.

Executed reproduction against the reviewed v0.1.1 tree:

- Chromium context: viewport/screen 844 x 390, `hasTouch: true`,
  `isMobile: true`, DPR 1;
- loaded exact head top-level from a loopback server;
- waited for `window.__ofa2` and inspected the rendered title;
- observed `body.touch === true`, `.touch-only` display `flex`, `.key-only`
  display `none`, title card 402 x 204, zero console/page errors;
- visual capture showed the touch drag/boost/auto-throttle glyphs in the same
  two-column v0.1.1 layout.

The committed image therefore depicts a desktop-pointer browser squeezed to a
phone-shaped viewport while the kit calls it a phone screenshot. Uploading it
beside the Mobile friendly claim would teach controls the depicted device does
not have.

Required repair: regenerate `landscape-844x390.png` from exact v0.1.1 with
touch/mobile emulation, then update its byte count and SHA-256 in
`itch/README.md`. Re-inspect the replacement for the two-column fit and touch
glyphs. The landscape result image contains no control instructions and does
not share this mismatch.

## Passing controls

### Still images

All six PNGs decode as 8-bit RGB, non-interlaced images. Every documented byte
count and SHA-256 in `itch/README.md` matches the file exactly.

| File | Dimensions | Bytes | Visual verdict |
| --- | ---: | ---: | --- |
| `cover-630x500.png` | 630 x 500 | 99,303 | PASS - wordless real gameplay frame, nonblank |
| `play-1280x720.png` | 1280 x 720 | 204,893 | PASS - active gameplay, HUD unobstructed |
| `result-1280x720.png` | 1280 x 720 | 442,660 | PASS - complete result card, no overlap/crop |
| `portrait-390x844.png` | 390 x 844 | 76,664 | PASS - playable portrait frame, HUD visible |
| `landscape-844x390.png` | 844 x 390 | 177,026 | BLOCKED only by E-R1; image itself decodes and fits |
| `landscape-result-844x390.png` | 844 x 390 | 181,510 | PASS - complete two-column result card |

No image is blank, corrupt, unexpectedly cropped, or internally overlapped.
The cover uses a real frame and adds no text or generated illustration.

### Gameplay GIF

Independent ImageIO decode (not the first frame alone) found:

- GIF89a, 480 x 270;
- 46 frames;
- every frame delay exactly 0.2 seconds;
- total duration exactly 9.2 seconds, therefore exactly 5 fps;
- 256-entry global color table;
- 2,322,490 bytes, below the 3 MB target;
- SHA-256
  `1973038ad67a4d6d70dc2a10e9e0ea6991c139db9190604e41bae3a75da83e67`,
  matching `itch/README.md`.

Frames 0, 11, 23, 34, and 45 were independently extracted to PNG and visually
inspected. They show distinct, coherent moments of the player moving through
the world, including boost and nearby hunters. The world and HUD stay nonblank
and correctly framed; no corrupt delta frame, frozen first-frame loop, crop, or
overlap was observed.

### Release/source binding

- Local tag `v0.1.1` resolves to
  `59c949f39bb6f5f677260b70abd6d01792739ee3`.
- GitHub Release is published/non-prerelease, titled `Onigokko v0.1.1`.
- GitHub reports `onigokko-v0.1.1.zip` as 553,538 bytes with SHA-256
  `8f36eb8b492f6430acd2ccfc340806309e855ded782f6d5ef7d156e93a02bad1`.
- Downloaded ZIP matches its `.sha256`; CRC test passes; it has 30 files and
  root `index.html`.
- The hardened Lane F verifier passes tag/title, GitHub metadata, sidecar,
  provenance, exact tag-tree manifest/modes, all file CRCs, notices, and the
  real `Onigokko` title element.
- A fresh `git archive` of source commit
  `b0313a7c5062ecdb1625e0f221e3b0ea0b1cba38` was byte-compared with the
  downloaded release: `main.js`, every `sim/`, `view/`, and `vendor/` file is
  identical; `index.html` becomes identical after only `OFA v2` -> `Onigokko`
  in the title. The two remaining release files are the documented deploy
  `README.md` and `THIRD_PARTY_NOTICES.txt`.

This confirms the media visibly depicts the v0.1.1 product family and the kit's
archive/hash/source statements bind to the published artifact. E-R1 concerns
device-capability truth, not release identity.

### Copy/privacy/fences

- `ITCH-PAGE.md` names v0.1.1, the correct asset and digest, and says Mobile
  friendly ON; it discloses the still-owed real Safari/phone check.
- No public kit text contains prohibited age-positioning wording.
- The privacy line matches the code: best and preferences live under
  `onigokko.ofa2.*`; optional run history is gated by the bar-chart consent
  toggle; withdrawal deletes run history before changing consent; the held bin
  sweeps the namespace; no data is sent over a game-owned network path.
- Pricing is Free with donations off; there are no ads, analytics transport,
  commerce, accounts, backend, or custom-domain claims.

## Evidence limits

The screenshots and GIF are browser captures, not physical-device evidence.
This review does not close the owner's Safari/phone gate. Image inspection
cannot by itself cryptographically prove which runtime emitted a pixel file;
the release/source verification and product-specific v0.1.1 landscape UI make
the stronger identity evidence stated above.
