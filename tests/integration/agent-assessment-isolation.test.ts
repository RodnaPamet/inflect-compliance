/**
 * Agent risk assessment — the RLS SPLIT, proved in BOTH directions.
 *
 * This subsystem has two kinds of table, and the whole design depends on
 * getting the difference right:
 *
 *   • `AgentAssessmentDomain` / `AgentAssessmentQuestion` are GLOBAL reference
 *     content — no `tenantId`, no RLS, seeded once from a fixture. Every tenant
 *     must read the SAME rows, because an assessor citing "ara-1-03" in a report
 *     has to resolve to the same question forever.
 *   • `AgentRiskAssessment` / `AgentRiskAssessmentAnswer` are TENANT-SCOPED
 *     runs. They hold what one customer said about the guardrails missing on
 *     its own autonomous agents — which is to say, a list of that customer's
 *     unmitigated weaknesses.
 *
 * A tenant-only isolation suite proves half of that and would stay green if the
 * global tables had been put behind RLS by mistake: every tenant would then see
 * zero questions, the instrument would be blank for everybody, and nothing in a
 * cross-tenant test would object. So this file asserts BOTH — the shared rows
 * really are shared, and the tenant rows really are not.
 *
 * It also drives the SCORER through the real usecase under two tenants, because
 * the tier this writes back to `RegisteredAgent.riskTier` is what caps the
 * agent's authority: a cross-tenant write here is one customer setting another
 * customer's agent authority cap.
 */
import { PrismaClient, MembershipStatus, Role } from '@prisma/client';
import { prismaTestClient, resetDatabase } from '../helpers/db';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { createRegisteredAgent } from '@/app-layer/usecases/agent-registry';
import {
    completeAgentRiskAssessment,
    getAgentRiskAssessmentState,
    listAgentRiskAssessments,
    refreshAgentAssessmentStaleness,
    saveAgentAssessmentAnswer,
} from '@/app-layer/usecases/agent-risk-assessment';

const fixture = require('../../prisma/fixtures/agent-risk-assessment.json') as {
    questionSetVersion: number;
    domains: Array<{ id: number; code: string; name: string; description: string; sortOrder: number }>;
    questions: Array<{
        id: string;
        domainId: number;
        criticality: string;
        text: string;
        guidance: string | null;
        mappings: { asi: string[]; imda: string[] };
    }>;
};

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(60_000);

const T1 = 'agentassess-tenant-one';
const T2 = 'agentassess-tenant-two';

/** `app_user` with NO tenant bound — the "context never got set" case. */
async function asAppUserWithNoTenant<T>(fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
    return prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE app_user`);
        return fn(tx as unknown as PrismaClient);
    });
}

/** `app_user` bound to one tenant — what a real request looks like. */
async function asTenant<T>(tenantId: string, fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
    return prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE app_user`);
        await tx.$executeRawUnsafe(`SELECT set_config('app.tenant_id', '${tenantId}', true)`);
        return fn(tx as unknown as PrismaClient);
    });
}

/**
 * The REAL fixture seed, run exactly as `scripts/seed-self-assessments.ts` runs
 * it. Using the shipped loader shape rather than a hand-written fixture means
 * the idempotency assertion below is about the thing that runs in production.
 */
async function seedReferenceContent(): Promise<void> {
    for (const d of fixture.domains) {
        const data = { code: d.code, name: d.name, description: d.description, sortOrder: d.sortOrder };
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

/**
 * `resetDatabase` truncates a fixed table list that includes none of these, so
 * this suite clears its own rows — otherwise it passes exactly once on a fresh
 * database and fails every re-run, and CI always starts clean, which is what
 * would hide it.
 *
 * The global reference rows are deliberately NOT cleared: they are shared
 * library content that the deployment is supposed to carry, the seed is an
 * upsert, and deleting them would break any sibling suite that assumes they are
 * there.
 *
 * The AuditLog / TenantMembership deletes go through `session_replication_role
 * = 'replica'`: the immutable-audit-log trigger and the last-OWNER guard both
 * fire on an ordinary DELETE and would take the teardown — and therefore the
 * whole suite — down with them.
 */
async function clearOwnRows(): Promise<void> {
    const t = { tenantId: { in: [T1, T2] } };
    await prisma.agentRiskAssessmentAnswer.deleteMany({ where: t });
    await prisma.agentRiskAssessment.deleteMany({ where: t });
    await prisma.registeredAgent.deleteMany({ where: t });
    await prisma.aiSystem.deleteMany({ where: t });
    await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        await tx.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE "tenantId" = ANY($1::text[])`, [T1, T2]);
        await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = ANY($1::text[])`, [T1, T2]);
    });
    await prisma.user.deleteMany({
        where: { emailHash: { in: [T1, T2].map((t2) => hashForLookup(`owner@${t2}.test`)) } },
    });
    await prisma.tenant.deleteMany({ where: { id: { in: [T1, T2] } } });
}

