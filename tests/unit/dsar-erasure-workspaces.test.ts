/**
 * Which workspaces a DSAR erasure covers (#5802): the pure decision over each
 * membership writer's audit shape, and the bounded, paged read.
 *
 * Every shape below is the one its writer emits today (the writer is named on
 * each case); the DB-backed `tests/integration/dsar-erase-command.test.ts`
 * drives the real SCIM writer and the real member removal end to end.
 */
import {
    ErasureWorkspaceDiscoveryTruncatedError,
    MEMBERSHIP_WRITERS_WITHOUT_A_SUBJECT_ROW,
    TARGET_RECORD_ACTIONS,
    erasureWorkspacesFrom,
    readErasureWorkspaces,
    type AuditEvidenceRow,
    type OrgFanoutEvidenceRow,
} from '@/app-layer/jobs/dsar-erasure-workspaces';

const S = 'cuid-subject';
const OTHER = 'cuid-other-person';
const ADMIN = 'cuid-org-admin';

const audit = (row: Partial<AuditEvidenceRow> & { tenantId: string; action: string }): AuditEvidenceRow => ({
    userId: null,
    entity: 'TenantMembership',
    entityId: null,
    ...row,
});
const decide = (rows: AuditEvidenceRow[], org: OrgFanoutEvidenceRow[] = []) =>
    erasureWorkspacesFrom(S, { audit: rows, orgFanout: org });

describe('erasureWorkspacesFrom — each membership writer\'s audit shape', () => {
    it('invite redemption (tenant-invites.ts, both paths): MEMBER_INVITE_ACCEPTED, the subject as actor, the membership id as entity', () => {
        const out = decide([audit({ tenantId: 't-inv', userId: S, entityId: 'membership-id', action: 'MEMBER_INVITE_ACCEPTED' })]);
        expect(out.workspaces).toEqual([{ tenantId: 't-inv', kinds: ['OWN_ACTION'], rows: 1 }]);
    });

    it('platform-admin tenant creation (tenant-lifecycle.ts): TENANT_MEMBERSHIP_GRANTED names the owner as actor AND as entity, counted once', () => {
        const out = decide([
            audit({ tenantId: 't-new', userId: S, entityId: S, action: 'TENANT_MEMBERSHIP_GRANTED' }),
            audit({ tenantId: 't-new', userId: S, entity: 'Tenant', entityId: 't-new', action: 'TENANT_CREATED' }),
        ]);
        expect(out.workspaces).toEqual([{ tenantId: 't-new', kinds: ['MEMBERSHIP_RECORD', 'OWN_ACTION'], rows: 2 }]);
    });

    it.each(['SCIM_USER_CREATED', 'SCIM_USER_REACTIVATED', 'SCIM_USER_UPDATED', 'SCIM_USER_DEACTIVATED'])(
        'SCIM (scim-users.ts): %s — actor SCIM with no user, the subject as entity — finds a workspace the subject never acted in',
        (action) => {
            const out = decide([audit({ tenantId: 't-scim', entityId: S, action, rows: 2 })]);
            expect(out.tenantIds).toEqual(['t-scim']);
            expect(out.workspaces[0]).toEqual({ tenantId: 't-scim', kinds: ['MEMBERSHIP_RECORD'], rows: 2 });
        },
    );

    it.each(['ORG_ADMIN_PROVISIONED', 'ORG_ADMIN_DEPROVISIONED'])(
        'org provisioning (org-members.ts via org-provisioning.ts): %s — another person as actor, the subject as entity',
        (action) => {
            const out = decide([audit({ tenantId: 't-org', userId: ADMIN, entityId: S, action })]);
            expect(out.workspaces).toEqual([{ tenantId: 't-org', kinds: ['MEMBERSHIP_RECORD'], rows: 1 }]);
        },
    );

    it('Entra role sync (entra-group-sync.ts): MEMBER_ROLE_CHANGED carries the member as actor', () => {
        const out = decide([audit({ tenantId: 't-entra', userId: S, entityId: 'membership-id', action: 'MEMBER_ROLE_CHANGED' })]);
        expect(out.tenantIds).toEqual(['t-entra']);
    });

    it.each(['ORG_ADMIN_PROVISIONED_TO_TENANTS', 'ORG_ADMIN_DEPROVISIONED_FROM_TENANTS'])(
        'org fan-out in the org trail (org-members.ts, org-invites.ts): %s lists its tenants in detailsJson',
        (action) => {
            const out = decide([], [{ id: 'o1', targetUserId: S, action, detailsJson: { tenantIds: ['t-2', 't-1'], role: 'ADMIN' } }]);
            expect(out.workspaces).toEqual([
                { tenantId: 't-1', kinds: ['ORG_TENANT_FANOUT'], rows: 1 },
                { tenantId: 't-2', kinds: ['ORG_TENANT_FANOUT'], rows: 1 },
            ]);
        },
    );

    it('any own row counts, whatever its entity — today\'s rule is kept', () => {
        const out = decide([audit({ tenantId: 't-own', userId: S, entity: 'Risk', entityId: 'risk-1', action: 'RISK_CREATED', rows: 7 })]);
        expect(out.workspaces).toEqual([{ tenantId: 't-own', kinds: ['OWN_ACTION'], rows: 7 }]);
    });

    it('merges several kinds of evidence for one tenant and sorts the tenants', () => {
        const out = decide(
            [
                audit({ tenantId: 't-b', userId: S, entity: 'Risk', entityId: 'r', action: 'RISK_CREATED' }),
                audit({ tenantId: 't-b', entityId: S, action: 'SCIM_USER_UPDATED' }),
                audit({ tenantId: 't-a', entityId: S, action: 'SCIM_USER_CREATED' }),
            ],
            [{ id: 'o1', targetUserId: S, action: 'ORG_ADMIN_PROVISIONED_TO_TENANTS', detailsJson: { tenantIds: ['t-b'] } }],
        );
        expect(out.tenantIds).toEqual(['t-a', 't-b']);
        expect(out.workspaces[1]).toEqual({ tenantId: 't-b', kinds: ['MEMBERSHIP_RECORD', 'ORG_TENANT_FANOUT', 'OWN_ACTION'], rows: 3 });
    });
});

