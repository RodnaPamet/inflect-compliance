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
    syncEntraMembershipRolesAtSignIn,
    applyEntraSyncToToken,
    type EntraSignInDb,
    type EntraSyncDb,
} from '@/lib/auth/entra-group-sync';
import { SCIM_GROUP_ASSIGNABLE_ROLES } from '@/lib/scim/roles';

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
    membership?: { id: string; role: any; customRoleId?: string | null } | null;
    config?: unknown;
    emailDomains?: string[];
}): { db: EntraSyncDb; update: jest.Mock } {
    const update = jest.fn().mockResolvedValue({});
    const db: EntraSyncDb = {
        tenantIdentityProvider: {
            findFirst: jest.fn().mockResolvedValue(
                over.config === undefined ? null : { configJson: over.config, emailDomains: over.emailDomains ?? [] },
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

/**
 * AI_ADMIN through a group mapping (#3699 deploy 2): written on both paths,
 * never over a custom role, and never by an undecidable tie.
 */
// ── a PREFIX of the membership decides nothing (#5600) ──────────────────

describe('syncEntraMembershipRole — an incomplete group read', () => {
    /**
     * The issue's own scenario: a user over the 200-group overage threshold
     * whose ADMIN-mapped group sits on page 2 and whose EDITOR-mapped group
     * sits on page 1. Graph throttles on page 2, so only `g-editor` was read.
     */
    const PARTIAL_PREFIX = ['g-editor'];
    const MAPPINGS = [
        { aadGroupId: 'g-editor', role: 'EDITOR' as any, priority: 10 },
        { aadGroupId: 'g-admin', role: 'ADMIN' as any, priority: 20 },
    ];

    it('does not demote the member on groups it has not read yet', async () => {
        const { db, update } = mockDb({
            mappings: MAPPINGS,
            membership: { id: 'm1', role: 'ADMIN' },
            config: validConfig,
        });

        const r = await syncEntraMembershipRole(
            { ...base, aadGroups: PARTIAL_PREFIX, aadGroupsComplete: false, signInDirectoryId: GUID, signInEmail: 'p@acme.test' },
            { db },
        );

        // No write, and the membership keeps the role it had.
        expect(update).not.toHaveBeenCalled();
        expect(r).toEqual({ effectiveRole: 'ADMIN', changed: false, gateDenied: false });
        // And nothing is audited as the directory's doing — the demotion used
        // to arrive as `source: 'entra_group_sync'` with the prefix's
        // `matchedGroupIds` offered as its evidence.
        expect(mockAppend).not.toHaveBeenCalled();
        expect(mockMetric).toHaveBeenCalledWith({ outcome: 'partial_group_read' });
    });

    it('POSITIVE CONTROL — the same prefix DOES demote once the read is complete', async () => {
        // Without this, a sync that never wrote anything at all would satisfy
        // the test above. The only difference here is the flag.
        const { db, update } = mockDb({
            mappings: MAPPINGS,
            membership: { id: 'm1', role: 'ADMIN' },
            config: validConfig,
        });

        const r = await syncEntraMembershipRole(
            { ...base, aadGroups: PARTIAL_PREFIX, signInDirectoryId: GUID, signInEmail: 'p@acme.test' },
            { db },
        );

        expect(update).toHaveBeenCalledWith({ where: { id: 'm1' }, data: { role: 'EDITOR' } });
        expect(r.effectiveRole).toBe('EDITOR');
    });

    it('does NOT refuse the workspace when the gate is on and nothing matched', async () => {
        // Owner decision, 2026-11-14: skip the gate decision rather than deny.
        // A Graph outage must not lock a gated workspace's members out for the
        // session — `entraGateDeniedTenantIds` holds until the next sign-in.
        const { db, update } = mockDb({
            mappings: MAPPINGS,
            membership: { id: 'm1', role: 'EDITOR' },
            config: { ...validConfig, enforceGroupGate: true },
        });

        const r = await syncEntraMembershipRole(
            { ...base, aadGroups: [], aadGroupsComplete: false, signInDirectoryId: GUID, signInEmail: 'p@acme.test' },
            { db },
        );

        expect(r.gateDenied).toBe(false);
        expect(update).not.toHaveBeenCalled();
    });

    it('and the gate STILL denies on a complete read that matched nothing', async () => {
        // The control for that one: `partial_group_read` must not have become a
        // way to never deny. Same inputs, complete read.
        const { db } = mockDb({
            mappings: MAPPINGS,
            membership: { id: 'm1', role: 'EDITOR' },
            config: { ...validConfig, enforceGroupGate: true },
        });

        const r = await syncEntraMembershipRole(
            { ...base, aadGroups: [], signInDirectoryId: GUID, signInEmail: 'p@acme.test' },
            { db },
        );

        expect(r.gateDenied).toBe(true);
        expect(mockMetric).toHaveBeenCalledWith({ outcome: 'gate_denied' });
    });

    it('reports a FOREIGN directory rather than the partial read', async () => {
        // Placement: the refusal sits after the checks that do not depend on
        // the group LIST, so a sign-in refused for a more specific reason still
        // says so. Reporting `partial_group_read` here would be alert noise on
        // every overage sign-in into a workspace that does not map it.
        const { db } = mockDb({
            mappings: MAPPINGS,
            membership: { id: 'm1', role: 'EDITOR' },
            config: { ...validConfig, aadTenantId: '99999999-9999-4999-8999-999999999999' },
        });

        await syncEntraMembershipRole(
            { ...base, aadGroupsComplete: false, signInDirectoryId: GUID, signInEmail: 'p@acme.test' },
            { db },
        );

        expect(mockMetric).toHaveBeenCalledWith({ outcome: 'foreign_directory' });
    });

    it('the SCIM path is untouched — its list is complete by construction', async () => {
        // `aadGroupsComplete` defaults to true, so the push path, whose list
        // arrives in the request body, keeps writing exactly as before.
        const { db, update } = mockDb({
            mappings: MAPPINGS,
            membership: { id: 'm1', role: 'READER' },
            config: validConfig,
        });

        await syncEntraMembershipRole(
            { ...base, aadGroups: ['g-editor'], assignableRoles: SCIM_GROUP_ASSIGNABLE_ROLES },
            { db },
        );

        expect(update).toHaveBeenCalledWith({ where: { id: 'm1' }, data: { role: 'EDITOR' } });
    });
});

describe('syncEntraMembershipRole — AI_ADMIN', () => {
    // The real ceiling the SCIM Groups usecase passes (`tests/unit/scim-groups.test.ts`).
    const SCIM_GROUP_CEILING = SCIM_GROUP_ASSIGNABLE_ROLES;

    it.each([
        ['the sign-in path', {}],
        ['the SCIM Groups path', { assignableRoles: SCIM_GROUP_CEILING }],
    ] as const)('%s promotes a READER to AI_ADMIN and audits it', async (_label, extra) => {
        const { db, update } = mockDb({
            mappings: [{ aadGroupId: 'g-1', role: 'AI_ADMIN', priority: 0 }],
            membership: { id: 'm1', role: 'READER', customRoleId: null },
        });
        const r = await syncEntraMembershipRole({ ...base, ...extra }, { db });
        expect(r).toEqual({ effectiveRole: 'AI_ADMIN', changed: true, gateDenied: false });
        expect(update).toHaveBeenCalledWith({ where: { id: 'm1' }, data: { role: 'AI_ADMIN' } });
        expect(mockAppend.mock.calls[0][0]).toMatchObject({
            action: 'MEMBER_ROLE_CHANGED',
            detailsJson: expect.objectContaining({ before: { role: 'READER' }, after: { role: 'AI_ADMIN' } }),
        });
    });

    it('the SCIM Groups path can move a member back OUT of AI_ADMIN when the group changes', async () => {
        const { db, update } = mockDb({
            mappings: [{ aadGroupId: 'g-1', role: 'READER', priority: 0 }],
            membership: { id: 'm1', role: 'AI_ADMIN', customRoleId: null },
        });
        const r = await syncEntraMembershipRole({ ...base, assignableRoles: SCIM_GROUP_CEILING }, { db });
        expect(r.changed).toBe(true);
        expect(update).toHaveBeenCalledWith({ where: { id: 'm1' }, data: { role: 'READER' } });
    });

    it('never writes AI_ADMIN over a custom role — custom_role_held, nothing written', async () => {
        const { db, update } = mockDb({
            mappings: [{ aadGroupId: 'g-1', role: 'AI_ADMIN', priority: 0 }],
            membership: { id: 'm1', role: 'EDITOR', customRoleId: 'cr-1' },
        });
        const r = await syncEntraMembershipRole(base, { db });
        expect(r).toEqual({ effectiveRole: 'EDITOR', changed: false, gateDenied: false });
        expect(update).not.toHaveBeenCalled();
        expect(mockAppend).not.toHaveBeenCalled();
        expect(mockMetric).toHaveBeenCalledWith({ outcome: 'custom_role_held' });
    });

    it('a custom role does not hold back a mapping to a role that may carry one', async () => {
        const { db, update } = mockDb({
            mappings: [{ aadGroupId: 'g-1', role: 'EDITOR', priority: 0 }],
            membership: { id: 'm1', role: 'READER', customRoleId: 'cr-1' },
        });
        await syncEntraMembershipRole(base, { db });
        expect(update).toHaveBeenCalledWith({ where: { id: 'm1' }, data: { role: 'EDITOR' } });
    });

    it('an AI_ADMIN-vs-EDITOR tie at the top priority leaves the membership as it is', async () => {
        const { db, update } = mockDb({
            mappings: [
                { aadGroupId: 'g-1', role: 'AI_ADMIN', priority: 0 },
                { aadGroupId: 'g-2', role: 'EDITOR', priority: 0 },
            ],
            membership: { id: 'm1', role: 'READER', customRoleId: null },
            config: { ...validConfig, enforceGroupGate: true },
        });
        const r = await syncEntraMembershipRole({ ...base, aadGroups: ['g-1', 'g-2'] }, { db });
        // Not gate-denied: the user IS in mapped groups.
        expect(r).toEqual({ effectiveRole: null, changed: false, gateDenied: false });
        expect(update).not.toHaveBeenCalled();
        expect(mockMetric).toHaveBeenCalledWith({ outcome: 'ambiguous_tie' });
    });
});

describe('syncEntraMembershipRole — a sign-in counts only from the configured directory', () => {
    // The deployment's Microsoft app can admit any directory; the mappings are
    // this workspace's own, so only its configured directory (aadTenantId,
    // against the ID token's tid) gets them.
    const reader = { id: 'm1', role: 'READER' as const };
    const toAdmin = [{ aadGroupId: 'g-1', role: 'ADMIN', priority: 0 }];
    const OTHER = '99999999-9999-4999-8999-999999999999';

    it('syncs a sign-in from the configured directory, whatever the GUID case', async () => {
        const { db, update } = mockDb({ mappings: toAdmin, membership: reader, config: validConfig });
        const r = await syncEntraMembershipRole({ ...base, signInDirectoryId: GUID.toUpperCase() }, { db });
        expect(r).toMatchObject({ effectiveRole: 'ADMIN', changed: true });
        expect(update).toHaveBeenCalled();
    });

    it('applies no mapping to a sign-in from another directory, and the gate refuses it', async () => {
        const { db, update } = mockDb({ mappings: toAdmin, membership: reader, config: validConfig });
        const r = await syncEntraMembershipRole({ ...base, signInDirectoryId: OTHER }, { db });
        expect(r).toEqual({ effectiveRole: null, changed: false, gateDenied: true });
        expect(update).not.toHaveBeenCalled();
        expect(mockMetric).toHaveBeenCalledWith({ outcome: 'foreign_directory' });
    });

    it('with the gate off, a sign-in from another directory just keeps its role', async () => {
        const { db, update } = mockDb({
            mappings: toAdmin,
            membership: reader,
            config: { ...validConfig, enforceGroupGate: false },
        });
        const r = await syncEntraMembershipRole({ ...base, signInDirectoryId: OTHER }, { db });
        expect(r).toEqual({ effectiveRole: null, changed: false, gateDenied: false });
        expect(update).not.toHaveBeenCalled();
    });

    it('treats a token with no directory, or a workspace with none configured, as foreign', async () => {
        const noTid = mockDb({ mappings: toAdmin, membership: reader, config: validConfig });
        await syncEntraMembershipRole({ ...base, signInDirectoryId: null }, { db: noTid.db });
        expect(noTid.update).not.toHaveBeenCalled();

        const noConfig = mockDb({ mappings: toAdmin, membership: reader });
        const r = await syncEntraMembershipRole({ ...base, signInDirectoryId: GUID }, { db: noConfig.db });
        expect(r).toEqual({ effectiveRole: null, changed: false, gateDenied: false });
        expect(noConfig.update).not.toHaveBeenCalled();
    });

    it('still never locks out an OWNER, from any directory', async () => {
        const { db } = mockDb({ mappings: toAdmin, membership: { id: 'm1', role: 'OWNER' }, config: validConfig });
        const r = await syncEntraMembershipRole({ ...base, signInDirectoryId: OTHER }, { db });
        expect(r).toEqual({ effectiveRole: 'OWNER', changed: false, gateDenied: false });
    });

    it('leaves the SCIM Groups path, which has no sign-in, as it was', async () => {
        const { db, update } = mockDb({ mappings: [{ aadGroupId: 'g-1', role: 'EDITOR', priority: 0 }], membership: reader, config: validConfig });
        await syncEntraMembershipRole({ ...base, assignableRoles: SCIM_GROUP_ASSIGNABLE_ROLES }, { db });
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

    it('a sync for another workspace changes that workspace only, never the primary role (#4869)', () => {
        const token: any = {
            tenantId: 't1',
            role: 'READER',
            memberships: [
                { slug: 'a', role: 'READER', tenantId: 't1' },
                { slug: 'b', role: 'READER', tenantId: 't2' },
            ],
        };
        applyEntraSyncToToken(token, 't2', { effectiveRole: 'ADMIN', changed: true, gateDenied: false });
        expect(token.role).toBe('READER');
        expect(token.memberships).toEqual([
            { slug: 'a', role: 'READER', tenantId: 't1' },
            { slug: 'b', role: 'ADMIN', tenantId: 't2' },
        ]);
    });

    it('a refusal of another workspace drops it and keeps the primary as it was (#4869)', () => {
        const token: any = {
            tenantId: 't1',
            tenantSlug: 'a',
            role: 'EDITOR',
            memberships: [
                { slug: 'a', role: 'EDITOR', tenantId: 't1' },
                { slug: 'b', role: 'READER', tenantId: 't2' },
                { slug: 'c', role: 'READER', tenantId: 't3' },
            ],
        };
        applyEntraSyncToToken(token, 't3', { effectiveRole: null, changed: false, gateDenied: true });
        expect(token.tenantId).toBe('t1');
        expect(token.tenantSlug).toBe('a');
        expect(token.role).toBe('EDITOR');
        expect(token.memberships.map((m: any) => m.tenantId)).toEqual(['t1', 't2']);
        expect(token.entraGateDeniedTenantIds).toEqual(['t3']);
    });

    it('records every refused workspace once, so the refusal holds for the session', () => {
        const token: any = {
            tenantId: 't1',
            memberships: [
                { slug: 'a', role: 'EDITOR', tenantId: 't1' },
                { slug: 'b', role: 'READER', tenantId: 't2' },
            ],
            entraGateDeniedTenantIds: ['t2'],
        };
        applyEntraSyncToToken(token, 't2', { effectiveRole: null, changed: false, gateDenied: true });
        applyEntraSyncToToken(token, 't1', { effectiveRole: null, changed: false, gateDenied: true });
        expect(token.entraGateDeniedTenantIds).toEqual(['t2', 't1']);
        expect(token.memberships).toEqual([]);
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

describe('syncEntraMembershipRole — the allowed sign-in domains (#4869)', () => {
    // Saved as the provider's emailDomains and, before #4869, read by nothing
    // on the Microsoft path: an admin who filled it in kept nobody out.
    const reader = { id: 'm1', role: 'READER' as const };
    const toAdmin = [{ aadGroupId: 'g-1', role: 'ADMIN', priority: 0 }];
    const fromDirectory = { ...base, signInDirectoryId: GUID };

    it('syncs a sign-in from an allowed domain, whatever its case', async () => {
        const { db, update } = mockDb({ mappings: toAdmin, membership: reader, config: validConfig, emailDomains: ['contoso.com'] });
        const r = await syncEntraMembershipRole({ ...fromDirectory, signInEmail: 'Ana@Contoso.COM' }, { db });
        expect(r).toMatchObject({ effectiveRole: 'ADMIN', changed: true, gateDenied: false });
        expect(update).toHaveBeenCalled();
    });

    it('gives a sign-in from another domain no mapped role, and the gate refuses it', async () => {
        const { db, update } = mockDb({ mappings: toAdmin, membership: reader, config: validConfig, emailDomains: ['contoso.com'] });
        const r = await syncEntraMembershipRole({ ...fromDirectory, signInEmail: 'ana@fabrikam.com' }, { db });
        expect(r).toEqual({ effectiveRole: null, changed: false, gateDenied: true });
        expect(update).not.toHaveBeenCalled();
        expect(mockMetric).toHaveBeenCalledWith({ outcome: 'domain_not_allowed' });
    });

    it('with the gate off, a sign-in from another domain keeps its role and gets no mapped one', async () => {
        const { db, update } = mockDb({
            mappings: toAdmin,
            membership: reader,
            config: { ...validConfig, enforceGroupGate: false },
            emailDomains: ['contoso.com'],
        });
        const r = await syncEntraMembershipRole({ ...fromDirectory, signInEmail: 'ana@fabrikam.com' }, { db });
        expect(r).toEqual({ effectiveRole: null, changed: false, gateDenied: false });
        expect(update).not.toHaveBeenCalled();
    });

    it('does not admit a subdomain the list does not name', async () => {
        const { db } = mockDb({ mappings: toAdmin, membership: reader, config: validConfig, emailDomains: ['contoso.com'] });
        const r = await syncEntraMembershipRole({ ...fromDirectory, signInEmail: 'ana@mail.contoso.com' }, { db });
        expect(r.gateDenied).toBe(true);
    });

    it('refuses a sign-in with no email when there is a list, and admits it when there is none', async () => {
        const listed = mockDb({ mappings: toAdmin, membership: reader, config: validConfig, emailDomains: ['contoso.com'] });
        expect((await syncEntraMembershipRole({ ...fromDirectory, signInEmail: null }, { db: listed.db })).gateDenied).toBe(true);

        const open = mockDb({ mappings: toAdmin, membership: reader, config: validConfig, emailDomains: [] });
        const r = await syncEntraMembershipRole({ ...fromDirectory, signInEmail: null }, { db: open.db });
        expect(r).toMatchObject({ effectiveRole: 'ADMIN', changed: true });
    });

    it('still never locks out an OWNER from a domain not on the list', async () => {
        const { db } = mockDb({ mappings: toAdmin, membership: { id: 'm1', role: 'OWNER' }, config: validConfig, emailDomains: ['contoso.com'] });
        const r = await syncEntraMembershipRole({ ...fromDirectory, signInEmail: 'owner@fabrikam.com' }, { db });
        expect(r).toEqual({ effectiveRole: 'OWNER', changed: false, gateDenied: false });
    });

    it('leaves the SCIM Groups path, which has no sign-in email, as it was', async () => {
        const { db, update } = mockDb({
            mappings: [{ aadGroupId: 'g-1', role: 'EDITOR', priority: 0 }],
            membership: reader,
            config: validConfig,
            emailDomains: ['contoso.com'],
        });
        await syncEntraMembershipRole({ ...base, assignableRoles: SCIM_GROUP_ASSIGNABLE_ROLES }, { db });
        expect(update).toHaveBeenCalled();
    });
});

describe('syncEntraMembershipRolesAtSignIn — every workspace with a provider (#4869)', () => {
    // It used to sync the primary workspace alone, so a member whose oldest
    // membership was elsewhere got no role from this workspace's mappings,
    // and its gate was never asked.
    function signInDb(over: {
        memberships: string[];
        providers: string[];
        configs?: Record<string, unknown>;
        mappings?: Record<string, Array<{ aadGroupId: string; role: any; priority: number }>>;
        throwFor?: string;
    }) {
        const update = jest.fn().mockResolvedValue({});
        const db: EntraSignInDb = {
            tenantMembership: {
                findMany: jest.fn().mockResolvedValue(over.memberships.map((tenantId) => ({ tenantId }))),
                findFirst: jest.fn(async (args: any) => ({ id: `m-${args.where.tenantId}`, role: 'READER' as const })),
                update,
            },
            tenantIdentityProvider: {
                findMany: jest.fn().mockResolvedValue(over.providers.map((tenantId) => ({ tenantId }))),
                findFirst: jest.fn(async (args: any) => ({
                    configJson: over.configs?.[args.where.tenantId] ?? validConfig,
                    emailDomains: [],
                })),
            },
            tenantEntraGroupMapping: {
                findMany: jest.fn(async (args: any) => {
                    if (args.where.tenantId === over.throwFor) throw new Error('db down');
                    return over.mappings?.[args.where.tenantId] ?? [{ aadGroupId: 'g-1', role: 'EDITOR', priority: 0 }];
                }),
            },
        };
        return { db, update };
    }
    const input = { userId: 'u1', aadGroups: ['g-1'], signInDirectoryId: GUID, signInEmail: 'ana@contoso.com' };

    it('asks every workspace the person belongs to that has a provider, and no other', async () => {
        const { db, update } = signInDb({ memberships: ['t1', 't2', 't3'], providers: ['t2', 't3'] });
        const results = await syncEntraMembershipRolesAtSignIn(input, { db });
        expect(results.map((r) => r.tenantId)).toEqual(['t2', 't3']);
        expect(results.every((r) => r.result.effectiveRole === 'EDITOR' && r.result.changed)).toBe(true);
        expect(update).toHaveBeenCalledTimes(2);
        // Only ACTIVE memberships in live workspaces.
        expect((db.tenantMembership.findMany as jest.Mock).mock.calls[0][0].where).toEqual({
            userId: 'u1',
            status: 'ACTIVE',
            tenant: { deletedAt: null },
        });
    });

    it('applies each workspace its own rules: one refuses, the other syncs', async () => {
        const OTHER = '99999999-9999-4999-8999-999999999999';
        const { db } = signInDb({
            memberships: ['t1', 't2'],
            providers: ['t1', 't2'],
            configs: { t2: { ...validConfig, aadTenantId: OTHER } },
        });
        const results = await syncEntraMembershipRolesAtSignIn(input, { db });
        expect(results).toEqual([
            { tenantId: 't1', result: { effectiveRole: 'EDITOR', changed: true, gateDenied: false } },
            { tenantId: 't2', result: { effectiveRole: null, changed: false, gateDenied: true } },
        ]);
    });

    it('skips a workspace whose sync fails and still syncs the rest', async () => {
        const { db } = signInDb({ memberships: ['t1', 't2'], providers: ['t1', 't2'], throwFor: 't1' });
        const results = await syncEntraMembershipRolesAtSignIn(input, { db });
        expect(results.map((r) => r.tenantId)).toEqual(['t2']);
    });

    it('reads no provider for a person with no active membership', async () => {
        const { db } = signInDb({ memberships: [], providers: ['t1'] });
        expect(await syncEntraMembershipRolesAtSignIn(input, { db })).toEqual([]);
        expect(db.tenantIdentityProvider.findMany).not.toHaveBeenCalled();
    });
});
