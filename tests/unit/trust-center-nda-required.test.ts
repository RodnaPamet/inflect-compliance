/**
 * #5764 item 7 — the trust center's "Require NDA acceptance" switch.
 *
 * `TrustCenter.ndaRequired` decides whether the public request form asks for
 * the NDA and whether an approval refuses a request that did not accept it
 * (#5613), and nothing in the product wrote it. It is now written by the
 * compose save (`PUT /admin/trust-center` → `upsertTrustCenter`), under the
 * key that route holds, and every change to it is audited.
 *
 * The route runs for real here, through `requirePermission` and the real
 * usecase; only the request context, the tenant transaction and the audit
 * writers are stand-ins.
 */

import { strictMock } from '../helpers/strict-mock';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getTenantCtxMock = jest.fn<any, [unknown, unknown]>();
jest.mock('@/app-layer/context', () => ({
    getTenantCtx: (params: unknown, req: unknown) => getTenantCtxMock(params, req),
}));

// The AUTHZ_DENIED row `requirePermission` writes on denial must not reach a
// real DB in a unit test.
// A strict mock: an export the factory omits throws when reached, rather than
// resolving to undefined and silently writing no row.
jest.mock('@/lib/audit', () =>
    strictMock('@/lib/audit', jest.requireActual('@/lib/audit'), {
        appendAuditEntryOrQueue: jest.fn(async () => ({ recorded: 'chain' as const, auditId: 'audit-x' })),
        appendAuditEntry: jest.fn(async () => ({ id: 'audit-x', entryHash: 'hash-x', previousHash: null })),
    }),
);

const db = {
    trustCenter: { findUnique: jest.fn(), upsert: jest.fn() },
    tenant: { findUnique: jest.fn() },
};
const reachedDb = jest.fn();
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: (_ctx: unknown, fn: (d: unknown) => unknown) => {
        reachedDb();
        return fn(db);
    },
}));
const logEvent = jest.fn();
jest.mock('@/app-layer/events/audit', () => ({ logEvent: (...a: unknown[]) => logEvent(...a) }));

import { NextRequest } from 'next/server';
import { PUT } from '@/app/api/t/[tenantSlug]/admin/trust-center/route';
import { upsertTrustCenter } from '@/app-layer/usecases/trust-center';
import { TRUST_CENTER_COMPOSE_NEEDS_ADMIN_MANAGE } from '@/lib/trust-center/compose-refusals';
import { makeRequestContext } from '../helpers/make-context';

const base = { displayName: 'Acme' };

/** The stored row before the save, and the row the upsert hands back. */
function stored(before: { enabled?: boolean; ndaRequired: boolean } | null) {
    db.trustCenter.findUnique.mockResolvedValue(before && { id: 'tc-1', enabled: before.enabled ?? false, ndaRequired: before.ndaRequired });
    db.trustCenter.upsert.mockImplementation(async (args: { create: Record<string, unknown>; update: Record<string, unknown> }) => {
        const written = before ? args.update : args.create;
        return {
            id: 'tc-1',
            slug: 'acme',
            enabled: before?.enabled ?? false,
            ndaRequired: 'ndaRequired' in written ? written.ndaRequired : (before?.ndaRequired ?? false),
        };
    });
}

/** The NDA audit rows written by the save. */
const ndaAudits = () =>
    logEvent.mock.calls
        .map((c) => c[2] as { action: string; detailsJson: Record<string, unknown> })
        .filter((e) => e.action.startsWith('TRUST_CENTER_NDA'));

beforeEach(() => {
    jest.clearAllMocks();
    db.tenant.findUnique.mockResolvedValue({ slug: 'acme' });
});

