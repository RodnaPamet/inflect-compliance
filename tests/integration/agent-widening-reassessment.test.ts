/**
 * A WIDENING RE-SCORES THE AGENT — and the model reference is writable.
 *
 * This suite exists because two claims that were written down about the agent
 * risk assessment were false, and both were false in the same way: a mechanism
 * was asserted by tests that constructed states no product surface could
 * produce, so the mechanism looked covered while nothing could reach it.
 *
 * ## 1. `MODEL_CHANGED` had no write path
 *
 * `RegisteredAgent.modelRef` was absent from the create schema, the update
 * schema and the repository's write shape. Both schemas are strict objects, so
 * a caller supplying `modelRef` had it silently STRIPPED; the column was NULL
 * for the life of every agent, and `before !== after` in the staleness
 * comparison was permanently false. Its only coverage hand-built two values.
 * So every assertion here about the model goes THROUGH THE USECASES and reads
 * the column back.
 *
 * ## 2. "The widening is inert until somebody re-scores" was false
 *
 * That was the third and load-bearing reason for warning rather than blocking
 * on a stale assessment. It holds only for AUTONOMY_RAISED, where
 * `agent.autonomyLevel` is itself a term in the `min` that forms the ceiling.
 * Data scope, reversibility and provenance appear in the ceiling NOWHERE: an
 * agent could be walked from READ_TENANT_DATA to EXTERNAL_EGRESS, keep its tier
 * and its whole ladder, and run at an authority a fresh score of the very same
 * agent would have refused.
 *
 * The fix is not a block. The scorer is pure in (autonomy, data access,
 * reversibility, provenance, answers), so a widening of any of those AXES is
 * re-scored on the spot from the answers already on file — in the same
 * transaction that records it. The tier follows the agent, the ceiling narrows
 * at once, and "stale" narrows to mean only "the questionnaire answers may be
 * out of date".
 *
 * ## What every case below insists on
 *
 * The tier is read back from the ROW, and the narrowing is demonstrated at the
 * REAL MCP boundary — same agent, same key, same tool, differing only in that a
 * widening was recorded between the two calls. A suite that only asserted the
 * usecase's return value would pass against a re-score that computed the right
 * number and wrote it nowhere.
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
    createRegisteredAgent,
    registerAgent,
    updateRegisteredAgent,
} from '@/app-layer/usecases/agent-registry';
import { grantAgentTool } from '@/app-layer/usecases/agent-tool-exposure';
import { completeAgentRiskAssessment } from '@/app-layer/usecases/agent-risk-assessment';
import { MAX_AUTONOMY_BY_TIER } from '@/lib/agentic/agent-risk-scoring';
import fixture from '../../prisma/fixtures/agent-risk-assessment.json';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(60_000);

const SUITE = `awide-${randomUUID().slice(0, 8)}`;
const TENANT = `t-${SUITE}`;
const USER = `u-${SUITE}`;
const VENDOR = `v-${SUITE}`;

const SCOPES = ['mcp:read', 'mcp:propose', 'risks:read', 'audits:read', 'findings:write'];

const ctx = () =>
    makeRequestContext('OWNER', { tenantId: TENANT, tenantSlug: TENANT, userId: USER });

type Scope =
    | 'NONE'
    | 'READ_METADATA'
    | 'READ_TENANT_DATA'
    | 'WRITE_TENANT_DATA'
    | 'EXTERNAL_EGRESS';
type Reversibility = 'REVERSIBLE' | 'COMPENSABLE' | 'TERMINAL';

interface AgentSpec {
    autonomyLevel?: number;
    dataAccessScope?: Scope;
    reversibility?: Reversibility;
    modelRef?: string | null;
}

/**
 * An agent created through the REAL create usecase, over its own AI-system
 * register entry. Never a hand-written `prisma.registeredAgent.create` — the
 * whole point of these cases is what the product's own write path does with the
 * payload it is handed.
 */
