# Lane F de7 final independent review

Target: `de7fd7ce9717b01c37af852c712b265eb1c339fa`, rebased on deploy main
`d1d7806`; implementation parent `fcdd9c62`.

## Verdict

**BLOCKED: F-R1 and F-R3 remain fixed; F-R2 still has a nested foreign-title
bypass.** Clean-clone tools and the actual v0.1.1 artifact pass. The one blocker
concerns malformed/adversarial verifier input, not the published archive.

## F-R2 residual

The final fix treats `svg` and `math` as raw-text containers and skips to the
first matching closing tag. Unlike script/style, these foreign elements can
nest. The first inner close therefore ends the skip while the parser is still
inside the outer foreign namespace:

```html
<svg><svg></svg><title>Onigokko</title></svg>
<math><math></math><title>Onigokko</title></math>
```

**CONFIRMED:** both inputs pass `verifyHtmlTitle()` and
`htmlTitleElements()` returns `["Onigokko"]`. The accepted title remains inside
the outer SVG/MathML element, so it is not the HTML document title. The simple
SVG/MathML, comment, script, and attribute decoys now reject correctly, and a
foreign decoy beside a valid HTML title passes correctly.

Required disposition: skip foreign containers with nesting awareness, or use a
tokenizer/parser that maintains the foreign-content stack. Add both nested
same-tag cases as regressions. A flat first-close search is insufficient.

## Prior findings and controls

**CONFIRMED FIXED:** F-R1 rejects Unix ZIP symlink/FIFO/special modes,
file/directory name-mode mismatches, and non-regular Git blob modes. Full fake
Release and unit fixtures pass. The live archive's entry modes and every file
CRC pass.

**CONFIRMED FIXED:** F-R3 resolves configured root and requested target with
`realpath()`, checks confinement before and after directory index resolution,
and returns 403 without serving the outside symlink fixture.

## Exact clean-clone proof

I cloned the implementer repository with `git clone --no-local`, checked out
the exact target detached, and verified a clean tree before and after.

Executed results:

- every tool `.mjs` passed `node --check`;
- `git diff --check` passed;
- `node --test tools/tests/*.test.mjs` passed 26/26 with ephemeral loopback
  permission;
- `node tools/verify-release.mjs v0.1.1 --json` passed.

Live Release result: `Onigokko v0.1.1`, 553,538 bytes, SHA-256
`8f36eb8b492f6430acd2ccfc340806309e855ded782f6d5ef7d156e93a02bad1`,
30 files, and directory entries `sim/`, `vendor/`, `view/`. Sidecar, GitHub
asset digest/size, provenance, tag-tree paths/modes, all CRCs, notices, and the
actual archive's valid HTML title pass.

## Rebase preservation

**CONFIRMED:** all eight `itch/` files are byte-identical between deploy main
`d1d7806` and target. The Lane L README sentence beginning "Onigokko itself
sends no play or settings data" is preserved. Target adds Lane F tools/reviews
and the verifier README section without removing the deploy media/privacy work.

The published artifact is valid. Approval of the general verifier contract
waits only on the nested foreign-title regression above.
