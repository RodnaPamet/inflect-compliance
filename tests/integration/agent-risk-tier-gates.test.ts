/**
 * The assessed risk tier is LOAD-BEARING — proved at both gates.
 *
 * An assessment that changes no behaviour is paperwork. `RegisteredAgent.riskTier`
 * is written by the agent risk assessment and then does two jobs, and this suite
 * exists because either of them could be quietly removed and every other test in
 * the repository would stay green:
 *
 *   1. AT THE TOOL BOUNDARY it is a term in the autonomy ceiling
 *      (`min(key max, registered autonomy, tier cap)`), so an agent assessed
 *      CRITICAL cannot be driven to a rung its registration claims. An UNSCORED
 *      agent — `riskTier IS NULL` — resolves to `DENY_CEILING` and reaches
 *      nothing at all.
 *   2. AT THE USECASE it refuses to RAISE an agent's registered autonomy above
 *      what the tier permits, and refuses to ACTIVATE an agent nobody has
 *      assessed.
 *
 * ── Why the pairs matter more than the refusals ──────────────────────
 *
 * Every refusal below is stated with its positive companion: the same agent,
 * the same key, the same tool, differing only in the tier. A suite of refusals
 * alone would pass against a gate that refused everything — which is the
 * failure mode that actually threatened this change, because wiring the tier
 * term while every agent in every register was unscored would have taken the
 * whole MCP surface dark and looked, from inside the tests, exactly like the
 * control working.
 *
 * ── And why "nothing was written" is asserted, not just "it threw" ───
 *
 * The autonomy raise is refused BEFORE the update, in the same transaction that
 * would have performed it. A check placed after the write would also throw, and
 * would also leave the caller with an error — and the row would be wrong. So
 * the refusal is checked against the ROW and against a second field carried in
 * the same payload, which can only have survived if the write never ran.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { NextRequest } from 'next/server';
import { randomUUID } from 'crypto';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { generateApiKey } from '@/lib/auth/api-key-auth';
import { POST as MCP_POST } from '@/app/api/mcp/route';
import { makeRequestContext } from '../helpers/make-context';
import {
    activateRegisteredAgent,
    updateRegisteredAgent,
} from '@/app-layer/usecases/agent-registry';
import { grantAgentTool } from '@/app-layer/usecases/agent-tool-exposure';
import { completeAgentRiskAssessment } from '@/app-layer/usecases/agent-risk-assessment';
import { listAgentCredentials } from '@/app-layer/usecases/api-keys';
import { MAX_AUTONOMY_BY_TIER } from '@/lib/agentic/agent-risk-scoring';
import { DENY_CEILING } from '@/lib/agentic/autonomy-ceiling';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(60_000);

const SUITE = `atier-${randomUUID().slice(0, 8)}`;
const TENANT = `t-${SUITE}`;
const USER = `u-${SUITE}`;

const SCOPES = ['mcp:read', 'mcp:propose', 'risks:read', 'audits:read'];
const GRANTED_TOOLS = ['list_risks', 'propose_finding'];

const ctx = () =>
    makeRequestContext('OWNER', { tenantId: TENANT, tenantSlug: TENANT, userId: USER });

interface SeedOptions {
    autonomyLevel?: number;
    dataAccessScope?: 'NONE' | 'READ_METADATA' | 'READ_TENANT_DATA' | 'WRITE_TENANT_DATA' | 'EXTERNAL_EGRESS';
    reversibility?: 'REVERSIBLE' | 'COMPENSABLE' | 'TERMINAL';
    status?: 'DRAFT' | 'ACTIVE' | 'SUSPENDED';
    /** `null` is the UNSCORED state — the one that must deny. */
    riskTier?: 'LOW' | 'MODERATE' | 'HIGH' | 'CRITICAL' | null;
    grantTools?: boolean;
}

