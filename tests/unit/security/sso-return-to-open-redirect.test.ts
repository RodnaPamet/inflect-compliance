/**
 * SSO cannot be used to bounce a user off our domain.
 *
 * `returnTo` starts life in the query string of the UNAUTHENTICATED
 * `/api/auth/sso/{saml,oidc}/start` routes, rides through an UNSIGNED state
 * blob (SAML: RelayState), and lands in `NextResponse.redirect` in both
 * callbacks. It was never validated, and the surrounding
 * `new URL(returnTo, baseUrl)` does not constrain it — `new URL` treats an
 * absolute or protocol-relative input as the whole URL:
 *
 *     new URL('https://evil.com', 'https://app.example')  ->  https://evil.com/
 *     new URL('//evil.com',       'https://app.example')  ->  https://evil.com/
 *
 * So a link on our own domain lands the user on the attacker's, after a real
 * sign-in. `sanitizeRedirectPath` was already in the tree and unused by this
 * flow, which is the part worth remembering: the defence existed and was not
 * wired.
 *
 * The behavioural half is on the helper, because it is what actually decides
 * the outcome; the wiring half is asserted per callback, because a helper
 * nothing calls is what this bug was.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { sanitizeRedirectPath } from '@/lib/auth/guard';

const ROOT = path.resolve(__dirname, '../../..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const codeOnly = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const CALLBACKS = [
    ['oidc', 'src/app/api/auth/sso/oidc/callback/route.ts'],
    ['saml', 'src/app/api/auth/sso/saml/callback/route.ts'],
] as const;

const STARTS = [
    ['oidc', 'src/app/api/auth/sso/oidc/start/route.ts'],
    ['saml', 'src/app/api/auth/sso/saml/start/route.ts'],
] as const;

describe('sanitizeRedirectPath refuses every off-domain shape', () => {
    it.each([
        ['https://evil.com'],
        ['http://evil.com/path'],
        ['//evil.com'],
        ['///evil.com'],
        ['\\\\evil.com'],
        ['javascript:alert(1)'],
        ['https:/\\evil.com'],
    ])('%s resolves to /', (input) => {
        const out = sanitizeRedirectPath(input);
        // The real assertion: whatever it returns, resolving it against our
        // origin must stay on our origin. Checking the string alone would
        // miss a value that is "relative" but still escapes.
        expect(new URL(out, 'https://app.example').origin).toBe('https://app.example');
    });

    it('preserves a genuine in-app destination', () => {
        expect(sanitizeRedirectPath('/t/acme/risks?status=OPEN')).toBe('/t/acme/risks?status=OPEN');
    });

    it('returns / rather than empty for absent input', () => {
        // Load-bearing for the callers below: '/' is TRUTHY, which is why
        // they must not write `sanitize(x) || fallback`.
        expect(sanitizeRedirectPath(undefined)).toBe('/');
        expect(sanitizeRedirectPath(null)).toBe('/');
        expect(sanitizeRedirectPath('')).toBe('/');
    });
});

describe('both SSO callbacks sanitise before redirecting', () => {
    it.each(CALLBACKS)('%s callback runs returnTo through the sanitiser', (_n, file) => {
        expect(codeOnly(read(file))).toMatch(/sanitizeRedirectPath\(/);
    });

    it.each(CALLBACKS)('%s callback keeps its dashboard fallback', (_n, file) => {
        // The trap in the obvious fix. `sanitizeRedirectPath(x) || fallback`
        // never reaches the fallback, because the sanitiser returns '/' —
        // truthy — for absent input. That would silently land every SSO
        // sign-in without a returnTo on the root instead of the tenant
        // dashboard, which is a behaviour change disguised as a security fix.
        const src = codeOnly(read(file));
        expect(src).toMatch(/dashboard/);
        expect(src).not.toMatch(/sanitizeRedirectPath\([^)]*\)\s*\|\|/);
    });
});

describe('the SSO entry points do not enumerate tenants or providers', () => {
    it.each(STARTS)('%s start returns one generic message', (_n, file) => {
        // Distinct "Tenant not found" vs "provider not found or not enabled"
        // answers, to a fully anonymous caller and before any assertion is
        // validated, whether a slug exists and which providers it has.
        const src = codeOnly(read(file));
        expect(src).not.toMatch(/notFound\(['"]Tenant not found['"]\)/);
        expect(src).not.toMatch(/provider not found or not enabled/i);
    });
});

describe('the SSO entry points are rate-limited as sign-in, not as /csrf', () => {
    it('classifyEndpoint puts /api/auth/sso/ in the strict tier', () => {
        const src = codeOnly(read('src/lib/rate-limit/authRateLimit.ts'));
        const at = src.indexOf('function classifyEndpoint');
        const body = src.slice(at, src.indexOf("return 'medium'", at));
        expect(body).toMatch(/\/api\/auth\/sso\//);
    });
});
