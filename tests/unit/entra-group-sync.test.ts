/* eslint-disable @typescript-eslint/no-explicit-any -- test-mock pattern. */
/**
 * EI-3 — Entra group → role enforcement at sign-in.
 *
 * `syncEntraMembershipRole` is exercised with an injected mock DB; the pure
 * `applyEntraSyncToToken` is tested directly. Covers role sync, the gate, and —
 * critically — OWNER immunity (a mapping must never demote / lock out an owner).
 */
const mockAppend = jest.fn();
const mockMetric = jest.fn();
jest.mock('@/lib/prisma', () => ({ __esModule: true, default: {} }));
jest.mock('@/lib/audit', () => ({ __esModule: true, appendAuditEntry: (...a: unknown[]) => mockAppend(...a) }));
jest.mock('@/lib/observability/metrics', () => ({
    __esModule: true,
    recordEntraRoleSync: (...a: unknown[]) => mockMetric(...a),
}));
jest.mock('@/lib/observability/edge-logger', () => ({
    __esModule: true,
    edgeLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import {
    syncEntraMembershipRole,
    applyEntraSyncToToken,
    type EntraSyncDb,
} from '@/lib/auth/entra-group-sync';

const GUID = '11111111-1111-4111-8111-111111111111';
const validConfig = {
    aadTenantId: GUID,
    clientId: '22222222-2222-4222-8222-222222222222',
    groupClaimMode: 'securityGroup',
    enforceGroupGate: true,
    allowedDomains: [],
};

function mockDb(over: {
    mappings?: Array<{ aadGroupId: string; role: any; priority: number }>;
    membership?: { id: string; role: any } | null;
    config?: unknown;
}): { db: EntraSyncDb; update: jest.Mock } {
    const update = jest.fn().mockResolvedValue({});
    const db: EntraSyncDb = {
        tenantIdentityProvider: {
            findFirst: jest.fn().mockResolvedValue(
                over.config === undefined ? null : { configJson: over.config },
            ),
        },
        tenantEntraGroupMapping: {
            findMany: jest.fn().mockResolvedValue(over.mappings ?? []),
        },
        tenantMembership: {
            findFirst: jest.fn().mockResolvedValue(over.membership ?? null),
            update,
        },
    };
    return { db, update };
}

beforeEach(() => {
    mockAppend.mockClear();
    mockMetric.mockClear();
});

const base = { userId: 'u1', tenantId: 't1', aadGroups: ['g-1'] };

describe('syncEntraMembershipRole', () => {
    it('no-ops when the tenant has no mappings', async () => {
        const { db, update } = mockDb({ mappings: [] });
        const r = await syncEntraMembershipRole(base, { db });
        expect(r).toEqual({ effectiveRole: null, changed: false, gateDenied: false });
        expect(update).not.toHaveBeenCalled();
        expect(mockMetric).toHaveBeenCalledWith({ outcome: 'no_mappings' });
    });

    it('OWNER is immune — never demoted or gate-denied even with a matching mapping', async () => {
        const { db, update } = mockDb({
            mappings: [{ aadGroupId: 'g-1', role: 'READER', priority: 0 }],
            membership: { id: 'm1', role: 'OWNER' },
            config: { ...validConfig, enforceGroupGate: true },
        });
        const r = await syncEntraMembershipRole(base, { db });
        expect(r).toEqual({ effectiveRole: 'OWNER', changed: false, gateDenied: false });
        expect(update).not.toHaveBeenCalled();
        expect(mockMetric).toHaveBeenCalledWith({ outcome: 'owner_immune' });
    });

    // ── Ceiling-bound callers (SCIM Groups push) — #2200 ──

    const CEILING = ['READER', 'EDITOR', 'AUDITOR'] as const;

    it('OWNER immunity still fires first for a ceiling-bound caller', async () => {
        const { db, update } = mockDb({
            mappings: [{ aadGroupId: 'g-1', role: 'READER', priority: 0 }],
            membership: { id: 'm1', role: 'OWNER' },
            config: { ...validConfig, enforceGroupGate: true },
        });
        const r = await syncEntraMembershipRole({ ...base, assignableRoles: CEILING }, { db });
        expect(r).toEqual({ effectiveRole: 'OWNER', changed: false, gateDenied: false });
        expect(update).not.toHaveBeenCalled();
        expect(mockMetric).toHaveBeenCalledWith({ outcome: 'owner_immune' });
    });

    it('refuses to touch an ADMIN membership when a ceiling is supplied', async () => {
        const { db, update } = mockDb({
            mappings: [{ aadGroupId: 'g-1', role: 'READER', priority: 0 }],
            membership: { id: 'm1', role: 'ADMIN' },
        });
        const r = await syncEntraMembershipRole({ ...base, assignableRoles: CEILING }, { db });
        expect(r).toEqual({ effectiveRole: 'ADMIN', changed: false, gateDenied: false });
        expect(update).not.toHaveBeenCalled();
        expect(mockMetric).toHaveBeenCalledWith({ outcome: 'role_protected' });
    });

    it('still syncs an ADMIN membership on the UNCEILINGED sign-in path', async () => {
        const { db, update } = mockDb({
            mappings: [{ aadGroupId: 'g-1', role: 'READER', priority: 0 }],
            membership: { id: 'm1', role: 'ADMIN' },
        });
        const r = await syncEntraMembershipRole(base, { db });
        expect(r.changed).toBe(true);
        expect(update).toHaveBeenCalledWith(
            expect.objectContaining({ data: { role: 'READER' } }),
        );
    });

    it('a ceiling-bound caller cannot promote a READER to ADMIN', async () => {
        const { db, update } = mockDb({
            mappings: [{ aadGroupId: 'g-1', role: 'ADMIN', priority: 0 }],
            membership: { id: 'm1', role: 'READER' },
        });
        const r = await syncEntraMembershipRole({ ...base, assignableRoles: CEILING }, { db });
        expect(r.effectiveRole).toBeNull();
        expect(update).not.toHaveBeenCalled();
        expect(mockMetric).toHaveBeenCalledWith({ outcome: 'no_match' });
    });

    it('denies via the gate when enforceGroupGate is on and no group matches', async () => {
        const { db, update } = mockDb({
            mappings: [{ aadGroupId: 'other', role: 'EDITOR', priority: 0 }],
            membership: { id: 'm1', role: 'READER' },
            config: { ...validConfig, enforceGroupGate: true },
        });
        const r = await syncEntraMembershipRole(base, { db });
        expect(r.gateDenied).toBe(true);
        expect(update).not.toHaveBeenCalled();
        expect(mockMetric).toHaveBeenCalledWith({ outcome: 'gate_denied' });
    });

    it('does not deny when the gate is off and nothing matches', async () => {
        const { db } = mockDb({
            mappings: [{ aadGroupId: 'other', role: 'EDITOR', priority: 0 }],
            membership: { id: 'm1', role: 'READER' },
            config: { ...validConfig, enforceGroupGate: false },
        });
        const r = await syncEntraMembershipRole(base, { db });
        expect(r).toEqual({ effectiveRole: null, changed: false, gateDenied: false });
        expect(mockMetric).toHaveBeenCalledWith({ outcome: 'no_match' });
    });

    it('returns the mapped role but does not create a membership when none exists', async () => {
        const { db, update } = mockDb({
            mappings: [{ aadGroupId: 'g-1', role: 'EDITOR', priority: 0 }],
            membership: null,
        });
        const r = await syncEntraMembershipRole(base, { db });
        expect(r).toEqual({ effectiveRole: 'EDITOR', changed: false, gateDenied: false });
        expect(update).not.toHaveBeenCalled();
        expect(mockMetric).toHaveBeenCalledWith({ outcome: 'no_membership' });
    });

    it('is a no-op write when the role already matches', async () => {
        const { db, update } = mockDb({
            mappings: [{ aadGroupId: 'g-1', role: 'EDITOR', priority: 0 }],
            membership: { id: 'm1', role: 'EDITOR' },
        });
        const r = await syncEntraMembershipRole(base, { db });
        expect(r.changed).toBe(false);
        expect(update).not.toHaveBeenCalled();
        expect(mockMetric).toHaveBeenCalledWith({ outcome: 'unchanged' });
    });

    it('syncs + audits when the mapped role differs', async () => {
        const { db, update } = mockDb({
            mappings: [{ aadGroupId: 'g-1', role: 'ADMIN', priority: 0 }],
            membership: { id: 'm1', role: 'READER' },
        });
        const r = await syncEntraMembershipRole(base, { db });
        expect(r).toEqual({ effectiveRole: 'ADMIN', changed: true, gateDenied: false });
        expect(update).toHaveBeenCalledWith({ where: { id: 'm1' }, data: { role: 'ADMIN' } });
        expect(mockMetric).toHaveBeenCalledWith({ outcome: 'synced' });
        expect(mockAppend).toHaveBeenCalledTimes(1);
        expect(mockAppend.mock.calls[0][0]).toMatchObject({
            action: 'MEMBER_ROLE_CHANGED',
            detailsJson: expect.objectContaining({ source: 'entra_group_sync' }),
        });
    });

    it('a committed role change survives an audit failure (sign-in not blocked)', async () => {
        mockAppend.mockRejectedValueOnce(new Error('audit down'));
        const { db, update } = mockDb({
            mappings: [{ aadGroupId: 'g-1', role: 'ADMIN', priority: 0 }],
            membership: { id: 'm1', role: 'READER' },
        });
        const r = await syncEntraMembershipRole(base, { db });
        expect(r.changed).toBe(true);
        expect(update).toHaveBeenCalled();
    });
});

describe('applyEntraSyncToToken', () => {
    it('on role sync, updates role + the matching memberships entry', () => {
        const token: any = {
            tenantId: 't1',
            tenantSlug: 'acme',
            role: 'READER',
            memberships: [{ slug: 'acme', role: 'READER', tenantId: 't1' }],
        };
        applyEntraSyncToToken(token, 't1', { effectiveRole: 'ADMIN', changed: true, gateDenied: false });
        expect(token.role).toBe('ADMIN');
        expect(token.memberships[0].role).toBe('ADMIN');
    });

    it('ignores a sync result for a tenant that is not the primary', () => {
        const token: any = { tenantId: 't1', role: 'READER', memberships: [{ slug: 'a', role: 'READER', tenantId: 't1' }] };
        applyEntraSyncToToken(token, 't2', { effectiveRole: 'ADMIN', changed: true, gateDenied: false });
        expect(token.role).toBe('READER');
    });

    it('on gate denial, drops the tenant and falls back to the next membership', () => {
        const token: any = {
            tenantId: 't1',
            tenantSlug: 'acme',
            role: 'EDITOR',
            memberships: [
                { slug: 'acme', role: 'EDITOR', tenantId: 't1' },
                { slug: 'beta', role: 'READER', tenantId: 't2' },
            ],
        };
        applyEntraSyncToToken(token, 't1', { effectiveRole: null, changed: false, gateDenied: true });
        expect(token.error).toBe('EntraGroupGateDenied');
        expect(token.memberships).toHaveLength(1);
        expect(token.tenantId).toBe('t2');
        expect(token.tenantSlug).toBe('beta');
        expect(token.role).toBe('READER');
    });

    it('on gate denial with no other tenant, clears to no-tenant / READER', () => {
        const token: any = {
            tenantId: 't1',
            tenantSlug: 'acme',
            role: 'EDITOR',
            memberships: [{ slug: 'acme', role: 'EDITOR', tenantId: 't1' }],
        };
        applyEntraSyncToToken(token, 't1', { effectiveRole: null, changed: false, gateDenied: true });
        expect(token.error).toBe('EntraGroupGateDenied');
        expect(token.tenantId).toBeNull();
        expect(token.tenantSlug).toBeNull();
        expect(token.role).toBe('READER');
        expect(token.memberships).toHaveLength(0);
    });
});