async function seedAgent(name: string, options: SeedOptions = {}): Promise<string> {
    const aiSystem = await prisma.aiSystem.create({
        data: { tenantId: TENANT, name: `${name} host`, ownerUserId: USER },
    });
    const tier = options.riskTier === undefined ? 'LOW' : options.riskTier;
    const agent = await prisma.registeredAgent.create({
        data: {
            tenantId: TENANT,
            aiSystemId: aiSystem.id,
            name,
            autonomyLevel: options.autonomyLevel ?? 3,
            dataAccessScope: options.dataAccessScope ?? 'READ_TENANT_DATA',
            reversibility: options.reversibility ?? 'REVERSIBLE',
            provenance: 'FIRST_PARTY',
            ownerUserId: USER,
            status: options.status ?? 'ACTIVE',
            // The CHECK constraint pins tier and stamp to move together, so a
            // scored fixture must carry both.
            riskTier: tier,
            riskTierScoredAt: tier === null ? null : new Date(),
        },
    });
    if (options.grantTools !== false) {
        for (const toolName of GRANTED_TOOLS) {
            await prisma.registeredAgentTool.create({
                data: { tenantId: TENANT, agentId: agent.id, toolName, grantedByUserId: USER },
            });
        }
    }
    return agent.id;
}

async function setTier(agentId: string, tier: SeedOptions['riskTier']): Promise<void> {
    await prisma.registeredAgent.update({
        where: { id: agentId },
        data: {
            riskTier: tier ?? null,
            riskTierScoredAt: tier === null || tier === undefined ? null : new Date(),
        },
    });
}

async function mintKey(agentId: string | null): Promise<string> {
    const { plaintext, keyHash, keyPrefix } = generateApiKey();
    await prisma.tenantApiKey.create({
        data: {
            tenantId: TENANT,
            name: `k-${randomUUID().slice(0, 6)}`,
            keyPrefix,
            keyHash,
            scopes: SCOPES,
            createdById: USER,
            agentId,
        },
    });
    return plaintext;
}

async function callTool(token: string, name: string, args: unknown = {}) {
    const req = new NextRequest('http://localhost/api/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name, arguments: args },
        }),
    });
    const res = await MCP_POST(req, { params: Promise.resolve({}) } as never);
    let json: unknown = null;
    try {
        json = await res.json();
    } catch {
        /* empty body */
    }
    return { status: res.status, json };
}

function errorOf(json: unknown): string | undefined {
    return (json as { error?: { message?: string } })?.error?.message;
}

function resultOf(json: unknown): unknown {
    const text = (json as { result?: { content?: Array<{ text: string }> } })?.result?.content?.[0]
        ?.text;
    return text === undefined ? undefined : JSON.parse(text);
}

async function setEnforcement(requireRegisteredAgent: boolean): Promise<void> {
    await prisma.tenantSecuritySettings.upsert({
        where: { tenantId: TENANT },
        update: { requireRegisteredAgent },
        create: { tenantId: TENANT, requireRegisteredAgent },
    });
}

