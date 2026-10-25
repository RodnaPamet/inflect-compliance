/* eslint-disable @typescript-eslint/no-explicit-any -- test mocks. */
/**
 * Unit tests for policy attestation (Audit S4, 2026-05-22).
 *
 * `attestPolicy`, `getPolicyAttestation`, `requirePolicyAcknowledgement`,
 * `getPolicyAcknowledgementRoster` — the operational surface on top of
 * the previously-dormant `PolicyAcknowledgement` model.
 */
const policyCalls: string[] = [];

// Each gate records that it ran AND enforces, by delegating to the real one.
// The previous mocks recorded without enforcing, so a "requires admin" test
// passed on whatever else happened to throw (a missing policy fixture), and
// could not tell a widened gate from an unchanged one.
jest.mock('@/app-layer/policies/common', () => {
    const actual = jest.requireActual('@/app-layer/policies/common');
    const recorded = (name: string, fn: (ctx: unknown) => void) =>
        jest.fn((ctx: unknown) => {
            policyCalls.push(name);
            return fn(ctx);
        });
    return {
        assertCanRead: recorded('read', actual.assertCanRead),
        assertCanWrite: recorded('write', actual.assertCanWrite),
        assertCanAdmin: recorded('admin', actual.assertCanAdmin),
        assertCanAudit: recorded('audit', actual.assertCanAudit),
    };
});

const policyRepoGetById = jest.fn();
jest.mock('@/app-layer/repositories/PolicyRepository', () => ({
    PolicyRepository: { getById: policyRepoGetById },
}));

jest.mock('@/app-layer/events/audit', () => ({ logEvent: jest.fn() }));

const tenantDb: any = {
    policyAcknowledgement: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
    },
    policyAcknowledgementAssignment: {
        createMany: jest.fn(),
        findMany: jest.fn(),
    },
    policyVersion: { findMany: jest.fn() },
    tenantMembership: { findMany: jest.fn() },
    notification: { create: jest.fn() },
    user: { findMany: jest.fn() },
    tenant: { findUnique: jest.fn() },
};
jest.mock('@/lib/db-context', () => {
    const actual = jest.requireActual('@/lib/db-context');
    return {
        ...actual,
        runInTenantContext: jest.fn(async (_ctx: any, cb: any) => cb(tenantDb)),
    };
});

import {
    attestPolicy,
    getPolicyAttestation,
    requirePolicyAcknowledgement,
    getPolicyAcknowledgementRoster,
} from '@/app-layer/usecases/policy-attestation';
import { makeRequestContext } from '../../helpers/make-context';

beforeEach(() => {
    policyCalls.length = 0;
    policyRepoGetById.mockReset();
    tenantDb.policyAcknowledgement.findUnique.mockReset();
    tenantDb.policyAcknowledgement.findMany.mockReset();
    tenantDb.policyAcknowledgement.create.mockReset();
    tenantDb.policyAcknowledgementAssignment.createMany.mockReset();
    tenantDb.policyAcknowledgementAssignment.findMany.mockReset();
    tenantDb.policyVersion.findMany.mockReset().mockResolvedValue([]);
    tenantDb.tenantMembership.findMany.mockReset();
    tenantDb.notification.create.mockReset().mockResolvedValue({ id: 'n1' });
    tenantDb.user.findMany.mockReset();
    tenantDb.tenant.findUnique.mockReset().mockResolvedValue({ slug: 'looked-up' });
});

const ctx = makeRequestContext('EDITOR');

