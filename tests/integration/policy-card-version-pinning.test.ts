/**
 * The policy-card version PIN — what a run and a proposal record about the
 * rules they executed under, and why it cannot be rewritten.
 *
 * `AgentPolicyCardVersion` is already immutable. That is only half of the
 * evidence: a pointer INTO immutable state is still worthless if the pointer
 * itself can move, and reading "the agent's card" at review time answers what
 * the agent may do NOW — a different question from what it was allowed to do
 * THEN, and the two differ precisely when somebody has edited the card, which is
 * the case a review exists to find.
 *
 * So four properties, none of which a unit test can establish:
 *
 *   1. THE PIN IS WRITTEN, BY THE REAL PATH. A run started by an agent records
 *      the version in force; a proposal queued by that run's PROPOSE step
 *      records the version the tool boundary actually authorized it against.
 *      Both go through the engine, not through a hand-written row.
 *
 *   2. IT TRACKS THE HEAD, IT IS NOT A CONSTANT. A run started after the card
 *      moves to v2 records 2. Without this, every assertion of `1` below is
 *      equally consistent with a column hard-wired to 1 — the same defect one
 *      level down as an assertion that passes because nothing ran.
 *
 *   3. IT SURVIVES THE EDIT. After the card moves to v2, the v1 run and the v1
 *      proposal still report 1.
 *
 *   4. REWRITING IT FAILS, WHILE ORDINARY UPDATES DO NOT. Both tables are
 *      updated constantly on the normal path — a run moves RUNNING →
 *      AWAITING_APPROVAL → COMPLETED, a proposal moves PENDING → APPROVED — so
 *      immutability here CANNOT be "no UPDATE" the way it is on the version
 *      table. It is a column-level write-once trigger, and a test that only
 *      proved the refusal would pass just as well against a trigger that had
 *      broken the engine.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { registerWorkflow } from '@/lib/agentic/workflow-registry';
import { startWorkflowRun, getWorkflowRun } from '@/app-layer/usecases/workflow-runs';
import { createRegisteredAgent } from '@/app-layer/usecases/agent-registry';
import {
    createAgentPolicyCard,
    updateAgentPolicyCard,
} from '@/app-layer/usecases/agent-policy-card';
import { NO_POLICY_CARD } from '@/lib/agentic/policy-card';
import { makeRequestContext } from '../helpers/make-context';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(60_000);

const SUITE = `pin-${randomUUID().slice(0, 8)}`;
const TENANT = `t-${SUITE}`;
const USER = `u-${SUITE}`;
const WF = `pin-wf-${SUITE}`;

/** The two tools the workflow reaches. Granted, then seeded into the card. */
const READ_TOOL = 'get_compliance_posture';
const PROPOSE_TOOL = 'propose_risks';

/**
 * Every escalation trigger, spelled out on every edit below.
 *
 * DROPPING one is a WIDENING — the card stops asking to be told — so an edit
 * that quietly shortened this list would be refused by the ladder for a reason
 * that has nothing to do with what the test is about.
 */
const ALL_TRIGGERS = [
    'TOOL_NOT_PERMITTED',
    'DATA_SCOPE_EXCEEDED',
    'AUTONOMY_EXCEEDED',
    'RUN_ACTION_CAP_EXCEEDED',
    'DAILY_ACTION_CAP_EXCEEDED',
] as const;

let agentId = '';

/** The context an AGENT-driven run arrives on: a principal plus a binding. */
const agentCtx = () =>
    makeRequestContext('ADMIN', {
        tenantId: TENANT,
        tenantSlug: TENANT,
        userId: USER,
        agentId,
    });

/** The context a HUMAN-driven run arrives on: no binding at all. */
const humanCtx = () =>
    makeRequestContext('ADMIN', { tenantId: TENANT, tenantSlug: TENANT, userId: USER });