describeFn('the assessed risk tier is load-bearing', () => {
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
        // The key's PRINCIPAL is intersected with the agent's authority at the
        // tool boundary, so it has to be a live OWNER for the propose tool to
        // reach the tier check rather than being refused earlier for a
        // permission it lacks.
        await prisma.tenantMembership.upsert({
            where: { tenantId_userId: { tenantId: TENANT, userId: USER } },
            update: { role: 'OWNER', status: 'ACTIVE' },
            create: { tenantId: TENANT, userId: USER, role: 'OWNER', status: 'ACTIVE' },
        });
        await setEnforcement(true);
    });

    afterAll(async () => {
        await prisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
            await tx.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE "tenantId" = $1`, TENANT);
            await tx.$executeRawUnsafe(
                `DELETE FROM "TenantMembership" WHERE "tenantId" = $1`,
                TENANT,
            );
        });
        // The propose tool leaves real proposal rows behind, and their
        // composite FK to (agentId, tenantId) is RESTRICT — a proposal is
        // history and must outlive nothing quietly. So they go first.
        await prisma.agentProposal.deleteMany({ where: { tenantId: TENANT } });
        await prisma.agentRiskAssessmentAnswer.deleteMany({ where: { tenantId: TENANT } });
        await prisma.agentRiskAssessment.deleteMany({ where: { tenantId: TENANT } });
        await prisma.registeredAgentTool.deleteMany({ where: { tenantId: TENANT } });
        await prisma.tenantApiKey.deleteMany({ where: { tenantId: TENANT } });
        await prisma.registeredAgent.deleteMany({ where: { tenantId: TENANT } });
        await prisma.aiSystem.deleteMany({ where: { tenantId: TENANT } });
        await prisma.tenantSecuritySettings.deleteMany({ where: { tenantId: TENANT } });
        await prisma.user.deleteMany({ where: { id: USER } });
        await prisma.tenant.deleteMany({ where: { id: TENANT } });
        await prisma.$disconnect();
    });

    // ─────────────────────────────────────────────────────────────────
    // 1. The cap, at the USECASE. This is the acceptance criterion:
    //    an agent cannot be GRANTED more autonomy than its tier permits,
    //    and the refusal is server-side.
    // ─────────────────────────────────────────────────────────────────
    describe('raising autonomy above the assessed tier is refused server-side', () => {
        it('refuses the raise AND writes nothing — not the level, not the name beside it', async () => {
            const agentId = await seedAgent('raise-probe', {
                autonomyLevel: 1,
                riskTier: 'HIGH',
            });

            await expect(
                updateRegisteredAgent(ctx(), agentId, {
                    autonomyLevel: 6,
                    // Carried in the SAME payload as the illegal field. If the
                    // check ran after the write, or per-field, this would land
                    // and the refusal would be cosmetic.
                    name: 'renamed by a refused call',
                }),
            ).rejects.toThrow(/risk tier/i);

            const row = await prisma.registeredAgent.findUniqueOrThrow({
                where: { id: agentId },
                select: { autonomyLevel: true, name: true },
            });
            expect(row.autonomyLevel).toBe(1);
            expect(row.name).toBe('raise-probe');

            const audited = await prisma.auditLog.count({
                where: { tenantId: TENANT, entityId: agentId, action: 'AGENT_UPDATED' },
            });
            expect(audited).toBe(0);
        });

        it('names the cap the tier actually imposes, so the message is actionable', async () => {
            const agentId = await seedAgent('message-probe', {
                autonomyLevel: 1,
                riskTier: 'CRITICAL',
            });
            await expect(
                updateRegisteredAgent(ctx(), agentId, { autonomyLevel: 4 }),
            ).rejects.toThrow(new RegExp(`CRITICAL.*${MAX_AUTONOMY_BY_TIER.CRITICAL}`));
        });

        it('ALLOWS a raise that stays within the tier — the refusal is not blanket', async () => {
            // The positive companion. Without it, a usecase that refused every
            // update would satisfy the assertion above.
            const agentId = await seedAgent('within-probe', {
                autonomyLevel: 1,
                riskTier: 'HIGH',
            });
            await expect(
                updateRegisteredAgent(ctx(), agentId, {
                    autonomyLevel: MAX_AUTONOMY_BY_TIER.HIGH,
                }),
            ).resolves.toMatchObject({ updated: true });

            const row = await prisma.registeredAgent.findUniqueOrThrow({
                where: { id: agentId },
                select: { autonomyLevel: true },
            });
            expect(row.autonomyLevel).toBe(MAX_AUTONOMY_BY_TIER.HIGH);
        });

        it('ALLOWS a lowering that is still above the cap — the rule is one-directional', async () => {
            // An agent registered at 6 and later assessed HIGH is an ordinary
            // state: registration declares, assessment judges, and the two are
            // allowed to disagree. A rule written as "the result must be within
            // the cap" would refuse 6 → 4 here, fighting the operator who is
            // moving toward the cap.
            const agentId = await seedAgent('lower-probe', {
                autonomyLevel: 6,
                riskTier: 'HIGH',
            });
            await expect(
                updateRegisteredAgent(ctx(), agentId, { autonomyLevel: 4 }),
            ).resolves.toMatchObject({ updated: true });
        });

        it('an UNSCORED agent cannot be raised at all, and is told to assess itself', async () => {
            const agentId = await seedAgent('unscored-raise', {
                autonomyLevel: 1,
                riskTier: null,
            });
            await expect(
                updateRegisteredAgent(ctx(), agentId, { autonomyLevel: 2 }),
            ).rejects.toThrow(/not been risk-assessed/i);

            const row = await prisma.registeredAgent.findUniqueOrThrow({
                where: { id: agentId },
                select: { autonomyLevel: true },
            });
            expect(row.autonomyLevel).toBe(1);
        });
    });

    // ─────────────────────────────────────────────────────────────────
    // 2. Unscored denies, scored permits — at the real tool boundary.
    //    THE pair that proves the tier is the thing doing the work.
    // ─────────────────────────────────────────────────────────────────
    describe('an unscored agent denies; the same agent scored permits', () => {
        it('refuses the read while unscored and allows it once scored — same agent, same key, same rung', async () => {
            const agentId = await seedAgent('deny-permit', {
                autonomyLevel: 2,
                riskTier: null,
            });
            const token = await mintKey(agentId);

            const denied = await callTool(token, 'list_risks');
            expect(errorOf(denied.json)).toMatch(/risk-assessed/i);
            expect(resultOf(denied.json)).toBeUndefined();

            // Nothing else moves. Only the tier.
            await setTier(agentId, 'MODERATE');

            const allowed = await callTool(token, 'list_risks');
            expect(errorOf(allowed.json)).toBeUndefined();
            expect(resultOf(allowed.json)).toBeDefined();
        });

        it('the refusal is a hash-chained AUTHZ_DENIED row naming the tier as the cause', async () => {
            // A refusal nobody can review is not a control. And the row has to
            // distinguish "unscored" from an ordinary ceiling refusal, because
            // the two have different fixes.
            const agentId = await seedAgent('deny-audit', {
                autonomyLevel: 2,
                riskTier: null,
            });
            const token = await mintKey(agentId);
            await callTool(token, 'list_risks');

            const row = await prisma.auditLog.findFirst({
                where: { tenantId: TENANT, action: 'AUTHZ_DENIED', entityId: 'list_risks' },
                orderBy: { createdAt: 'desc' },
            });
            expect(row).not.toBeNull();
            expect(row?.detailsJson).toMatchObject({
                reason: 'autonomy_denied',
                ceiling: DENY_CEILING,
                unscored: true,
                riskTier: null,
            });
        });

        it('a CRITICAL tier narrows PARTIALLY — the read survives, the propose does not', async () => {
            // The tier is a cap, not a switch. An agent registered at rung 3
            // and assessed CRITICAL keeps rung 1 and loses rung 2, which is
            // what "the assessment bounds the agent" has to mean if it means
            // anything. Asserted as a flip on ONE agent so nothing but the tier
            // can explain the difference.
            const agentId = await seedAgent('partial-narrow', {
                autonomyLevel: 3,
                riskTier: 'LOW',
            });
            const token = await mintKey(agentId);

            const proposeAtLow = await callTool(token, 'propose_finding', {
                items: [{ severity: 'LOW', type: 'OTHER', title: 'probe' }],
            });
            expect(errorOf(proposeAtLow.json)).toBeUndefined();

            await setTier(agentId, 'CRITICAL');

            const proposeAtCritical = await callTool(token, 'propose_finding', {
                items: [{ severity: 'LOW', type: 'OTHER', title: 'probe' }],
            });
            expect(errorOf(proposeAtCritical.json)).toMatch(/autonomy/i);

            const readAtCritical = await callTool(token, 'list_risks');
            expect(errorOf(readAtCritical.json)).toBeUndefined();
            expect(resultOf(readAtCritical.json)).toBeDefined();
        });
    });

    // ─────────────────────────────────────────────────────────────────
    // 3. The THIRD null. "No agent resolved" is not "an unscored agent",
    //    and reading it as one is what would have taken the surface dark.
    // ─────────────────────────────────────────────────────────────────
    describe('a caller with no resolved agent contributes no tier term', () => {
        it('an unbound key under a NON-enforcing tenant still reaches its tools', async () => {
            // There is no agent, so there is nothing to have assessed. Denying
            // here would make the register's own switch a kill switch for every
            // ordinary integration key in the product.
            await setEnforcement(false);
            try {
                const token = await mintKey(null);
                const { json } = await callTool(token, 'list_risks');
                expect(errorOf(json)).toBeUndefined();
                expect(resultOf(json)).toBeDefined();
            } finally {
                await setEnforcement(true);
            }
        });
    });

    // ─────────────────────────────────────────────────────────────────
    // 4. Activation. The forward half of the transition: nothing NEW can
    //    enter the ACTIVE-and-unscored state.
    // ─────────────────────────────────────────────────────────────────
    describe('an unassessed agent cannot be activated', () => {
        it('refuses activation while unscored and leaves the status alone', async () => {
            const agentId = await seedAgent('activate-probe', {
                status: 'DRAFT',
                riskTier: null,
            });
            await expect(activateRegisteredAgent(ctx(), agentId)).rejects.toThrow(
                /not been risk-assessed/i,
            );

            const row = await prisma.registeredAgent.findUniqueOrThrow({
                where: { id: agentId },
                select: { status: true },
            });
            expect(row.status).toBe('DRAFT');
        });

        it('activates once the agent has been scored', async () => {
            const agentId = await seedAgent('activate-ok', {
                status: 'DRAFT',
                riskTier: 'MODERATE',
            });
            await expect(activateRegisteredAgent(ctx(), agentId)).resolves.toMatchObject({
                status: 'ACTIVE',
            });
        });

        it('SUSPENDING is never refused — the emergency stop keeps no precondition', async () => {
            // The asymmetry is deliberate and worth pinning: a check that could
            // refuse the kill switch would be a check that refuses the
            // emergency. An unscored agent must still be suspendable.
            const { suspendRegisteredAgent } = await import(
                '@/app-layer/usecases/agent-registry'
            );
            const agentId = await seedAgent('suspend-unscored', { riskTier: null });
            await expect(suspendRegisteredAgent(ctx(), agentId)).resolves.toMatchObject({
                status: 'SUSPENDED',
            });
        });
    });

    // ─────────────────────────────────────────────────────────────────
    // 5. Staleness WARNS. The decision, asserted rather than described.
    // ─────────────────────────────────────────────────────────────────
    describe('a widening marks the assessment stale and does NOT stop the agent', () => {
        it('granting a tool stamps staleness on the standing run and leaves the tier in force', async () => {
            const agentId = await seedAgent('stale-probe', {
                autonomyLevel: 2,
                riskTier: null,
                grantTools: false,
            });
            const token = await mintKey(agentId);

            // Score it for real, so the run carries a frozen basis to compare
            // against — a hand-written row would prove the comparison works
            // against a fixture rather than against what the product writes.
            const scored = await completeAgentRiskAssessment(ctx(), agentId);
            expect(scored.tier).toBeDefined();

            const granted = await grantAgentTool(ctx(), agentId, { toolName: 'list_risks' });
            expect(granted.staleness.stale).toBe(true);
            expect(granted.staleness.triggers).toContain('TOOL_GRANTED');

            const run = await prisma.agentRiskAssessment.findUniqueOrThrow({
                where: { id: scored.assessmentId },
                select: { staleAt: true, staleTriggers: true, scoredTier: true },
            });
            expect(run.staleAt).not.toBeNull();
            expect(run.staleTriggers).toContain('TOOL_GRANTED');

            // And the agent keeps working. Stale is a warning about the tier
            // being out of date, not a revocation of the tier — the widening
            // that caused it is inert anyway, because the ceiling composes as a
            // `min` against the basis that WAS assessed.
            const agent = await prisma.registeredAgent.findUniqueOrThrow({
                where: { id: agentId },
                select: { riskTier: true },
            });
            expect(agent.riskTier).toBe(run.scoredTier);

            const { json } = await callTool(token, 'list_risks');
            expect(errorOf(json)).toBeUndefined();
        });
    });

    // ─────────────────────────────────────────────────────────────────
    // 6. The 10/10 evidence seam. Unwired, and SAYING so.
    // ─────────────────────────────────────────────────────────────────
    describe('the evidence-emission seam reports itself unwired rather than silently skipping', () => {
        it('completion returns a real descriptor with emitted:false, and audits the same', async () => {
            const agentId = await seedAgent('evidence-probe', {
                autonomyLevel: 2,
                riskTier: null,
                grantTools: false,
            });
            const result = await completeAgentRiskAssessment(ctx(), agentId);

            expect(result.evidence.emitted).toBe(false);
            expect(result.evidence.reason).toBe('evidence_emission_unwired');
            // The descriptor is BUILT, not stubbed: it is the part of the seam
            // that can be wrong, so it is the part that is checked.
            expect(result.evidence.descriptor).toMatchObject({
                agentId,
                agentName: 'evidence-probe',
                assessmentId: result.assessmentId,
                tier: result.tier,
                score: result.score,
            });
            expect(result.evidence.descriptor.title).toContain('evidence-probe');

            const audit = await prisma.auditLog.findFirst({
                where: { tenantId: TENANT, entityId: agentId, action: 'AGENT_RISK_SCORED' },
                orderBy: { createdAt: 'desc' },
            });
            expect(audit?.detailsJson).toMatchObject({ evidenceEmitted: false });
        });
    });

    // ─────────────────────────────────────────────────────────────────
    // 7. The REPORT agrees with the enforcement. A credentials list that
    //    shows a number the tool boundary does not honour is worse than
    //    no number: it is the confusion the column exists to end.
    // ─────────────────────────────────────────────────────────────────
    describe('the agent-credentials report computes the same ceiling the funnel does', () => {
        it('reports the tier cap for a scored agent and flags an unscored one', async () => {
            const scoredId = await seedAgent('report-scored', {
                autonomyLevel: 6,
                riskTier: 'HIGH',
                grantTools: false,
            });
            const unscoredId = await seedAgent('report-unscored', {
                autonomyLevel: 6,
                riskTier: null,
                grantTools: false,
            });
            await mintKey(scoredId);
            await mintKey(unscoredId);

            const rows = await listAgentCredentials(ctx());
            const scored = rows.find((r) => r.agent?.id === scoredId);
            const unscored = rows.find((r) => r.agent?.id === unscoredId);

            // Registered at 6, assessed HIGH: the reported ceiling is the TIER
            // cap, not the registration. If this read the registration the
            // page would promise authority the funnel refuses.
            expect(scored?.effectiveAutonomy).toBe(MAX_AUTONOMY_BY_TIER.HIGH);
            expect(scored?.unscored).toBe(false);

            expect(unscored?.effectiveAutonomy).toBe(DENY_CEILING);
            // The word, not the magic number. A UI must not have to recognise
            // -1 to tell an operator why their integration stopped.
            expect(unscored?.unscored).toBe(true);
        });
    });

    // ─────────────────────────────────────────────────────────────────
    // 8. The TRANSITION. Wiring the tier denies every agent that was
    //    already ACTIVE and never assessed, so the route out is part of
    //    the change and is tested as part of it.
    //
    //    Declared LAST on purpose: it scores every remaining unscored
    //    ACTIVE agent in this tenant, which would change the fixtures the
    //    blocks above rely on.
    // ─────────────────────────────────────────────────────────────────
    describe('the backfill is a real route out of the unscored state', () => {
        it('scores an ACTIVE unscored agent through the real usecase, and is idempotent', async () => {
            const { run } = await import('../../scripts/backfill-agent-risk-tiers');
            const agentId = await seedAgent('backfill-subject', {
                autonomyLevel: 4,
                dataAccessScope: 'READ_TENANT_DATA',
                reversibility: 'REVERSIBLE',
                riskTier: null,
                // Tools ARE granted: the exposure allowlist is checked before
                // the ceiling, so an agent with no grants would be refused for
                // a reason that has nothing to do with the tier and the test
                // would pass without exercising it.
            });
            const token = await mintKey(agentId);

            // Before: the agent is dark. This is the state the deploy creates
            // for an estate nobody has assessed, and the reason the route out
            // is not optional.
            const before = await callTool(token, 'list_risks');
            expect(errorOf(before.json)).toMatch(/risk-assessed/i);

            await expect(run(['--execute', `--tenant=${TENANT}`])).resolves.toBe(0);

            const scored = await prisma.registeredAgent.findUniqueOrThrow({
                where: { id: agentId },
                select: { riskTier: true, riskTierScoredAt: true },
            });
            expect(scored.riskTier).not.toBeNull();
            expect(scored.riskTierScoredAt).not.toBeNull();
            // Never LOW. A run with nothing answered carries the full answer
            // weight, which alone exceeds the LOW band — so the backfill cannot
            // be used to buy an agent its whole ladder, and the questionnaire
            // stays the only route to rung 6.
            expect(scored.riskTier).not.toBe('LOW');

            // And the tier has EVIDENCE: a real completed run, legible as
            // provisional because every applicable question is unanswered.
            const runRow = await prisma.agentRiskAssessment.findFirstOrThrow({
                where: { tenantId: TENANT, agentId, status: 'COMPLETED' },
                orderBy: { completedAt: 'desc' },
            });
            const breakdown = runRow.scoreBreakdownJson as {
                applicableQuestions: number;
                unansweredQuestions: number;
            };
            expect(breakdown.unansweredQuestions).toBe(breakdown.applicableQuestions);
            expect(runRow.scoredTier).toBe(scored.riskTier);

            // The agent is out of the dark, at the tier it earned.
            const after = await callTool(token, 'list_risks');
            expect(errorOf(after.json)).toBeUndefined();

            // Idempotent: the second pass finds nothing, because the filter is
            // `riskTier IS NULL` and the first pass emptied it.
            await expect(run(['--execute', `--tenant=${TENANT}`])).resolves.toBe(0);
            const stillUnscored = await prisma.registeredAgent.count({
                where: { tenantId: TENANT, status: 'ACTIVE', riskTier: null, deletedAt: null },
            });
            expect(stillUnscored).toBe(0);
        });
    });
});