async function createAgent(name: string, spec: AgentSpec = {}): Promise<string> {
    const aiSystem = await prisma.aiSystem.create({
        data: { tenantId: TENANT, name: `${name} host`, ownerUserId: USER },
    });
    const created = await createRegisteredAgent(ctx(), {
        aiSystemId: aiSystem.id,
        name,
        autonomyLevel: spec.autonomyLevel ?? 0,
        dataAccessScope: spec.dataAccessScope ?? 'READ_TENANT_DATA',
        reversibility: spec.reversibility ?? 'REVERSIBLE',
        provenance: 'FIRST_PARTY',
        ownerUserId: USER,
        ...(spec.modelRef !== undefined ? { modelRef: spec.modelRef } : {}),
    });
    return created.id;
}

/** The agent as the register holds it. */
async function row(agentId: string) {
    return prisma.registeredAgent.findUniqueOrThrow({
        where: { id: agentId },
        select: {
            riskTier: true,
            riskTierScoredAt: true,
            autonomyLevel: true,
            dataAccessScope: true,
            reversibility: true,
            provenance: true,
            modelRef: true,
        },
    });
}

async function standingRun(agentId: string) {
    return prisma.agentRiskAssessment.findFirstOrThrow({
        where: { tenantId: TENANT, agentId, status: 'COMPLETED' },
        orderBy: { completedAt: 'desc' },
    });
}

