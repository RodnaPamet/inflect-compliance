/**
 * One fault must not become a cascade (OWASP ASI08).
 *
 * Three propagation paths on the agentic surface, all proved here against a
 * real database, real RLS and the real usecases:
 *
 *   1. ONE STEP inside a run. A throw used to mark the whole run FAILED — a
 *      terminal state `resumeWorkflowRun` refuses — so every step that had
 *      already succeeded was stranded. A step that declares
 *      `continueOnFailure` is now isolated: the run carries on and REPORTS the
 *      count. The default is untouched, and that is asserted too, because a
 *      change that silently made every step optional would be the same defect
 *      pointing the other way.
 *
 *   2. ONE AGENT inside a fan-out. One agent's throw must not stop the agents
 *      behind it in the list.
 *
 *   3. THE ENUMERATION ITSELF. A `take:` cap sweeps a prefix and reports a
 *      finished pass; the reaper drains by cursor, which is proved by forcing
 *      the walk across a page boundary.
 *
 * ── Isolation is not swallowing, and that is what most of these assert ──
 *
 * Every test below checks the COUNT as well as the survival. A `try/catch` that
 * continues quietly is a silent truncation wearing a different hat: the batch
 * reports success and nobody learns a member failed. So each case asserts both
 * that the siblings lived AND that the failure was recorded — in the run's
 * result (`stepFailures`), in the durable step ledger (a `FAILED` row), and in
 * the fan-out's outcome (`failed` / `halted` / `unattempted`).
 *
 * ── And where isolation is WRONG ──
 *
 * A fatal error ends the run whatever a step declared, and halts a fan-out
 * where it fires. Both are asserted, because a control that cannot say no is
 * not a control.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { registerWorkflow } from '@/lib/agentic/workflow-registry';
import { startWorkflowRun, getWorkflowRun } from '@/app-layer/usecases/workflow-runs';
import {
    AgenticFatalError,
    isolateEach,
} from '@/lib/agentic/failure-isolation';
import { runAgentRunReaperJob, REAP_REASON } from '@/app-layer/jobs/agent-run-reaper';
import { ENGINE_CAPS } from '@/lib/agentic/workflow-types';
import { makeRequestContext } from '../helpers/make-context';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const SUITE = randomUUID().slice(0, 8);
const TENANT = `fi-${SUITE}`;
/**
 * A SECOND tenant, used only by the pagination case.
 *
 * Not tidiness: the reaper's outcome counts are tenant-wide, so a pagination
 * assertion sharing a tenant with the reaping case counts that case's leftover
 * rows too — and then a mutation to the reaper's `where` reddens BOTH tests,
 * which makes neither of them a sole detector of the thing it names.
 */
const TENANT_B = `fib-${SUITE}`;
const USER = `u-${TENANT}`;

/** Workflow whose middle step throws AND declares itself isolable. */
const ISOLATED_WF = `fi-isolated-${SUITE}`;
/** The same shape WITHOUT the declaration — the engine's original behaviour. */
const STRICT_WF = `fi-strict-${SUITE}`;
/** Isolable by declaration, but the throw is FATAL. The declaration must lose. */
const FATAL_WF = `fi-fatal-${SUITE}`;
/** No failing step at all — the sibling run whose progress must be untouched. */
const CLEAN_WF = `fi-clean-${SUITE}`;

const ctx = (agentId?: string) =>
    makeRequestContext('ADMIN', {
        tenantId: TENANT,
        tenantSlug: TENANT,
        userId: USER,
        ...(agentId ? { agentId } : {}),
    });

/** Registered agents seeded in `beforeAll`, in creation order. */
const agentIds: string[] = [];

/**
 * Backdate a run's LAST PROGRESS. `updatedAt` is `@updatedAt`, so Prisma
 * overwrites it on every write — raw SQL is the only way to say "this run has
 * not moved since". The reaper selects on progress rather than birth, so this is
 * what makes a fixture wedged.
 */
