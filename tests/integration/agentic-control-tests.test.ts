/**
 * THE FOUR AGENTIC CHECKS, DRIVEN THROUGH THE REAL CONTROL-TEST RUNNER.
 *
 * Every case below goes through `runControlTestRunner` — the same function the
 * BullMQ executor calls — against a real database, so what is asserted is the
 * whole chain and not a check function in isolation:
 *
 *     ControlTestPlan(INTEGRATION, automationConfig.check)
 *       → the registered handler → one verdict
 *       → ControlTestRun(COMPLETED, PASS|FAIL) + Evidence + on FAIL a Finding
 *         bridged to the control through FindingEvidence.
 *
 * ═══ WHY EVERY CHECK IS ASSERTED IN BOTH DIRECTIONS ═══
 *
 * A control test that cannot fail is not a control test, and this repo has the
 * receipt: `tests/guards/item-29-status-buttons.test.ts` asserted that the
 * schema MENTIONED `status` and stayed green for months while the control
 * persisted nothing. So each of the four is run twice against the SAME plan,
 * the SAME control and the SAME tenant, differing only in one seeded breach —
 * and the FAIL half asserts the Finding exists, not merely that the verdict
 * changed. A check that returned FAIL without raising anything would satisfy
 * half of that and is exactly the failure worth catching.
 *
 * The breaches are chosen to be states the WRITE path cannot refuse:
 *
 *   • the policy-card data rung is narrowed on the REGISTER, which
 *     `assertDataScopeRaiseWithinDeclaration` deliberately allows (refusing the
 *     resulting value would block the edit that repairs it), so the card is
 *     left reaching further than the agent declares and nothing says so;
 *   • the agent is re-assessed UPWARDS, which lowers its autonomy ceiling under
 *     a card written when the ceiling was higher;
 *   • a pinned tool manifest stops matching the build;
 *   • five approvals land inside one minute;
 *   • the newest drill row says FAILED.
 *
 * Each is reachable without anybody doing anything illegal, which is what makes
 * a periodic check the only thing that can see it.
 *
 * ═══ AND WHY THE EMPTY TENANT IS ASSERTED AT ALL ═══
 *
 * A check that FAILS a tenant with no agents cries wolf at every customer who
 * has not adopted them; one that PASSES reports compliance nobody earned. The
 * last block asserts the third answer: INCONCLUSIVE with `Vacuous: yes` in the
 * evidence, no Finding, and — the part that makes it more than a label —
 * `Control.lastTested` still NULL, so the control keeps reading as due rather
 * than being credited by an empty run.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import {
    controlTestRunnerExecutor,
    runControlTestRunner,
    runnerHandlerRegistry,
} from '@/app-layer/jobs/control-test-runner';
import {
    registerAgenticControlTestHandler,
    AGENTIC_CHECKS,
    type AgenticCheckId,
} from '@/app-layer/services/agent-control-tests';
import { allToolDefinitions } from '@/lib/mcp/tool-definitions';
import { hashToolManifest } from '@/lib/mcp/tool-manifest';
import { ceilingForRiskTier } from '@/lib/agentic/autonomy-ceiling';
import { withholdingReasonForTool } from '@/lib/agentic/policy-card-evaluation';
import { MIN_REPORTABLE_SAMPLE } from '@/lib/agentic/automation-bias';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(180_000);

const SUITE = `actl-${randomUUID().slice(0, 8)}`;
const TENANT = `t-${SUITE}`;
const EMPTY_TENANT = `te-${SUITE}`;
const USER = `u-${SUITE}`;

/** The card the healthy fixture writes, and the register it must sit inside. */
const CARD_AUTONOMY = 2;
const CARD_TOOL = 'propose_risks';
const HEALTHY_TIER = 'LOW' as const;
/** `propose_risks` reaches this rung on EVERY call — see `baseDataScopeForTool`. */
const HEALTHY_SCOPE = 'WRITE_TENANT_DATA' as const;
/** One rung below it. Legal to narrow the register to; the card cannot follow. */
const NARROWED_SCOPE = 'READ_TENANT_DATA' as const;

let agentId = '';
let cardId = '';

// ─── Fixture helpers ────────────────────────────────────────────────

async function seedTenant(id: string): Promise<void> {
    await prisma.tenant.upsert({
        where: { id },
        update: {},
        create: { id, name: id, slug: id },
    });
}

