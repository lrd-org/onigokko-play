# Lane F final independent re-review

Target: `fa0818ec9240321b68321c267d5e10e493c1a83c`.

## Verdict

**BLOCKED: F-R1 and F-R3 are fixed; F-R2 remains incomplete.** The published
v0.1.1 Release passes from a clean clone and the existing 26 tests pass. One
HTML-title decoy remains accepted: an SVG `<title>` is not the document's HTML
title, but the verifier counts it as one.

## Implementer disposition

**FIXED after this re-review.** The token scan now treats SVG and MathML as
foreign subtrees, just as it already treats scripts/comments as non-title
content. An SVG-only or MathML-only `<title>Onigokko</title>` rejects; an SVG
decoy beside one real HTML title passes; the original comment, script, and
attribute decoys still reject. The published v0.1.1 HTML continues to pass.

Regression command and final clean-clone/live evidence are recorded in
`F-release-verifier-embed-harness.md` at the final branch head.

## F-R1: special ZIP and Git modes

**CONFIRMED FIXED.** `parseZip()` reads creator system and external attributes,
classifies Unix regular/directory modes, rejects symlink/FIFO/special modes,
and rejects mode/name disagreement. `compareArchive()` uses the parsed kind.
`releaseFilesFromTree()` rejects Git blob modes other than `100644`/`100755`.

Executed controls passed:

- ZIP symlink mode `0120777` rejects as special;
- ZIP FIFO mode `0010644` rejects as special;
- regular-file/directory trailing-slash mismatches reject;
- full fake Release with special `main.js` rejects;
- Git tree `main.js` mode `120000` rejects.

The live v0.1.1 archive's modes and every file CRC passed.

## F-R2: HTML page title

**CONFIRMED PARTIAL FIX, STILL BLOCKING.** Comments, script raw text, and title
bytes inside an attribute are ignored correctly. A real case-insensitive HTML
title element passes. The tokenizer does not track HTML versus foreign SVG
namespace, however:

```js
internals.verifyHtmlTitle(Buffer.from(
  '<svg><title>Onigokko</title></svg>'
)); // passes
```

Headless Chromium control for the same markup:

```json
{"title":"","node":"SVGTitleElement"}
```

For `<head><title>Onigokko</title></head>`, Chromium reports title `Onigokko`
and `HTMLTitleElement`. Thus the accepted SVG input contains no HTML document
title and contradicts the verifier's `HTML title Onigokko` check.

Required disposition: track/ignore foreign SVG title elements or use an HTML
parser/tokenizer that distinguishes `HTMLTitleElement`; add the SVG decoy as a
regression. The existing comment/script regressions remain valid.

## F-R3: embed-root confinement

**CONFIRMED FIXED.** The handler resolves both configured root and requested
target with `realpath()`, checks the real target remains inside the real root,
then repeats the check after directory-to-`index.html` resolution. The
independent symlink fixture returned 403 and did not return `REVIEW-SECRET`.
Lexical traversal and non-loopback bind tests also passed.

## Clean-clone and live Release proof

I cloned the implementer repository with `git clone --no-local`, checked out
the exact target detached, and verified the clone was clean before and after.

**CONFIRMED:** all tool `.mjs` syntax checks and `git diff --check` passed.
The initial sandboxed test run was denied only at ephemeral loopback `listen()`;
the same exact command with loopback permission passed 26/26:

```sh
node --test tools/tests/*.test.mjs
```

The clean clone then executed:

```sh
node tools/verify-release.mjs v0.1.1 --json
```

**CONFIRMED result:** public, non-prerelease `Onigokko v0.1.1`; 553,538-byte
`onigokko-v0.1.1.zip`; SHA-256
`8f36eb8b492f6430acd2ccfc340806309e855ded782f6d5ef7d156e93a02bad1`;
30 exact files; `sim/`, `vendor/`, and `view/` directory entries. Sidecar,
GitHub asset digest/size, provenance, tag-tree paths/modes, all file CRCs,
notices, and the actual release's valid HTML title passed.

**Scope:** this residual decoy does not invalidate the already-published
v0.1.1 artifact, whose real title is valid. It blocks approval of the claimed
general verifier contract until F-R2 is closed completely.
