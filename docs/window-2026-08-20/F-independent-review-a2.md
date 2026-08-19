# Lane F independent review (lrd-a2)

Reviewed final head: `08062af915fccb9e6ca7b46b80c9bb4737dca77f`

Verdict: **BLOCKED - three CONFIRMED contract mismatches remain.**

This is a software-correctness review of the release-verifier and local embed
contracts. The published v0.1 artifact itself still passes; the findings concern
inputs the tools claim to reject or confine.

## Findings

### F-R1 - Expected ZIP files can be special entries

Severity: HIGH. Disposition: **CONFIRMED, blocking.**

`tools/verify-release.mjs:215-236` reads names, compression, CRC, sizes, and
offsets from each central-directory entry, but does not read the creator system
or external attributes that distinguish regular files from symlinks, FIFOs, and
other special entries. `compareArchive()` at lines 316-340 then classifies every
non-directory name as a file.

Executed fixture:

- generated stored ZIP entry `main.js`, valid CRC and expected name;
- set Unix central-directory mode first to `0120777` (symlink), then `0010644`
  (FIFO);
- ran `parseZip()`, `compareArchive(..., ['main.js'])`, and `readEntry()`.

Both entries were accepted. A complete in-process Release fixture containing the
symlink entry also returned PASS. This contradicts the lane's exact-files
contract: an expected regular file name is not sufficient when the entry is not
a regular file.

Required repair: parse creator system and external attributes, accept only
regular-file entries for expected files and directory entries for directories,
and add end-to-end regressions for symlink and non-regular modes. The tagged
tree mode should also be checked so an unexpected Git symlink is not flattened
into the expected file set.

### F-R2 - The HTML title check accepts decoy text

Severity: MEDIUM. Disposition: **CONFIRMED, blocking.**

`tools/verify-release.mjs:343-348` searches raw source with a regular expression.
It does not distinguish HTML elements from comments or JavaScript strings.

Both of these inputs passed `verifyHtmlTitle()` despite containing no title
element:

```html
<!-- <title>Onigokko</title> --><main>No title element</main>
<script>const decoy = "<title>Onigokko</title>";</script>
```

This contradicts the explicit requirement for exactly one HTML title
`Onigokko`, not one matching byte sequence.

Required repair: tokenize enough HTML to ignore comments and raw-text element
contents before accepting a title element, and add both decoys as regressions.

### F-R3 - Static serving is not confined to the game directory

Severity: HIGH. Disposition: **CONFIRMED, blocking.**

`tools/embed-harness/serve.mjs:116-145` checks the lexically resolved path with
`inside()`, then calls `stat()` and `readFile()`, both of which follow filesystem
symlinks. It never compares the real target with the real game root.

Executed fixture:

- created a temporary game directory and a separate temporary directory;
- placed `secret.txt` in the separate directory;
- placed `game/escape` as a symlink to that directory;
- invoked the exported game handler with `GET /escape/secret.txt`.

Observed: HTTP 200 with the outside file body `REVIEW-SECRET`. This contradicts
the documented local game-directory confinement and the test claim that paths
outside the game directory are not served.

Required repair: compare `realpath()` results for the root and final candidate
(including directory-to-index resolution), reject a target outside the real
root, and add this local fixture as a regression.

## Passing controls

The following final-head behavior is **CONFIRMED**:

- author suite: 23/23 passed;
- all tool JS/MJS files pass `node --check`; `git diff --check` passes;
- traversal, backslash, exact duplicate, case-collision, CRC, missing/extra
  regular-file, notices, ordinary wrong/missing-title, non-loopback host, and
  remote `?game=` fixtures are rejected or confined as documented;
- live `node tools/verify-release.mjs v0.1 --json` passes for the published
  551,874-byte archive at SHA-256
  `3eba5a04a1296563fbd2bf5ac0f4fc0d708e74b20895a32559aee0dbdd42a752`.

Independent clean-clone control:

```sh
git clone --no-local <local-repository> <temporary-clone>
git -C <temporary-clone> checkout --detach 08062af915fccb9e6ca7b46b80c9bb4737dca77f
```

The detached clone was clean, all syntax checks passed, the suite passed 23/23,
and the live v0.1 verifier reproduced the same size, digest, 30-file manifest,
and three directory entries.

## Optional hardening, not blockers

The following were observed but are not required by lane F's explicit contract:

- compare archive bytes with every tagged-tree blob SHA, beyond the promised
  exact path manifest and local provenance digest;
- reject additional, differently named Release assets, beyond requiring and
  validating the provenance-named ZIP and sidecar;
- require GitHub's optional asset `digest` field to be present rather than
  verifying it when present and relying on sidecar plus provenance otherwise.

These should not delay lane F once F-R1 through F-R3 are repaired and the
ordinary plus adversarial fixtures are green.

## Evidence limits

The generated fixtures prove the stated accept/reject behavior on this head.
They do not claim exhaustive ZIP-format coverage, browser-engine equivalence,
or correctness of future GitHub API behavior. Those broader conclusions remain
**PLAUSIBLE**, not confirmed.
