/**
 * EI-4 — `authenticateScimRequest` records a `scim.auth.count` metric at every
 * terminal branch. Operators alert on `not_found` (brute-force / stale
 * connector) and `revoked` (IdP still pushing a rotated token); without the
 * metric those failures are only visible as pino warns, which dashboards miss.
 *
 * Every external dependency (Prisma, logger) is mocked — no DB.
 */
const mockRecord = jest.fn();
const mockFindUnique = jest.fn();
const mockUpdate = jest.fn().mockResolvedValue(undefined);

jest.mock('@/lib/observability/metrics', () => ({
    __esModule: true,
    recordScimAuth: (...args: unknown[]) => mockRecord(...args),
}));
jest.mock('@/lib/observability/logger', () => ({
    __esModule: true,
    logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
}));
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {
        tenantScimToken: {
            findUnique: (...args: unknown[]) => mockFindUnique(...args),
            update: (...args: unknown[]) => mockUpdate(...args),
        },
    },
}));

import { authenticateScimRequest, ScimAuthError } from '@/lib/scim/auth';

/** Minimal NextRequest stand-in — the function only reads the auth header. */
function reqWith(authorization?: string) {
    return {
        headers: { get: (k: string) => (k === 'authorization' ? authorization ?? null : null) },
    } as unknown as Parameters<typeof authenticateScimRequest>[0];
}

beforeEach(() => {
    mockRecord.mockClear();
    mockFindUnique.mockReset();
    mockUpdate.mockClear().mockResolvedValue(undefined);
});

describe('authenticateScimRequest — scim.auth.count metric', () => {
    it('missing_header when there is no Bearer header', async () => {
        await expect(authenticateScimRequest(reqWith(undefined))).rejects.toBeInstanceOf(ScimAuthError);
        expect(mockRecord).toHaveBeenCalledWith({ outcome: 'failure', reason: 'missing_header' });
    });

    it('empty_token when the Bearer value is blank', async () => {
        await expect(authenticateScimRequest(reqWith('Bearer    '))).rejects.toBeInstanceOf(ScimAuthError);
        expect(mockRecord).toHaveBeenCalledWith({ outcome: 'failure', reason: 'empty_token' });
    });

    it('not_found when the token hash matches no row', async () => {
        mockFindUnique.mockResolvedValue(null);
        await expect(authenticateScimRequest(reqWith('Bearer abc'))).rejects.toBeInstanceOf(ScimAuthError);
        expect(mockRecord).toHaveBeenCalledWith({ outcome: 'failure', reason: 'not_found' });
    });

    it('revoked when the token row is revoked', async () => {
        mockFindUnique.mockResolvedValue({ id: 't1', tenantId: 'ten1', label: 'l', revokedAt: new Date() });
        await expect(authenticateScimRequest(reqWith('Bearer abc'))).rejects.toBeInstanceOf(ScimAuthError);
        expect(mockRecord).toHaveBeenCalledWith({ outcome: 'failure', reason: 'revoked' });
    });

    it('success on a live token, and returns the resolved tenant', async () => {
        mockFindUnique.mockResolvedValue({ id: 't1', tenantId: 'ten1', label: 'okta', revokedAt: null });
        const ctx = await authenticateScimRequest(reqWith('Bearer abc'));
        expect(ctx).toEqual({ tenantId: 'ten1', tokenId: 't1', tokenLabel: 'okta' });
        expect(mockRecord).toHaveBeenCalledWith({ outcome: 'success', reason: 'ok' });
    });

    /**
     * #5184 — A REMOVED TENANT ANSWERS NO CREDENTIAL.
     *
     * `deleteTenantUnderOrg` soft-deletes the tenant, deactivates every
     * membership, bumps `sessionVersion` and disables its integration
     * connections. It did not revoke the SCIM tokens, and this function never
     * looked at `Tenant.deletedAt` — so the customer's identity provider kept
     * calling on its own schedule, reading a removed workspace's users and,
     * via `POST` / `PATCH {active: true}`, RE-ACTIVATING the memberships the
     * removal had just deactivated. The sibling credential path
     * (`api-key-auth.ts`) carries the identical check and documents the same
     * gap for `TenantApiKey`.
     */
    it('tenant_deleted when the token is live but its tenant was removed', async () => {
        mockFindUnique.mockResolvedValue({
            id: 't1', tenantId: 'ten1', label: 'okta', revokedAt: null,
            tenant: { id: 'ten1', slug: 'acme', deletedAt: new Date() },
        });
        await expect(authenticateScimRequest(reqWith('Bearer abc')))
            .rejects.toBeInstanceOf(ScimAuthError);
        expect(mockRecord).toHaveBeenCalledWith({ outcome: 'failure', reason: 'tenant_deleted' });
    });

    it('and does not stamp lastUsedAt for a credential it refused', async () => {
        mockFindUnique.mockResolvedValue({
            id: 't1', tenantId: 'ten1', label: 'okta', revokedAt: null,
            tenant: { id: 'ten1', slug: 'acme', deletedAt: new Date() },
        });
        await expect(authenticateScimRequest(reqWith('Bearer abc'))).rejects.toThrow();
        // The stamp sits after the check, so a refused call records no use.
        // Asserted because "lastUsedAt" is read as evidence a connector is live.
        expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('POSITIVE CONTROL: a live token whose tenant is NOT deleted still passes', async () => {
        mockFindUnique.mockResolvedValue({
            id: 't1', tenantId: 'ten1', label: 'okta', revokedAt: null,
            tenant: { id: 'ten1', slug: 'acme', deletedAt: null },
        });
        const ctx = await authenticateScimRequest(reqWith('Bearer abc'));
        expect(ctx).toEqual({ tenantId: 'ten1', tokenId: 't1', tokenLabel: 'okta' });
        expect(mockRecord).toHaveBeenCalledWith({ outcome: 'success', reason: 'ok' });
    });

    /**
     * THE QUERY SHAPE, not just the branch.
     *
     * Prisma is mocked here, so a `deletedAt` the MOCK supplies would satisfy
     * the check above even if the real query never selected the column — the
     * test would pass against code that cannot work. This asserts the field is
     * actually requested, which is the half the mock cannot prove.
     */
    it('SELECTS tenant.deletedAt, so the check above has data to read', async () => {
        mockFindUnique.mockResolvedValue({
            id: 't1', tenantId: 'ten1', label: 'okta', revokedAt: null,
            tenant: { id: 'ten1', slug: 'acme', deletedAt: null },
        });
        await authenticateScimRequest(reqWith('Bearer abc'));
        const [args] = mockFindUnique.mock.calls[0] as unknown as [
            { include: { tenant: { select: Record<string, boolean> } } },
        ];
        expect(args.include.tenant.select).toMatchObject({ deletedAt: true });
    });

    it('records exactly one metric per call', async () => {
        mockFindUnique.mockResolvedValue({ id: 't1', tenantId: 'ten1', label: 'okta', revokedAt: null });
        await authenticateScimRequest(reqWith('Bearer abc'));
        expect(mockRecord).toHaveBeenCalledTimes(1);
    });
});