/** A control plus an INTEGRATION plan selecting one check. Returns both ids. */
async function seedPlan(
    tenantId: string,
    check: AgenticCheckId,
    config: Record<string, unknown> = {},
): Promise<{ controlId: string; planId: string }> {
    const control = await prisma.control.create({
        data: { tenantId, name: `${check} control`, createdByUserId: USER },
    });
    const plan = await prisma.controlTestPlan.create({
        data: {
            tenantId,
            controlId: control.id,
            name: `${check} plan`,
            createdByUserId: USER,
            automationType: 'INTEGRATION',
            status: 'ACTIVE',
            schedule: '0 3 * * *',
            automationConfig: { check, ...config },
        },
    });
    return { controlId: control.id, planId: plan.id };
}

async function runPlan(tenantId: string, planId: string) {
    return runControlTestRunner({
        tenantId,
        testPlanId: planId,
        scheduledForIso: new Date().toISOString(),
        schedulerJobRunId: `${SUITE}-${randomUUID().slice(0, 8)}`,
    });
}

/** The auto-attached evidence body for a run. Plaintext — `content` is not encrypted. */
async function evidenceBodyFor(evidenceId: string | undefined): Promise<string> {
    if (!evidenceId) return '';
    const row = await prisma.evidence.findUnique({
        where: { id: evidenceId },
        select: { content: true },
    });
    return row?.content ?? '';
}

/** Insert one decided proposal with an exact propose→decide latency. */
async function seedDecidedProposal(input: {
    decidedAt: Date;
    latencySeconds: number;
    approved: boolean;
}): Promise<void> {
    await prisma.agentProposal.create({
        data: {
            tenantId: TENANT,
            agentId,
            kind: 'RISK',
            payloadJson: '{"title":"redacted"}',
            status: input.approved ? 'ACCEPTED' : 'REJECTED',
            reviewedByUserId: USER,
            reviewedAt: input.decidedAt,
            createdAt: new Date(input.decidedAt.getTime() - input.latencySeconds * 1000),
            policyCardVersion: 1,
        },
    });
}

