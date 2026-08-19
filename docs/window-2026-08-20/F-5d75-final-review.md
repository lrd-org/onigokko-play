# Lane F 5d75 final independent review

Target: `5d75a67aa96c258c85cf2d2c00982568c0315ba5`.

## Verdict

**BLOCKED: named nested foreign cases are fixed, but self-closing HTML
raw/template elements still bypass the page-title check.** Published v0.1.1 is
valid; the blocker is the verifier's claimed adversarial-input contract.

## Passing title controls

**CONFIRMED:** verifier rejects simple, nested, and three-level nested SVG;
nested MathML; nested template; mixed SVG/MathML/SVG; comments inside SVG; raw
script bytes inside SVG; attribute/comment/script decoys; and self-closing SVG
inside an outer SVG. A self-closing top-level SVG followed by the real HTML
title passes, as it should. A nested foreign decoy followed by one real HTML
title also passes.

The exact reviewer cases now reject:

```html
<svg><svg></svg><title>Onigokko</title></svg>
<math><math></math><title>Onigokko</title></math>
<template><template></template><title>Onigokko</title></template>
```

## Remaining self-closing bypass

`htmlTitleElements()` uses `isSelfClosing()` for both foreign elements and the
HTML `RAW_TEXT_ELEMENTS`/`template` paths. In HTML parsing, the slash on a
non-void HTML element is ignored; it does not close template, script, iframe,
style, textarea, or the other raw-text container.

**CONFIRMED accepted incorrectly:** all three pass `verifyHtmlTitle()` and
return `titles:["Onigokko"]`:

```html
<template/><title>Onigokko</title>
<script/><title>Onigokko</title>
<iframe/><title>Onigokko</title>
```

Headless Chromium controls for each report `document.title === ""`. The
template/script cases produce no document title node; iframe contains the title
inside its fallback content. As a control,
`<svg/><title>Onigokko</title>` reports an `HTMLTitleElement` and document title
`Onigokko`, so foreign self-closing behavior must remain accepted.

Required disposition: honor self-closing syntax only for foreign SVG/MathML
content. HTML template/raw-text elements must skip through their closing tag or
EOF even when the start tag contains `/`. Add the three cases above as
regressions.

## Clean-clone and release controls

I cloned with `git clone --no-local`, checked out the exact target detached,
and verified a clean tree before and after.

**CONFIRMED:** every tool `.mjs` and `git diff --check` pass. The tool suite
passes 26/26 with loopback permission, including special ZIP entry, Git mode,
and outside-root symlink confinement controls.

Live `node tools/verify-release.mjs v0.1.1 --json` passes:

- 553,538 bytes;
- SHA-256 `8f36eb8b492f6430acd2ccfc340806309e855ded782f6d5ef7d156e93a02bad1`;
- 30 exact files; `sim/`, `vendor/`, `view/` directories;
- sidecar, GitHub asset metadata, provenance, tree paths/modes, every CRC,
  notices, and the actual archive title.

## E/L preservation

**CONFIRMED:** all eight `itch/` files are byte-identical to deploy main
`d1d7806`. README retains the Lane L sentence beginning "Onigokko itself sends
no play or settings data" and its four-record retention/deletion detail.

Everything except the self-closing HTML title boundary is approved.
