/**
 * EU AI Act Art 14 — a human decision on a RUN reaches the run's decision rows.
 *
 * ── THE GAP THIS CLOSES ─────────────────────────────────────────────────────
 *
 * Plan point 4 is "one decision-log row per model call (Art 12); stamp
 * `humanOutcome` on review (Art 14), closed loop". The Art 12 half shipped for
 * the Flue engine; the Art 14 half could not reach the rows it wrote.
 *
 * `recordDecisionOutcomeForDigest` matches on `inputDigest`, and all three of
 * its call sites pass `AgentProposal.guardInputDigest` — a digest over
 * `{ kind, payload, rationale }`. The Flue row's digest is over the dispatched
 * run PROMPT. Two `sha256:` strings of identical shape over different content,
 * which never match. `updateMany` reports `count: 0` and raises nothing, so
 * every `agentic-run:*` row stayed PENDING for ever while the loop looked
 * closed.
 *
 * ── WHY THIS SUITE COMPUTES BOTH SIDES ──────────────────────────────────────
 *
 * That is exactly the failure a test which asserts "the stamper is called"
 * cannot see: it WAS called, with a key that addressed nothing. So nothing
 * here asserts a call. Every test writes the row through the REAL recorder
 * (`recordModelDecision`, the function `executeFlueRun` calls), performs the
 * REAL human action (`resumeWorkflowRun` / `abortWorkflowRun`), and then reads
 * the row back to see where it landed. The first test additionally computes
 * BOTH digests with the product's own functions and asserts they disagree —
 * pinning the trap itself, so a future author who "unifies the keys" is told
 * why they cannot.
 *
 * The run here is walked by the STATIC driver, because the Flue engine needs an
 * ESM runtime and a model that no CJS suite can load. That costs nothing the
 * claim depends on: the join key is the run id, `recordModelDecision` takes it
 * as an argument, and `resumeWorkflowRun` / `abortWorkflowRun` are one
 * implementation for every engine.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { registerWorkflow, getWorkflowDefinition } from '@/lib/agentic/workflow-registry';
import {
    startWorkflowRun,
    resumeWorkflowRun,
    abortWorkflowRun,
} from '@/app-layer/usecases/workflow-runs';
import { recordModelDecision } from '@/lib/agentic/flue/model-decision';
import { computeInputDigest, recordDecisionOutcomeForDigest } from '@/app-layer/ai/decision-log';
import { guardAgentProposal } from '@/app-layer/ai/guard/proposal-guard';
import { runInTenantContext } from '@/lib/db/rls-middleware';
import { makeRequestContext } from '../helpers/make-context';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(60_000);

const SUITE = `art14run-${randomUUID().slice(0, 8)}`;
const TENANT = `t-${SUITE}`;
const OTHER = `o-${SUITE}`;
const USER = `u-${SUITE}`;
const CHECKPOINT_WF = `art14-checkpoint-${SUITE}`;

const ctx = () => makeRequestContext('ADMIN', { tenantId: TENANT, tenantSlug: TENANT, userId: USER });
const otherCtx = () => makeRequestContext('ADMIN', { tenantId: OTHER, tenantSlug: OTHER, userId: USER });

const MODEL = 'anthropic/claude-sonnet-4';
const USAGE = { tokensIn: 120, tokensOut: 40 };

/** Write the Art 12 row the Flue engine writes, through the engine's own function. */
async function recordFor(
    context: ReturnType<typeof ctx>,
    runId: string,
    message: string,
): Promise<void> {
    const def = getWorkflowDefinition(CHECKPOINT_WF)!;
    await recordModelDecision(context, runId, def, message, 'a reply', USAGE, MODEL);
}

const rowsFor = (tenantId: string, runId: string) =>
    prisma.aiDecisionLog.findMany({
        where: { tenantId, sessionRef: runId },
        orderBy: { createdAt: 'asc' },
        select: { id: true, sessionRef: true, inputDigest: true, humanOutcome: true, feature: true },
    });

