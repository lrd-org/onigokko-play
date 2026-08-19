# Lane F - Release verifier and embed harness

Date: 2026-08-19 JST

## Scope

This lane implements two reviewer tools in `lrd-org/onigokko-play`:

1. `tools/verify-release.mjs` downloads and verifies a GitHub Release by tag.
2. `tools/embed-harness/` serves the game and an itch-like parent on separate
   loopback origins.

The tools use Node.js built-ins only. No game file was changed, and no network
primitive was introduced into the game.

## CONFIRMED - v0.1 Release contract

Executed probe:

```sh
node tools/verify-release.mjs v0.1 --json
```

Result: PASS.

| Check | Observed |
| --- | --- |
| Release | published, non-prerelease `Onigokko v0.1` at tag `v0.1` |
| Asset | `onigokko-v0.1.zip`, 551874 bytes |
| SHA-256 | `3eba5a04a1296563fbd2bf5ac0f4fc0d708e74b20895a32559aee0dbdd42a752` |
| Manifest | 30 files, exact match to the tagged release tree |
| Directory entries | `sim/`, `vendor/`, `view/`; all expected |
| Required roots | `index.html` and `THIRD_PARTY_NOTICES.txt` present |
| HTML title | exactly `Onigokko` |

The computed SHA-256 matched the `.sha256` asset, GitHub's asset digest, and
the matching `PROVENANCE.md` record. The downloaded sizes matched GitHub and
provenance. The checksum asset's own size and GitHub digest also matched.

## CONFIRMED - Cross-origin embed path

The harness was started on ports 43183 and 43184 (port 8130 was not used), then
exercised with headless Playwright Chromium at a 1200 x 760 parent viewport.

Observed:

| Check | Observed |
| --- | --- |
| Iframe box | 960 x 600 CSS pixels |
| Parent/game origins | `http://127.0.0.1:43184` / `http://127.0.0.1:43183` |
| Activation | overlay visible before click, hidden after; iframe focused |
| Game load | `document.title` `Onigokko`; `window.__ofa2` present |
| Pumped round | seed 42, `t` 3.48, state `playing`, 60 fps median |
| Fullscreen | parent `#stage` became `document.fullscreenElement` |
| Console | 0 errors |
| Network | 29 requests, confined to the two loopback origins |
| Remote override | `?game=https://example.com/...` ignored; local game loaded |

## Automated checks

```sh
node --check tools/verify-release.mjs
node --check tools/embed-harness/serve.mjs
node --check tools/tests/verify-release.test.mjs
node --check tools/tests/embed-harness.test.mjs
node --test tools/tests/*.test.mjs
git diff --check
```

Result: 23 tests passed, 0 failed; all syntax and diff checks passed. Tests cover
strict provenance/checksum parsing, stored/deflated ZIP entries, traversal and
duplicate rejection, exact tag-tree manifests, title enforcement, separate
origins, click/fullscreen markup, and the static server traversal guard.

## Adversarial failure paths

Executed with the Node test suite against generated ZIPs and an in-process
GitHub API/asset fixture:

| Mutation | Verdict |
| --- | --- |
| corrupt but well-formed `.sha256` sidecar | rejected: zip digest mismatch |
| false SHA-256 in provenance | rejected: provenance mismatch |
| tagged tree missing a required root file | rejected before manifest acceptance |
| duplicate ZIP entry | rejected while parsing central directory |
| expected file missing from ZIP | rejected by exact manifest comparison |
| extra file in ZIP | rejected by exact manifest comparison |
| `../` path traversal | rejected as unsafe entry name |
| backslash path | rejected as unsafe entry name |
| names differing only by case | rejected as a case collision |
| corrupt per-file ZIP CRC-32 | rejected while reading the entry |
| missing notices heading | rejected |
| wrong or absent HTML title | rejected |
| non-loopback harness bind host | rejected before listen |
| `?game=https://example.com/...` on parent | ignored; iframe remains loopback |

Two CONFIRMED gaps were fixed during this pass: the first implementation read
only the two required archive files rather than CRC-checking all files, and the
first parent fixture allowed its game URL to be overridden by a query string.

## Clean-clone proof

Code commit `c36b7e6440a6949f1afa75faf5e1871756ea9b32` was cloned with
`git clone --no-local` to a new temporary
directory. The clone had no working-tree changes. From that clone:

- all four `node --check` probes passed;
- `node --test tools/tests/*.test.mjs` passed 23/23;
- `node tools/verify-release.mjs v0.1 --json` passed with the values above;
- the harness CLI served ports 43203/43204 and a fresh Playwright Chromium
  session opened the parent with `?game=https://example.com/remote-build`;
  the iframe still loaded `http://127.0.0.1:43203/`, reproduced the 960 x 600
  frame, click activation/focus, `__ofa2` runtime advancement (`t` 1.48),
  fullscreen, zero console errors, and 29 requests confined to the two
  loopback origins.

The final follow-up commit changes this evidence file only, so `c36b7e6`
identifies the exact implementation tree exercised by the clean-clone probe.

## Deliberately not done

- The verifier does not modify, publish, tag, upload, or delete anything.
- The harness does not proxy the live itch site or add code to the game.
- Safari/WebKit equivalence is not claimed; cross-engine work belongs to lane B.
- The v0.1.x manual release path remains the record. Reconciliation with the
  automated v0.2+ release procedure belongs to lane J as directed by issue #14.
