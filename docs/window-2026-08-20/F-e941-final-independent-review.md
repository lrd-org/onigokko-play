# Lane F final independent review - e941911

Date: 2026-08-20 JST

## Verdict

**APPROVE** exact target
`e941911195aed52124afcff2aaf5fccef140a81f`, implementation
`dc2b97d6d3a91190e426fd5dbb2297dc83624ef7`.

The first reviewed target `33d99f3` remained blocked by template-nested
`plaintext` and script double-escaped false positives. Both were reproduced in
Chromium, reported, fixed in `dc2b97d`, and independently closed at the exact
superseding head. No verifier false positive remains in the bounded 81-case
corpus. The published v0.1.1 Release, mode checks, symlink confinement, and
deploy-lane preservation all pass.

This review used separate branch `lrd-a2/review-f-final-33d` and did not edit the
implementer branch.

## HTML title differential

The same probe called `internals.verifyHtmlTitle()` and parsed every input with
headless Chromium. The browser oracle required `document.title.trim()` to be
`Onigokko` and exactly one `HTMLTitleElement` anywhere in the document; SVG and
MathML title nodes do not count.

```sh
node /private/tmp/f-final-differential.mjs "$PWD"
```

The **81 cases** covered:

- flat and deeply nested SVG, MathML, and template title decoys;
- a foreign decoy followed by the one real HTML title;
- HTML self-closing syntax for template, script, iframe, and textarea, plus a
  self-closing SVG control;
- exact raw closers with case, whitespace, slash, and attributes, and near
  closers `scriptx`, `iframex`, `textareax`, `stylex`, and `xmpx`;
- script escaped/double-escaped states, nested marker case/attributes/spacing,
  a second-real-close control, and a `scriptx` near-start control;
- top-level, apparent-closed, template-nested, deeply nested, foreignObject, and
  MathML annotation-xml plaintext;
- frameset-contained, after-frameset, self-closing frameset, and valid title
  before frameset;
- HTML integration points, foreign breakouts, malformed/mixed foreign closes,
  comments, bogus declarations, CDATA-like input, processing instructions,
  quoted attributes, title near closes, and duplicate titles.

### Before

**CONFIRMED BLOCKER at `33d99f3`.** Ten witnesses across two root causes passed
the verifier while Chromium had an empty title and no title node. Minimal cases:

```html
<template><plaintext></template><title>Onigokko</title>
<script><!--<script></script><title>Onigokko</title></script>
```

The plaintext class also reproduced through nested templates, SVG
`foreignObject`, and MathML `annotation-xml` HTML integration. The script class
reproduced with nested-marker case, attributes, and closing-tag whitespace.

### After

**CONFIRMED FIXED at `e941911`: 0 false positives.** `nestedIgnoredEnd()` now
conservatively returns EOF when it encounters an EOF-consuming element, and the
script scanner tracks exact delimited script markers until its depth reaches
zero. The complete 81-case oracle reports:

```json
{"count":81,"falsePositive":[],"conservative":11}
```

The 11 conservative rejects are malformed or integration cases in which
Chromium still constructs one HTML title: frameset ignored inside body/template,
foreignObject or annotation-xml HTML integration, foreign breakouts, foreign
plaintext controls, `--!>` comment close, and attributes on `</title>`. They do
not allow a title-less archive through. The actual release and ordinary valid
head-title controls pass.

## Existing parser regressions

**CONFIRMED.** The complete authored suite and independent corpus agree on all
previous findings:

- SVG-only, MathML-only, nested SVG/MathML/template: reject;
- foreign or nested-foreign decoy plus real title: pass;
- self-closing template/script/iframe: reject; self-closing SVG plus real title:
  pass;
- top-level plaintext, apparent close, title inside/after/self-closing frameset:
  reject;
- real head title before frameset: pass;
- raw near-match closers reject; simple exact delimited closer controls agree
  with Chromium;
- comment, script-string, and attribute-only title bytes: reject.

## Clean-clone and live Release proof

A new `git clone --no-local` was checked out detached at exact `e941911`. It was
clean before and after every command.

```sh
git ls-files -z 'tools/*.mjs' 'tools/**/*.mjs' | xargs -0 -n1 node --check
node --test tools/tests/*.test.mjs
node tools/verify-release.mjs v0.1.1 --json
git diff --check
git status --porcelain=v1 --untracked-files=all
```

**CONFIRMED:** every tool module parsed and the suite passed **26/26**. The
published, non-prerelease `Onigokko v0.1.1` Release passed at:

| Field | Verified value |
|---|---|
| ZIP | `onigokko-v0.1.1.zip` |
| Size | 553,538 bytes |
| Files | 30 exact files |
| Directories | `sim/`, `vendor/`, `view/` |
| SHA-256 | `8f36eb8b492f6430acd2ccfc340806309e855ded782f6d5ef7d156e93a02bad1` |

The sidecar, GitHub asset digest/size, provenance size/hash/count, tagged-tree
manifest and modes, every archive file CRC, notices, and actual release title
all passed.

## Mode, symlink, and confinement controls

**CONFIRMED.** The exact suite behaviorally exercised these boundaries:

- Unix ZIP symlink and FIFO modes reject as special entries;
- regular-file/directory modes that disagree with the trailing slash reject;
- a full fake Release with special-mode `main.js` rejects;
- Git tree mode `120000` rejects before manifest acceptance;
- duplicate, traversal, backslash, case-collision, corrupt-CRC, missing, and
  extra entries reject;
- the embed server accepts loopback bind hosts only, uses distinct origins,
  rejects lexical traversal, and returns 403 for an in-root symlink whose real
  target is outside the game root.

These are generated archive/server behaviors, not source-presence assertions.

## Lane E and L preservation

**CONFIRMED.** Base-to-target checks show all eight `itch/` files byte-identical
to deploy main `d1d780669d7af17279ca27e6f5088e40c06318fb`. Lane E evidence
`docs/window-2026-08-20/E-independent-review-a2.md` is byte-identical to
`814061f`. The Lane L README sentence beginning "Onigokko itself sends no play
or settings data" remains verbatim. The README delta from deploy main only adds
the Lane F verifier/embed instructions after that preserved section.

No game, `sim/`, `view/`, vendor, `itch/`, or release artifact byte is changed
by the Lane F parser follow-ups; they change verifier code, verifier tests, and
review evidence only.

## Limits

**PLAUSIBLE.** The differential is broad but bounded, and the verifier remains a
conservative dependency-free tokenizer rather than a complete HTML parser.
Conservative false negatives are acceptable for this release gate because they
cannot bless a title-less archive. Chromium is the executed HTML oracle; no
claim is made that every malformed-token recovery is byte-for-byte identical in
all browser engines. The real v0.1.1 document is ordinary HTML and passes both
the verifier and the browser contract.