describe('upsertTrustCenter writes ndaRequired', () => {
    it('turns the NDA on, and audits the change', async () => {
        stored({ ndaRequired: false });
        const row = await upsertTrustCenter(makeRequestContext('ADMIN'), { ...base, ndaRequired: true });

        expect(row.ndaRequired).toBe(true);
        expect(db.trustCenter.upsert.mock.calls[0][0].update).toMatchObject({ ndaRequired: true });
        expect(ndaAudits()).toEqual([
            expect.objectContaining({
                action: 'TRUST_CENTER_NDA_REQUIRED',
                entityId: 'tc-1',
                detailsJson: expect.objectContaining({
                    changedFields: ['ndaRequired'],
                    before: { ndaRequired: false },
                    after: { ndaRequired: true },
                }),
            }),
        ]);
    });

    it('turns the NDA off, and audits that too — published or not', async () => {
        stored({ ndaRequired: true, enabled: false });
        const row = await upsertTrustCenter(makeRequestContext('ADMIN'), { ...base, ndaRequired: false });

        expect(row.ndaRequired).toBe(false);
        expect(db.trustCenter.upsert.mock.calls[0][0].update).toMatchObject({ ndaRequired: false });
        expect(ndaAudits().map((e) => e.action)).toEqual(['TRUST_CENTER_NDA_NOT_REQUIRED']);
    });

    it('turns the NDA on in the first save that creates the trust center', async () => {
        stored(null);
        await upsertTrustCenter(makeRequestContext('ADMIN'), { ...base, ndaRequired: true });

        expect(db.trustCenter.upsert.mock.calls[0][0].create).toMatchObject({ ndaRequired: true });
        expect(ndaAudits().map((e) => e.action)).toEqual(['TRUST_CENTER_NDA_REQUIRED']);
    });

    it('keeps the stored value when the save leaves it out, and audits nothing about it', async () => {
        stored({ ndaRequired: true });
        const row = await upsertTrustCenter(makeRequestContext('ADMIN'), base);

        expect(db.trustCenter.upsert.mock.calls[0][0].update).not.toHaveProperty('ndaRequired');
        expect(row.ndaRequired).toBe(true);
        expect(ndaAudits()).toEqual([]);
    });

    it('audits nothing when the value does not change', async () => {
        stored({ ndaRequired: true });
        await upsertTrustCenter(makeRequestContext('ADMIN'), { ...base, ndaRequired: true });
        expect(ndaAudits()).toEqual([]);
    });

    it('refuses a member without admin.manage, by name, before any read', async () => {
        // An EDITOR passes the coarse write floor and holds no admin.manage —
        // the key the only route to this usecase requires.
        await expect(upsertTrustCenter(makeRequestContext('EDITOR'), { ...base, ndaRequired: true })).rejects.toMatchObject({
            status: 403,
            details: { reason: TRUST_CENTER_COMPOSE_NEEDS_ADMIN_MANAGE },
        });
        expect(reachedDb).not.toHaveBeenCalled();
    });
});

describe('PUT /api/t/:slug/admin/trust-center', () => {
    const routeArgs = { params: Promise.resolve({ tenantSlug: 'acme' }) };
    const put = (body: Record<string, unknown>) =>
        new NextRequest('https://example.test/api/t/acme/admin/trust-center', {
            method: 'PUT',
            body: JSON.stringify(body),
            headers: { 'content-type': 'application/json' },
        });

    it.each([true, false])('sets ndaRequired to %s for an administrator', async (value) => {
        getTenantCtxMock.mockResolvedValue(makeRequestContext('ADMIN'));
        stored({ ndaRequired: !value });

        const res = await PUT(put({ ...base, ndaRequired: value }), routeArgs);

        expect(res.status).toBe(200);
        await expect(res.json()).resolves.toMatchObject({ ndaRequired: value });
        expect(db.trustCenter.upsert.mock.calls[0][0].update).toMatchObject({ ndaRequired: value });
    });

    it('refuses an editor at the route, and writes nothing', async () => {
        getTenantCtxMock.mockResolvedValue(makeRequestContext('EDITOR'));

        const res = await PUT(put({ ...base, ndaRequired: true }), routeArgs);

        expect(res.status).toBe(403);
        expect(reachedDb).not.toHaveBeenCalled();
        expect(db.trustCenter.upsert).not.toHaveBeenCalled();
    });

    it('refuses a value that is not a boolean', async () => {
        getTenantCtxMock.mockResolvedValue(makeRequestContext('ADMIN'));

        const res = await PUT(put({ ...base, ndaRequired: 'yes' }), routeArgs);

        expect(res.status).toBe(400);
        expect(db.trustCenter.upsert).not.toHaveBeenCalled();
    });
});