describeFn('the policy-card version pin (real DB, real engine)', () => {
    beforeAll(async () => {
        await prisma.$connect();
        await prisma.tenant.upsert({
            where: { id: TENANT },
            update: {},
            create: { id: TENANT, name: TENANT, slug: TENANT },
        });
        const email = `${TENANT}@example.test`;
        await prisma.user.upsert({
            where: { id: USER },
            update: {},
            create: { id: USER, email, emailHash: hashForLookup(email) },
        });
        await prisma.tenantMembership.upsert({
            where: { tenantId_userId: { tenantId: TENANT, userId: USER } },
            update: { role: 'OWNER', status: 'ACTIVE' },
            create: { tenantId: TENANT, userId: USER, role: 'OWNER', status: 'ACTIVE' },
        });
        const aiSystem = await prisma.aiSystem.create({
            data: { tenantId: TENANT, name: `Host ${SUITE}`, ownerUserId: USER },
        });

        const agent = await createRegisteredAgent(agentCtxWithoutBinding(), {
            aiSystemId: aiSystem.id,
            name: `Pinned agent ${SUITE}`,
            autonomyLevel: 3,
            // WRITE_TENANT_DATA because the workflow PROPOSES, and a propose
            // tool's base data rung is WRITE_TENANT_DATA. The card seeds its
            // ceiling from this axis, so a narrower agent would have its own
            // card refuse the propose step — a refusal about fixture data
            // rather than about pinning.
            dataAccessScope: 'WRITE_TENANT_DATA',
            reversibility: 'COMPENSABLE',
            provenance: 'FIRST_PARTY',
            ownerUserId: USER,
        });
        agentId = agent.id;

        // ACTIVE + scored, set directly. Activation and scoring have their own
        // suites; here they are preconditions. An agent that is not ACTIVE
        // resolves to NO agent at the gate, which would mean no card, which
        // would make every assertion below read `null` for the wrong reason.
        await prisma.registeredAgent.update({
            where: { id: agentId },
            data: { status: 'ACTIVE', riskTier: 'LOW', riskTierScoredAt: new Date() },
        });

        for (const toolName of [READ_TOOL, PROPOSE_TOOL]) {
            await prisma.registeredAgentTool.create({
                data: { tenantId: TENANT, agentId, toolName, grantedByUserId: USER },
            });
        }

        // v1, seeded from the grants above and from the LOW tier.
        await createAgentPolicyCard(agentCtx(), agentId);

        registerWorkflow({
            key: WF,
            name: 'Pin fixture workflow',
            description: 'read → propose → checkpoint → synthesis',
            steps: [
                { kind: 'READ', label: 'posture', tool: READ_TOOL },
                {
                    kind: 'PROPOSE',
                    label: 'proposed',
                    tool: PROPOSE_TOOL,
                    buildItems: () => [
                        { title: `Pinned risk ${SUITE}`, description: 'from a pinned run' },
                    ],
                },
                { kind: 'HUMAN_CHECKPOINT', label: 'review' },
                { kind: 'SYNTHESIS', label: 'summary', synthesize: () => ({ text: 'done' }) },
            ],
        });
    });

    afterAll(async () => {
        if (TENANT) {
            await prisma.workflowStep.deleteMany({ where: { tenantId: TENANT } }).catch(() => {});
            await prisma.workflowRun.deleteMany({ where: { tenantId: TENANT } }).catch(() => {});
            await prisma.agentProposal.deleteMany({ where: { tenantId: TENANT } }).catch(() => {});
            await prisma.agentPolicyCardVersion.deleteMany({ where: { tenantId: TENANT } }).catch(() => {});
            await prisma.agentPolicyCard.deleteMany({ where: { tenantId: TENANT } }).catch(() => {});
            await prisma.registeredAgentTool.deleteMany({ where: { tenantId: TENANT } }).catch(() => {});
            await prisma.registeredAgent.deleteMany({ where: { tenantId: TENANT } }).catch(() => {});
            await prisma.aiSystem.deleteMany({ where: { tenantId: TENANT } }).catch(() => {});
            await prisma.risk.deleteMany({ where: { tenantId: TENANT } }).catch(() => {});
            await prisma.$transaction(async (tx) => {
                await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
                await tx.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE "tenantId" = $1`, TENANT);
                await tx.$executeRawUnsafe(
                    `DELETE FROM "TenantMembership" WHERE "tenantId" = $1`,
                    TENANT,
                );
            }).catch(() => {});
            await prisma.tenant.deleteMany({ where: { id: TENANT } }).catch(() => {});
            await prisma.user.deleteMany({ where: { id: USER } }).catch(() => {});
        }
        await prisma.$disconnect();
    });

    // Captured by the first test and read by the ones after it. They are a
    // single sequence — a run made under v1, then the card moved on — so the
    // ordering is real rather than incidental, and each stage re-reads from the
    // database rather than trusting the previous stage's return value.
    let v1RunId = '';
    let v1ProposalId = '';

    it('an agent-driven run and its proposal both record the version in force (v1)', async () => {
        const started = await startWorkflowRun(agentCtx(), WF, {});
        v1RunId = started.runId;
        // The run actually RAN — it reached the checkpoint after the propose
        // step. Without this the pin assertions would hold just as well on a
        // run that failed at step one, which is not "executed under v1".
        expect(started.status).toBe('AWAITING_APPROVAL');

        const run = await getWorkflowRun(agentCtx(), v1RunId);
        expect(run.agentId).toBe(agentId);
        expect(run.policyCardVersion).toBe(1);

        const proposal = await prisma.agentProposal.findFirstOrThrow({
            where: { tenantId: TENANT, agentId },
        });
        v1ProposalId = proposal.id;
        // The proposal's pin comes from the INVOCATION the tool boundary
        // authorized, not from a re-read — so it is the version that allowed
        // the call rather than the version in force a moment later.
        expect(proposal.policyCardVersion).toBe(1);
    });

    it('a HUMAN-started run records NO card, which is not the same as recording nothing', async () => {
        const started = await startWorkflowRun(humanCtx(), 'diagnostic', {});
        const run = await getWorkflowRun(humanCtx(), started.runId);

        expect(run.agentId).toBeNull();
        // The sentinel, not NULL. NULL is reserved for a row written before
        // pinning existed; this row says the question was asked and the answer
        // was "no card governed this". An operator can act on the difference.
        expect(run.policyCardVersion).toBe(NO_POLICY_CARD);
        expect(run.policyCardVersion).not.toBeNull();
    });

    it('the pin survives the card moving to v2 — and the NEW run gets v2', async () => {
        // A NARROWING (one rung down on the per-run budget), so the ladder has
        // nothing to say about it: this test is about the pin, not the ladder.
        const edited = await updateAgentPolicyCard(agentCtx(), agentId, {
            expectedVersion: 1,
            card: {
                permittedTools: [READ_TOOL, PROPOSE_TOOL],
                maxDataScope: 'WRITE_TENANT_DATA',
                maxAutonomyLevel: 4,
                maxActionsPerRun: 25,
                maxActionsPerDay: 500,
                escalationTriggers: [...ALL_TRIGGERS],
                approvalRung: 'SINGLE_APPROVER',
            },
        });
        expect(edited.version).toBe(2);

        // 3 — the v1 records are unchanged.
        const oldRun = await prisma.workflowRun.findUniqueOrThrow({ where: { id: v1RunId } });
        expect(oldRun.policyCardVersion).toBe(1);
        const oldProposal = await prisma.agentProposal.findUniqueOrThrow({
            where: { id: v1ProposalId },
        });
        expect(oldProposal.policyCardVersion).toBe(1);

        // 2 — and the pin is READ, not a constant. This is the assertion that
        // separates "the pin works" from "the column happens to be 1".
        const after = await startWorkflowRun(agentCtx(), WF, {});
        const newRun = await getWorkflowRun(agentCtx(), after.runId);
        expect(newRun.policyCardVersion).toBe(2);
        const newProposal = await prisma.agentProposal.findFirstOrThrow({
            where: { tenantId: TENANT, agentId, policyCardVersion: 2 },
        });
        expect(newProposal.policyCardVersion).toBe(2);
    });

    it('ORDINARY updates to a pinned row still work — the trigger is column-scoped', async () => {
        // The half a refusal test cannot cover. A blanket UPDATE ban would pass
        // every assertion in the next test and take the engine down with it:
        // the v1 run below already moved RUNNING → AWAITING_APPROVAL with its
        // pin set, and its step count was rewritten on the way.
        const before = await prisma.workflowRun.findUniqueOrThrow({ where: { id: v1RunId } });
        expect(before.status).toBe('AWAITING_APPROVAL');
        expect(before.stepCount).toBeGreaterThan(0);

        await prisma.workflowRun.update({
            where: { id: v1RunId },
            data: { summary: 'a later edit that has nothing to do with the pin' },
        });
        const after = await prisma.workflowRun.findUniqueOrThrow({ where: { id: v1RunId } });
        expect(after.summary).toBe('a later edit that has nothing to do with the pin');
        expect(after.policyCardVersion).toBe(1);

        // Restating the pin as itself is not a rewrite, and must not be refused
        // — an ordinary update that happens to include the column in its SET
        // list would otherwise fail for no reason anybody could act on.
        await expect(
            prisma.agentProposal.update({
                where: { id: v1ProposalId },
                data: { status: 'REJECTED', policyCardVersion: 1 },
            }),
        ).resolves.toBeTruthy();
    });

    it('REWRITING the pin fails, on both tables and in both directions', async () => {
        await expect(
            prisma.workflowRun.update({
                where: { id: v1RunId },
                data: { policyCardVersion: 2 },
            }),
        ).rejects.toThrow(/IMMUTABLE_POLICY_CARD_PIN/);

        await expect(
            prisma.agentProposal.update({
                where: { id: v1ProposalId },
                data: { policyCardVersion: 99 },
            }),
        ).rejects.toThrow(/IMMUTABLE_POLICY_CARD_PIN/);

        // Erasing it is a rewrite too, and the more attractive one: a NULL pin
        // reads as "predates pinning", so clearing the column would not look
        // like tampering in a diff — it would look like an old row.
        await expect(
            prisma.workflowRun.update({
                where: { id: v1RunId },
                data: { policyCardVersion: null },
            }),
        ).rejects.toThrow(/IMMUTABLE_POLICY_CARD_PIN/);

        // And nothing landed.
        const run = await prisma.workflowRun.findUniqueOrThrow({ where: { id: v1RunId } });
        expect(run.policyCardVersion).toBe(1);
        const proposal = await prisma.agentProposal.findUniqueOrThrow({
            where: { id: v1ProposalId },
        });
        expect(proposal.policyCardVersion).toBe(1);
    });

    it('a NULL pin may be filled in ONCE — the only transition the trigger allows', async () => {
        // The pre-pinning rows this migration deliberately did not backfill.
        // Refusing to let them be filled in would make the backfill impossible
        // to ever run; letting them be REwritten would make the pin worthless.
        // One direction, once.
        const legacyId = `legacy-run-${SUITE}`;
        await prisma.$executeRawUnsafe(
            `INSERT INTO "WorkflowRun" ("id","tenantId","workflowKey","status","startedAt","createdAt","updatedAt")
             VALUES ($1,$2,'diagnostic','COMPLETED',NOW(),NOW(),NOW())`,
            legacyId,
            TENANT,
        );
        const legacy = await prisma.workflowRun.findUniqueOrThrow({ where: { id: legacyId } });
        expect(legacy.policyCardVersion).toBeNull();

        await prisma.workflowRun.update({
            where: { id: legacyId },
            data: { policyCardVersion: 1 },
        });
        expect(
            (await prisma.workflowRun.findUniqueOrThrow({ where: { id: legacyId } }))
                .policyCardVersion,
        ).toBe(1);

        // …and once only.
        await expect(
            prisma.workflowRun.update({
                where: { id: legacyId },
                data: { policyCardVersion: 2 },
            }),
        ).rejects.toThrow(/IMMUTABLE_POLICY_CARD_PIN/);
    });
});

/**
 * The context used to REGISTER the agent, before its id exists.
 *
 * Separate from `agentCtx()` for a reason that is not cosmetic: `agentCtx()`
 * closes over `agentId`, which is empty at that moment, and passing an empty
 * binding to the register would exercise a state no real caller produces.
 */
function agentCtxWithoutBinding() {
    return makeRequestContext('ADMIN', {
        tenantId: TENANT,
        tenantSlug: TENANT,
        userId: USER,
    });
}
