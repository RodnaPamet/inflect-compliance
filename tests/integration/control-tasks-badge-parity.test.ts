/**
 * TP-2 P4.9 (control part) — the control-detail Tasks-tab BADGE count must
 * equal the number of rows the tab BODY (LinkedTasksPanel) lists.
 *
 * After the ControlTask→unified-Task migration both numbers derive from the
 * SAME dual-linkage rule (a TaskLink with entityType=CONTROL OR the direct
 * `Task.controlId` FK, deduped by task id):
 *   • badge = `getControlHeader(ctx, id)._count.controlTasks`
 *             (→ TaskRepository.countLinkedToControl)
 *   • body  = `listTasks(ctx, { linkedEntityType: 'CONTROL', linkedEntityId })`
 *             (the exact query `/tasks?linkedEntityType=CONTROL&linkedEntityId=`
 *             runs — what LinkedTasksPanel fetches)
 *
 * This test creates a mix of both linkage paths (plus a both-ways task that
 * must count once, and an unrelated task that must not count) and asserts the
 * two agree — so a future regression that repoints one source but not the
 * other fails here.
 *
 * Hits a real DB (project convention).
 */
import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { createTask, setTaskStatus, addTaskLink, listTasks } from '@/app-layer/usecases/task';
import { getControlHeader } from '@/app-layer/usecases/control/queries';

const globalPrisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DB_URL }),
});
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const SUITE_TAG = `ctl-badge-${randomUUID().slice(0, 8)}`;
const TENANT_ID = `t-${SUITE_TAG}`;

let ownerUserId: string;
let controlId: string;
let otherControlId: string;
let ctx: ReturnType<typeof makeRequestContext>;

async function makeUser(label: string, role: Role): Promise<string> {
    const email = `${SUITE_TAG}-${label}@example.test`;
    const u = await globalPrisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
    await globalPrisma.tenantMembership.create({
        data: { tenantId: TENANT_ID, userId: u.id, role, status: MembershipStatus.ACTIVE },
    });
    return u.id;
}

describeFn('control Tasks-tab badge == list (integration)', () => {
    beforeAll(async () => {
        await globalPrisma.tenant.upsert({
            where: { id: TENANT_ID },
            update: {},
            create: { id: TENANT_ID, name: `t ${SUITE_TAG}`, slug: SUITE_TAG },
        });
        ownerUserId = await makeUser('owner', Role.OWNER);
        const control = await globalPrisma.control.create({
            data: { tenantId: TENANT_ID, code: 'C-BADGE', name: 'Badge control' },
        });
        controlId = control.id;
        const other = await globalPrisma.control.create({
            data: { tenantId: TENANT_ID, code: 'C-OTHER', name: 'Other control' },
        });
        otherControlId = other.id;
        ctx = makeRequestContext('OWNER', { tenantId: TENANT_ID, tenantSlug: SUITE_TAG, userId: ownerUserId });
    });

    afterAll(async () => {
        await globalPrisma.taskLink.deleteMany({ where: { tenantId: TENANT_ID } });
        await globalPrisma.task.deleteMany({ where: { tenantId: TENANT_ID } });
        await globalPrisma.control.deleteMany({ where: { tenantId: TENANT_ID } });
        await globalPrisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
            await tx.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE "tenantId" = $1`, TENANT_ID);
            await tx.$executeRawUnsafe(`DELETE FROM "Notification" WHERE "tenantId" = $1`, TENANT_ID);
            await tx.$executeRawUnsafe(`DELETE FROM "NotificationOutbox" WHERE "tenantId" = $1`, TENANT_ID);
            await tx.$executeRawUnsafe(`DELETE FROM "AutomationExecution" WHERE "tenantId" = $1`, TENANT_ID);
            await tx.$executeRawUnsafe(`DELETE FROM "TaskKeySequence" WHERE "tenantId" = $1`, TENANT_ID);
            await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = $1`, TENANT_ID);
        });
        // Guarded: an undefined filter value is DROPPED, not matched —
        // see the teardown note in ./db-helper.ts.
        if (ownerUserId) {
            await globalPrisma.user.deleteMany({ where: { id: ownerUserId } });
        }
        await globalPrisma.tenant.deleteMany({ where: { id: TENANT_ID } });
        await globalPrisma.$disconnect();
    });

    it('badge count equals the tab-body list count under mixed dual-linkage', async () => {
        // A — direct controlId FK only.
        await createTask(ctx, { title: 'fk-only', controlId });
        // B — TaskLink CONTROL only.
        const b = await createTask(ctx, { title: 'link-only' });
        await addTaskLink(ctx, b.id, 'CONTROL', controlId);
        // C — BOTH paths → must be counted ONCE (deduped by task id).
        const c = await createTask(ctx, { title: 'both', controlId });
        await addTaskLink(ctx, c.id, 'CONTROL', controlId);
        // D — completed (CLOSED) via the direct FK → counts toward total AND done.
        const d = await createTask(ctx, { title: 'done', controlId });
        await setTaskStatus(ctx, d.id, 'CLOSED', 'remediated');
        // E — attached to a DIFFERENT control → must NOT count here.
        await createTask(ctx, { title: 'elsewhere', controlId: otherControlId });
        // F — unlinked entirely → must NOT count.
        await createTask(ctx, { title: 'unlinked' });

        // Body: the exact query LinkedTasksPanel fetches.
        const body = await listTasks(ctx, { linkedEntityType: 'CONTROL', linkedEntityId: controlId });
        // Badge: the control-header tab-badge source.
        const header = await getControlHeader(ctx, controlId);

        // Four unique tasks (A, B, C, D) linked to THIS control; C counted once.
        expect(body.length).toBe(4);
        expect(header._count.controlTasks).toBe(body.length);

        // "done" (RESOLVED|CLOSED) parity too — the Overview progress widget.
        const doneInBody = body.filter(
            (t: { status: string }) => t.status === 'RESOLVED' || t.status === 'CLOSED',
        ).length;
        expect(doneInBody).toBe(1);
        expect(header.doneControlTasks).toBe(doneInBody);
    });
});
