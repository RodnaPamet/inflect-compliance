/**
 * A manually requested joiner pass acts with its requester's authority only
 * while they still hold it (#4400), against a real database.
 *
 * The joiner twin of `identity-leaver-pass-requester-authority.test.ts`. The
 * "Run now" route asserts `admin.tenant_lifecycle` when the pass is QUEUED,
 * and the pass used to act on that alone: an ADMIN-shaped context in the
 * requester's name, never re-checked. At AUTOMATIC that is a directory account
 * CREATED by a pass whose journal names somebody who may since have been
 * removed, deactivated or demoted.
 *
 * Each case seeds its own tenant at AUTOMATIC with one starter who begins
 * today, a department map and a default group, and runs the REAL pass: real
 * membership resolution, real planner, real create sequence, real journal,
 * real execution row, real audit extension. Only the directory provisioner
 * and writer are fakes, because the alternative is a network call to a
 * customer's tenant.
 */
const fakeCreate = jest.fn(async () => ({ kind: 'applied', externalUserId: 'created-account-1' }));
jest.mock('@/app-layer/integrations/identity-provisioner-factory', () => ({
    resolveDirectoryProvisioner: jest.fn(async () => ({
        kind: 'live',
        provisioner: {
            provider: 'entra-id',
            collisionNamespaces: ['userPrincipalName'],
            probeIdentifier: async () => ({ kind: 'free', namespacesChecked: ['userPrincipalName'] }),
            createBlockedAccount: (...a: unknown[]) => (fakeCreate as (...x: unknown[]) => Promise<unknown>)(...a),
            assignGroup: async () => ({ kind: 'applied' }),
            issueCredential: async () => ({ kind: 'applied' }),
            readAccountState: async () => ({ kind: 'read', priorState: { accountEnabled: false } }),
            enableAccount: async () => ({ kind: 'applied' }),
        },
        close: async () => undefined,
    })),
}));
jest.mock('@/app-layer/integrations/identity-writer-factory', () => ({
    resolveDirectoryWriter: jest.fn(async () => ({
        kind: 'live',
        writer: {
            provider: 'entra-id',
            readState: async () => ({ enabled: true, priorState: { accountEnabled: true } }),
            disable: async () => undefined,
        },
        close: async () => undefined,
        readiness: { readiness: 'WRITE_READY', detail: 'fake writer for the test' },
    })),
}));

import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { runIdentityJoinerPass } from '@/app-layer/usecases/identity-joiner-run';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';

const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DB_URL }),
    transactionOptions: TENANT_TX_OPTIONS,
});
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const TAG = randomUUID().slice(0, 8);
const tenants: string[] = [];
const users: string[] = [];
/** The four journalled steps of one successful create. */
const CREATE_STEPS = ['ASSIGN_GROUP', 'CREATE_ACCOUNT', 'ENABLE_ACCOUNT', 'ISSUE_CREDENTIAL'];

async function mkUser(label: string): Promise<string> {
    const email = `${label}-${TAG}@example.test`;
    const u = await db.user.create({ data: { email, emailHash: hashForLookup(email) } });
    users.push(u.id);
    return u.id;
}

/**
 * One tenant at AUTOMATIC with exactly one starter the planner will PLAN, and
 * the requester's membership as the case needs it (`null`: no row at all).
 */
async function seedTenant(
    label: string,
    requester: { role: Role; status: MembershipStatus } | null,
    now: Date,
): Promise<{ tenantId: string; requesterId: string }> {
    const tenantId = `t-joiner-auth-${label}-${TAG}`;
    tenants.push(tenantId);
    await db.tenant.create({ data: { id: tenantId, name: tenantId, slug: tenantId } });
    await db.tenantSecuritySettings.create({
        data: {
            tenantId,
            identityJoinerMode: 'AUTOMATIC',
            identityDefaultGroupId: 'grp-default',
            identityDefaultGroupName: 'All staff',
        },
    });
    await db.identityDepartmentGroupRule.create({
        data: { tenantId, department: 'Engineering', groupId: 'grp-eng', groupName: 'Engineering' },
    });

    const requesterId = await mkUser(`requester-${label}`);
    if (requester) {
        await db.tenantMembership.create({
            data: { tenantId, userId: requesterId, role: requester.role, status: requester.status },
        });
    }

    await db.employee.create({
        data: {
            tenantId,
            fullName: 'Jane Smith',
            // The address the planner derives from the name, so the identity
            // does not diverge from the roster.
            workEmail: `jane.smith@acme-${TAG}.test`,
            source: 'workday',
            externalId: `WD-${label}`,
            department: 'Engineering',
            status: 'ONBOARDING',
            startDate: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())),
        },
    });
    return { tenantId, requesterId };
}

