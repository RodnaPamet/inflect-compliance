/**
 * #5716 — the recursion depth is write-once and bounded at the DATABASE.
 *
 * The unit tests prove the counter now counts: the bus stamps it, the executor
 * increments it, the dispatch refuses above the cap, and a resumed run gets it
 * back from its row. What they cannot prove is the half that makes the counter
 * trustworthy — that nothing can RESET it. A depth that could be rewritten
 * could be set back to 1 on every lap, and `MAX_AGENT_INVOKE_DEPTH` would stop
 * binding while every unit test stayed green.
 *
 * So both database terms are asserted here against a real Postgres, by the only
 * writer that can bypass the application: raw SQL.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }), transactionOptions: TENANT_TX_OPTIONS });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(30_000);

const TENANT = 'invoke-depth-tenant';
const RUN_AT_TWO = 'invoke-depth-run-2';
const RUN_AT_NONE = 'invoke-depth-run-none';

describeFn('WorkflowRun.agentInvokeDepth is write-once and at least one', () => {
    beforeAll(async () => {
        await prisma.workflowRun.deleteMany({ where: { tenantId: TENANT } });
        await prisma.tenant.deleteMany({ where: { id: TENANT } });
        await prisma.tenant.create({ data: { id: TENANT, name: TENANT, slug: TENANT } });
        await prisma.workflowRun.create({
            data: { id: RUN_AT_TWO, tenantId: TENANT, workflowKey: 'audit-prep', agentInvokeDepth: 2 },
        });
        await prisma.workflowRun.create({
            data: { id: RUN_AT_NONE, tenantId: TENANT, workflowKey: 'audit-prep' },
        });
    });

    afterAll(async () => {
        await prisma.workflowRun.deleteMany({ where: { tenantId: TENANT } });
        await prisma.tenant.deleteMany({ where: { id: TENANT } });
        await prisma.$disconnect();
    });

    it('stores the depth a rule invoked the run at, and NULL when none did', async () => {
        const rows = await prisma.workflowRun.findMany({
            where: { tenantId: TENANT },
            select: { id: true, agentInvokeDepth: true },
            orderBy: { id: 'asc' },
        });
        // `…run-2` sorts before `…run-none`: '2' < 'n'.
        expect(rows).toEqual([
            { id: RUN_AT_TWO, agentInvokeDepth: 2 },
            { id: RUN_AT_NONE, agentInvokeDepth: null },
        ]);
    });

    it('refuses a rewrite — a counter that could be reset would not bind', async () => {
        await expect(
            prisma.$executeRawUnsafe(`UPDATE "WorkflowRun" SET "agentInvokeDepth" = 1 WHERE "id" = $1`, RUN_AT_TWO),
        ).rejects.toThrow(/IMMUTABLE_AGENT_INVOKE_DEPTH/);
    });

    // NULL -> value too, stricter than the card pin and the same as
    // `mountedSkills`: a later fill could only ever be a reconstruction.
    it('refuses filling a depth in after the fact', async () => {
        await expect(
            prisma.$executeRawUnsafe(`UPDATE "WorkflowRun" SET "agentInvokeDepth" = 3 WHERE "id" = $1`, RUN_AT_NONE),
        ).rejects.toThrow(/IMMUTABLE_AGENT_INVOKE_DEPTH/);
    });

    it('refuses clearing a recorded depth', async () => {
        await expect(
            prisma.$executeRawUnsafe(`UPDATE "WorkflowRun" SET "agentInvokeDepth" = NULL WHERE "id" = $1`, RUN_AT_TWO),
        ).rejects.toThrow(/IMMUTABLE_AGENT_INVOKE_DEPTH/);
    });

    it('lets an unrelated column still be updated, so the trigger is not a table-wide freeze', async () => {
        await expect(
            prisma.$executeRawUnsafe(`UPDATE "WorkflowRun" SET "costTokens" = 42 WHERE "id" = $1`, RUN_AT_TWO),
        ).resolves.toBe(1);
    });

    // Through the client rather than raw SQL: `updatedAt` is NOT NULL with no
    // database default, so a hand-written INSERT fails on that first and would
    // have asserted nothing about the CHECK.
    it('refuses a depth below one at insert — zero is a lap nobody took', async () => {
        await expect(
            prisma.workflowRun.create({
                data: { id: 'invoke-depth-run-zero', tenantId: TENANT, workflowKey: 'audit-prep', agentInvokeDepth: 0 },
            }),
        ).rejects.toThrow(/agentInvokeDepth_at_least_one/);
    });
});
