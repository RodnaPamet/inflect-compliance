/**
 * CSP (Content Security Policy) — nonce generation and header builder.
 *
 * Architecture:
 *   middleware.ts → generateNonce() → buildCspHeader(nonce)
 *                → sets x-csp-nonce request header  (server components read it)
 *                → sets Content-Security-Policy[-Report-Only] response header
 *
 * Next.js integration:
 *   The root layout reads the nonce from headers() and passes it through.
 *   Next.js automatically tags its own <script> and <link> tags with the nonce
 *   when it is present on the request headers.
 *
 * Rollout strategy:
 *   1. Set CSP_REPORT_ONLY=true → Content-Security-Policy-Report-Only (observe)
 *   2. Monitor /api/security/csp-report for violations
 *   3. Set CSP_REPORT_ONLY=false (or unset) → Content-Security-Policy (enforce)
 *
 * unsafe-inline status:
 *   - script-src: NO unsafe-inline in any environment
 *     Uses 'strict-dynamic' + nonce for all scripts. Next.js propagates the nonce
 *     to its own script tags automatically.
 *   - style-src: 'unsafe-inline' is allowed, nonce is NOT present.
 *     Per CSP Level 3, a nonce on style-src causes 'unsafe-inline' to be
 *     ignored — including for `style=""` attributes, which nonces never
 *     match. The app uses many dynamic SSR inline styles (progress bars,
 *     colour-coded badges), so we omit the nonce from style-src and let
 *     'unsafe-inline' cover both `<style>` tags and style attributes.
 *     <style> tags are kept out of the codebase by the guardrail at
 *     tests/guards/csp-style-guardrails.test.ts. CSS injection has far
 *     lower blast radius than JS injection, and script-src stays strict
 *     (nonce + strict-dynamic).
 *   - script-src dev: 'unsafe-eval' required for Next.js HMR/Fast Refresh eval().
 */

// Edge-compatible crypto — works in both Node.js and Edge Runtime
function getRandomBytes(size: number): Uint8Array {
    if (typeof globalThis.crypto?.getRandomValues === 'function') {
        const buf = new Uint8Array(size);
        globalThis.crypto.getRandomValues(buf);
        return buf;
    }
    // Fallback for environments without WebCrypto (shouldn't happen in Next.js)
    throw new Error('CSP: No cryptographic random source available');
}

/**
 * Generate a cryptographically secure, base64-encoded nonce.
 * 16 bytes (128 bits) — matches OWASP recommendation.
 */
export function generateNonce(): string {
    const bytes = getRandomBytes(16);
    // Edge-compatible base64 encoding
    return btoa(String.fromCharCode(...bytes));
}

// ─── Directive types ────────────────────────────────────────────────

export interface CspDirectives {
    'default-src': string[];
    'script-src': string[];
    'style-src': string[];
    'img-src': string[];
    'font-src': string[];
    'connect-src': string[];
    'object-src': string[];
    'base-uri': string[];
    'frame-ancestors': string[];
    'form-action': string[];
    'worker-src'?: string[];
    'manifest-src'?: string[];
    'report-uri'?: string[];
    'report-to'?: string[];
    'upgrade-insecure-requests'?: true;
}

/**
 * Request header name used to pass the nonce from middleware → server components.
 * Server components read this via `headers().get(CSP_NONCE_HEADER)`.
 */
export const CSP_NONCE_HEADER = 'x-csp-nonce';

/**
 * CSP report endpoint path within the app.
 */
export const CSP_REPORT_PATH = '/api/security/csp-report';

/**
 * The pre-hardening CSP report path, still live because browsers hold cached
 * CSP headers pointing at it (`src/app/api/csp-report/route.ts` forwards a
 * POST to `CSP_REPORT_PATH`). Named here because the edge treats the two as
 * one surface: both are on `MACHINE_CALLER_PREFIXES`, so both are anonymous
 * at the edge, and the rate limit `src/middleware.ts` puts on the operator
 * GET has to cover both or the alias becomes the unmetered way in the moment
 * anyone exports a GET from it.
 */
export const LEGACY_CSP_REPORT_PATH = '/api/csp-report';

