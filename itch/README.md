# Onigokko v0.1.1 itch media kit

Owner-upload kit generated from the extracted GitHub Release asset
`onigokko-v0.1.1.zip` (SHA-256
`8f36eb8b492f6430acd2ccfc340806309e855ded782f6d5ef7d156e93a02bad1`).
The release reproduces private source commit
`b0313a7c5062ecdb1625e0f221e3b0ea0b1cba38` with the documented title-only
transform.

## Files

| File | Purpose | Bytes | SHA-256 |
| --- | --- | ---: | --- |
| `screenshots/cover-630x500.png` | itch cover | 99,303 | `ce2c4085ce7a120c9eceb323291e06637ea9361ebdf5637e90d8c076262645b0` |
| `screenshots/play-1280x720.png` | desktop play | 204,893 | `7887272e05c8e3105a887062544448f5880759162268536919878348a41e83eb` |
| `screenshots/result-1280x720.png` | desktop result | 442,660 | `8ca50395151f842d04922bef78acd878f764bc119ee05b9b6c15c3cd12d3d214` |
| `screenshots/portrait-390x844.png` | phone portrait play | 76,664 | `f95306435793190dcfb6106b1514ade79a5d98f75b6bf6aa9633b36e1dc2fe86` |
| `screenshots/landscape-844x390.png` | phone landscape title, touch controls | 176,626 | `44e2d12c7d528ab6567c6a4ddb6339934800dfa6bf656d501d8eaa7057b99b8d` |
| `screenshots/landscape-result-844x390.png` | phone landscape result | 181,510 | `07087628c42a221cfdb404775f56904d44ac0cfca95dae5bcad6670e7338ed2d` |
| `onigokko-v0.1.1-gameplay.gif` | 9.2-second play loop, 480x270, 5 fps, 256 colors | 2,322,490 | `1973038ad67a4d6d70dc2a10e9e0ea6991c139db9190604e41bae3a75da83e67` |

All media is a direct capture of the game: no generated illustration, added
copy, marketing claim, or post-composited product element. The GIF is below the
3 MB target.

## Capture method

Chromium loaded the extracted release ZIP from a loopback static server. Fixed
seed 42 and the existing `window.__ofa2` debug handle supplied deterministic
active/result states for the PNGs. The GIF is a real-time Playwright video after
the page's Play gesture and count-in; only scaling, frame sampling, and palette
quantization were applied.

These are browser-shaped viewport captures, not real-device evidence. The
owner's Safari/phone check remains open.