describe('attestPolicy', () => {
    it('rejects attestation of a non-PUBLISHED policy', async () => {
        policyRepoGetById.mockResolvedValueOnce({
            id: 'p1',
            status: 'DRAFT',
            currentVersionId: 'v1',
        });
        await expect(attestPolicy(ctx, 'p1')).rejects.toThrow(
            /Only PUBLISHED policies/,
        );
    });

    it('rejects attestation when policy has no currentVersionId', async () => {
        policyRepoGetById.mockResolvedValueOnce({
            id: 'p1',
            status: 'PUBLISHED',
            currentVersionId: null,
        });
        await expect(attestPolicy(ctx, 'p1')).rejects.toThrow(
            /no currentVersionId/i,
        );
    });

    it('throws notFound when the policy is missing', async () => {
        policyRepoGetById.mockResolvedValueOnce(null);
        await expect(attestPolicy(ctx, 'missing')).rejects.toThrow(/not found/i);
    });

    it('creates a row on first attestation (created: true)', async () => {
        policyRepoGetById.mockResolvedValueOnce({
            id: 'p1',
            status: 'PUBLISHED',
            currentVersionId: 'v1',
        });
        tenantDb.policyAcknowledgement.findUnique.mockResolvedValueOnce(null);
        tenantDb.policyAcknowledgement.create.mockResolvedValueOnce({
            id: 'ack-1',
            policyVersionId: 'v1',
            userId: 'user-1',
            acknowledgedAt: new Date('2026-05-24'),
        });
        const out = await attestPolicy(ctx, 'p1');
        expect(out.created).toBe(true);
        expect(out.acknowledgementId).toBe('ack-1');
        expect(tenantDb.policyAcknowledgement.create).toHaveBeenCalledWith({
            data: { policyVersionId: 'v1', userId: 'user-1' },
        });
    });

    it('returns existing row idempotently (created: false) when user already attested', async () => {
        policyRepoGetById.mockResolvedValueOnce({
            id: 'p1',
            status: 'PUBLISHED',
            currentVersionId: 'v1',
        });
        const ackedAt = new Date('2026-04-01');
        tenantDb.policyAcknowledgement.findUnique.mockResolvedValueOnce({
            id: 'ack-existing',
            policyVersionId: 'v1',
            userId: 'user-1',
            acknowledgedAt: ackedAt,
        });
        const out = await attestPolicy(ctx, 'p1');
        expect(out.created).toBe(false);
        expect(out.acknowledgementId).toBe('ack-existing');
        expect(out.acknowledgedAt).toBe(ackedAt);
        expect(tenantDb.policyAcknowledgement.create).not.toHaveBeenCalled();
    });

    it('gates on canRead (not admin) — any tenant member can attest', async () => {
        policyRepoGetById.mockResolvedValueOnce({
            id: 'p1',
            status: 'PUBLISHED',
            currentVersionId: 'v1',
        });
        tenantDb.policyAcknowledgement.findUnique.mockResolvedValueOnce(null);
        tenantDb.policyAcknowledgement.create.mockResolvedValueOnce({
            id: 'ack-1',
            policyVersionId: 'v1',
            userId: 'user-1',
            acknowledgedAt: new Date(),
        });
        await attestPolicy(makeRequestContext('READER'), 'p1');
        expect(policyCalls).toEqual(['read']);
    });
});

describe('getPolicyAttestation', () => {
    it('returns null when policy has no currentVersionId', async () => {
        policyRepoGetById.mockResolvedValueOnce({
            id: 'p1',
            status: 'DRAFT',
            currentVersionId: null,
        });
        const out = await getPolicyAttestation(ctx, 'p1');
        expect(out).toBeNull();
    });

    it('looks up by (currentVersionId, callerUserId) by default', async () => {
        policyRepoGetById.mockResolvedValueOnce({
            id: 'p1',
            status: 'PUBLISHED',
            currentVersionId: 'v1',
        });
        tenantDb.policyAcknowledgement.findUnique.mockResolvedValueOnce({
            id: 'ack-1',
            policyVersionId: 'v1',
            userId: 'user-1',
        });
        const out = await getPolicyAttestation(ctx, 'p1');
        expect(out?.userId).toBe('user-1');
        expect(tenantDb.policyAcknowledgement.findUnique).toHaveBeenCalledWith({
            where: {
                policyVersionId_userId: {
                    policyVersionId: 'v1',
                    userId: 'user-1',
                },
            },
        });
    });

    it('requires admin to look up another user\'s attestation', async () => {
        // ctx = EDITOR; trying to look up another userId.
        await expect(
            getPolicyAttestation(makeRequestContext('EDITOR'), 'p1', 'other-user'),
        ).rejects.toThrow();
    });

    it('admin can look up another user\'s attestation', async () => {
        policyRepoGetById.mockResolvedValueOnce({
            id: 'p1',
            status: 'PUBLISHED',
            currentVersionId: 'v1',
        });
        tenantDb.policyAcknowledgement.findUnique.mockResolvedValueOnce(null);
        const out = await getPolicyAttestation(
            makeRequestContext('ADMIN'),
            'p1',
            'other-user',
        );
        expect(out).toBeNull();
        expect(policyCalls).toEqual(['read', 'admin']);
    });
});

