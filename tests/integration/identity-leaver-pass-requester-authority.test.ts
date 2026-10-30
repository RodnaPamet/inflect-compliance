/**
 * A manually requested leaver pass acts with its requester's authority only
 * while they still hold it (#4400), against a real database.
 *
 * The "Run now" route asserts `admin.tenant_lifecycle` when the pass is
 * QUEUED. The pass used to act on that alone: an ADMIN-shaped context in the
 * requester's name, never re-checked. So a pass queued by somebody since
 * removed, deactivated or demoted still disabled a directory account, and the
 * journal named them as the actor.
 *
 * Each case seeds its own tenant at AUTOMATIC with one terminated worker, one
 * fresh link and one cloud-only account, and runs the REAL pass: real
 * membership resolution, real ladder read, real breaker, real journal, real
 * execution row, real audit extension. Only the directory writer is a fake,
 * because the alternative is a network call to a customer's tenant.
 *
 * What the database must show:
 *   - a requester who still holds the key: the journal row and the audit trail
 *     name them, and the execution row says the pass carried their authority;
 *   - a requester removed, deactivated or demoted: the pass STILL disabled the
 *     account (refusing would leave a departed employee enabled), the journal
 *     and the audit trail do not name them, and the execution row records
 *     their request and why their authority was refused;
 *   - the scheduled pass: unchanged.
 */
const fakeDisable = jest.fn(async () => undefined);
jest.mock('@/app-layer/integrations/identity-writer-factory', () => ({
    resolveDirectoryWriter: jest.fn(async () => ({
        kind: 'live',
        writer: {
            provider: 'entra-id',
            selfAccountIds: [],
            readState: async () => ({ enabled: true, priorState: { accountEnabled: true } }),
            disable: (...a: unknown[]) => (fakeDisable as (...x: unknown[]) => Promise<undefined>)(...a),
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
import { runIdentityLeaverPass } from '@/app-layer/usecases/identity-leaver-pass';
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

async function mkUser(label: string): Promise<string> {
    const email = `${label}-${TAG}@example.test`;
    const u = await db.user.create({ data: { email, emailHash: hashForLookup(email) } });
    users.push(u.id);
    return u.id;
}

/**
 * One tenant at AUTOMATIC with exactly one actionable leaver, and the
 * requester's membership as the case needs it (`null`: no row at all).
 */
async function seedTenant(
    label: string,
    requester: { role: Role; status: MembershipStatus } | null,
): Promise<{ tenantId: string; requesterId: string }> {
    const tenantId = `t-leaver-auth-${label}-${TAG}`;
    tenants.push(tenantId);
    await db.tenant.create({ data: { id: tenantId, name: tenantId, slug: tenantId } });
    await db.tenantSecuritySettings.create({ data: { tenantId, identityLeaverMode: 'AUTOMATIC' } });

    const requesterId = await mkUser(`requester-${label}`);
    if (requester) {
        await db.tenantMembership.create({
            data: { tenantId, userId: requesterId, role: requester.role, status: requester.status },
        });
    }

    const conn = await db.integrationConnection.create({
        data: { tenantId, provider: 'entra-id', name: `entra-${label}`, configJson: {} },
    });
    const employee = await db.employee.create({
        data: { tenantId, fullName: 'Departed Worker', workEmail: `leaver-${label}-${TAG}@acme.test`, status: 'TERMINATED' },
    });
    const account = await db.connectedIdentityAccount.create({
        data: {
            tenantId,
            provider: 'entra-id',
            connectionId: conn.id,
            externalUserId: `ext-${label}-${TAG}`,
            email: employee.workEmail,
            syncedAt: new Date(),
            // Cloud-only, and observed so: the write-target rail allows it.
            onPremisesSyncEnabled: false,
            onPremStateObservedAt: new Date(),
        },
    });
    await db.identityAccountLink.create({
        data: {
            tenantId,
            employeeId: employee.id,
            connectedAccountId: account.id,
            matchMethod: 'EMAIL_EXACT',
            lastVerifiedAt: new Date(),
        },
    });
    return { tenantId, requesterId };
}

async function artefactsOf(tenantId: string) {
    const rows = await db.integrationExecution.findMany({ where: { tenantId } });
    const journal = await db.identityWriteJournal.findMany({ where: { tenantId } });
    const audit = await db.auditLog.findMany({ where: { tenantId }, select: { userId: true, entity: true } });
    expect(rows).toHaveLength(1);
    expect(journal).toHaveLength(1);
    return { row: rows[0], journal: journal[0], audit };
}

describeFn('a requested leaver pass carries its requester\'s authority only while they hold it (#4400)', () => {
    afterAll(async () => {
        await deleteAuditRowsForTenants(db, tenants);
        for (const t of [
            'NotificationOutbox',
            'Notification',
            'IdentityWriteJournal',
            'IntegrationExecution',
            'IdentityAccountLink',
            'ConnectedIdentityAccount',
            'IntegrationConnection',
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

    beforeEach(() => fakeDisable.mockClear());

    it('an OWNER who still holds the key: the pass acts as them, and says so', async () => {
        const { tenantId, requesterId } = await seedTenant('owner', {
            role: Role.OWNER,
            status: MembershipStatus.ACTIVE,
        });

        const r = await runIdentityLeaverPass({ tenantId, provider: 'entra-id', requestedByUserId: requesterId });

        expect(r.status).toBe('PASSED');
        expect(r.counts).toEqual({ DISABLED: 1 });
        expect(fakeDisable).toHaveBeenCalledTimes(1);
        const { row, journal, audit } = await artefactsOf(tenantId);
        expect(row.triggeredBy).toBe('manual');
        expect((row.resultJson as Record<string, unknown>).request).toEqual({
            requestedByUserId: requesterId,
            authority: 'REQUESTER',
        });
        // A non-null actor on the journal means a human: here it is them.
        expect(journal.outcome).toBe('APPLIED');
        expect(journal.actorUserId).toBe(requesterId);
        // The positive control for the refusal cases below: the audit
        // extension names the acting user on the rows the pass wrote.
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
        const label = refusal.refusal.toLowerCase().replace(/_/g, '-');
        const { tenantId, requesterId } = await seedTenant(label, membership);

        const r = await runIdentityLeaverPass({ tenantId, provider: 'entra-id', requestedByUserId: requesterId });

        // It RAN. Refusing would have left a departed employee's account enabled.
        expect(r.status).toBe('PASSED');
        expect(r.counts).toEqual({ DISABLED: 1 });
        expect(fakeDisable).toHaveBeenCalledTimes(1);

        const { row, journal, audit } = await artefactsOf(tenantId);
        // Nothing the pass wrote as an actor names them: the journal carries
        // what the scheduled pass's carries, and no audit row is theirs.
        expect(journal.outcome).toBe('APPLIED');
        expect(journal.actorUserId).not.toBe(requesterId);
        expect(journal.actorUserId).toBe('system');
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
        const { tenantId } = await seedTenant('scheduled', {
            role: Role.OWNER,
            status: MembershipStatus.ACTIVE,
        });

        const r = await runIdentityLeaverPass({ tenantId, provider: 'entra-id' });

        expect(r.status).toBe('PASSED');
        expect(r.counts).toEqual({ DISABLED: 1 });
        const { row, journal } = await artefactsOf(tenantId);
        expect(row.triggeredBy).toBe('scheduled');
        expect(row.resultJson as Record<string, unknown>).not.toHaveProperty('request');
        expect(journal.actorUserId).toBe('system');
    });
});
