/**
 * #3537 — an automation-started run records the rule firing that caused it.
 *
 * The claim is about CAUSE, which the row could not express. An
 * automation-started run's `startedByUserId` is the rule's OWNER — the run
 * executes under their permissions and is stamped `actorType: 'JOB'` so the
 * trail does not claim a person acted — so a reader saw a person's name for
 * work a rule scheduled, and nothing said which rule.
 *
 * Three assertions, and the third is the one that makes the column worth a
 * migration rather than a note:
 *
 *   1. An automation-started run records the execution id.
 *   2. A human-started run records NULL — inventing a parent would put a
 *      fiction in the column, and "no parent" has to stay expressible.
 *   3. TWO RULES invoking the SAME agent on the SAME workflow produce runs
 *      that are distinguishable. That is the case any `(agentId, workflowKey)`
 *      join gets wrong, and it is why the process canvas cannot bind to the
 *      ledger without this column.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { registerWorkflow } from '@/lib/agentic/workflow-registry';
import { startWorkflowRun } from '@/app-layer/usecases/workflow-runs';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }), transactionOptions: TENANT_TX_OPTIONS });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(120_000);

const SUITE = `cause-${randomUUID().slice(0, 8)}`;
const TENANT = `t-${SUITE}`;
const USER = `u-${SUITE}`;
const WF = `cause-wf-${SUITE}`;

const ctx = () =>
    makeRequestContext('ADMIN', { tenantId: TENANT, tenantSlug: TENANT, userId: USER });

const parentOf = async (runId: string) =>
    (await prisma.workflowRun.findUniqueOrThrow({
        where: { id: runId },
        select: { parentExecutionId: true },
    })).parentExecutionId;

describeFn('a run records what caused it (real DB, real start path)', () => {
    beforeAll(async () => {
        await prisma.$connect();
        await prisma.tenant.create({ data: { id: TENANT, name: TENANT, slug: TENANT } });
        const email = `${TENANT}@example.test`;
        await prisma.user.create({
            data: { id: USER, email, emailHash: hashForLookup(email) },
        });
        await prisma.tenantMembership.create({
            data: { tenantId: TENANT, userId: USER, role: 'OWNER', status: 'ACTIVE' },
        });
        registerWorkflow({
            key: WF,
            name: 'Causality probe',
            description: 'one synthesis, so a run completes without a checkpoint',
            steps: [
                { kind: 'SYNTHESIS', label: 'summary', synthesize: () => ({ text: 'done' }) },
            ],
        });
    });

    afterAll(async () => {
        await prisma.workflowStep.deleteMany({ where: { tenantId: TENANT } }).catch(() => {});
        await prisma.workflowRun.deleteMany({ where: { tenantId: TENANT } }).catch(() => {});
        await deleteAuditRowsForTenants(prisma, TENANT).catch(() => {});
        await prisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
            await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = $1`, TENANT);
        }).catch(() => {});
        await prisma.tenant.deleteMany({ where: { id: TENANT } });
        await prisma.user.deleteMany({ where: { id: USER } });
        await prisma.$disconnect();
    });

    it('records the execution that caused it', async () => {
        const { runId } = await startWorkflowRun(ctx(), WF, {}, {
            parentExecutionId: 'exec-abc',
        });
        expect(await parentOf(runId)).toBe('exec-abc');
    });

    it('a run nothing caused records NULL, not a placeholder', async () => {
        // "No parent" has to stay expressible: a human- or
        // credential-started run genuinely has none, and a sentinel string
        // would make it indistinguishable from a rule nobody can look up.
        const { runId } = await startWorkflowRun(ctx(), WF, {});
        expect(await parentOf(runId)).toBeNull();
    });

    it('an explicit null is the same as omitting it', async () => {
        // The dispatcher passes `payload.parentExecutionId`, which is optional
        // on the payload — so `undefined` and `null` both reach this path and
        // must mean the same thing.
        const { runId } = await startWorkflowRun(ctx(), WF, {}, {
            parentExecutionId: null,
        });
        expect(await parentOf(runId)).toBeNull();
    });

    it('TWO rules on the same agent and workflow stay distinguishable', async () => {
        // THE ASSERTION THE COLUMN EXISTS FOR. Both runs share every other
        // field a canvas could join on — same tenant, same workflowKey, same
        // (absent) agent — so a `(agentId, workflowKey)` join returns both for
        // either rule, which is the invented binding this avoids.
        const a = await startWorkflowRun(ctx(), WF, {}, { parentExecutionId: 'exec-rule-a' });
        const b = await startWorkflowRun(ctx(), WF, {}, { parentExecutionId: 'exec-rule-b' });

        expect(await parentOf(a.runId)).toBe('exec-rule-a');
        expect(await parentOf(b.runId)).toBe('exec-rule-b');

        // …and the canvas query actually separates them.
        const forA = await prisma.workflowRun.findMany({
            where: { tenantId: TENANT, parentExecutionId: 'exec-rule-a' },
            select: { id: true },
        });
        expect(forA.map((r) => r.id)).toEqual([a.runId]);
    });

    it('the write survives the run completing — it is in the CREATE, not an update', async () => {
        // A run that crashes mid-step still has to say what caused it, which is
        // why this is written with the row rather than stamped afterwards. The
        // probe workflow completes, so this also holds that the settlement
        // update does not clear the column.
        const { runId, status } = await startWorkflowRun(ctx(), WF, {}, {
            parentExecutionId: 'exec-survives',
        });
        expect(status).toBe('COMPLETED');
        expect(await parentOf(runId)).toBe('exec-survives');
    });
});