describe('requirePolicyAcknowledgement (campaign)', () => {
    it('requires admin', async () => {
        await expect(
            requirePolicyAcknowledgement(makeRequestContext('EDITOR'), 'p1', { audience: { type: 'all' } }),
        ).rejects.toThrow(/administrative/);
    });

    it('stays admin-only: an AUDITOR, who may read the roster, may not request (#4128)', async () => {
        await expect(
            requirePolicyAcknowledgement(makeRequestContext('AUDITOR'), 'p1', { audience: { type: 'all' } }),
        ).rejects.toThrow(/administrative/);
        expect(policyRepoGetById).not.toHaveBeenCalled();
    });

    it('links each notification to the policy inside the workspace, not a bare /policies path (#4128)', async () => {
        policyRepoGetById.mockResolvedValueOnce({ id: 'p1', status: 'PUBLISHED', currentVersionId: 'v1', title: 'P' });
        tenantDb.tenantMembership.findMany.mockResolvedValueOnce([{ userId: 'u1' }]);
        tenantDb.policyAcknowledgementAssignment.createMany.mockResolvedValueOnce({ count: 1 });
        await requirePolicyAcknowledgement(makeRequestContext('ADMIN'), 'p1', { audience: { type: 'all' } });
        const data = tenantDb.notification.create.mock.calls[0][0].data;
        expect(data.linkUrl).toBe('/t/acme/policies/p1');
        // The context carried the slug, so nothing was looked up.
        expect(tenantDb.tenant.findUnique).not.toHaveBeenCalled();
    });

    it('looks the slug up when the context carries none', async () => {
        policyRepoGetById.mockResolvedValueOnce({ id: 'p1', status: 'PUBLISHED', currentVersionId: 'v1', title: 'P' });
        tenantDb.tenantMembership.findMany.mockResolvedValueOnce([{ userId: 'u1' }]);
        tenantDb.policyAcknowledgementAssignment.createMany.mockResolvedValueOnce({ count: 1 });
        await requirePolicyAcknowledgement(makeRequestContext('ADMIN', { tenantSlug: undefined }), 'p1', {
            audience: { type: 'all' },
        });
        expect(tenantDb.notification.create.mock.calls[0][0].data.linkUrl).toBe('/t/looked-up/policies/p1');
    });

    it('refuses a non-PUBLISHED policy', async () => {
        policyRepoGetById.mockResolvedValueOnce({ id: 'p1', status: 'DRAFT', currentVersionId: 'v1', title: 'P' });
        await expect(
            requirePolicyAcknowledgement(makeRequestContext('ADMIN'), 'p1', { audience: { type: 'all' } }),
        ).rejects.toThrow(/Only PUBLISHED/);
    });

    it('throws when the audience resolves to zero members', async () => {
        policyRepoGetById.mockResolvedValueOnce({ id: 'p1', status: 'PUBLISHED', currentVersionId: 'v1', title: 'P' });
        tenantDb.tenantMembership.findMany.mockResolvedValueOnce([]);
        await expect(
            requirePolicyAcknowledgement(makeRequestContext('ADMIN'), 'p1', { audience: { type: 'all' } }),
        ).rejects.toThrow(/zero active members/);
    });

    it('assigns the resolved audience, dedupes, and notifies each', async () => {
        policyRepoGetById.mockResolvedValueOnce({ id: 'p1', status: 'PUBLISHED', currentVersionId: 'v1', title: 'Acceptable Use' });
        tenantDb.tenantMembership.findMany.mockResolvedValueOnce([{ userId: 'u1' }, { userId: 'u2' }]);
        tenantDb.policyAcknowledgementAssignment.createMany.mockResolvedValueOnce({ count: 2 });
        const out = await requirePolicyAcknowledgement(makeRequestContext('ADMIN'), 'p1', { audience: { type: 'all' } });
        expect(out).toEqual({ policyVersionId: 'v1', assignedCount: 2 });
        const createManyArg = tenantDb.policyAcknowledgementAssignment.createMany.mock.calls[0][0];
        expect(createManyArg.skipDuplicates).toBe(true);
        expect(createManyArg.data).toHaveLength(2);
        expect(createManyArg.data[0]).toMatchObject({ policyVersionId: 'v1', assignedById: 'user-1' });
        expect(tenantDb.notification.create).toHaveBeenCalledTimes(2);
    });

    it('scopes a role audience to that role', async () => {
        policyRepoGetById.mockResolvedValueOnce({ id: 'p1', status: 'PUBLISHED', currentVersionId: 'v1', title: 'P' });
        tenantDb.tenantMembership.findMany.mockResolvedValueOnce([{ userId: 'u1' }]);
        tenantDb.policyAcknowledgementAssignment.createMany.mockResolvedValueOnce({ count: 1 });
        await requirePolicyAcknowledgement(makeRequestContext('ADMIN'), 'p1', { audience: { type: 'role', role: 'EDITOR' as any } });
        const where = tenantDb.tenantMembership.findMany.mock.calls[0][0].where;
        expect(where.role).toBe('EDITOR');
        expect(where.status).toBe('ACTIVE');
    });
});

