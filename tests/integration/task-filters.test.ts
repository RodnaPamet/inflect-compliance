/**
 * Tasks roadmap TP-6 (P4.10) — task list-filter integrity (integration).
 *
 * Proves, against a real DB, that two list filters actually populate +
 * match:
 *
 *   1. `status=TRIAGED` returns EXACTLY the TRIAGED rows (TRIAGED is a
 *      real TaskStatus — the filter must not silently drop it).
 *   2. The linked-control filter (`controlId`) returns the
 *      control-linked task AND the returned row carries a populated
 *      `control` object — the TP-6 `taskListSelect` fix. Before TP-6
 *      the select omitted `control`, so the filter's runtime-derived
 *      options never populated even though the server-side `controlId`
 *      predicate matched.
 *
 * Hits a real DB (project convention).
 */
import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { createTask, setTaskStatus, listTasks } from '@/app-layer/usecases/task';

const globalPrisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DB_URL }),
});
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(30_000);

const TAG = `task-filt-${randomUUID().slice(0, 8)}`;
const TENANT_ID = `t-${TAG}`;

let ownerUserId: string;
let controlId: string;
let ctx: ReturnType<typeof makeRequestContext>;

// Row ids created in beforeAll, asserted on below.
let triagedA = '';
let triagedB = '';
let openC = '';
let controlLinked = '';

async function makeUser(label: string, role: Role): Promise<string> {
    const email = `${TAG}-${label}@example.test`;
    const u = await globalPrisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
    await globalPrisma.tenantMembership.create({
        data: { tenantId: TENANT_ID, userId: u.id, role, status: MembershipStatus.ACTIVE },
    });
    return u.id;
}

describeFn('task filters — integrity (integration)', () => {
    beforeAll(async () => {
        await globalPrisma.tenant.upsert({
            where: { id: TENANT_ID },
            update: {},
            create: { id: TENANT_ID, name: `t ${TAG}`, slug: TAG },
        });
        ownerUserId = await makeUser('owner', Role.OWNER);
        const control = await globalPrisma.control.create({
            data: { tenantId: TENANT_ID, code: 'C-FILT', name: 'Filter control' },
        });
        controlId = control.id;
        ctx = makeRequestContext('OWNER', { tenantId: TENANT_ID, tenantSlug: TAG, userId: ownerUserId });

        const a = await createTask(ctx, { title: 'triaged A' });
        const b = await createTask(ctx, { title: 'triaged B' });
        const c = await createTask(ctx, { title: 'open C' });
        const linked = await createTask(ctx, { title: 'control linked', controlId });
        triagedA = a.id;
        triagedB = b.id;
        openC = c.id;
        controlLinked = linked.id;

        // OPEN → TRIAGED is a valid transition.
        await setTaskStatus(ctx, triagedA, 'TRIAGED');
        await setTaskStatus(ctx, triagedB, 'TRIAGED');
    });

    afterAll(async () => {
        if (!DB_AVAILABLE) {
            await globalPrisma.$disconnect();
            return;
        }
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
        await globalPrisma.user.deleteMany({ where: { id: ownerUserId } });
        await globalPrisma.tenant.deleteMany({ where: { id: TENANT_ID } });
        await globalPrisma.$disconnect();
    });

    it('status=TRIAGED returns exactly the TRIAGED rows', async () => {
        const rows = (await listTasks(ctx, { status: 'TRIAGED' })) as Array<{ id: string; status: string }>;
        const ids = rows.map((r) => r.id).sort();
        expect(ids).toEqual([triagedA, triagedB].sort());
        expect(rows.every((r) => r.status === 'TRIAGED')).toBe(true);
        // The OPEN rows are excluded.
        expect(ids).not.toContain(openC);
        expect(ids).not.toContain(controlLinked);
    });

    it('controlId filter returns the control-linked task with a populated control', async () => {
        const rows = (await listTasks(ctx, { controlId })) as Array<{
            id: string;
            control: { id: string; code: string | null; name: string } | null;
        }>;
        expect(rows.map((r) => r.id)).toEqual([controlLinked]);
        // The TP-6 select fix: the row carries the linked control object,
        // which is what the filter's option-derivation reads.
        expect(rows[0]?.control?.id).toBe(controlId);
        expect(rows[0]?.control?.code).toBe('C-FILT');
    });

    it('taskListSelect returns control on every row (option-derivation source)', async () => {
        const rows = (await listTasks(ctx, {})) as Array<{ id: string; control: unknown }>;
        // Every row exposes the `control` key (null for unlinked tasks,
        // the object for the linked one) so the client can build the
        // filter options + column without an extra fetch.
        expect(rows.length).toBe(4);
        for (const r of rows) {
            expect('control' in r).toBe(true);
        }
    });
});