async function artefactsOf(tenantId: string) {
    const rows = await db.integrationExecution.findMany({ where: { tenantId } });
    const journal = await db.identityWriteJournal.findMany({ where: { tenantId } });
    const audit = await db.auditLog.findMany({ where: { tenantId }, select: { userId: true } });
    expect(rows).toHaveLength(1);
    // The pass reached the directory: every step of one create, journalled.
    // Sorted here: Postgres orders an enum by declaration, not by name.
    expect(journal.map((j) => String(j.action)).sort()).toEqual(CREATE_STEPS);
    expect(journal.every((j) => j.outcome === 'APPLIED')).toBe(true);
    return { row: rows[0], journal, audit };
}

describeFn("a requested joiner pass carries its requester's authority only while they hold it (#4400)", () => {
    afterAll(async () => {
        await deleteAuditRowsForTenants(db, tenants);
        for (const t of [
            'IdentityWriteJournal',
            'IntegrationExecution',
            'IdentityDepartmentGroupRule',
            'Employee',
            'TenantSecuritySettings',
            'TenantMembership',
        ]) {
            await db.$executeRawUnsafe(`DELETE FROM "${t}" WHERE "tenantId" = ANY($1)`, tenants).catch(() => {});
        }
        await db.$executeRawUnsafe(`DELETE FROM "Tenant" WHERE id = ANY($1)`, tenants).catch(() => {});
        await db.$executeRawUnsafe(`DELETE FROM "User" WHERE id = ANY($1)`, users).catch(() => {});
        await db.$disconnect();
    });

    beforeEach(() => fakeCreate.mockClear());

    it('an OWNER who still holds the key: the pass acts as them, and says so', async () => {
        const now = new Date();
        const { tenantId, requesterId } = await seedTenant(
            'owner',
            { role: Role.OWNER, status: MembershipStatus.ACTIVE },
            now,
        );

        const r = await runIdentityJoinerPass({ tenantId, provider: 'entra-id', requestedByUserId: requesterId, now });

        expect(r.status).toBe('PASSED');
        expect(fakeCreate).toHaveBeenCalledTimes(1);
        const { row, journal, audit } = await artefactsOf(tenantId);
        expect(row.triggeredBy).toBe('manual');
        expect((row.resultJson as Record<string, unknown>).request).toEqual({
            requestedByUserId: requesterId,
            authority: 'REQUESTER',
        });
        // A non-null actor on the journal means a human: here it is them.
        expect(journal.every((j) => j.actorUserId === requesterId)).toBe(true);
        // The positive control for the refusal cases below.
        expect(audit.some((a) => a.userId === requesterId)).toBe(true);
    });

    it.each([
        ['removed from the tenant', null, { refusal: 'REQUESTER_NOT_A_MEMBER' }],
        [
            'deactivated',
            { role: Role.OWNER, status: MembershipStatus.DEACTIVATED },
            { refusal: 'REQUESTER_NOT_ACTIVE', membershipStatus: 'DEACTIVATED' },
        ],
        [
            'demoted to ADMIN, which lacks the key',
            { role: Role.ADMIN, status: MembershipStatus.ACTIVE },
            { refusal: 'REQUESTER_LACKS_PERMISSION' },
        ],
    ] as const)('a requester %s since: the pass still runs, names nobody, and records why', async (_l, membership, refusal) => {
        const now = new Date();
        const label = refusal.refusal.toLowerCase().replace(/_/g, '-');
        const { tenantId, requesterId } = await seedTenant(label, membership, now);

        const r = await runIdentityJoinerPass({ tenantId, provider: 'entra-id', requestedByUserId: requesterId, now });

        // It RAN, as the 04:30 pass would have.
        expect(r.status).toBe('PASSED');
        expect(fakeCreate).toHaveBeenCalledTimes(1);

        const { row, journal, audit } = await artefactsOf(tenantId);
        // Nothing the pass wrote as an actor names them: the journal carries
        // what the scheduled pass's carries, and no audit row is theirs.
        expect(journal.every((j) => j.actorUserId === 'system')).toBe(true);
        expect(audit.length).toBeGreaterThan(0);
        expect(audit.filter((a) => a.userId === requesterId)).toEqual([]);
        // The row says a person asked, who, and why it was not their authority.
        expect(row.triggeredBy).toBe('manual');
        expect((row.resultJson as Record<string, unknown>).request).toEqual({
            requestedByUserId: requesterId,
            authority: 'JOB',
            ...refusal,
        });
    });

    it('the scheduled pass is unchanged', async () => {
        const now = new Date();
        const { tenantId } = await seedTenant('scheduled', { role: Role.OWNER, status: MembershipStatus.ACTIVE }, now);

        const r = await runIdentityJoinerPass({ tenantId, provider: 'entra-id', now });

        expect(r.status).toBe('PASSED');
        const { row, journal } = await artefactsOf(tenantId);
        expect(row.triggeredBy).toBe('scheduled');
        expect(row.resultJson as Record<string, unknown>).not.toHaveProperty('request');
        expect(journal.every((j) => j.actorUserId === 'system')).toBe(true);
    });
});