describeFn('Art 14 closes on the run a human actually reviews', () => {
    beforeAll(async () => {
        await prisma.$connect();
        for (const t of [TENANT, OTHER]) {
            await prisma.tenant.upsert({
                where: { id: t },
                update: {},
                create: { id: t, name: t, slug: t },
            });
        }
        const email = `${USER}@example.test`;
        await prisma.user.upsert({
            where: { id: USER },
            update: {},
            create: { id: USER, email, emailHash: hashForLookup(email) },
        });
        // READ → HUMAN_CHECKPOINT → SYNTHESIS. Starting it parks the run at
        // AWAITING_APPROVAL, which is the state a human resumes or aborts —
        // the same state a guard-FLAGGED Flue run is settled into by
        // `haltRunAtGuard`.
        registerWorkflow({
            key: CHECKPOINT_WF,
            name: 'Art 14 checkpoint workflow',
            description: 'read → checkpoint → synthesis',
            steps: [
                { kind: 'READ', label: 'posture', tool: 'get_compliance_posture' },
                { kind: 'HUMAN_CHECKPOINT', label: 'review' },
                { kind: 'SYNTHESIS', label: 'summary', synthesize: () => ({ text: 'done' }) },
            ],
        });
    });

    afterAll(async () => {
        if (TENANT && OTHER) {
            // The suite's own rows only, and NOT the tenants — same shape as
            // `agentic-engine.test.ts`, for the reason that suite found first:
            // a run writes hash-chained `AuditLog` rows, `AuditLog_tenantId_fkey`
            // is RESTRICT, and the chain is referenced so the audit rows cannot
            // be deleted either. The tenant ids carry a per-run uuid, so what
            // is left behind collides with nothing.
            await prisma.aiDecisionLog.deleteMany({ where: { tenantId: { in: [TENANT, OTHER] } } });
            await prisma.workflowStep.deleteMany({ where: { tenantId: { in: [TENANT, OTHER] } } });
            await prisma.workflowRun.deleteMany({ where: { tenantId: { in: [TENANT, OTHER] } } });
            await prisma.user.deleteMany({ where: { id: USER } });
        }
        await prisma.$disconnect();
    });

    it('a RESUME stamps ACCEPTED on every segment, keyed on the run and not on either digest', async () => {
        const started = await startWorkflowRun(ctx(), CHECKPOINT_WF, {});
        expect(started.status).toBe('AWAITING_APPROVAL');

        // TWO segments with DIFFERENT prompts — a run with a checkpoint
        // dispatches once per segment, so the rows genuinely carry different
        // digests and a digest-keyed stamp could at best reach one of them.
        const messageA = 'segment one: cover steps 1-2';
        const messageB = 'segment two: cover step 3';
        await recordFor(ctx(), started.runId, messageA);
        await recordFor(ctx(), started.runId, messageB);

        const before = await rowsFor(TENANT, started.runId);
        expect(before).toHaveLength(2);
        expect(before.every((r) => r.humanOutcome === 'PENDING')).toBe(true);
        expect(before.every((r) => r.feature === `agentic-run:${CHECKPOINT_WF}`)).toBe(true);

        // ── BOTH SIDES, COMPUTED ────────────────────────────────────────────
        //
        // The WRITE side's key, read back out of the database, against the
        // value the READ side is about to be handed. Asserted as a set so two
        // rows agreeing on the wrong id cannot pass.
        expect(new Set(before.map((r) => r.sessionRef))).toEqual(new Set([started.runId]));

        // And the digests, which are what the finding was about. Each row's
        // `inputDigest` is the digest of ITS OWN prompt, the two differ, and
        // neither equals the digest the proposal path computes over proposal
        // content — so the key the three existing stampers use addresses
        // nothing here, by construction rather than by accident.
        expect(before.map((r) => r.inputDigest)).toEqual([
            computeInputDigest(messageA),
            computeInputDigest(messageB),
        ]);
        expect(before[0].inputDigest).not.toEqual(before[1].inputDigest);
        const proposalDigest = guardAgentProposal({
            kind: 'RISK',
            payload: { title: 'a proposed risk', description: messageA },
            rationale: messageA,
        }).inputDigest;
        expect([before[0].inputDigest, before[1].inputDigest]).not.toContain(proposalDigest);

        // The negative control, run against the REAL digest stamper: the key
        // the proposal path would use reaches zero of these rows.
        const digestStamped = await runInTenantContext(ctx(), (db) =>
            recordDecisionOutcomeForDigest(db, ctx(), proposalDigest, 'ACCEPTED'),
        );
        expect(digestStamped).toBe(0);

        // ── THE HUMAN ACTION ────────────────────────────────────────────────
        const resumed = await resumeWorkflowRun(ctx(), started.runId);
        expect(resumed.status).toBe('COMPLETED');

        const after = await rowsFor(TENANT, started.runId);
        expect(after.map((r) => r.humanOutcome)).toEqual(['ACCEPTED', 'ACCEPTED']);
    });

    it('an ABORT stamps REJECTED', async () => {
        const started = await startWorkflowRun(ctx(), CHECKPOINT_WF, {});
        await recordFor(ctx(), started.runId, 'the aborted run prompt');
        expect((await rowsFor(TENANT, started.runId))[0].humanOutcome).toBe('PENDING');

        await abortWorkflowRun(ctx(), started.runId);

        const after = await rowsFor(TENANT, started.runId);
        expect(after.map((r) => r.humanOutcome)).toEqual(['REJECTED']);
    });

    it('the stamp reaches THIS run only — not a sibling run, not another tenant', async () => {
        const target = await startWorkflowRun(ctx(), CHECKPOINT_WF, {});
        const sibling = await startWorkflowRun(ctx(), CHECKPOINT_WF, {});
        await recordFor(ctx(), target.runId, 'the reviewed run');
        await recordFor(ctx(), sibling.runId, 'a run nobody touched');

        // Another TENANT's row carrying the SAME run id — the id is a cuid and
        // will not collide in life, but the filter must be scoped by tenant
        // rather than trusting that.
        await recordFor(otherCtx(), target.runId, 'the reviewed run');

        await abortWorkflowRun(ctx(), target.runId);

        expect((await rowsFor(TENANT, target.runId)).map((r) => r.humanOutcome)).toEqual(['REJECTED']);
        expect((await rowsFor(TENANT, sibling.runId)).map((r) => r.humanOutcome)).toEqual(['PENDING']);
        expect((await rowsFor(OTHER, target.runId)).map((r) => r.humanOutcome)).toEqual(['PENDING']);
    });

    it('the stamp is ONE-WAY: an abort after a resume does not overwrite the acceptance', async () => {
        const started = await startWorkflowRun(ctx(), CHECKPOINT_WF, {});
        await recordFor(ctx(), started.runId, 'accepted at the checkpoint');
        await resumeWorkflowRun(ctx(), started.runId);
        expect((await rowsFor(TENANT, started.runId))[0].humanOutcome).toBe('ACCEPTED');

        // A run that has COMPLETED refuses the abort outright, which is the
        // first line of defence. The claim worth pinning is the second: the
        // stamp itself only moves PENDING rows, so even a reachable abort
        // could not rewrite a human's recorded acceptance.
        await expect(abortWorkflowRun(ctx(), started.runId)).rejects.toThrow(/already COMPLETED/);

        const stampedAgain = await runInTenantContext(ctx(), async (db) => {
            const res = await db.aiDecisionLog.updateMany({
                where: { tenantId: TENANT, sessionRef: started.runId, humanOutcome: 'PENDING' },
                data: { humanOutcome: 'REJECTED' },
            });
            return res.count;
        });
        expect(stampedAgain).toBe(0);
        expect((await rowsFor(TENANT, started.runId))[0].humanOutcome).toBe('ACCEPTED');
    });
});
