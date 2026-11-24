/**
 * Where every tldraw mount loads its fonts from: our own origin.
 *
 * tldraw 3.x defaults its 16 font files to `https://cdn.tldraw.com/<version>/fonts/…`.
 * Our CSP `font-src` is `'self' data: https://fonts.gstatic.com`, so those
 * requests were refused: canvas text fell back to the browser's fonts and every
 * canvas logged 16 refusals and their `NetworkError`s. The owner decided on
 * 2026-11-24 (#5870) to self-host the fonts rather than widen `font-src`, so
 * that no canvas viewer's browser contacts a third party for them.
 *
 * The files live in `public/vendor/tldraw/<version>/fonts/`, copied byte for
 * byte from `@tldraw/assets` at the installed tldraw version (the same bytes
 * the CDN serves), with their SIL OFL 1.1 licences beside them. The path
 * carries the version, so a tldraw upgrade is a new folder, never a silent
 * mismatch: `tests/rendered/tldraw-fonts-are-self-hosted-at-the-installed-version.test.tsx`
 * fails until the folder and `TLDRAW_VENDORED_VERSION` follow the installed
 * package. The refresh steps are in
 * `docs/implementation-notes/2026-11-24-tldraw-self-hosted-fonts.md`.
 *
 * Fonts only. Icons and translations still come from tldraw's defaults; the
 * CSP admits those under `img-src https:` / `connect-src https:`.
 *
 * Kept to a type-only import of tldraw and plain strings, so it costs a canvas
 * chunk a few hundred bytes and never pulls tldraw into anything else.
 */
import type { TLUiAssetUrlOverrides } from 'tldraw';

/** The tldraw version whose fonts are in `public/vendor/tldraw/`. */
export const TLDRAW_VENDORED_VERSION = '3.15.6';

const FONT_BASE = `/vendor/tldraw/${TLDRAW_VENDORED_VERSION}/fonts`;

/**
 * Passed as `assetUrls` to every `<Tldraw>`. One module-level object, so the
 * reference is stable and tldraw's `useMemo` over it never re-runs.
 */
export const TLDRAW_ASSET_URLS = {
    fonts: {
        tldraw_mono: `${FONT_BASE}/IBMPlexMono-Medium.woff2`,
        tldraw_mono_italic: `${FONT_BASE}/IBMPlexMono-MediumItalic.woff2`,
        tldraw_mono_bold: `${FONT_BASE}/IBMPlexMono-Bold.woff2`,
        tldraw_mono_italic_bold: `${FONT_BASE}/IBMPlexMono-BoldItalic.woff2`,
        tldraw_serif: `${FONT_BASE}/IBMPlexSerif-Medium.woff2`,
        tldraw_serif_italic: `${FONT_BASE}/IBMPlexSerif-MediumItalic.woff2`,
        tldraw_serif_bold: `${FONT_BASE}/IBMPlexSerif-Bold.woff2`,
        tldraw_serif_italic_bold: `${FONT_BASE}/IBMPlexSerif-BoldItalic.woff2`,
        tldraw_sans: `${FONT_BASE}/IBMPlexSans-Medium.woff2`,
        tldraw_sans_italic: `${FONT_BASE}/IBMPlexSans-MediumItalic.woff2`,
        tldraw_sans_bold: `${FONT_BASE}/IBMPlexSans-Bold.woff2`,
        tldraw_sans_italic_bold: `${FONT_BASE}/IBMPlexSans-BoldItalic.woff2`,
        tldraw_draw: `${FONT_BASE}/Shantell_Sans-Informal_Regular.woff2`,
        tldraw_draw_italic: `${FONT_BASE}/Shantell_Sans-Informal_Regular_Italic.woff2`,
        tldraw_draw_bold: `${FONT_BASE}/Shantell_Sans-Informal_Bold.woff2`,
        tldraw_draw_italic_bold: `${FONT_BASE}/Shantell_Sans-Informal_Bold_Italic.woff2`,
    },
} as const satisfies TLUiAssetUrlOverrides;