async function backdateProgress(ids: string[], at: Date): Promise<void> {
    if (ids.length === 0) return;
    await prisma.$executeRawUnsafe(
        `UPDATE "WorkflowRun" SET "updatedAt" = $1 WHERE "id" = ANY($2::text[])`,
        at,
        ids,
    );
}

describeFn('agentic failure isolation (real DB)', () => {
    beforeAll(async () => {
        await prisma.$connect();
        for (const t of [TENANT, TENANT_B]) {
            await prisma.tenant.upsert({
                where: { id: t },
                update: {},
                create: { id: t, name: t, slug: t },
            });
        }
        const email = `${TENANT}@example.test`;
        await prisma.user.upsert({
            where: { id: USER },
            update: {},
            create: { id: USER, email, emailHash: hashForLookup(email) },
        });
        // The principal every background sweep writes its audit rows under.
        // `AuditLog.userId` is a real FK, so the reaper's audit write needs the
        // row to exist — in production it does; here the suite makes it so.
        await prisma.user.upsert({
            where: { id: 'system' },
            update: {},
            create: {
                id: 'system',
                email: 'system@inflect.test',
                emailHash: hashForLookup('system@inflect.test'),
            },
        });

        // Three agents. `RegisteredAgent` is one-per-`AiSystem`, so each needs
        // its own host row.
        for (let i = 0; i < 3; i++) {
            const aiSystem = await prisma.aiSystem.create({
                data: { tenantId: TENANT, name: `${TENANT}-host-${i}`, ownerUserId: USER },
            });
            const agent = await prisma.registeredAgent.create({
                data: {
                    tenantId: TENANT,
                    aiSystemId: aiSystem.id,
                    name: `${TENANT}-agent-${i}`,
                    autonomyLevel: 1,
                    dataAccessScope: 'READ_TENANT_DATA',
                    reversibility: 'REVERSIBLE',
                    provenance: 'FIRST_PARTY',
                    ownerUserId: USER,
                },
            });
            agentIds.push(agent.id);
        }

        const boom = () => {
            throw new Error('deliberate step failure');
        };
        registerWorkflow({
            key: ISOLATED_WF,
            name: 'isolated',
            description: 'read → a step that fails and is isolated → synthesis',
            steps: [
                { kind: 'READ', label: 'posture', tool: 'get_compliance_posture' },
                { kind: 'SYNTHESIS', label: 'flaky', synthesize: boom, continueOnFailure: true },
                { kind: 'SYNTHESIS', label: 'after', synthesize: () => ({ text: 'ran after the failure' }) },
            ],
        });
        registerWorkflow({
            key: STRICT_WF,
            name: 'strict',
            description: 'the same shape without the isolation declaration',
            steps: [
                { kind: 'READ', label: 'posture', tool: 'get_compliance_posture' },
                { kind: 'SYNTHESIS', label: 'flaky', synthesize: boom },
                { kind: 'SYNTHESIS', label: 'after', synthesize: () => ({ text: 'must not run' }) },
            ],
        });
        registerWorkflow({
            key: FATAL_WF,
            name: 'fatal',
            description: 'declares itself isolable, then throws something fatal',
            steps: [
                { kind: 'READ', label: 'posture', tool: 'get_compliance_posture' },
                {
                    kind: 'SYNTHESIS',
                    label: 'killed',
                    continueOnFailure: true,
                    synthesize: () => {
                        throw new AgenticFatalError('AGENT_KILLED');
                    },
                },
                { kind: 'SYNTHESIS', label: 'after', synthesize: () => ({ text: 'must not run' }) },
            ],
        });
        registerWorkflow({
            key: CLEAN_WF,
            name: 'clean',
            description: 'a run with nothing wrong with it',
            steps: [
                { kind: 'READ', label: 'posture', tool: 'get_compliance_posture' },
                { kind: 'SYNTHESIS', label: 'summary', synthesize: () => ({ text: 'clean run' }) },
            ],
        });
    }, 60_000);

    afterAll(async () => {
        for (const t of [TENANT, TENANT_B]) {
            await prisma.workflowStep.deleteMany({ where: { tenantId: t } }).catch(() => {});
            await prisma.workflowRun.deleteMany({ where: { tenantId: t } }).catch(() => {});
            await prisma.registeredAgent.deleteMany({ where: { tenantId: t } }).catch(() => {});
            await prisma.aiSystem.deleteMany({ where: { tenantId: t } }).catch(() => {});
        }
        await prisma.$disconnect();
    });

    // ── 1. One failing step ─────────────────────────────────────────

    it('an isolated step failure does NOT abort its sibling steps, and the run says how many failed', async () => {
        const clean = await startWorkflowRun(ctx(agentIds[0]), CLEAN_WF, {});
        const result = await startWorkflowRun(ctx(agentIds[1]), ISOLATED_WF, {});

        // The run finished, and the step AFTER the failure ran.
        expect(result.status).toBe('COMPLETED');
        const run = await getWorkflowRun(ctx(agentIds[1]), result.runId);
        expect(run.status).toBe('COMPLETED');
        expect(run.steps.map((s) => `${s.seq}:${s.status}`)).toEqual([
            '0:DONE',
            '1:FAILED',
            '2:DONE',
        ]);

        // ISOLATION IS NOT SWALLOWING. The count rides out on the result the
        // caller already has, and the failed step is a durable row — a caller
        // that reads only `status` still cannot be told this was a clean run,
        // because `stepFailures` sits beside it.
        expect(result.stepFailures).toBe(1);

        // The run's progress is committed past the failure rather than stranded.
        expect(run.stepCount).toBe(3);

        // ANOTHER AGENT'S RUN, started immediately before, is untouched.
        expect(clean.status).toBe('COMPLETED');
        expect(clean.stepFailures).toBe(0);
        const cleanRun = await getWorkflowRun(ctx(agentIds[0]), clean.runId);
        expect(cleanRun.status).toBe('COMPLETED');
        expect(cleanRun.steps.every((s) => s.status === 'DONE')).toBe(true);
    }, 60_000);

    it('a step that did NOT declare isolation still ends the run — the default is unchanged', async () => {
        const result = await startWorkflowRun(ctx(agentIds[1]), STRICT_WF, {});
        expect(result.status).toBe('FAILED');
        // Nothing was ISOLATED: the run ended, so the isolated-failure count is
        // zero. A non-zero value here would mean the engine had quietly made
        // every step optional.
        expect(result.stepFailures).toBe(0);

        const run = await getWorkflowRun(ctx(agentIds[1]), result.runId);
        // The step after the failure never ran.
        expect(run.steps.map((s) => s.seq)).toEqual([0, 1]);
        expect(run.steps.find((s) => s.seq === 1)?.status).toBe('FAILED');
    }, 60_000);

    it('a FATAL failure ends the run even on a step that declared itself isolable', async () => {
        const result = await startWorkflowRun(ctx(agentIds[2]), FATAL_WF, {});
        expect(result.status).toBe('FAILED');
        expect(result.stepFailures).toBe(0);

        const run = await getWorkflowRun(ctx(agentIds[2]), result.runId);
        expect(run.steps.map((s) => s.seq)).toEqual([0, 1]);
    }, 60_000);

    // ── 2. One failing agent ────────────────────────────────────────

    it('a fan-out over many agents COMPLETES despite one throwing, and counts the one that did', async () => {
        // The middle agent asks for a workflow key nobody registered, which is
        // how a real fan-out member throws: a bad row, not a contrived stub.
        const members = [
            { agentId: agentIds[0], key: CLEAN_WF },
            { agentId: agentIds[1], key: `never-registered-${SUITE}` },
            { agentId: agentIds[2], key: CLEAN_WF },
        ];

        const outcome = await isolateEach(
            members,
            (m) => m.agentId,
            (m) => startWorkflowRun(ctx(m.agentId), m.key, {}),
        );

        expect(outcome.attempted).toBe(3);
        expect(outcome.succeeded).toBe(2);
        expect(outcome.failed).toBe(1);
        expect(outcome.unattempted).toBe(0);
        expect(outcome.halted).toBeNull();
        // The failure is NAMED, not merely counted — and it carries a class and
        // a digest, never the message.
        expect(outcome.failures.map((f) => f.key)).toEqual([agentIds[1]]);
        expect(outcome.failures[0].digest).toMatch(/^[0-9a-f]{16}$/);

        // The agent AFTER the throwing one really did its work, in the database.
        expect(outcome.results.map((r) => r.status)).toEqual(['COMPLETED', 'COMPLETED']);
        const lastAgentRuns = await prisma.workflowRun.count({
            where: { tenantId: TENANT, agentId: agentIds[2], workflowKey: CLEAN_WF },
        });
        expect(lastAgentRuns).toBeGreaterThanOrEqual(1);
    }, 90_000);

    it('a FATAL member halts the fan-out, and the outcome says how many were never attempted', async () => {
        const before = await prisma.workflowRun.count({ where: { tenantId: TENANT } });
        const members = [
            { agentId: agentIds[0], fatal: false },
            { agentId: agentIds[1], fatal: true },
            { agentId: agentIds[2], fatal: false },
        ];

        const outcome = await isolateEach(
            members,
            (m) => m.agentId,
            async (m) => {
                if (m.fatal) throw new AgenticFatalError('AGENT_KILLED');
                return startWorkflowRun(ctx(m.agentId), CLEAN_WF, {});
            },
        );

        expect(outcome.attempted).toBe(2);
        expect(outcome.succeeded).toBe(1);
        expect(outcome.halted?.kind).toBe('AGENT_KILLED');
        // A HALT IS ANNOUNCED, NEVER TRIMMED: the member that was never reached
        // is a number the caller is handed, not a silence.
        expect(outcome.unattempted).toBe(1);

        // And it really did stop — exactly one run was created, not two.
        const after = await prisma.workflowRun.count({ where: { tenantId: TENANT } });
        expect(after - before).toBe(1);
    }, 90_000);

    // ── 3. The enumeration ──────────────────────────────────────────

    it('the reaper settles every wedged run across every agent, and never one waiting on a human', async () => {
        const now = new Date();
        const wedgedAt = new Date(now.getTime() - ENGINE_CAPS.WALL_CLOCK_MS - 3_600_000);

        const wedged: string[] = [];
        for (let i = 0; i < 3; i++) {
            const row = await prisma.workflowRun.create({
                data: {
                    tenantId: TENANT,
                    workflowKey: CLEAN_WF,
                    status: 'RUNNING',
                    startedAt: wedgedAt,
                    agentId: agentIds[i],
                },
            });
            wedged.push(row.id);
        }
        await backdateProgress(wedged, wedgedAt);
        // Two rows that must survive: one parked for a human however old it is,
        // one genuinely in flight.
        const parked = await prisma.workflowRun.create({
            data: {
                tenantId: TENANT,
                workflowKey: CLEAN_WF,
                status: 'AWAITING_APPROVAL',
                startedAt: wedgedAt,
                agentId: agentIds[0],
            },
        });
        const live = await prisma.workflowRun.create({
            data: { tenantId: TENANT, workflowKey: CLEAN_WF, status: 'RUNNING', startedAt: now, agentId: agentIds[0] },
        });

        const { result, outcome } = await runAgentRunReaperJob({ tenantId: TENANT, now });

        expect(outcome.runsFound).toBe(3);
        expect(outcome.agentsFound).toBe(3);
        expect(outcome.runsReaped).toBe(3);
        expect(outcome.agentsFailed).toBe(0);
        expect(outcome.halted).toBeNull();
        expect(result.success).toBe(true);

        const reaped = await prisma.workflowRun.findMany({
            where: { id: { in: wedged } },
            select: { status: true, errorMessage: true, completedAt: true },
        });
        expect(reaped.map((r) => r.status)).toEqual(['FAILED', 'FAILED', 'FAILED']);
        expect(reaped.every((r) => r.errorMessage === REAP_REASON)).toBe(true);
        expect(reaped.every((r) => r.completedAt !== null)).toBe(true);

        // Untouched.
        const survivors = await prisma.workflowRun.findMany({
            where: { id: { in: [parked.id, live.id] } },
            select: { id: true, status: true },
            orderBy: { id: 'asc' },
        });
        expect(survivors.find((s) => s.id === parked.id)?.status).toBe('AWAITING_APPROVAL');
        expect(survivors.find((s) => s.id === live.id)?.status).toBe('RUNNING');
    }, 90_000);

    it('the reaper walks PAST a full page — a prefix is not a finished sweep', async () => {
        const now = new Date();
        const wedgedAt = new Date(now.getTime() - ENGINE_CAPS.WALL_CLOCK_MS - 3_600_000);
        const ids: string[] = [];
        for (let i = 0; i < 5; i++) {
            const row = await prisma.workflowRun.create({
                // A tenant of its own, and `agentId: null` — a pre-register run,
                // which the reaper groups under a single key. What is under test
                // here is the ENUMERATION, so the grouping is deliberately trivial.
                data: {
                    tenantId: TENANT_B,
                    workflowKey: CLEAN_WF,
                    status: 'RUNNING',
                    startedAt: wedgedAt,
                },
            });
            ids.push(row.id);
        }
        await backdateProgress(ids, wedgedAt);

        // A page size SMALLER than the result set. A `take:` cap here would
        // settle two rows and report a clean pass; the cursor walk settles all
        // five.
        const { outcome } = await runAgentRunReaperJob({ tenantId: TENANT_B, now, pageSize: 2 });

        expect(outcome.runsFound).toBe(5);
        expect(outcome.runsReaped).toBe(5);
        const left = await prisma.workflowRun.count({
            where: { id: { in: ids }, status: 'RUNNING' },
        });
        expect(left).toBe(0);
    }, 90_000);

    describe('the reaper asks about PROGRESS, not about birth', () => {
        it('leaves a resumed run alone, however old its startedAt is', async () => {
            // The reaper used to select on `startedAt`, which never moves — a resume
            // flips the row back to RUNNING and deliberately leaves it, because
            // WALL_CLOCK_MS spans resumes and an audit reads that field as when the
            // run began. So a run that parked at a checkpoint longer than the cutoff
            // was reapable from the FIRST MILLISECOND of its post-approval segment,
            // and both shipped workflows carry a HUMAN_CHECKPOINT. The sweep settled
            // live, executing runs and wrote a permanent hash-chained row asserting
            // they had no executor.
            const now = new Date();
            const longAgo = new Date(now.getTime() - ENGINE_CAPS.WALL_CLOCK_MS - 3 * 60 * 60 * 1000);

            // A run BORN long ago that is making progress right now: exactly the
            // shape a resume produces.
            const resumed = await prisma.workflowRun.create({
                data: {
                    tenantId: TENANT,
                    workflowKey: CLEAN_WF,
                    status: 'RUNNING',
                    startedAt: longAgo,
                    agentId: agentIds[0],
                },
            });
            // `updatedAt` is `@updatedAt`, so touching the row is what a step does.
            await prisma.workflowRun.update({
                where: { id: resumed.id },
                data: { stepCount: 1 },
            });

            const { outcome } = await runAgentRunReaperJob({ tenantId: TENANT, now });

            expect(outcome.runsFound).toBe(0);
            expect(outcome.runsReaped).toBe(0);

            const after = await prisma.workflowRun.findFirstOrThrow({ where: { id: resumed.id } });
            expect(after.status).toBe('RUNNING');
            expect(after.errorMessage).toBeNull();
        }, 60_000);
    });
});

