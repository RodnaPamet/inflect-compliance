/**
 * #2224 — an API key is bound to its own tenant, and `getTenantCtx` enforces
 * that against the slug in the URL.
 *
 * Before #2224 a key-only request never passed the edge, so the only
 * key-bearing requests that reached a handler also carried a session cookie —
 * and the edge tenant-access gate refused a cross-tenant URL on the cookie's
 * memberships before the handler ran. The #2224 fall-through removes that gate
 * for key-bearing requests (they have no cookie for it to read), so the check
 * has to live here instead. `docs/api-consumer-guide.md` has always documented
 * this behaviour; until now it was vacuous.
 *
 * This drives the REAL `getTenantCtx` → `tryApiKeyAuth` → `verifyApiKey` chain
 * with only Prisma mocked. The mock matches on `keyHash`, so the SHA-256
 * hashing is really exercised: a lookup with the wrong hash returns null and
 * the request 401s, exactly as it would against the database.
 */
const mockPrisma = {
    tenantApiKey: {
        findUnique: jest.fn(),
        update: jest.fn(),
    },
};

jest.mock('@/lib/prisma', () => ({ __esModule: true, default: mockPrisma }));
jest.mock('@/lib/observability/context', () => ({
    mergeRequestContext: jest.fn(),
}));
jest.mock('@/lib/auth', () => ({
    getSessionOrThrow: jest.fn(async () => {
        throw new Error('session path must not be reached for a valid API key');
    }),
}));

import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { generateApiKey } from '@/lib/auth/api-key-auth';

const { plaintext, keyHash } = generateApiKey();

function keyRow(tenantSlug: string) {
    return {
        id: 'key-1',
        keyHash,
        tenantId: 'tenant-uuid-for-' + tenantSlug,
        createdById: 'user-1',
        revokedAt: null,
        expiresAt: null,
        scopes: ['risks:read'],
        tenant: { slug: tenantSlug },
    };
}

function req(pathname: string) {
    return new NextRequest(`http://localhost:3000${pathname}`, {
        method: 'GET',
        headers: new Headers({ authorization: `Bearer ${plaintext}` }),
    });
}

describe('getTenantCtx — API key ↔ URL tenant binding (#2224)', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockPrisma.tenantApiKey.update.mockResolvedValue({});
    });

    it('a key used on its own tenant resolves that tenant', async () => {
        mockPrisma.tenantApiKey.findUnique.mockImplementation(
            async ({ where }: { where: { keyHash: string } }) =>
                where.keyHash === keyHash ? keyRow('acme') : null,
        );
        const ctx = await getTenantCtx({ tenantSlug: 'acme' }, req('/api/t/acme/risks'));
        expect(ctx.tenantSlug).toBe('acme');
        expect(ctx.tenantId).toBe('tenant-uuid-for-acme');
        expect(ctx.apiKeyId).toBe('key-1');
    });

    it('a key used on ANOTHER tenant is refused, not silently re-pointed', async () => {
        // The key belongs to `beta`; the URL says `acme`. The dangerous
        // outcome is not an error — it is returning beta's context under an
        // acme-shaped URL, so every row read, every audit row written and
        // every metric emitted is labelled with the wrong tenant.
        mockPrisma.tenantApiKey.findUnique.mockImplementation(
            async ({ where }: { where: { keyHash: string } }) =>
                where.keyHash === keyHash ? keyRow('beta') : null,
        );
        await expect(
            getTenantCtx({ tenantSlug: 'acme' }, req('/api/t/acme/risks')),
        ).rejects.toMatchObject({ status: 403 });
    });

    it('an invalid key is refused rather than falling back to the session', async () => {
        // The edge waves a `Bearer iflk_…` request through on the header
        // alone, so the handler is the only thing that can say no. If this
        // ever fell back to the cookie, presenting a garbage key would
        // downgrade a request to whatever session it happened to carry.
        mockPrisma.tenantApiKey.findUnique.mockImplementation(
            // No row carries this key's hash.
            async () => null,
        );
        await expect(
            getTenantCtx({ tenantSlug: 'acme' }, req('/api/t/acme/risks')),
        ).rejects.toMatchObject({ status: 401 });
    });
});