/**
 * Report-To group name for the Reporting API.
 */
export const CSP_REPORT_GROUP = 'csp-endpoint';

/**
 * The response header name for the CSP policy.
 * - Content-Security-Policy: enforced (violations are blocked)
 * - Content-Security-Policy-Report-Only: report-only (violations reported, not blocked)
 */
export const CSP_HEADER_ENFORCE = 'Content-Security-Policy';
export const CSP_HEADER_REPORT_ONLY = 'Content-Security-Policy-Report-Only';

/**
 * Determine the correct CSP header name based on the report-only setting.
 *
 * @param reportOnly - If true, use report-only mode; otherwise enforce
 * @returns The appropriate header name
 */
export function getCspHeaderName(reportOnly: boolean): string {
    return reportOnly ? CSP_HEADER_REPORT_ONLY : CSP_HEADER_ENFORCE;
}

/**
 * Check whether CSP report-only mode is enabled.
 *
 * Reads from CSP_REPORT_ONLY environment variable.
 * Any truthy value ('true', '1', 'yes') enables report-only mode.
 * Default: false (enforce mode).
 */
export function isCspReportOnly(envValue?: string): boolean {
    if (!envValue) return false;
    return ['true', '1', 'yes'].includes(envValue.toLowerCase().trim());
}

/**
 * Build the full Content-Security-Policy header string.
 *
 * @param nonce  - The per-request nonce (base64)
 * @param isDev  - true for development mode (allows unsafe-eval for HMR)
 */
export function buildCspHeader(nonce: string, isDev = false): string {
    const directives: CspDirectives = {
        'default-src': ["'self'"],
        'script-src': [
            "'self'",
            `'nonce-${nonce}'`,
            "'strict-dynamic'",
            // In dev, Next.js HMR / Fast Refresh requires eval
            ...(isDev ? ["'unsafe-eval'"] : []),
        ],
        'style-src': [
            "'self'",
            // Per CSP L3, once a nonce or hash appears in style-src,
            // 'unsafe-inline' is *ignored* — including for `style=""`
            // attributes, which nonces never match. The app uses many
            // SSR-emitted inline styles (progress-bar widths, status
            // colours) so we drop the nonce from style-src and rely on
            // 'unsafe-inline' alone. The guardrail at
            // tests/guards/csp-style-guardrails.test.ts keeps <style>
            // tags and CSS-in-JS out of the codebase, and script-src
            // remains strict (nonce + strict-dynamic).
            "'unsafe-inline'",
            // Google Fonts stylesheet
            'https://fonts.googleapis.com',
        ],
        'img-src': ["'self'", 'data:', 'https:'],
        'font-src': ["'self'", 'data:', 'https://fonts.gstatic.com'],
        'connect-src': [
            "'self'",
            'blob:',
            'https:',
            // In dev, allow HMR WebSocket
            ...(isDev ? ['ws://localhost:*', 'ws://127.0.0.1:*'] : []),
        ],
        'object-src': ["'none'"],
        'base-uri': ["'self'"],
        'frame-ancestors': ["'none'"],
        'form-action': ["'self'"],
        // Workers: restrict to same-origin
        'worker-src': ["'self'", 'blob:'],
        // PWA manifest
        'manifest-src': ["'self'"],
        // Violation reporting — both legacy and modern endpoints
        'report-uri': [CSP_REPORT_PATH],
        'report-to': [CSP_REPORT_GROUP],
    };

    // Only add upgrade-insecure-requests in production
    if (!isDev) {
        directives['upgrade-insecure-requests'] = true;
    }

    return serializeDirectives(directives);
}

/**
 * Serialize directives map into a CSP header string.
 */
function serializeDirectives(directives: CspDirectives): string {
    const parts: string[] = [];

    for (const [key, value] of Object.entries(directives)) {
        if (value === undefined) continue;
        if (value === true) {
            // Boolean directives like upgrade-insecure-requests
            parts.push(key);
        } else if (Array.isArray(value) && value.length > 0) {
            parts.push(`${key} ${value.join(' ')}`);
        }
    }

    return parts.join('; ');
}
