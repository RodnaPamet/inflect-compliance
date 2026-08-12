/**
 * Integration — an automation rule executes under its principal's REAL
 * tenant authority, never a fabricated ADMIN one.
 *
 * The executor used to build its RequestContext by hand with
 * `role: 'ADMIN'` + `getPermissionsForRole('ADMIN')` while stamping a real
 * person's `userId` on it. Every granular gate downstream — here
 * `assertCanCreateTask`, which reads `permissions.canWrite` AND
 * `appPermissions.tasks.create` — was therefore cleared for free, and the
 * resulting TASK_CREATED audit row named a user who never held that
 * permission.
 *
 * What this proves against a real database, through the real dispatcher and
 * the real `createTask` usecase (no mocks in the authorization path):
 *
 *   • a rule whose principal is a READER does NOT create a Task, and the
 *     AutomationExecution row settles FAILED carrying the reason;
 *   • the same rule authored by an ADMIN does create one, owned by the author;
 *   • demoting the author afterwards revokes the rule's authority on the very
 *     next firing — the role is re-resolved per execution, not captured;
 *   • a REMOVED member's rule cannot execute at all.
 *
 * Setup + assertions use a raw (superuser) client; the executions under test
 * run through `runAutomationEventDispatch`, exactly as the BullMQ worker
 * invokes them.
 */
import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { runAutomationEventDispatch } from '@/app-layer/jobs/automation-event-dispatch';
import { toDispatchPayload } from '@/app-layer/automation';
import type { AutomationEventDispatchPayload } from '@/app-layer/jobs/types';

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const TAG = `aaa-${randomUUID().slice(0, 8)}`;
const TENANT = `t-${TAG}`;

let adminUserId: string;
let readerUserId: string;
let demotedUserId: string;
let removedUserId: string;

async function makeMember(label: string, role: Role, status: MembershipStatus = MembershipStatus.ACTIVE) {
    const email = `${TAG}-${label}@example.test`;
    const u = await db.user.create({ data: { email, emailHash: hashForLookup(email) } });
    await db.tenantMembership.create({ data: { tenantId: TENANT, userId: u.id, role, status } });
    return u.id;
}

/** An ENABLED CREATE_TASK rule attributed to `authorId`. */
async function makeRule(name: string, authorId: string | null) {
    return db.automationRule.create({
        data: {
            tenantId: TENANT,
            name: `${TAG}-${name}`,
            triggerEvent: 'RISK_CREATED',
            actionType: 'CREATE_TASK',
            actionConfigJson: { title: `Remediate ${name}` },
            status: 'ENABLED',
            priority: 0,
            createdByUserId: authorId,
        },
    });
}

/**
 * The payload shape the worker receives. `firedBy` is the member whose own
 * action emitted the event — deliberately a READER in most cases, to prove
 * the firing identity is provenance and never a source of authority.
 */