const seeded: Record<string, { agentId: string; aiSystemId: string; ownerUserId: string }> = {};
const ctxFor = (tenantId: string) =>
    makeRequestContext('OWNER', {
        tenantId,
        tenantSlug: tenantId,
        userId: seeded[tenantId].ownerUserId,
    });

const FIRST_QUESTION = fixture.questions[0].id;
const SECOND_QUESTION = fixture.questions[1].id;

beforeAll(async () => {
    await resetDatabase(prisma);
    await clearOwnRows();
    await seedReferenceContent();

    for (const [id, name] of [[T1, 'Tenant One'], [T2, 'Tenant Two']] as const) {
        await prisma.tenant.create({ data: { id, name, slug: id } });
        const email = `owner@${id}.test`;
        const user = await prisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
        await prisma.tenantMembership.create({
            data: { tenantId: id, userId: user.id, role: Role.OWNER, status: MembershipStatus.ACTIVE },
        });
        const aiSystem = await prisma.aiSystem.create({
            data: { tenantId: id, name: `Agent host ${id}`, ownerUserId: user.id },
        });
        seeded[id] = { agentId: '', aiSystemId: aiSystem.id, ownerUserId: user.id };
    }

    for (const t of [T1, T2]) {
        const created = await createRegisteredAgent(ctxFor(t), {
            aiSystemId: seeded[t].aiSystemId,
            name: `Ops agent ${t}`,
            autonomyLevel: 3,
            dataAccessScope: 'READ_TENANT_DATA',
            reversibility: 'COMPENSABLE',
            provenance: 'FIRST_PARTY',
            ownerUserId: seeded[t].ownerUserId,
        });
        seeded[t].agentId = created.id;
    }

    // One answer per tenant, each naming its own tenant so a leak is legible.
    for (const t of [T1, T2]) {
        await saveAgentAssessmentAnswer(ctxFor(t), seeded[t].agentId, {
            questionId: FIRST_QUESTION,
            answer: 'PARTIALLY',
            note: `<script>alert(1)</script>Tool allowlist partial for ${t}`,
        });
    }
});

afterAll(async () => {
    await clearOwnRows();
    await prisma.$disconnect();
});

// ─────────────────────────────────────────────────────────────────────
// Direction 1 — the GLOBAL half. Shared rows really are shared.
// ─────────────────────────────────────────────────────────────────────

describe('the reference content is GLOBAL — both tenants read the same rows', () => {
    it('the fixture seeded the four IMDA dimensions and every ASI class', () => {
        expect(fixture.domains).toHaveLength(4);
        const classes = new Set(fixture.questions.flatMap((q) => q.mappings.asi));
        expect([...classes].sort()).toEqual([
            'ASI01', 'ASI02', 'ASI03', 'ASI04', 'ASI05',
            'ASI06', 'ASI07', 'ASI08', 'ASI09', 'ASI10',
        ]);
    });

    it('each tenant sees the full question set through the usecase — the SAME ids', async () => {
        const [one, two] = await Promise.all([
            getAgentRiskAssessmentState(ctxFor(T1), seeded[T1].agentId),
            getAgentRiskAssessmentState(ctxFor(T2), seeded[T2].agentId),
        ]);
        expect(one.questions).toHaveLength(fixture.questions.length);
        expect(one.domains).toHaveLength(fixture.domains.length);

        const idsOne = one.questions.map((q) => q.id).sort();
        const idsTwo = two.questions.map((q) => q.id).sort();
        expect(idsOne).toEqual(idsTwo);
        expect(idsOne).toEqual([...fixture.questions.map((q) => q.id)].sort());
    });

    it('and a raw read under app_user with NO tenant context still returns them', async () => {
        // The proof that these tables carry no RLS. A tenant-scoped table
        // returns ZERO rows here (asserted below); these must not.
        const rows = await asAppUserWithNoTenant((tx) =>
            tx.agentAssessmentQuestion.findMany({ select: { id: true } }),
        );
        expect(rows.length).toBeGreaterThanOrEqual(fixture.questions.length);
    });

    it('a tenant-bound app_user reads the same global rows as any other tenant', async () => {
        const [one, two] = await Promise.all([
            asTenant(T1, (tx) => tx.agentAssessmentDomain.findMany({ select: { code: true } })),
            asTenant(T2, (tx) => tx.agentAssessmentDomain.findMany({ select: { code: true } })),
        ]);
        expect(one.map((d) => d.code).sort()).toEqual(two.map((d) => d.code).sort());
        expect(one).toHaveLength(fixture.domains.length);
    });

    it('re-running the seed yields ONE copy, not two', async () => {
        const before = await prisma.agentAssessmentQuestion.count();
        await seedReferenceContent();
        await seedReferenceContent();
        expect(await prisma.agentAssessmentQuestion.count()).toBe(before);
        expect(await prisma.agentAssessmentDomain.count()).toBe(fixture.domains.length);
    });
});

