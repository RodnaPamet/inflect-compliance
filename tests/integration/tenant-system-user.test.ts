/**
 * The per-tenant SYSTEM user (#4400), against a real database.
 *
 * A background job that must write a row with a NOT NULL foreign key to
 * `User` writes it as `sys_<tenantId>` instead of borrowing a member. That
 * row is a foreign-key target and nothing else, and these tests hold the
 * three things that make it safe to have:
 *
 *   1. its shape: a `system:` hash no lookup by email can compute, and no
 *      password, ever;
 *   2. it can hold no sign-in, membership, credential or session, refused by
 *      the database in every table that would grant one;
 *   3. the first caller, the policy review reminder, now writes its task as
 *      that user, still assigns the owner, and touches no other tenant.
 *
 * Setup and assertions use a raw client; the code under test runs through
 * the app's own client (with the PII middleware) and the real job.
 */
import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import appPrisma from '@/lib/prisma';
import { ensureTenantSystemUser } from '@/app-layer/context-system';
import { processOverdueReminders } from '@/app-layer/jobs/policyReviewReminder';
import {
    isTenantSystemUserId,
    tenantSystemUserEmail,
    tenantSystemUserEmailHash,
    tenantSystemUserId,
} from '@/lib/tenant-system-user';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';

const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DB_URL }),
    transactionOptions: TENANT_TX_OPTIONS,
});
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const TAG = randomUUID().slice(0, 8);
const TENANT_A = `t-sysuser-a-${TAG}`;
const TENANT_B = `t-sysuser-b-${TAG}`;
const SYS_A = tenantSystemUserId(TENANT_A);

/** Postgres's check_violation, however the driver wraps it. */
async function expectCheckViolation(op: Promise<unknown>, constraint: string): Promise<void> {
    const err = await op.then(() => null, (e: unknown) => e);
    expect(err).not.toBeNull();
    expect(String((err as Error).message)).toContain(constraint);
}

let ownerA: string;
let ownerB: string;