describe('erasureWorkspacesFrom — a removal names the person (#5940)', () => {
    it.each(Object.keys(TARGET_RECORD_ACTIONS))('%s with detailsJson.targetUserId = the subject puts its tenant in the plan', (action) => {
        const out = decide([audit({ tenantId: 't-removed', userId: ADMIN, entityId: 'membership-id', action, targetUserId: S })]);
        expect(out.tenantIds).toEqual(['t-removed']);
        expect(out.workspaces).toEqual([{ tenantId: 't-removed', kinds: ['TARGET_RECORD'], rows: 1 }]);
        expect(out.undecided).toEqual([]);
    });

    it('lists the removal and deactivation writers by their actions', () => {
        expect(Object.keys(TARGET_RECORD_ACTIONS).sort()).toEqual([
            'ACCESS_REVIEW_DECISION_EXECUTED',
            'MEMBER_DEACTIVATED',
            'MEMBER_REMOVED',
            'ORG_ADMIN_DEPROVISIONED',
            'SCIM_USER_DEACTIVATED',
        ]);
    });

    it('a row that is both a membership record and a removal counts its rows once', () => {
        const out = decide([audit({ tenantId: 't-scim', entityId: S, action: 'SCIM_USER_DEACTIVATED', targetUserId: S, rows: 2 })]);
        expect(out.workspaces).toEqual([{ tenantId: 't-scim', kinds: ['MEMBERSHIP_RECORD', 'TARGET_RECORD'], rows: 2 }]);
    });

    it('the key under an unlisted action is ignored, not undecided: it is the actor convention on rows about no membership', () => {
        const out = decide([audit({ tenantId: 't-dsar', userId: ADMIN, entity: 'DataSubjectRequest', entityId: 'req-1', action: 'DSAR_VERIFIED', targetUserId: S })]);
        expect(out.tenantIds).toEqual([]);
        expect(out.undecided).toEqual([]);
    });

    it('a removal naming another person is not the subject\'s', () => {
        const out = decide([audit({ tenantId: 't-x', userId: ADMIN, entityId: 'membership-id', action: 'MEMBER_REMOVED', targetUserId: OTHER })]);
        expect(out.tenantIds).toEqual([]);
    });
});