// ─────────────────────────────────────────────────────────────────────
// Direction 2 — the TENANT half. A customer's answers are its own.
// ─────────────────────────────────────────────────────────────────────

describe('assessments and answers are TENANT-SCOPED', () => {
    it('BOTH tenants really have rows — otherwise every assertion below is vacuous', async () => {
        const assessments = await prisma.agentRiskAssessment.findMany({
            where: { tenantId: { in: [T1, T2] } },
        });
        expect(assessments).toHaveLength(2);
        expect(assessments.map((a) => a.tenantId).sort()).toEqual([T1, T2]);

        const answers = await prisma.agentRiskAssessmentAnswer.findMany({
            where: { tenantId: { in: [T1, T2] } },
        });
        expect(answers).toHaveLength(2);
    });

    it('each tenant lists exactly its own runs through the usecase', async () => {
        for (const t of [T1, T2]) {
            const runs = await listAgentRiskAssessments(ctxFor(t), seeded[t].agentId);
            expect(runs).toHaveLength(1);
            expect(runs[0].tenantId).toBe(t);
        }
    });

    it("asking for the OTHER tenant's agent is a not-found, not a read", async () => {
        await expect(
            getAgentRiskAssessmentState(ctxFor(T1), seeded[T2].agentId),
        ).rejects.toThrow(/not found/i);
        await expect(
            listAgentRiskAssessments(ctxFor(T2), seeded[T1].agentId),
        ).rejects.toThrow(/not found/i);
    });

    it('a direct query under app_user with NO tenant context returns zero rows', async () => {
        const assessments = await asAppUserWithNoTenant((tx) =>
            tx.agentRiskAssessment.findMany({}),
        );
        const answers = await asAppUserWithNoTenant((tx) =>
            tx.agentRiskAssessmentAnswer.findMany({}),
        );
        expect(assessments).toEqual([]);
        expect(answers).toEqual([]);
    });

    it("a tenant-bound app_user cannot see the other tenant's assessment or answers", async () => {
        const seenByOne = await asTenant(T1, (tx) =>
            tx.agentRiskAssessment.findMany({ select: { tenantId: true } }),
        );
        expect(seenByOne.map((a) => a.tenantId)).toEqual([T1]);

        const answersSeenByTwo = await asTenant(T2, (tx) =>
            tx.agentRiskAssessmentAnswer.findMany({ select: { tenantId: true } }),
        );
        expect(answersSeenByTwo.map((a) => a.tenantId)).toEqual([T2]);
    });

    it("cannot write a row stamped with the OTHER tenant's id", async () => {
        await expect(
            asTenant(T1, (tx) =>
                tx.agentRiskAssessment.create({
                    data: { tenantId: T2, agentId: seeded[T2].agentId, staleTriggers: [] },
                }),
            ),
        ).rejects.toThrow();
    });

    it("saving an answer against the other tenant's agent is refused", async () => {
        await expect(
            saveAgentAssessmentAnswer(ctxFor(T1), seeded[T2].agentId, {
                questionId: SECOND_QUESTION,
                answer: 'YES',
            }),
        ).rejects.toThrow(/not found/i);

        const t2Answers = await prisma.agentRiskAssessmentAnswer.findMany({
            where: { tenantId: T2 },
        });
        expect(t2Answers).toHaveLength(1);
    });

    it('the free-text note is sanitised before it is stored, per tenant', async () => {
        const state = await getAgentRiskAssessmentState(ctxFor(T1), seeded[T1].agentId);
        const answered = state.questions.find((q) => q.id === FIRST_QUESTION);
        expect(answered?.note).toBe(`Tool allowlist partial for ${T1}`);
        expect(answered?.note).not.toContain('<script');
    });
});

// ─────────────────────────────────────────────────────────────────────
// The scorer, driven through the real usecase under two tenants.
// ─────────────────────────────────────────────────────────────────────