describe('getPolicyAcknowledgementRoster', () => {
    // Owner decision (#4128): OWNER, ADMIN and AUDITOR may READ the roster and
    // its attestation log — acknowledgement evidence is what an auditor asks
    // for. It was `assertCanAdmin`, which refused the AUDITOR.
    it.each(['EDITOR', 'READER', 'AI_ADMIN'])('refuses %s', async (role) => {
        await expect(getPolicyAcknowledgementRoster(makeRequestContext(role), 'p1')).rejects.toThrow(
            /permission to perform audit actions/,
        );
        expect(policyRepoGetById).not.toHaveBeenCalled();
    });

    it.each(['OWNER', 'ADMIN', 'AUDITOR'])('lets %s read it', async (role) => {
        policyRepoGetById.mockResolvedValueOnce({ id: 'p1', status: 'PUBLISHED', currentVersionId: 'v1', title: 'P' });
        tenantDb.policyAcknowledgementAssignment.findMany.mockResolvedValueOnce([{ userId: 'u1' }]);
        tenantDb.policyAcknowledgement.findMany.mockResolvedValueOnce([{ userId: 'u1', acknowledgedAt: new Date('2026-06-01') }]);
        tenantDb.user.findMany.mockResolvedValueOnce([{ id: 'u1', name: 'One', email: 'one@x.com' }]);

        const roster = await getPolicyAcknowledgementRoster(makeRequestContext(role), 'p1');

        expect(policyCalls).toEqual(['audit']);
        expect(roster.acknowledgedCount).toBe(1);
        expect(roster.attestations.map((a) => a.userId)).toEqual(['u1']);
    });

    it('computes % complete from assignments vs acknowledgements', async () => {
        policyRepoGetById.mockResolvedValueOnce({ id: 'p1', status: 'PUBLISHED', currentVersionId: 'v1', title: 'P' });
        // u1 + u2 assigned; only u1 acknowledged → 50% complete.
        tenantDb.policyAcknowledgementAssignment.findMany.mockResolvedValueOnce([{ userId: 'u1' }, { userId: 'u2' }]);
        tenantDb.policyAcknowledgement.findMany.mockResolvedValueOnce([{ userId: 'u1', acknowledgedAt: new Date('2026-06-01') }]);
        tenantDb.user.findMany.mockResolvedValueOnce([
            { id: 'u1', name: 'One', email: 'one@x.com' },
            { id: 'u2', name: 'Two', email: 'two@x.com' },
        ]);
        const roster = await getPolicyAcknowledgementRoster(makeRequestContext('ADMIN'), 'p1');
        expect(roster.assignedCount).toBe(2);
        expect(roster.acknowledgedCount).toBe(1);
        expect(roster.pctComplete).toBe(50);
        // Outstanding (u2) sorts before acknowledged (u1).
        expect(roster.entries[0].userId).toBe('u2');
        expect(roster.entries[0].acknowledgedAt).toBeNull();
        expect(roster.entries.find((e) => e.userId === 'u1')?.acknowledgedAt).not.toBeNull();
    });

    it('returns an empty roster when the policy has no current version', async () => {
        policyRepoGetById.mockResolvedValueOnce({ id: 'p1', status: 'DRAFT', currentVersionId: null, title: 'P' });
        const roster = await getPolicyAcknowledgementRoster(makeRequestContext('ADMIN'), 'p1');
        expect(roster).toEqual({ policyVersionId: null, assignedCount: 0, acknowledgedCount: 0, pctComplete: 0, entries: [], attestations: [] });
    });

    it('marks a stale (superseded-version) ack as non-compliant, not acknowledged', async () => {
        policyRepoGetById.mockResolvedValueOnce({ id: 'p1', status: 'PUBLISHED', currentVersionId: 'v2', title: 'P' });
        // u1 assigned to current v2; has NOT acked v2 but DID ack the prior v1.
        tenantDb.policyVersion.findMany.mockResolvedValueOnce([{ id: 'v1' }, { id: 'v2' }]);
        tenantDb.policyAcknowledgementAssignment.findMany.mockResolvedValueOnce([{ userId: 'u1', assignedById: 'admin', assignedAt: new Date('2026-06-01') }]);
        tenantDb.policyAcknowledgement.findMany
            .mockResolvedValueOnce([]) // current version (v2) acks — none
            .mockResolvedValueOnce([{ userId: 'u1', acknowledgedAt: new Date('2026-05-01') }]); // prior (v1) acks
        tenantDb.user.findMany.mockResolvedValueOnce([{ id: 'u1', name: 'One', email: 'one@x.com' }]);

        const roster = await getPolicyAcknowledgementRoster(makeRequestContext('ADMIN'), 'p1');
        // Stale ack does NOT count toward completion.
        expect(roster.acknowledgedCount).toBe(0);
        expect(roster.pctComplete).toBe(0);
        const entry = roster.entries.find((e) => e.userId === 'u1');
        expect(entry?.status).toBe('ACKNOWLEDGED_SUPERSEDED');
        expect(entry?.acknowledgedAt).toBeNull();
        expect(entry?.supersededAckAt).not.toBeNull();
        expect(entry?.assignedByName).toBe(null); // 'admin' not in the user lookup here
    });
});