describeFn('the four agentic checks run as control tests, and can fail', () => {
    beforeAll(async () => {
        await prisma.$connect();
        runnerHandlerRegistry._reset();
        registerAgenticControlTestHandler();

        await seedTenant(TENANT);
        await seedTenant(EMPTY_TENANT);

        const email = `${USER}@example.test`;
        await prisma.user.upsert({
            where: { id: USER },
            update: {},
            create: { id: USER, email, emailHash: hashForLookup(email) },
        });
        for (const t of [TENANT, EMPTY_TENANT]) {
            await prisma.tenantMembership.upsert({
                where: { tenantId_userId: { tenantId: t, userId: USER } },
                update: { role: 'OWNER', status: 'ACTIVE' },
                create: { tenantId: t, userId: USER, role: 'OWNER', status: 'ACTIVE' },
            });
        }

        const aiSystem = await prisma.aiSystem.create({
            data: { tenantId: TENANT, name: `${SUITE} host`, ownerUserId: USER },
        });
        const agent = await prisma.registeredAgent.create({
            data: {
                tenantId: TENANT,
                aiSystemId: aiSystem.id,
                name: `${SUITE} agent`,
                autonomyLevel: CARD_AUTONOMY,
                dataAccessScope: HEALTHY_SCOPE,
                reversibility: 'REVERSIBLE',
                provenance: 'FIRST_PARTY',
                ownerUserId: USER,
                status: 'ACTIVE',
                riskTier: HEALTHY_TIER,
                riskTierScoredAt: new Date(),
                // Older than the drill staleness window, so the
                // AWAITING_FIRST_DRILL grace period is not in play.
                createdAt: new Date(Date.now() - 30 * 24 * 3_600_000),
            },
        });
        agentId = agent.id;

        const card = await prisma.agentPolicyCard.create({
            data: { tenantId: TENANT, agentId, currentVersion: 1, createdByUserId: USER },
        });
        cardId = card.id;
        await prisma.agentPolicyCardVersion.create({
            data: {
                tenantId: TENANT,
                cardId,
                version: 1,
                permittedTools: [CARD_TOOL],
                maxDataScope: HEALTHY_SCOPE,
                maxAutonomyLevel: CARD_AUTONOMY,
                maxActionsPerRun: 10,
                maxActionsPerDay: 100,
                escalationTriggers: [],
                approvalRung: 'SINGLE_APPROVER',
                seeded: true,
                seededFromTier: HEALTHY_TIER,
                createdByUserId: USER,
            },
        });
    }, 180_000);

    afterAll(async () => {
        await prisma.$disconnect();
    });

    // ─────────────────────────────────────────────────────────────────
    // The fixture is only evidence if it is the shape this test claims.
    // ─────────────────────────────────────────────────────────────────

    it('the healthy card really is inside every ceiling it is measured against', () => {
        // If either of these stopped being true the PASS halves below would be
        // passing for the wrong reason, and nothing else in the file would say
        // so — the classic "the test is green because the fixture drifted".
        expect(CARD_AUTONOMY).toBeLessThanOrEqual(ceilingForRiskTier(HEALTHY_TIER));
        expect(
            withholdingReasonForTool(CARD_TOOL, {
                maxDataScope: HEALTHY_SCOPE,
                maxAutonomyLevel: CARD_AUTONOMY,
            }),
        ).toBeNull();
    });

    // ─────────────────────────────────────────────────────────────────
    // 1. Policy-card conformance
    // ─────────────────────────────────────────────────────────────────

    describe('policy-card conformance', () => {
        let planId = '';
        let controlId = '';

        beforeAll(async () => {
            const seeded = await seedPlan(TENANT, 'AGENTIC_POLICY_CARD_CONFORMANCE');
            planId = seeded.planId;
            controlId = seeded.controlId;
        });

        afterEach(async () => {
            // Restore the register between breaches so each one is the ONLY
            // thing that differs from the healthy run.
            await prisma.registeredAgent.update({
                where: { id: agentId },
                data: {
                    dataAccessScope: HEALTHY_SCOPE,
                    riskTier: HEALTHY_TIER,
                    riskTierScoredAt: new Date(),
                },
            });
        });

        it('PASSES a card that still sits inside the register, and attests the control', async () => {
            const result = await runPlan(TENANT, planId);

            expect(result.runStatus).toBe('COMPLETED');
            expect(result.runResult).toBe('PASS');
            expect(result.findingCreated).toBe(false);

            const body = await evidenceBodyFor(result.evidenceId);
            expect(body).toContain('Verdict: PASS');
            expect(body).toContain('Basis: ALL_CARDS_CONFORMANT');
            expect(body).toContain('Vacuous: no');

            const control = await prisma.control.findUnique({
                where: { id: controlId },
                select: { lastTested: true },
            });
            expect(control?.lastTested).not.toBeNull();
        });

        it('FAILS and raises a Finding when the register narrows below the card', async () => {
            // The write path CANNOT refuse this: narrowing the agent's declared
            // scope is never refused, and it does not reach back to rewrite the
            // card that was seeded from the wider one.
            await prisma.registeredAgent.update({
                where: { id: agentId },
                data: { dataAccessScope: NARROWED_SCOPE },
            });

            const result = await runPlan(TENANT, planId);

            expect(result.runResult).toBe('FAIL');
            expect(result.findingCreated).toBe(true);
            expect(result.findingId).toBeDefined();

            const body = await evidenceBodyFor(result.evidenceId);
            expect(body).toContain('Basis: CARD_OUTSIDE_DECLARATION');
            expect(body).toContain('code=DATA_SCOPE_ABOVE_DECLARATION');

            const finding = await prisma.finding.findUnique({
                where: { id: result.findingId! },
                select: { severity: true, type: true, status: true },
            });
            expect(finding).toMatchObject({
                severity: AGENTIC_CHECKS.AGENTIC_POLICY_CARD_CONFORMANCE.severity,
                type: 'NONCONFORMITY',
                status: 'OPEN',
            });

            // The Finding reaches the control the only way this schema allows —
            // through the run's own evidence row, which carries the controlId.
            const bridge = await prisma.findingEvidence.findFirst({
                where: { findingId: result.findingId!, evidenceId: result.evidenceId! },
            });
            expect(bridge).not.toBeNull();
        });

        it('FAILS when a re-assessment lowers the tier ceiling under an unchanged card', async () => {
            await prisma.registeredAgent.update({
                where: { id: agentId },
                data: { riskTier: 'CRITICAL', riskTierScoredAt: new Date() },
            });
            // The premise, stated rather than assumed: the new tier's ceiling is
            // genuinely below the card the fixture wrote.
            expect(ceilingForRiskTier('CRITICAL')).toBeLessThan(CARD_AUTONOMY);

            const result = await runPlan(TENANT, planId);

            expect(result.runResult).toBe('FAIL');
            expect(result.findingCreated).toBe(true);
            const body = await evidenceBodyFor(result.evidenceId);
            expect(body).toContain('code=AUTONOMY_ABOVE_TIER');
        });
    });

    // ─────────────────────────────────────────────────────────────────
    // 2. Tool-manifest integrity
    // ─────────────────────────────────────────────────────────────────

    describe('tool-manifest integrity', () => {
        let planId = '';
        const def = allToolDefinitions()[0];
        const live = hashToolManifest(def);

        beforeAll(async () => {
            planId = (await seedPlan(TENANT, 'AGENTIC_TOOL_MANIFEST_INTEGRITY')).planId;
            await prisma.mcpToolManifestPin.create({
                data: {
                    tenantId: TENANT,
                    toolName: def.name,
                    descriptionHash: live.descriptionHash,
                    schemaHash: live.schemaHash,
                    manifestHash: live.manifestHash,
                    approvalSource: 'BASELINE',
                    revision: 1,
                },
            });
        });

        it('PASSES while every pin still describes the definition this build ships', async () => {
            const result = await runPlan(TENANT, planId);

            expect(result.runResult).toBe('PASS');
            expect(result.findingCreated).toBe(false);
            const body = await evidenceBodyFor(result.evidenceId);
            expect(body).toContain('Basis: ALL_PINS_MATCH_BUILD');
            expect(body).toContain('Examined: 1');
        });

        it('FAILS and raises a Finding when a pinned description no longer matches', async () => {
            // The description is the field an attacker edits: it is instruction
            // text delivered straight into the model's context by `tools/list`,
            // and it is the one a name+schema hash would miss. So the seeded
            // drift moves the DESCRIPTION hash only.
            await prisma.mcpToolManifestPin.update({
                where: { tenantId_toolName: { tenantId: TENANT, toolName: def.name } },
                data: {
                    descriptionHash: 'f'.repeat(64),
                    manifestHash: 'e'.repeat(64),
                },
            });

            const result = await runPlan(TENANT, planId);

            expect(result.runResult).toBe('FAIL');
            expect(result.findingCreated).toBe(true);

            const body = await evidenceBodyFor(result.evidenceId);
            expect(body).toContain('Basis: PINNED_DEFINITION_CHANGED');
            expect(body).toContain('code=DESCRIPTION_CHANGED');
            // The refusal the boundary would give is carried into the evidence,
            // because "drifted" and "and therefore refused" are different claims.
            expect(body).toContain('refusing=true');

            const finding = await prisma.finding.findUnique({
                where: { id: result.findingId! },
                select: { severity: true },
            });
            expect(finding?.severity).toBe(
                AGENTIC_CHECKS.AGENTIC_TOOL_MANIFEST_INTEGRITY.severity,
            );

            // Nothing about the tool's TEXT reaches the evidence row — the row
            // lands in a store the retention policy does not erase.
            expect(body).not.toContain(def.description);
        });
    });

    // ─────────────────────────────────────────────────────────────────
    // 3. Review quality
    // ─────────────────────────────────────────────────────────────────

    describe('review quality', () => {
        let planId = '';

        beforeAll(async () => {
            planId = (await seedPlan(TENANT, 'AGENTIC_REVIEW_QUALITY')).planId;

            // A clean history: one reviewer, twelve decisions ten minutes
            // apart, five-minute deliberation on each, two of them rejected.
            // Above the reportable floor, no burst, no implausible decision, a
            // median well above the reading floor, and an approval rate below 1.
            const base = Date.now() - 6 * 3_600_000;
            for (let i = 0; i < 12; i++) {
                await seedDecidedProposal({
                    decidedAt: new Date(base + i * 10 * 60_000),
                    latencySeconds: 300,
                    approved: i >= 2,
                });
            }
        });

        it('PASSES a queue whose decisions carry no automation-bias signal', async () => {
            const result = await runPlan(TENANT, planId);

            expect(result.runResult).toBe('PASS');
            expect(result.findingCreated).toBe(false);
            const body = await evidenceBodyFor(result.evidenceId);
            expect(body).toContain('Basis: NO_BIAS_SIGNALS');
            expect(body).toContain(`minReportableSample=${MIN_REPORTABLE_SAMPLE}`);
        });

        it('FAILS and raises a Finding on a burst of approvals inside one minute', async () => {
            const burstAt = Date.now() - 30 * 60_000;
            for (let i = 0; i < 5; i++) {
                await seedDecidedProposal({
                    // Five approvals spanning forty seconds — inside the window,
                    // and exactly at the threshold, which is where the boundary
                    // is worth testing.
                    decidedAt: new Date(burstAt + i * 10_000),
                    latencySeconds: 300,
                    approved: true,
                });
            }

            const result = await runPlan(TENANT, planId);

            expect(result.runResult).toBe('FAIL');
            expect(result.findingCreated).toBe(true);
            const body = await evidenceBodyFor(result.evidenceId);
            expect(body).toContain('Basis: AUTOMATION_BIAS_SIGNAL');
            expect(body).toContain('code=BULK_APPROVAL_BURST');
            expect(body).toContain(`subject=${USER}`);
        });
    });

    // ─────────────────────────────────────────────────────────────────
    // 4. Kill-switch drill outcome
    // ─────────────────────────────────────────────────────────────────

    describe('kill-switch drill outcome', () => {
        let planId = '';

        beforeAll(async () => {
            planId = (await seedPlan(TENANT, 'AGENTIC_KILL_SWITCH_DRILL')).planId;
        });

        afterEach(async () => {
            await prisma.agentKillSwitchDrill.deleteMany({ where: { tenantId: TENANT } });
        });

        it('PASSES on a recent PASSED drill', async () => {
            await prisma.agentKillSwitchDrill.create({
                data: {
                    tenantId: TENANT,
                    jobRunId: `${SUITE}-drill-ok`,
                    outcome: 'PASSED',
                    startedAt: new Date(Date.now() - 3_600_000),
                    completedAt: new Date(),
                    scopesHonoured: ['AGENT', 'TENANT', 'PLATFORM'],
                    scopesFailed: [],
                    toolCallsAfterKill: 0,
                    boundaryRefusalReason: 'agent_killed',
                    detail: 'Scheduled drill, all scopes honoured.',
                },
            });

            const result = await runPlan(TENANT, planId);

            expect(result.runResult).toBe('PASS');
            expect(result.findingCreated).toBe(false);
            const body = await evidenceBodyFor(result.evidenceId);
            expect(body).toContain('Basis: LAST_DRILL_PASSED');
            expect(body).toContain('toolCallsAfterKill=0');
        });

        it('FAILS and raises a Finding when the newest drill FAILED', async () => {
            await prisma.agentKillSwitchDrill.create({
                data: {
                    tenantId: TENANT,
                    jobRunId: `${SUITE}-drill-bad`,
                    outcome: 'FAILED',
                    startedAt: new Date(Date.now() - 3_600_000),
                    completedAt: new Date(),
                    scopesHonoured: ['TENANT', 'PLATFORM'],
                    scopesFailed: ['AGENT'],
                    // The measurement, not a verdict: one call got through.
                    toolCallsAfterKill: 1,
                    boundaryRefusalReason: null,
                    detail: 'Agent-scope kill was not honoured.',
                },
            });

            const result = await runPlan(TENANT, planId);

            expect(result.runResult).toBe('FAIL');
            expect(result.findingCreated).toBe(true);
            const body = await evidenceBodyFor(result.evidenceId);
            expect(body).toContain('Basis: LAST_DRILL_FAILED');
            expect(body).toContain('scopesFailed=AGENT');
            expect(body).toContain('toolCallsAfterKill=1');
        });

        it('is INCONCLUSIVE, not FAILED, when the newest drill could not run', async () => {
            // `ERROR` is not `FAILED`: a drill that could not run has proved
            // nothing, and raising a nonconformity would be a Finding about the
            // wrong thing. The column exists to keep the two apart and this is
            // the assertion that it still does.
            await prisma.agentKillSwitchDrill.create({
                data: {
                    tenantId: TENANT,
                    jobRunId: `${SUITE}-drill-err`,
                    outcome: 'ERROR',
                    startedAt: new Date(Date.now() - 3_600_000),
                    scopesHonoured: [],
                    scopesFailed: [],
                    toolCallsAfterKill: 0,
                    detail: 'No ACTIVE member to attribute the drill evidence to.',
                },
            });

            const result = await runPlan(TENANT, planId);

            expect(result.runResult).toBe('INCONCLUSIVE');
            expect(result.findingCreated).toBe(false);
            const body = await evidenceBodyFor(result.evidenceId);
            expect(body).toContain('Basis: LAST_DRILL_ERRORED');
            expect(body).toContain('Vacuous: no');
        });

        it('FAILS a tenant whose agents have never been drilled', async () => {
            // No drill row at all, and the agent is thirty days old — well past
            // the grace window. "Never ran" and "ran and found nothing" look
            // identical from outside; this is the assertion that separates them.
            const result = await runPlan(TENANT, planId);

            expect(result.runResult).toBe('FAIL');
            expect(result.findingCreated).toBe(true);
            const body = await evidenceBodyFor(result.evidenceId);
            expect(body).toContain('Basis: NO_DRILL_ON_RECORD');
            expect(body).toContain('drills=0');
        });
    });

    // ─────────────────────────────────────────────────────────────────
    // The tenant that has adopted nothing
    // ─────────────────────────────────────────────────────────────────

    describe('a tenant with no agents', () => {
        const checkIds = Object.keys(AGENTIC_CHECKS) as AgenticCheckId[];

        it.each(checkIds)(
            '%s is INCONCLUSIVE and vacuous — no Finding, and the control is NOT attested',
            async (check) => {
                const { planId, controlId } = await seedPlan(EMPTY_TENANT, check);

                const result = await runPlan(EMPTY_TENANT, planId);

                expect(result.runStatus).toBe('COMPLETED');
                expect(result.runResult).toBe('INCONCLUSIVE');
                expect(result.findingCreated).toBe(false);

                const body = await evidenceBodyFor(result.evidenceId);
                expect(body).toContain('Verdict: INCONCLUSIVE');
                expect(body).toContain('Vacuous: yes');
                expect(body).toContain('Examined: 0');

                // The part that makes "vacuous" more than a word in a file: an
                // INCONCLUSIVE run does not attest, so the control keeps reading
                // as due rather than being credited for a run that examined
                // nothing.
                const control = await prisma.control.findUnique({
                    where: { id: controlId },
                    select: { lastTested: true },
                });
                expect(control?.lastTested).toBeNull();
            },
        );
    });

    // ─────────────────────────────────────────────────────────────────
    // A plan that names somebody else's engine
    // ─────────────────────────────────────────────────────────────────

    it('declines an INTEGRATION plan whose config names no check of ours', async () => {
        // The registry is keyed by automationType, so registering on INTEGRATION
        // claims every INTEGRATION plan in the product. A decline must therefore
        // leave such a plan exactly where it was before this handler existed:
        // PLANNED, awaiting a human, with no verdict invented for it.
        const control = await prisma.control.create({
            data: { tenantId: TENANT, name: `${SUITE} foreign control`, createdByUserId: USER },
        });
        const plan = await prisma.controlTestPlan.create({
            data: {
                tenantId: TENANT,
                controlId: control.id,
                name: `${SUITE} foreign plan`,
                createdByUserId: USER,
                automationType: 'INTEGRATION',
                status: 'ACTIVE',
                schedule: '0 3 * * *',
                automationConfig: { connectorId: 'aws-1' },
            },
        });

        const result = await runPlan(TENANT, plan.id);

        expect(result.runStatus).toBe('PLANNED');
        expect(result.runResult).toBeNull();
        expect(result.findingCreated).toBe(false);
        const control2 = await prisma.control.findUnique({
            where: { id: control.id },
            select: { lastTested: true },
        });
        expect(control2?.lastTested).toBeNull();
    });

    // ─────────────────────────────────────────────────────────────────
    // The production entry point registers its own engine
    // ─────────────────────────────────────────────────────────────────

    it('the BullMQ executor registers the handler itself, on a cold registry', async () => {
        // Every case above registered the handler in `beforeAll`, which proves
        // the checks and proves nothing about the wiring. A worker boots with an
        // EMPTY registry: if the registration lived only in a test, the first —
        // and every — real pickup would fall through to the manual path and the
        // whole subsystem would report "awaiting manual completion" forever,
        // green, with a plan on a cron.
        runnerHandlerRegistry._reset();
        expect(runnerHandlerRegistry.get('INTEGRATION')).toBeUndefined();

        const { planId } = await seedPlan(TENANT, 'AGENTIC_POLICY_CARD_CONFORMANCE');
        const jobResult = await controlTestRunnerExecutor({
            tenantId: TENANT,
            testPlanId: planId,
            scheduledForIso: new Date().toISOString(),
            schedulerJobRunId: `${SUITE}-cold`,
        });

        expect(runnerHandlerRegistry.get('INTEGRATION')).toBeDefined();
        expect(jobResult.details).toMatchObject({
            runStatus: 'COMPLETED',
            runResult: 'PASS',
            evidenceAttached: true,
        });
    });
});