describe('erasureWorkspacesFrom — what it does not count', () => {
    it('ignores rows that do not name the subject: another person\'s SCIM row, a removal written before #5940 (membership id only)', () => {
        const out = decide([
            audit({ tenantId: 't-x', entityId: OTHER, action: 'SCIM_USER_CREATED' }),
            audit({ tenantId: 't-y', userId: ADMIN, entityId: 'membership-id', action: 'MEMBER_REMOVED' }),
            audit({ tenantId: 't-z', userId: OTHER, entity: 'Risk', entityId: S, action: 'RISK_CREATED' }),
        ]);
        expect(out.tenantIds).toEqual([]);
        expect(out.undecided).toEqual([]);
    });

    it('holds back, and reports, a membership record under an action it does not list', () => {
        const out = decide([audit({ tenantId: 't-new-writer', entityId: S, action: 'SOME_FUTURE_MEMBERSHIP_GRANT' })]);
        expect(out.tenantIds).toEqual([]);
        expect(out.undecided).toEqual([
            { trail: 'AuditLog', tenantId: 't-new-writer', action: 'SOME_FUTURE_MEMBERSHIP_GRANT', reason: 'UNLISTED_MEMBERSHIP_ACTION', rows: 1 },
        ]);
    });

    it('an unlisted action on the subject\'s OWN row is not undecided: the own row already counts', () => {
        const out = decide([audit({ tenantId: 't-own', userId: S, entityId: S, action: 'SOME_FUTURE_ACTION' })]);
        expect(out.tenantIds).toEqual(['t-own']);
        expect(out.undecided).toEqual([]);
    });

    it.each([
        ['no tenantIds', { role: 'ADMIN' }],
        ['an empty list', { tenantIds: [] }],
        ['a non-string id', { tenantIds: ['t-1', 7] }],
        ['an empty id', { tenantIds: [''] }],
        ['not an object', 'tenantIds'],
        ['null', null],
    ])('a fan-out row with %s is undecided, never guessed', (_label, detailsJson) => {
        const out = decide([], [{ id: 'o1', targetUserId: S, action: 'ORG_ADMIN_PROVISIONED_TO_TENANTS', detailsJson }]);
        expect(out.tenantIds).toEqual([]);
        expect(out.undecided).toEqual([
            { trail: 'OrgAuditLog', tenantId: null, action: 'ORG_ADMIN_PROVISIONED_TO_TENANTS', reason: 'FANOUT_TENANTS_UNREADABLE', rows: 1 },
        ]);
    });

    it('ignores org rows for another target and org actions that are not a tenant fan-out', () => {
        const out = decide([], [
            { id: 'o1', targetUserId: OTHER, action: 'ORG_ADMIN_PROVISIONED_TO_TENANTS', detailsJson: { tenantIds: ['t-1'] } },
            { id: 'o2', targetUserId: S, action: 'ORG_MEMBER_ADDED', detailsJson: { tenantIds: ['t-2'] } },
        ]);
        expect(out.tenantIds).toEqual([]);
    });

    it('always reports the writers no read of the audit trail can see', () => {
        expect(decide([]).writersWithoutASubjectRow).toBe(MEMBERSHIP_WRITERS_WITHOUT_A_SUBJECT_ROW);
        expect(MEMBERSHIP_WRITERS_WITHOUT_A_SUBJECT_ROW.length).toBeGreaterThan(0);
    });

    it('refuses an empty subject id', () => {
        expect(() => erasureWorkspacesFrom('', { audit: [], orgFanout: [] })).toThrow(/subject id/);
    });
});

describe('readErasureWorkspaces — bounded and paged', () => {
    /** A fake that serves `auditRows` grouped rows and no org rows, recording each page. */
    function fakeDb(auditRows: number) {
        const pages: Array<{ trail: string; values: unknown[] }> = [];
        const rows = Array.from({ length: auditRows }, (_, i) => audit({ tenantId: `t-${String(i).padStart(3, '0')}`, entityId: S, action: 'SCIM_USER_CREATED' }));
        return {
            pages,
            db: {
                async $queryRawUnsafe<T>(sql: string, ...values: unknown[]): Promise<T> {
                    const trail = sql.includes('FROM "OrgAuditLog"') ? 'OrgAuditLog' : 'AuditLog';
                    pages.push({ trail, values });
                    if (trail === 'OrgAuditLog') return [] as T;
                    const [limit, offset] = values.slice(1, 3) as [number, number];
                    return rows.slice(offset, offset + limit) as T;
                },
            },
        };
    }

    it('reads page by page until a short page, passing the subject as a parameter, never in the SQL', async () => {
        const { db, pages } = fakeDb(5);
        const out = await readErasureWorkspaces(db, S, { pageSize: 2, maxPages: 10 });
        expect(out.tenantIds).toHaveLength(5);
        const actions = Object.keys(TARGET_RECORD_ACTIONS);
        expect(pages.filter((p) => p.trail === 'AuditLog').map((p) => p.values)).toEqual([
            [S, 2, 0, actions],
            [S, 2, 2, actions],
            [S, 2, 4, actions],
        ]);
        expect(pages.every((p) => p.values[0] === S)).toBe(true);
    });

    it('a set of exactly the bound is read whole: one row past it is asked for, and absent', async () => {
        const { db } = fakeDb(4);
        const out = await readErasureWorkspaces(db, S, { pageSize: 2, maxPages: 2 });
        expect(out.tenantIds).toHaveLength(4);
    });

    it('refuses, never truncates, a set larger than the bound', async () => {
        const { db } = fakeDb(5);
        await expect(readErasureWorkspaces(db, S, { pageSize: 2, maxPages: 2 })).rejects.toBeInstanceOf(
            ErasureWorkspaceDiscoveryTruncatedError,
        );
    });
});
