# 2026-11-24 — tldraw fonts served from our own origin

**Issue:** #5870 (the font half of its tldraw CSP item; #5903 fixed the rest).

## Design

tldraw 3.15.6 resolves each of its four font families (draw, sans, serif, mono,
each in four faces) through `TLEditorAssetUrls.fonts`. The defaults are
`https://cdn.tldraw.com/3.15.6/fonts/<file>.woff2`
(`defaultEditorAssetUrls` in `tldraw/dist-cjs/lib/utils/static-assets/assetUrls.js`,
base from `getDefaultCdnBaseUrl()` in `@tldraw/editor`, which carries the
editor's version). Our CSP `font-src` is `'self' data: https://fonts.gstatic.com`,
so the browser refused all 16 files: canvas text used the browser's fallback
fonts, and every canvas logged 16 refusals and their `NetworkError`s.

The owner chose self-hosting over widening `font-src` (2026-11-24), so that no
canvas viewer's browser contacts a third party for fonts. The mechanism is
tldraw's own documented one, the `assetUrls` prop:

```
public/vendor/tldraw/3.15.6/fonts/*.woff2   ← @tldraw/assets@3.15.6 fonts/, unmodified
src/components/processes/tldraw/asset-urls.ts
    TLDRAW_VENDORED_VERSION = '3.15.6'
    TLDRAW_ASSET_URLS = { fonts: { tldraw_sans: '/vendor/tldraw/3.15.6/fonts/IBMPlexSans-Medium.woff2', … } }
<Tldraw assetUrls={TLDRAW_ASSET_URLS} …>    ← all three mounts
```

`FontManager.findOrCreateFontFace` builds each `FontFace` from
`assetUrls[font.src.url]`, and the SVG/PNG export's `toEmbeddedCssDeclaration`
reads the same map, so an export now fetches the fonts from our origin too.

## Files

| File | Role |
|---|---|
| `public/vendor/tldraw/3.15.6/fonts/*.woff2` | The 16 font files, 1,368,924 bytes in all |
| `public/vendor/tldraw/3.15.6/fonts/IBM-Plex-OFL.txt`, `Shantell-Sans-OFL.txt` | The upstream licence files (IBM/plex `LICENSE.txt`, arrowtype/shantell-sans `OFL.txt`) |
| `public/vendor/tldraw/3.15.6/fonts/NOTICE.txt` | Provenance, and which licence covers which file |
| `src/components/processes/tldraw/asset-urls.ts` | The one shared `assetUrls` constant and the vendored version |
| `src/components/processes/TldrawProcessCanvas.tsx`, `agent-view/AgentCanvasView.tsx`, `agent-flow/AgentFlowCanvas.tsx` | The three `<Tldraw>` mounts pass it |
| `tests/rendered/tldraw-fonts-are-self-hosted-at-the-installed-version.test.tsx` | Pins the version and the files, and mounts each canvas to read the URLs its editor builds |
| `docs/processes-canvas.md` | "Fonts come from our own origin" |
| `tests/guardrails/no-control-bytes-in-source.test.ts` | `MAX_EXCLUDED_FILES` 20 → 30: its `public/**` exclusion now covers the 19 vendored files (25 excluded in all) |

## Decisions

- **The files come from tldraw's published package, not the CDN.** `npm pack
  @tldraw/assets@3.15.6`, then `fonts/` copied unmodified. They are
  byte-identical (SHA-256) to the CDN's files for 3.15.6, checked once.
- **No runtime dependency.** `@tldraw/assets` exists to be bundled through
  `getAssetUrlsByImport` (an `import` per file, through the bundler) or served
  through `getAssetUrls({ baseUrl })`. The first adds 260 files of icons and
  translations to the dependency tree and asks webpack to emit fonts it does not
  need to touch; the second still needs the files copied into `public/`. A plain
  constant of 16 strings is smaller than either and keeps the canvas chunk
  unchanged in size (a type-only import of tldraw).
- **The licences.** Every font's own name table says SIL Open Font License 1.1:
  IBM Plex (Copyright 2017/2018/2020 IBM Corp., Reserved Font Name "Plex") and
  Shantell Sans (Copyright 2022 The Shantell Sans Project Authors). The OFL
  permits redistribution, bundled with software, provided the licence and
  copyright travel with the fonts and the Reserved Font Name is not used for a
  modified version; the files are unmodified and the licences sit beside them.
  The `@tldraw/assets` package's own `LICENSE.md` points at the tldraw licence;
  it covers tldraw's code and icons, not these third-party fonts, which carry
  their own OFL. Nothing else from that package is vendored.
- **The path carries the version.** A tldraw upgrade must not quietly serve the
  old version's fonts. The test fails when the installed `tldraw`, the version
  in tldraw's own default font URLs, `TLDRAW_VENDORED_VERSION` and the single
  folder under `public/vendor/tldraw/` disagree, or when any font tldraw would
  request has no file of the same name.
- **`font-src` is untouched**, and `tests/unit/csp.test.ts` still pins it.
- **Fonts only.** tldraw's icons (`img-src https:`) and translations
  (`connect-src https:`) still load from its CDN; the decision was about fonts.
- **No cache header of our own.** Next serves `public/` with revalidation, so a
  repeat visit costs a 304 per font. The versioned path would allow an
  `immutable` header, but that is a `next.config.js` change for a small saving
  and was left out.

## Refreshing the fonts on a tldraw upgrade

Run from the repository root after the new tldraw is installed:

1. `V=$(node -p "require('./node_modules/tldraw/package.json').version")`
2. In a scratch directory: `npm pack @tldraw/assets@$V && tar -xzf tldraw-assets-$V.tgz`.
3. `git mv public/vendor/tldraw/<old> public/vendor/tldraw/$V`, then replace
   the `.woff2` files with `package/fonts/*.woff2` from the tarball.
4. Compare the file names with the keys of `defaultEditorAssetUrls.fonts` in
   `node_modules/tldraw/dist-cjs/lib/utils/static-assets/assetUrls.js`. If tldraw
   added, renamed or dropped a font, update `TLDRAW_ASSET_URLS` to match.
5. If a font family changed, re-check its licence (the name table, IDs 0, 13
   and 14) and replace the licence files and `NOTICE.txt`; also update the
   version in `NOTICE.txt`.
6. Set `TLDRAW_VENDORED_VERSION` to `$V` and run the test above.

A tldraw 4.x upgrade is a licence question first (`docs/dependency-risk-review.md`).