describe('completing a run scores the agent and writes the tier back', () => {
    it('the agent arrives UNSCORED — NULL tier, NULL timestamp', async () => {
        const row = await prisma.registeredAgent.findUniqueOrThrow({
            where: { id: seeded[T1].agentId },
        });
        expect(row.riskTier).toBeNull();
        expect(row.riskTierScoredAt).toBeNull();
    });

    it('completing writes a tier, a timestamp and the basis, in one transaction', async () => {
        const result = await completeAgentRiskAssessment(ctxFor(T1), seeded[T1].agentId);
        expect(['LOW', 'MODERATE', 'HIGH', 'CRITICAL']).toContain(result.tier);

        const agent = await prisma.registeredAgent.findUniqueOrThrow({
            where: { id: seeded[T1].agentId },
        });
        expect(agent.riskTier).toBe(result.tier);
        expect(agent.riskTierScoredAt).not.toBeNull();

        const run = await prisma.agentRiskAssessment.findFirstOrThrow({
            where: { tenantId: T1, status: 'COMPLETED' },
        });
        expect(run.scoredTier).toBe(result.tier);
        expect(run.score).toBe(result.score);
        // The basis is the agent as it was, so staleness is a comparison later.
        expect(run.basisAutonomyLevel).toBe(3);
        expect(run.basisDataAccessScope).toBe('READ_TENANT_DATA');
        expect(run.basisReversibility).toBe('COMPENSABLE');
        expect(run.basisToolCount).toBe(0);
        expect(run.staleAt).toBeNull();
        expect(run.staleTriggers).toEqual([]);
    });

    it("scoring one tenant's agent leaves the other tenant's agent UNSCORED", async () => {
        const other = await prisma.registeredAgent.findUniqueOrThrow({
            where: { id: seeded[T2].agentId },
        });
        expect(other.riskTier).toBeNull();
        expect(other.riskTierScoredAt).toBeNull();
    });

    it("completing the other tenant's agent through tenant one's context is refused", async () => {
        await expect(
            completeAgentRiskAssessment(ctxFor(T1), seeded[T2].agentId),
        ).rejects.toThrow(/not found/i);

        const untouched = await prisma.registeredAgent.findUniqueOrThrow({
            where: { id: seeded[T2].agentId },
        });
        expect(untouched.riskTier).toBeNull();
    });
});

describe('staleness is detected against the basis, per tenant', () => {
    it('a freshly scored assessment is not stale', async () => {
        const verdict = await refreshAgentAssessmentStaleness(ctxFor(T1), seeded[T1].agentId);
        expect(verdict.stale).toBe(false);
        expect(verdict.triggers).toEqual([]);
    });

    it("raising the agent's autonomy marks the standing assessment stale — and only warns", async () => {
        await prisma.registeredAgent.update({
            where: { id: seeded[T1].agentId },
            data: { autonomyLevel: 5 },
        });

        const verdict = await refreshAgentAssessmentStaleness(ctxFor(T1), seeded[T1].agentId);
        expect(verdict.stale).toBe(true);
        expect(verdict.triggers).toEqual(['AUTONOMY_RAISED']);

        const agent = await prisma.registeredAgent.findUniqueOrThrow({
            where: { id: seeded[T1].agentId },
        });
        // WARNS, does not block: the tier stays in force, so the agent keeps
        // exactly the authority its last real assessment justified. "Stale" and
        // "never scored" are different states and only the second one denies.
        expect(agent.riskTier).not.toBeNull();

        const run = await prisma.agentRiskAssessment.findFirstOrThrow({
            where: { tenantId: T1, status: 'COMPLETED' },
        });
        expect(run.staleAt).not.toBeNull();
        expect(run.staleTriggers).toEqual(['AUTONOMY_RAISED']);
    });

    it("the other tenant's runs are untouched by that", async () => {
        const otherRuns = await prisma.agentRiskAssessment.findMany({ where: { tenantId: T2 } });
        expect(otherRuns.every((r) => r.staleAt === null)).toBe(true);
        expect(otherRuns.every((r) => r.staleTriggers.length === 0)).toBe(true);
    });

    it('re-scoring clears the staleness and records the NEW basis', async () => {
        const rescored = await completeAgentRiskAssessment(ctxFor(T1), seeded[T1].agentId);
        const runs = await prisma.agentRiskAssessment.findMany({
            where: { tenantId: T1, status: 'COMPLETED' },
            orderBy: { completedAt: 'desc' },
        });
        // A re-score is a NEW run — the previous judgement stays legible.
        expect(runs.length).toBeGreaterThanOrEqual(2);
        expect(runs[0].basisAutonomyLevel).toBe(5);
        expect(runs[0].staleAt).toBeNull();
        expect(runs[0].scoredTier).toBe(rescored.tier);
    });
});
