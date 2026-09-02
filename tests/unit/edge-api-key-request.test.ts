/**
 * #2224 — the edge must recognise an `iflk_` API key the same way the handler
 * parses one, and only there.
 *
 * `matchTenantApiKeyRequest` lives in `src/lib/auth/guard.ts` because the Edge
 * middleware cannot import `src/lib/auth/api-key-auth.ts` (Prisma +
 * `node:crypto`). That duplication is the risk this file exists to remove: if
 * the two disagree about what a key looks like, the edge either 401s a valid
 * partner again (the bug) or waves through a header the handler will not treat
 * as a credential.
 *
 * So the assertions here are AGREEMENT assertions, not two independent
 * restatements — every header shape is fed to both sides and the answers are
 * required to match.
 */
import {
    matchTenantApiKeyRequest,
    EDGE_API_KEY_PREFIX,
} from '@/lib/auth/guard';

// api-key-auth pulls in Prisma at module load; the parser functions under test
// never touch it.
jest.mock('@/lib/prisma', () => ({ __esModule: true, default: {} }));

import {
    API_KEY_PREFIX,
    extractBearerToken,
    isApiKeyToken,
} from '@/lib/auth/api-key-auth';

const KEY = `${API_KEY_PREFIX}${'a1b2c3d4'.repeat(6)}`;

describe('edge API-key recognition (#2224)', () => {
    it('the edge copy of the key prefix is the canonical one', () => {
        expect(EDGE_API_KEY_PREFIX).toBe(API_KEY_PREFIX);
    });

    // Every shape below is answered by BOTH parsers and the answers compared,
    // so a change to either side that is not mirrored fails here.
    const HEADERS: Array<[string, string | null]> = [
        ['a well-formed key', `Bearer ${KEY}`],
        ['lowercase bearer scheme', `bearer ${KEY}`],
        ['MiXeD-case bearer scheme', `BeArEr ${KEY}`],
        ['a session-style JWT, not a key', 'Bearer eyJhbGciOiJIUzI1NiJ9.e30.x'],
        ['a device-agent token, not a key', 'Bearer icdt_testtoken123456'],
        ['Basic auth', 'Basic dXNlcjpwYXNz'],
        ['the scheme with no token', 'Bearer'],
        ['a token containing a space', `Bearer ${KEY} extra`],
        ['no header at all', null],
        ['an empty header', ''],
        ['the bare key with no scheme', KEY],
    ];

    it.each(HEADERS)('edge and handler agree on %s', (_label, header) => {
        const handlerToken = extractBearerToken(header);
        const handlerSaysKey =
            handlerToken !== null && isApiKeyToken(handlerToken);
        const edgeSaysKey =
            matchTenantApiKeyRequest('/api/t/acme/risks', header) !== null;
        expect(edgeSaysKey).toBe(handlerSaysKey);
    });

    it('returns a stable rate-limit scope that is not the key', () => {
        const scope = matchTenantApiKeyRequest('/api/t/acme/risks', `Bearer ${KEY}`);
        expect(scope).toMatch(/^apikey:[0-9a-f]{8}$/);
        // The scope is passed to `checkApiReadRateLimit`, which logs it at WARN
        // on every 429. It must therefore carry no key material.
        expect(scope).not.toContain(KEY.slice(0, 12));
        // Deterministic — the same key must land in the same bucket.
        expect(matchTenantApiKeyRequest('/api/t/acme/risks', `Bearer ${KEY}`)).toBe(scope);
    });

    it('gives two different keys two different buckets', () => {
        const other = `${API_KEY_PREFIX}${'f9e8d7c6'.repeat(6)}`;
        expect(matchTenantApiKeyRequest('/api/t/acme/risks', `Bearer ${other}`))
            .not.toBe(matchTenantApiKeyRequest('/api/t/acme/risks', `Bearer ${KEY}`));
    });

    it('is scoped to the tenant API and nothing else', () => {
        // The documented partner surface.
        expect(matchTenantApiKeyRequest('/api/t/acme/risks', `Bearer ${KEY}`)).not.toBeNull();
        // Flat API routes, org routes, admin routes and pages are NOT opened by
        // a key header — the fall-through skips the session gates, so it must
        // not extend past the surface the credential is documented for.
        for (const path of [
            '/api/evidence',
            '/api/audit-log',
            '/api/admin/tenants',
            '/api/org/acme/portfolio',
            '/t/acme/dashboard',
            '/admin',
            '/api/tenant/acme/risks',
        ]) {
            expect(matchTenantApiKeyRequest(path, `Bearer ${KEY}`)).toBeNull();
        }
    });
});
