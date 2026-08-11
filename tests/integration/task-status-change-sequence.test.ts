/**
 * A task status change runs ONE sequence, whichever door it came through.
 *
 * `setTaskStatus` and `bulkSetTaskStatus` each spelled the sequence out
 * for themselves and the copies drifted: the bulk path had lost the
 * type-relevance gate, the `TASK_STATUS_CHANGED` automation emission and
 * the watcher bell fan-out. `POST /tasks/bulk/status {status:'CLOSED'}`
 * was therefore an escape hatch that closed an AUDIT_FINDING carrying
 * neither a `controlId` nor a CONTROL / FRAMEWORK_REQUIREMENT link —
 * exactly the shape the single-task path refuses.
 *
 * Every assertion below is made TWICE, once per entry point, so the
 * shared helpers are proven from both doors rather than from the one
 * that happened to be complete.
 *
 * Hits a real DB (project convention). Setup + assertions use a raw
 * (superuser) client; the mutations under test run through the usecases
 * (RLS-enforced). The automation emission is observed by subscribing to
 * the real in-process bus — the emit is the behaviour, and a rule
 * cannot fire without it.
 */
import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import {
    createTask,
    setTaskStatus,
    bulkSetTaskStatus,
    addTaskWatcher,
} from '@/app-layer/usecases/task';
import { getAutomationBus } from '@/app-layer/automation';
import type { AutomationDomainEvent } from '@/app-layer/automation';

const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DB_URL }),
});
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const TAG = `tsc-${randomUUID().slice(0, 8)}`;
const TENANT = `t-${TAG}`;

let actorId: string;
let watcherId: string;
let ctx: ReturnType<typeof makeRequestContext>;

async function makeUser(label: string): Promise<string> {
    const email = `${TAG}-${label}@example.test`;
    const u = await db.user.create({ data: { email, emailHash: hashForLookup(email) } });
    await db.tenantMembership.create({
        data: { tenantId: TENANT, userId: u.id, role: Role.OWNER, status: MembershipStatus.ACTIVE },
    });
    return u.id;
}

/** An AUDIT_FINDING with no controlId and no links — the shape the
 *  type-relevance rule exists to refuse on a terminal move. */
async function makeTypeIrrelevantTask(label: string) {
    return createTask(ctx, {
        title: `Irrelevant ${label}`,
        type: 'AUDIT_FINDING',
        source: 'AUDIT',
    });
}

/** A closeable AUDIT_FINDING: `controlId` satisfies type relevance,
 *  `findingId` gives the source reconciler something to write, and a
 *  second member watches it so the bell fan-out is observable. */
async function makeCloseableTask(label: string) {
    const control = await db.control.create({
        data: { tenantId: TENANT, code: `C-${TAG}-${label}`, name: `Control ${label}` },
    });
    const finding = await db.finding.create({
        data: {
            tenantId: TENANT,
            severity: 'MEDIUM',
            type: 'NONCONFORMITY',
            title: `Finding ${label}`,
            description: 'to remediate',
            status: 'OPEN',
        },
    });
    const task = await createTask(ctx, {
        title: `Remediate ${label}`,
        type: 'AUDIT_FINDING',
        controlId: control.id,
        findingId: finding.id,
        source: 'AUDIT',
    });
    await addTaskWatcher(ctx, task.id, watcherId);
    return { task, finding };
}

/** Collect every TASK_STATUS_CHANGED the bus sees during `run`. */
async function captureStatusEvents(run: () => Promise<unknown>) {
    const seen: AutomationDomainEvent[] = [];
    const off = getAutomationBus().subscribe('TASK_STATUS_CHANGED', (e) => {
        seen.push(e);
    });
    try {
        await run();
    } finally {
        off();
    }
    return seen;
}

async function watcherBells(taskId: string) {
    return db.notification.findMany({
        where: { tenantId: TENANT, userId: watcherId, type: 'TASK_WATCH_UPDATE' },
        select: { message: true, linkUrl: true },
    }).then((rows) => rows.filter((r) => r.linkUrl?.endsWith(taskId)));
}

async function statusAuditRows(taskId: string) {
    return db.auditLog.findMany({
        where: { tenantId: TENANT, entityId: taskId, action: 'TASK_STATUS_CHANGED' },
        select: { id: true },
    });
}