function payload(entityKey: string, firedBy: string | null): AutomationEventDispatchPayload {
    return toDispatchPayload({
        event: 'RISK_CREATED',
        tenantId: TENANT,
        entityType: 'Risk',
        entityId: `risk-${entityKey}`,
        actorUserId: firedBy,
        emittedAt: new Date(),
        stableKey: `risk-${entityKey}`,
        data: { title: 'Exposed bucket' },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
}

async function executionFor(ruleId: string) {
    const rows = await db.automationExecution.findMany({
        where: { tenantId: TENANT, ruleId },
        orderBy: { createdAt: 'desc' },
    });
    return rows[0];
}

/**
 * Tasks attributable to ONE rule. Scoped by rule rather than tenant-wide
 * because every dispatch fans out to every matching rule in the tenant, so a
 * tenant-wide count would move for reasons unrelated to the rule under test.
 */
const tasksForRule = (ruleId: string) =>
    db.task.findMany({ where: { tenantId: TENANT, metadataJson: { path: ['ruleId'], equals: ruleId } } });

describeFn('automation rules execute under the principal\'s real authority', () => {
    beforeAll(async () => {
        await db.tenant.upsert({
            where: { id: TENANT },
            update: {},
            create: { id: TENANT, name: `t ${TAG}`, slug: TENANT },
        });
        adminUserId = await makeMember('admin', Role.ADMIN);
        readerUserId = await makeMember('reader', Role.READER);
        demotedUserId = await makeMember('demoted', Role.ADMIN);
        removedUserId = await makeMember('removed', Role.ADMIN, MembershipStatus.REMOVED);
    });

    afterAll(async () => {
        try {
            await db.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE "tenantId" = $1`, TENANT);
            await db.automationExecution.deleteMany({ where: { tenantId: TENANT } });
            await db.automationRule.deleteMany({ where: { tenantId: TENANT } });
            await db.task.deleteMany({ where: { tenantId: TENANT } });
            await db.tenantMembership.deleteMany({ where: { tenantId: TENANT } });
            await db.user.deleteMany({
                where: { id: { in: [adminUserId, readerUserId, demotedUserId, removedUserId] } },
            });
            await db.tenant.delete({ where: { id: TENANT } });
        } catch {
            /* best effort */
        }
        await db.$disconnect();
    });

    test('a READER-authored rule creates NO task and records why', async () => {
        const rule = await makeRule('reader-authored', readerUserId);

        const result = await runAutomationEventDispatch(payload(`${TAG}-1`, readerUserId));
        expect(result.rulesMatched).toBe(1);

        const exec = await executionFor(rule.id);
        expect(exec.status).toBe('FAILED');
        // The reason must be legible on the execution row itself — an
        // operator seeing a FAILED automation needs to know it was refused,
        // not that it silently no-op'd.
        expect(exec.errorMessage).toContain('lacks permission to create tasks');
        expect(exec.errorMessage).toContain('READER');

        expect(await tasksForRule(rule.id)).toHaveLength(0);
    });

    test('an ADMIN-authored rule creates the task, owned by the author', async () => {
        const rule = await makeRule('admin-authored', adminUserId);

        // Fired by the READER: the firing member supplies provenance, the
        // AUTHOR supplies authority. Under the old fabricated context this
        // ran as the reader-wearing-ADMIN.
        const result = await runAutomationEventDispatch(payload(`${TAG}-2`, readerUserId));
        expect(result.rulesMatched).toBeGreaterThanOrEqual(1);

        const exec = await executionFor(rule.id);
        expect(exec.status).toBe('SUCCEEDED');

        const tasks = await tasksForRule(rule.id);
        expect(tasks).toHaveLength(1);
        expect(tasks[0].createdByUserId).toBe(adminUserId);
        expect(tasks[0].key).toMatch(/^TSK-\d+$/);
    });

    test('demoting the author revokes the rule on the very next firing', async () => {
        const rule = await makeRule('demoted-author', demotedUserId);

        // Still ADMIN — the rule works.
        await runAutomationEventDispatch(payload(`${TAG}-3`, null));
        expect((await executionFor(rule.id)).status).toBe('SUCCEEDED');
        expect(await tasksForRule(rule.id)).toHaveLength(1);

        await db.tenantMembership.update({
            where: { tenantId_userId: { tenantId: TENANT, userId: demotedUserId } },
            data: { role: Role.READER },
        });

        // A DIFFERENT entity, so the dedupe guard cannot be what stops it.
        await runAutomationEventDispatch(payload(`${TAG}-4`, null));
        const exec = await executionFor(rule.id);
        expect(exec.status).toBe('FAILED');
        expect(exec.errorMessage).toContain('lacks permission to create tasks');
        // Still exactly the one task from when the author was an ADMIN.
        expect(await tasksForRule(rule.id)).toHaveLength(1);
    });

    test('a REMOVED member\'s rule cannot execute at all', async () => {
        const rule = await makeRule('removed-author', removedUserId);

        await runAutomationEventDispatch(payload(`${TAG}-5`, null));
        const exec = await executionFor(rule.id);
        expect(exec.status).toBe('FAILED');
        expect(exec.errorMessage).toContain('REMOVED');
        expect(await tasksForRule(rule.id)).toHaveLength(0);
    });
});
