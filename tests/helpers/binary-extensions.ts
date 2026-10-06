/**
 * File extensions whose contents are **bytes, not source text**.
 *
 * WHY THIS IS SHARED
 * ──────────────────
 * Two repo-wide sweeps need the same answer to "is this file source?" and
 * must not drift apart:
 *
 *   - `tests/guardrails/no-secrets.test.ts` — scans every tracked file for
 *     secret-shaped strings. A PNG's entropy trips pattern matchers.
 *   - `tests/guardrails/no-control-bytes-in-source.test.ts` — bans C0
 *     control bytes in source. An image is *made of* them.
 *
 * Divergence between two copies of this set would make one sweep narrower
 * than it claims without anything failing, which is the whole hazard the
 * second of those guards exists to close.
 *
 * SCOPE. Extension-only, deliberately. The tempting second test — "read the
 * first KB and look for a NUL" — is how `no-secrets.test.ts` additionally
 * classifies *unknown* extensions, and it is exactly the wrong instrument for
 * the control-byte guard: it would skip precisely the files that carry the
 * defect, the same blindness as `grep -I`. So that sniff stays local to
 * `no-secrets.test.ts`; only the extension set is shared.
 *
 * MEMBERSHIP. An extension belongs here when a correct file of that type
 * cannot be read as text. Minified JS, SVG, CSV, SQL and lockfiles are text
 * however unpleasant, and are NOT members.
 */
export const BINARY_EXTENSIONS: ReadonlySet<string> = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.tiff',
    '.pdf', '.zip', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.7z',
    '.woff', '.woff2', '.ttf', '.otf', '.eot',
    '.mp3', '.mp4', '.webm', '.mov', '.wav',
    '.so', '.dll', '.dylib', '.exe', '.wasm',
    '.psd', '.sketch', '.fig',
]);