describeFn('task status change — one sequence for both entry points', () => {
    beforeAll(async () => {
        await db.tenant.upsert({
            where: { id: TENANT },
            update: {},
            create: { id: TENANT, name: `t ${TAG}`, slug: TENANT },
        });
        actorId = await makeUser('actor');
        watcherId = await makeUser('watcher');
        ctx = makeRequestContext('OWNER', {
            tenantId: TENANT,
            tenantSlug: TENANT,
            userId: actorId,
        });
    });

    afterAll(async () => {
        try {
            await db.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE "tenantId" = $1`, TENANT);
            await db.$executeRawUnsafe(`DELETE FROM "Notification" WHERE "tenantId" = $1`, TENANT);
            await db.$executeRawUnsafe(`DELETE FROM "TaskWatcher" WHERE "tenantId" = $1`, TENANT);
            await db.$executeRawUnsafe(`DELETE FROM "TaskLink" WHERE "tenantId" = $1`, TENANT);
            await db.$executeRawUnsafe(`DELETE FROM "Task" WHERE "tenantId" = $1`, TENANT);
            await db.$executeRawUnsafe(`DELETE FROM "Finding" WHERE "tenantId" = $1`, TENANT);
            await db.$executeRawUnsafe(`DELETE FROM "Control" WHERE "tenantId" = $1`, TENANT);
            await db.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = $1`, TENANT);
            await db.$executeRawUnsafe(`DELETE FROM "Tenant" WHERE "id" = $1`, TENANT);
            await db.$executeRawUnsafe(
                `DELETE FROM "User" WHERE "id" = ANY($1)`,
                [actorId, watcherId],
            );
        } catch {
            // best-effort teardown
        }
        await db.$disconnect();
    });

    // ─── The gate that had drifted out of the bulk path ──────────────

    describe('the type-relevance gate refuses a close through EITHER door', () => {
        it('bulkSetTaskStatus refuses a type-irrelevant close and writes nothing', async () => {
            const t = await makeTypeIrrelevantTask('bulk');

            await expect(
                bulkSetTaskStatus(ctx, [t.id], 'CLOSED', 'closed in bulk'),
            ).rejects.toThrow(/controlId or a link to CONTROL or FRAMEWORK_REQUIREMENT/);

            // The refusal is a refusal, not a warning: the row is untouched
            // and no status audit row was written for it.
            const after = await db.task.findUniqueOrThrow({ where: { id: t.id } });
            expect(after.status).toBe('OPEN');
            expect(after.completedAt).toBeNull();
            expect(await statusAuditRows(t.id)).toHaveLength(0);
        });

        it('setTaskStatus refuses the same shape (parity)', async () => {
            const t = await makeTypeIrrelevantTask('single');

            await expect(
                setTaskStatus(ctx, t.id, 'CLOSED', 'closed singly'),
            ).rejects.toThrow(/controlId or a link to CONTROL or FRAMEWORK_REQUIREMENT/);

            const after = await db.task.findUniqueOrThrow({ where: { id: t.id } });
            expect(after.status).toBe('OPEN');
        });

        it('one bad row refuses the WHOLE bulk batch (no partial close)', async () => {
            const bad = await makeTypeIrrelevantTask('batch-bad');
            const { task: good } = await makeCloseableTask('batchok');

            await expect(
                bulkSetTaskStatus(ctx, [good.id, bad.id], 'CLOSED', 'batch close'),
            ).rejects.toThrow(/controlId or a link to CONTROL or FRAMEWORK_REQUIREMENT/);

            // The good row must not have been closed on the way past the
            // bad one — the gate runs before any write.
            const goodAfter = await db.task.findUniqueOrThrow({ where: { id: good.id } });
            expect(goodAfter.status).toBe('OPEN');
        });
    });

    // ─── The post-write steps that had drifted out of the bulk path ──

    describe('a legal close runs audit + automation + reconcile + watchers', () => {
        it('through bulkSetTaskStatus', async () => {
            const { task, finding } = await makeCloseableTask('bulkok');

            const events = await captureStatusEvents(() =>
                bulkSetTaskStatus(ctx, [task.id], 'CLOSED', 'remediated in bulk'),
            );

            // 1. audit
            expect(await statusAuditRows(task.id)).toHaveLength(1);

            // 2. automation — a rule can only fire on an emitted event.
            const mine = events.filter((e) => e.entityId === task.id);
            expect(mine).toHaveLength(1);
            expect(mine[0].data).toMatchObject({ fromStatus: 'OPEN', toStatus: 'CLOSED' });

            // 3. source reconciliation — the Finding that raised the task
            //    is closed, not left silently open.
            const findingAfter = await db.finding.findUniqueOrThrow({ where: { id: finding.id } });
            expect(findingAfter.status).toBe('CLOSED');

            // 4. watcher bell
            const bells = await watcherBells(task.id);
            expect(bells).toHaveLength(1);
            expect(bells[0].message).toContain('OPEN → CLOSED');
        });

        it('through setTaskStatus (parity)', async () => {
            const { task, finding } = await makeCloseableTask('singleok');

            const events = await captureStatusEvents(() =>
                setTaskStatus(ctx, task.id, 'CLOSED', 'remediated singly'),
            );

            expect(await statusAuditRows(task.id)).toHaveLength(1);

            const mine = events.filter((e) => e.entityId === task.id);
            expect(mine).toHaveLength(1);
            expect(mine[0].data).toMatchObject({ fromStatus: 'OPEN', toStatus: 'CLOSED' });

            const findingAfter = await db.finding.findUniqueOrThrow({ where: { id: finding.id } });
            expect(findingAfter.status).toBe('CLOSED');

            const bells = await watcherBells(task.id);
            expect(bells).toHaveLength(1);
            expect(bells[0].message).toContain('OPEN → CLOSED');
        });

        it('bulk fans the sequence out PER task, not once per batch', async () => {
            const a = await makeCloseableTask('multi-a');
            const b = await makeCloseableTask('multi-b');

            const events = await captureStatusEvents(() =>
                bulkSetTaskStatus(ctx, [a.task.id, b.task.id], 'CLOSED', 'both remediated'),
            );

            for (const { task, finding } of [a, b]) {
                expect(await statusAuditRows(task.id)).toHaveLength(1);
                expect(events.filter((e) => e.entityId === task.id)).toHaveLength(1);
                const after = await db.finding.findUniqueOrThrow({ where: { id: finding.id } });
                expect(after.status).toBe('CLOSED');
                expect(await watcherBells(task.id)).toHaveLength(1);
            }
        });
    });
});