describeFn('the tenant SYSTEM user (#4400)', () => {
    beforeAll(async () => {
        for (const id of [TENANT_A, TENANT_B]) {
            await db.tenant.create({ data: { id, name: id, slug: id } });
        }
        const mkUser = async (label: string, tenantId: string) => {
            const email = `${label}-${TAG}@example.test`;
            const u = await db.user.create({ data: { email, emailHash: hashForLookup(email) } });
            // A READER owner: the reminder used to write its task under this
            // person's name with an ADMIN-shaped context.
            await db.tenantMembership.create({
                data: { tenantId, userId: u.id, role: Role.READER, status: MembershipStatus.ACTIVE },
            });
            return u.id;
        };
        ownerA = await mkUser('owner-a', TENANT_A);
        ownerB = await mkUser('owner-b', TENANT_B);
    });

    afterAll(async () => {
        await deleteAuditRowsForTenants(db, [TENANT_A, TENANT_B]);
        for (const t of ['AutomationExecution', 'NotificationOutbox', 'Notification', 'TaskLink', 'Task', 'TaskKeySequence', 'Policy', 'TenantMembership']) {
            await db.$executeRawUnsafe(`DELETE FROM "${t}" WHERE "tenantId" IN ($1, $2)`, TENANT_A, TENANT_B).catch(() => {});
        }
        await db.$executeRawUnsafe(`DELETE FROM "Tenant" WHERE id IN ($1, $2)`, TENANT_A, TENANT_B).catch(() => {});
        await db.$executeRawUnsafe(
            `DELETE FROM "User" WHERE id IN ($1, $2, $3, $4)`,
            ownerA, ownerB, SYS_A, tenantSystemUserId(TENANT_B),
        ).catch(() => {});
        await db.$disconnect();
    });

    describe('its shape', () => {
        it('is created once, with the reserved id and hash and no password', async () => {
            expect(await ensureTenantSystemUser(TENANT_A)).toBe(SYS_A);
            expect(await ensureTenantSystemUser(TENANT_A)).toBe(SYS_A);

            const rows = await db.user.findMany({ where: { id: SYS_A } });
            expect(rows).toHaveLength(1);
            expect(rows[0].emailHash).toBe(tenantSystemUserEmailHash(TENANT_A));
            expect(rows[0].passwordHash).toBeNull();
            // Set, so no verify-email path ever offers to mail it.
            expect(rows[0].emailVerified).not.toBeNull();
        });

        it('no lookup by email reaches it', async () => {
            await ensureTenantSystemUser(TENANT_A);
            const byEmail = await appPrisma.user.findUnique({
                where: { emailHash: hashForLookup(tenantSystemUserEmail(TENANT_A)) },
            });
            expect(byEmail).toBeNull();
        });

        it('cannot be given a password', async () => {
            await ensureTenantSystemUser(TENANT_A);
            await expectCheckViolation(
                db.$executeRawUnsafe(`UPDATE "User" SET "passwordHash" = 'x' WHERE id = $1`, SYS_A),
                'User_system_row_shape',
            );
        });

        it('cannot be repointed at a real address: the rewrite re-hashes it', async () => {
            await ensureTenantSystemUser(TENANT_A);
            await expectCheckViolation(
                appPrisma.user.update({ where: { id: SYS_A }, data: { email: `taken-${TAG}@example.test` } }),
                'User_system_row_shape',
            );
        });

        it('no person can take the reserved namespace', async () => {
            const email = `squatter-${TAG}@example.test`;
            await expectCheckViolation(
                db.user.create({ data: { id: `sys_${TAG}`, email, emailHash: hashForLookup(email) } }),
                'User_system_row_shape',
            );
            await expectCheckViolation(
                db.user.create({ data: { email, emailHash: `system:${TAG}` } }),
                'User_system_row_shape',
            );
        });
    });

    describe('it can hold no sign-in, membership, credential or session', () => {
        // Every table a session or a context needs a row in. One CHECK each.
        const GUARDED: ReadonlyArray<readonly [table: string, constraint: string]> = [
            ['Account', 'Account_not_system_user'],
            ['UserIdentityLink', 'UserIdentityLink_not_system_user'],
            ['TenantMembership', 'TenantMembership_not_system_user'],
            ['OrgMembership', 'OrgMembership_not_system_user'],
            ['PasswordResetToken', 'PasswordResetToken_not_system_user'],
            ['UserMfaEnrollment', 'UserMfaEnrollment_not_system_user'],
            ['UserSession', 'UserSession_not_system_user'],
            ['Session', 'Session_not_system_user'],
            ['TenantApiKey', 'TenantApiKey_not_system_user'],
            ['TenantDeviceToken', 'TenantDeviceToken_not_system_user'],
        ];

        it('each guarded table carries its constraint, validated', async () => {
            const rows = await db.$queryRawUnsafe<Array<{ table: string; conname: string; convalidated: boolean }>>(
                `SELECT c.relname AS "table", k.conname, k.convalidated
                   FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid
                  WHERE k.contype = 'c' AND k.conname LIKE '%\\_not\\_system\\_user'`,
            );
            const found = new Map(rows.map((r) => [r.conname, r]));
            for (const [table, constraint] of GUARDED) {
                expect(found.get(constraint)).toEqual({ table, conname: constraint, convalidated: true });
            }
            expect(rows).toHaveLength(GUARDED.length);
        });

        it('a membership for the system user is refused', async () => {
            await ensureTenantSystemUser(TENANT_A);
            await expectCheckViolation(
                db.tenantMembership.create({
                    data: { tenantId: TENANT_A, userId: SYS_A, role: Role.OWNER, status: MembershipStatus.ACTIVE },
                }),
                'TenantMembership_not_system_user',
            );
        });

        it('an OAuth account linked to the system user is refused', async () => {
            await ensureTenantSystemUser(TENANT_A);
            await expectCheckViolation(
                db.account.create({
                    data: { userId: SYS_A, type: 'oauth', provider: 'google', providerAccountId: `acct-${TAG}` },
                }),
                'Account_not_system_user',
            );
        });
    });

    describe('the policy review reminder writes as the system user', () => {
        it('names no person as the task author, still assigns the owner, and leaves the other tenant alone', async () => {
            const past = new Date(Date.now() - 3 * 86_400_000);
            const policyA = await db.policy.create({
                data: { tenantId: TENANT_A, slug: `pol-a-${TAG}`, title: 'Access policy', ownerUserId: ownerA, nextReviewAt: past },
            });
            await db.policy.create({
                data: { tenantId: TENANT_B, slug: `pol-b-${TAG}`, title: 'Other policy', ownerUserId: ownerB, nextReviewAt: past },
            });

            await processOverdueReminders(db, { tenantId: TENANT_A });

            const link = await db.taskLink.findFirstOrThrow({
                where: { tenantId: TENANT_A, entityType: 'POLICY', entityId: policyA.id },
                include: { task: true },
            });
            expect(link.task.createdByUserId).toBe(SYS_A);
            expect(isTenantSystemUserId(link.task.createdByUserId)).toBe(true);
            expect(link.task.assigneeUserId).toBe(ownerA);

            const created = await db.auditLog.findFirstOrThrow({
                where: { tenantId: TENANT_A, action: 'TASK_CREATED', entityId: link.task.id },
            });
            expect(created.userId).toBe(SYS_A);
            expect(created.actorType).toBe('JOB');

            // Nothing in tenant A was written under the owner's name.
            expect(await db.task.count({ where: { tenantId: TENANT_A, createdByUserId: ownerA } })).toBe(0);
            // Tenant B was not swept, and has no system user of its own yet.
            expect(await db.task.count({ where: { tenantId: TENANT_B } })).toBe(0);
            expect(await db.user.count({ where: { id: tenantSystemUserId(TENANT_B) } })).toBe(0);
        });
    });
});