async function mintKey(agentId: string): Promise<string> {
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

/** The shipped reference content, loaded exactly as the standalone seeder does. */
async function seedReferenceContent(): Promise<void> {
    for (const d of fixture.domains) {
        const data = {
            code: d.code,
            name: d.name,
            description: d.description,
            sortOrder: d.sortOrder,
        };
        await prisma.agentAssessmentDomain.upsert({
            where: { id: d.id },
            update: data,
            create: { id: d.id, ...data },
        });
    }
    for (const q of fixture.questions) {
        const data = {
            domainId: q.domainId,
            text: q.text,
            guidance: q.guidance ?? null,
            mappingsJson: q.mappings,
            criticality: q.criticality,
        };
        await prisma.agentAssessmentQuestion.upsert({
            where: { id: q.id },
            update: data,
            create: { id: q.id, ...data },
        });
    }
}

describeFn('a widening re-scores the agent', () => {
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
        await prisma.vendor.upsert({
            where: { id: VENDOR },
            update: {},
            create: { id: VENDOR, tenantId: TENANT, name: `${SUITE} supplier` },
        });
        await prisma.tenantSecuritySettings.upsert({
            where: { tenantId: TENANT },
            update: { requireRegisteredAgent: true },
            create: { tenantId: TENANT, requireRegisteredAgent: true },
        });
        await seedReferenceContent();
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
        await prisma.agentProposal.deleteMany({ where: { tenantId: TENANT } });
        await prisma.agentRiskAssessmentAnswer.deleteMany({ where: { tenantId: TENANT } });
        await prisma.agentRiskAssessment.deleteMany({ where: { tenantId: TENANT } });
        await prisma.registeredAgentTool.deleteMany({ where: { tenantId: TENANT } });
        await prisma.tenantApiKey.deleteMany({ where: { tenantId: TENANT } });
        await prisma.registeredAgent.deleteMany({ where: { tenantId: TENANT } });
        await prisma.aiSystemRequirementLink.deleteMany({ where: { tenantId: TENANT } });
        await prisma.aiSystem.deleteMany({ where: { tenantId: TENANT } });
        await prisma.vendor.deleteMany({ where: { tenantId: TENANT } });
        await prisma.tenantSecuritySettings.deleteMany({ where: { tenantId: TENANT } });
        await prisma.user.deleteMany({ where: { id: USER } });
        await prisma.tenant.deleteMany({ where: { id: TENANT } });
        await prisma.$disconnect();
    });

    // ─────────────────────────────────────────────────────────────────
    // 1. `modelRef` has a write path, so MODEL_CHANGED can fire.
    // ─────────────────────────────────────────────────────────────────
    describe('the declared model survives the write path', () => {
        it('createRegisteredAgent persists it — it is not stripped by the schema', async () => {
            const agentId = await createAgent('model-on-create', { modelRef: 'claude-x-2026-01' });
            expect((await row(agentId)).modelRef).toBe('claude-x-2026-01');
        });

        it('registerAgent — the operator-facing path — persists it too', async () => {
            // The other create seam. It has its own schema, so a field added to
            // one and forgotten on the other is exactly the shape of the defect
            // being fixed here.
            const registered = await registerAgent(ctx(), {
                name: 'model-on-register',
                autonomyLevel: 1,
                dataAccessScope: 'READ_METADATA',
                reversibility: 'REVERSIBLE',
                provenance: 'FIRST_PARTY',
                ownerUserId: USER,
                modelRef: 'internal-build-771',
            });
            expect((await row(registered.id)).modelRef).toBe('internal-build-771');
        });

        it('updateRegisteredAgent changes it, and clearing it is distinct from leaving it', async () => {
            const agentId = await createAgent('model-on-update', { modelRef: 'first' });

            await updateRegisteredAgent(ctx(), agentId, { modelRef: 'second' });
            expect((await row(agentId)).modelRef).toBe('second');

            // An update that never mentions the field leaves the column alone —
            // the three-state contract, not a partial update that wipes.
            await updateRegisteredAgent(ctx(), agentId, { name: 'model-on-update renamed' });
            expect((await row(agentId)).modelRef).toBe('second');

            await updateRegisteredAgent(ctx(), agentId, { modelRef: null });
            expect((await row(agentId)).modelRef).toBeNull();
        });

        it('an empty declaration is stored as NULL, so it cannot read as a change', async () => {
            const agentId = await createAgent('model-empty', { modelRef: '   ' });
            expect((await row(agentId)).modelRef).toBeNull();
        });

        it('MODEL_CHANGED fires end-to-end: score, change the model, the run is stale', async () => {
            const agentId = await createAgent('model-staleness', { modelRef: 'model-a' });
            const scored = await completeAgentRiskAssessment(ctx(), agentId);
            expect(scored.tier).toBeDefined();

            // The basis froze the declared model — which is only possible
            // because the create path stored it.
            expect((await standingRun(agentId)).basisModelRef).toBe('model-a');

            const result = await updateRegisteredAgent(ctx(), agentId, { modelRef: 'model-b' });
            expect(result.staleness.stale).toBe(true);
            expect(result.staleness.triggers).toContain('MODEL_CHANGED');

            const run = await standingRun(agentId);
            expect(run.staleAt).not.toBeNull();
            expect(run.staleTriggers).toContain('MODEL_CHANGED');

            // And the tier does NOT move: the model is not a scorer input, so
            // there is nothing to recompute. This is the case where "stale"
            // means exactly what it now says — the ANSWERS may be out of date.
            expect(result.staleness.rescored).toBeNull();
            expect((await row(agentId)).riskTier).toBe(run.scoredTier);
        });

        it('re-declaring the SAME model is not a change', async () => {
            const agentId = await createAgent('model-noop', { modelRef: 'model-a' });
            await completeAgentRiskAssessment(ctx(), agentId);

            const result = await updateRegisteredAgent(ctx(), agentId, { modelRef: 'model-a' });
            expect(result.staleness.stale).toBe(false);
            expect(result.staleness.triggers).toEqual([]);
        });
    });

    // ─────────────────────────────────────────────────────────────────
    // 2. Every axis the scorer reads re-scores on the spot.
    // ─────────────────────────────────────────────────────────────────
    describe('widening an axis raises the tier in the same transaction', () => {
        /**
         * The shared base: autonomy 0, READ_TENANT_DATA, REVERSIBLE,
         * FIRST_PARTY, nothing answered. That scores 16 — the top of the
         * MODERATE band — so a single step on ANY axis crosses into HIGH, which
         * is what makes one base serve all four cases and makes each case about
         * its own axis rather than about the size of the jump.
         */
        async function moderateBase(name: string): Promise<string> {
            const agentId = await createAgent(name, {
                autonomyLevel: 0,
                dataAccessScope: 'READ_TENANT_DATA',
                reversibility: 'REVERSIBLE',
            });
            const scored = await completeAgentRiskAssessment(ctx(), agentId);
            expect(scored.tier).toBe('MODERATE');
            return agentId;
        }

        it.each([
            ['AUTONOMY_RAISED', { autonomyLevel: 1 }],
            ['DATA_SCOPE_WIDENED', { dataAccessScope: 'EXTERNAL_EGRESS' as const }],
            ['REVERSIBILITY_WORSENED', { reversibility: 'TERMINAL' as const }],
            ['PROVENANCE_WIDENED', { provenance: 'THIRD_PARTY' as const, vendorId: VENDOR }],
        ])('%s re-scores the agent and narrows its ceiling', async (trigger, patch) => {
            const agentId = await moderateBase(`rescore-${trigger}`);
            const before = await row(agentId);
            expect(before.riskTier).toBe('MODERATE');

            const result = await updateRegisteredAgent(ctx(), agentId, patch);
            expect(result.staleness.triggers).toContain(trigger);

            // The row, not the return value: a re-score that computed the right
            // tier and wrote it nowhere would satisfy the caller and leave the
            // agent running at the old ceiling.
            const after = await row(agentId);
            expect(after.riskTier).toBe('HIGH');
            expect(result.staleness.rescored).toMatchObject({ from: 'MODERATE', to: 'HIGH' });

            // The consequence, stated as the number the tool boundary uses.
            expect(MAX_AUTONOMY_BY_TIER.HIGH).toBeLessThan(MAX_AUTONOMY_BY_TIER.MODERATE);

            // The stamp moves with the tier — the CHECK constraint pins the two
            // columns together, so a tier can never be read without its date.
            expect(after.riskTierScoredAt).not.toBeNull();
            expect(after.riskTierScoredAt!.getTime()).toBeGreaterThanOrEqual(
                before.riskTierScoredAt!.getTime(),
            );
        });

        it('records the raise as its own audit row, naming both tiers', async () => {
            const agentId = await moderateBase('rescore-audited');
            await updateRegisteredAgent(ctx(), agentId, { dataAccessScope: 'EXTERNAL_EGRESS' });

            const audited = await prisma.auditLog.findFirst({
                where: { tenantId: TENANT, entityId: agentId, action: 'AGENT_RISK_TIER_RAISED' },
                orderBy: { createdAt: 'desc' },
            });
            expect(audited).not.toBeNull();
            const details = audited!.detailsJson as Record<string, unknown>;
            expect(details.previousTier).toBe('MODERATE');
            expect(details.tier).toBe('HIGH');
            // The run whose ANSWERS were reused, so the trail shows this was an
            // existing judgement re-applied rather than a new one invented.
            expect(details.fromAssessmentId).toBe((await standingRun(agentId)).id);
        });

        it('leaves the completed run itself alone — it is the record of a judgement', async () => {
            const agentId = await moderateBase('rescore-run-intact');
            const runBefore = await standingRun(agentId);

            await updateRegisteredAgent(ctx(), agentId, { reversibility: 'TERMINAL' });

            const runAfter = await standingRun(agentId);
            expect(runAfter.id).toBe(runBefore.id);
            expect(runAfter.scoredTier).toBe('MODERATE');
            expect(runAfter.basisReversibility).toBe('REVERSIBLE');
            // While the OPERATIONAL tier has moved on. The two are different
            // questions and the register answers both.
            expect((await row(agentId)).riskTier).toBe('HIGH');
        });

        it('an unrelated edit re-scores nothing', async () => {
            const agentId = await moderateBase('rescore-unrelated');
            const result = await updateRegisteredAgent(ctx(), agentId, {
                name: 'rescore-unrelated renamed',
                description: 'a description is not a scorer input',
            });
            expect(result.staleness.stale).toBe(false);
            expect(result.staleness.rescored).toBeNull();
            expect((await row(agentId)).riskTier).toBe('MODERATE');
        });

        it('NARROWING never lowers the tier — an over-restrictive cap is the safe error', async () => {
            const agentId = await moderateBase('rescore-narrowing');
            await updateRegisteredAgent(ctx(), agentId, { dataAccessScope: 'EXTERNAL_EGRESS' });
            expect((await row(agentId)).riskTier).toBe('HIGH');

            // All the way back to the state the run was scored against.
            const result = await updateRegisteredAgent(ctx(), agentId, {
                dataAccessScope: 'READ_TENANT_DATA',
            });
            // The agent matches its basis again, so nothing is stale…
            expect(result.staleness.stale).toBe(false);
            expect(result.staleness.rescored).toBeNull();
            // …but the tier stays where the widening put it. Lowering it would
            // hand back authority on the strength of a questionnaire nobody
            // re-answered; re-assessing is how an agent gets a tier back.
            expect((await row(agentId)).riskTier).toBe('HIGH');
        });

        it('re-assessing IS the way back down, so the tier is not a one-way ratchet', async () => {
            // The paired positive for the case above. Without it, "never
            // lowers" would be satisfied by a tier that can only ever rise,
            // which would make the register unusable within a month.
            const agentId = await moderateBase('rescore-recoverable');
            await updateRegisteredAgent(ctx(), agentId, { dataAccessScope: 'EXTERNAL_EGRESS' });
            expect((await row(agentId)).riskTier).toBe('HIGH');

            await updateRegisteredAgent(ctx(), agentId, { dataAccessScope: 'READ_TENANT_DATA' });
            const rescored = await completeAgentRiskAssessment(ctx(), agentId);
            expect(rescored.tier).toBe('MODERATE');
            expect((await row(agentId)).riskTier).toBe('MODERATE');
        });
    });

    // ─────────────────────────────────────────────────────────────────
    // 3. The narrowing at the REAL tool boundary. Same agent, same key,
    //    same tool — a widening recorded between the two calls.
    // ─────────────────────────────────────────────────────────────────
    describe('the ceiling narrows at the MCP boundary, not just in the column', () => {
        it('a propose call that succeeded is refused after the agent is widened', async () => {
            // autonomy 2 + READ_TENANT_DATA + REVERSIBLE, nothing answered → 18,
            // which is HIGH (cap 2). Rung 2 is PROPOSE, so the agent sits
            // exactly at the rung its tier permits.
            const agentId = await createAgent('boundary-probe', {
                autonomyLevel: 2,
                dataAccessScope: 'READ_TENANT_DATA',
                reversibility: 'REVERSIBLE',
            });
            const scored = await completeAgentRiskAssessment(ctx(), agentId);
            expect(scored.tier).toBe('HIGH');

            await grantAgentTool(ctx(), agentId, { toolName: 'list_risks' });
            await grantAgentTool(ctx(), agentId, { toolName: 'propose_finding' });
            await activateRegisteredAgent(ctx(), agentId);
            const token = await mintKey(agentId);

            const beforeRead = await callTool(token, 'list_risks');
            expect(errorOf(beforeRead.json)).toBeUndefined();
            const beforePropose = await callTool(token, 'propose_finding', {
                items: [{ severity: 'LOW', type: 'OTHER', title: 'before the widening' }],
            });
            expect(errorOf(beforePropose.json)).toBeUndefined();

            // ONE amendment, no re-assessment, no autonomy change: the two axes
            // that appear nowhere in the ceiling. 2 + 8 + 6 + 12 = 28 → CRITICAL
            // (cap 1). Before this change the agent kept HIGH and kept PROPOSE.
            const widened = await updateRegisteredAgent(ctx(), agentId, {
                dataAccessScope: 'EXTERNAL_EGRESS',
                reversibility: 'TERMINAL',
            });
            expect(widened.staleness.rescored).toMatchObject({ from: 'HIGH', to: 'CRITICAL' });
            expect((await row(agentId)).riskTier).toBe('CRITICAL');

            const afterPropose = await callTool(token, 'propose_finding', {
                items: [{ severity: 'LOW', type: 'OTHER', title: 'after the widening' }],
            });
            expect(errorOf(afterPropose.json)).toMatch(/autonomy/i);

            // The paired positive, and it is the reason this is a NARROWING
            // rather than a kill switch: the agent is still working at the rung
            // its new tier permits. A suite that only showed the refusal would
            // pass against a change that took the agent dark.
            const afterRead = await callTool(token, 'list_risks');
            expect(errorOf(afterRead.json)).toBeUndefined();
        });
    });

    // ─────────────────────────────────────────────────────────────────
    // 4. TOOL_GRANTED — the one trigger a re-score cannot answer.
    // ─────────────────────────────────────────────────────────────────
    describe('a tool grant is bounded by the rung, not by a re-score', () => {
        /** autonomy 0 + EXTERNAL_EGRESS + TERMINAL, unanswered → 26 → CRITICAL. */
        async function criticalAgent(name: string): Promise<string> {
            const agentId = await createAgent(name, {
                autonomyLevel: 0,
                dataAccessScope: 'EXTERNAL_EGRESS',
                reversibility: 'TERMINAL',
            });
            const scored = await completeAgentRiskAssessment(ctx(), agentId);
            expect(scored.tier).toBe('CRITICAL');
            return agentId;
        }

        it('refuses a grant the tier could never exercise, and writes no row', async () => {
            const agentId = await criticalAgent('grant-refused');
            // CRITICAL caps at 1 (READ). `propose_finding` needs 2.
            await expect(
                grantAgentTool(ctx(), agentId, { toolName: 'propose_finding' }),
            ).rejects.toThrow(/CRITICAL/);

            expect(
                await prisma.registeredAgentTool.count({
                    where: { tenantId: TENANT, agentId, toolName: 'propose_finding' },
                }),
            ).toBe(0);
        });

        it('ALLOWS a grant within the cap — the refusal is not blanket', async () => {
            const agentId = await criticalAgent('grant-allowed');
            const granted = await grantAgentTool(ctx(), agentId, { toolName: 'list_risks' });
            expect(granted.toolName).toBe('list_risks');
        });

        it('and the same propose tool is granted freely to an agent whose tier reaches it', async () => {
            // The paired positive across TIERS rather than across tools: the
            // refusal is a property of the assessment, not of `propose_finding`.
            const agentId = await createAgent('grant-high-tier', {
                autonomyLevel: 2,
                dataAccessScope: 'READ_TENANT_DATA',
                reversibility: 'REVERSIBLE',
            });
            expect((await completeAgentRiskAssessment(ctx(), agentId)).tier).toBe('HIGH');
            await expect(
                grantAgentTool(ctx(), agentId, { toolName: 'propose_finding' }),
            ).resolves.toMatchObject({ toolName: 'propose_finding' });
        });

        it('an UNSCORED agent may still be prepared — assessment is demanded at activation', async () => {
            // Its ceiling is DENY, so a rung rule applied here would refuse
            // every grant and make setting a DRAFT agent up impossible. The
            // register's own maintenance must not be the outage.
            const agentId = await createAgent('grant-unscored');
            expect((await row(agentId)).riskTier).toBeNull();
            await expect(
                grantAgentTool(ctx(), agentId, { toolName: 'propose_finding' }),
            ).resolves.toMatchObject({ toolName: 'propose_finding' });

            await expect(activateRegisteredAgent(ctx(), agentId)).rejects.toThrow(
                /risk-assessed/i,
            );
        });

        it('a grant marks the run stale and re-scores NOTHING — the count is not a scorer input', async () => {
            const agentId = await criticalAgent('grant-stale');
            const tierBefore = (await row(agentId)).riskTier;

            const granted = await grantAgentTool(ctx(), agentId, { toolName: 'list_risks' });
            expect(granted.staleness.stale).toBe(true);
            expect(granted.staleness.triggers).toContain('TOOL_GRANTED');
            expect(granted.staleness.rescored).toBeNull();

            // The honest reading of this case: the tier is unchanged because
            // there is nothing to recompute, and the grant was bounded at the
            // moment it was written instead.
            expect((await row(agentId)).riskTier).toBe(tierBefore);
        });
    });
});
