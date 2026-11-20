/**
 * Agent Pay Phase 1.4 (#5333; owner decisions of 2026-11-20) — an AGENT
 * campaign's pack proposes WITHDRAWING a declared spending envelope, and a
 * person decides it, against a real database.
 *
 *   - Each ground the owner named produces a proposal, and the row records
 *     which: expired by the window's end, still suspension-requested after a
 *     kill, never reviewed. A reviewed, live envelope proposes nothing, and a
 *     withdrawn one proposes nothing.
 *   - Accepting withdraws the declaration the pack described, through the
 *     envelope writer's one internal path, and opens a task for the agent's
 *     owner to revoke the token at its requestor. Rejecting changes nothing.
 *   - A declaration made again since the pack is left alone; one withdrawn on
 *     the register first still gets the owner's task.
 *   - The agent's owner, frozen or current, may not decide (403 and
 *     AUTHZ_DENIED, and a CHECK for any writer).
 *   - A pending withdrawal holds the subject's verdict and the close.
 *   - The row is one-way (triggers), `app_user` cannot delete it, the grounds
 *     are a closed vocabulary (CHECK), and the closing evidence carries it and
 *     recomputes.
 *   - Tenant isolation, through RLS and through the usecases.
 */
import { PrismaClient, Role, type AgentSpendingRail } from '@prisma/client';

import { prismaTestClient } from '../helpers/db';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { makeRequestContext } from '../helpers/make-context';
import { hashForLookup } from '@/lib/security/encryption';
import { resolveTenantContext } from '@/lib/tenant-context';
import type { RequestContext } from '@/app-layer/types';
import {
    closeAgentAccessReview,
    confirmAgentHasNoPaymentAbility,
    createAgentAccessReview,
    decideAgentSpendingWithdrawal,
    getAgentReviewPacks,
    prepareAgentReviewPacks,
    recomputeAgentCampaignEvidence,
    submitAgentDecision,
} from '@/app-layer/usecases/access-review-agent';
import { AGENT_RECERTIFICATION_EVIDENCE_TOOL } from '@/lib/agentic/agent-recertification';
import { sha256Of } from '@/lib/agentic/agent-recertification-hash';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(180_000);

const T1 = 'arc-pay-wd-one';
const T2 = 'arc-pay-wd-two';
const TENANTS = [T1, T2];
const DAY = 86_400_000;
const TOKEN_REFERENCE = 'DWSPMC000000000132d72d4fcb2f4136';

type Person = 'owner' | 'reviewer' | 'declarer' | 'envReviewer' | 'agentOwner' | 'admin2';
const PEOPLE: Person[] = ['owner', 'reviewer', 'declarer', 'envReviewer', 'agentOwner', 'admin2'];
const ROLE: Record<Person, Role> = {
    owner: Role.OWNER,
    reviewer: Role.EDITOR,
    declarer: Role.ADMIN,
    envReviewer: Role.ADMIN,
    // An ADMIN, so the owner rule is the ONLY thing between them and deciding
    // their own agent's withdrawal: canAdmin alone would admit them.
    agentOwner: Role.ADMIN,
    admin2: Role.ADMIN,
};
const users: Record<string, Record<Person, string>> = {};
const contexts: Record<string, Record<Person, RequestContext>> = {};
const as = (tenantId: string, who: Person) => contexts[tenantId][who];
const emailOf = (tenantId: string, who: Person) => `${who}@${tenantId}.test`;
let seq = 0;

/** T1's population: the preparer, the paying agent, a clean one. T2: one agent. */
const A: Record<'preparer' | 'paying' | 'clean' | 'solo', string> = { preparer: '', paying: '', clean: '', solo: '' };

async function clearCampaigns(): Promise<void> {
    const t = { tenantId: { in: TENANTS } };
    await prisma.accessReviewDecisionSampleAudit.deleteMany({ where: t });
    await prisma.accessReviewAgentSpendingWithdrawal.deleteMany({ where: t });
    await prisma.accessReviewAgentNarrowing.deleteMany({ where: t });
    await prisma.accessReviewAgentPack.deleteMany({ where: t });
    await prisma.accessReviewConnectedDecision.deleteMany({ where: t });
    await prisma.accessReview.deleteMany({ where: t });
    await prisma.evidenceControlLink.deleteMany({ where: t });
    await prisma.evidence.deleteMany({ where: t });
    await prisma.fileRecord.deleteMany({ where: t });
    await prisma.task.deleteMany({ where: t });
    await prisma.finding.deleteMany({ where: t });
    await prisma.workflowStep.deleteMany({ where: t });
    await prisma.workflowRun.deleteMany({ where: t });
    await prisma.agentSpendingAuthority.deleteMany({ where: t });
}

async function clearOwnRows(): Promise<void> {
    const t = { tenantId: { in: TENANTS } };
    await clearCampaigns();
    await prisma.registeredAgentTool.deleteMany({ where: t });
    await prisma.registeredAgent.deleteMany({ where: t });
    await prisma.aiSystem.deleteMany({ where: t });
    await prisma.taskKeySequence.deleteMany({ where: t });
    await deleteAuditRowsForTenants(prisma, TENANTS);
    await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = ANY($1::text[])`, TENANTS);
    });
    await prisma.user.deleteMany({
        where: { emailHash: { in: TENANTS.flatMap((tn) => PEOPLE.map((p) => hashForLookup(emailOf(tn, p)))) } },
    });
    await prisma.tenant.deleteMany({ where: { id: { in: TENANTS } } });
}

async function makeAgent(tenantId: string, owner: Person): Promise<string> {
    seq += 1;
    const sys = await prisma.aiSystem.create({ data: { tenantId, name: `pay wd host ${seq}`, ownerUserId: users[tenantId][owner] } });
    const agent = await prisma.registeredAgent.create({
        data: {
            tenantId,
            aiSystemId: sys.id,
            name: `pay wd agent ${seq}`,
            autonomyLevel: 1,
            dataAccessScope: 'READ_TENANT_DATA',
            reversibility: 'REVERSIBLE',
            provenance: 'FIRST_PARTY',
            ownerUserId: users[tenantId][owner],
            status: 'ACTIVE',
            riskTier: 'LOW',
            riskTierScoredAt: new Date(),
        },
    });
    return agent.id;
}

/** An envelope as the register writer leaves it at DECLARED; the writer's own rules have their own test. */
function envelope(tenantId: string, agentId: string, rail: AgentSpendingRail, over: Record<string, unknown> = {}) {
    return {
        tenantId,
        agentId,
        rail,
        perTransactionLimitMinor: BigInt(5_000),
        periodBudgetMinor: BigInt(50_000),
        budgetPeriod: 'MONTH' as const,
        currency: 'EUR',
        merchantDomains: ['shop.example.com'],
        merchantCategoryCodes: [],
        expiresAt: new Date(Date.now() + 90 * DAY),
        consentedByUserId: users[tenantId].agentOwner,
        tokenRequestor: 'Example Agent Platform',
        tokenReference: TOKEN_REFERENCE,
        declaredByUserId: users[tenantId].declarer,
        declaredAt: new Date(Date.now() - 30 * DAY),
        ownerUserIdAtDeclaration: users[tenantId].agentOwner,
        ...over,
    };
}

async function review(id: string, tenantId = T1) {
    return prisma.agentSpendingAuthority.update({
        where: { id },
        data: { status: 'REVIEWED', reviewedByUserId: users[tenantId].envReviewer, reviewedAt: new Date(Date.now() - 29 * DAY) },
    });
}

/**
 * The paying agent's three envelopes, one per ground, and the clean agent's
 * two that propose nothing. Rebuilt for every campaign, because deciding one
 * changes them.
 */
async function seedEnvelopes(): Promise<void> {
    await prisma.agentSpendingAuthority.deleteMany({ where: { tenantId: { in: TENANTS } } });
    // (a) reviewed, but lapsed before the campaign was created.
    const expired = await prisma.agentSpendingAuthority.create({
        data: envelope(T1, A.paying, 'AGENT_PAY_TOKEN', { expiresAt: new Date(Date.now() - DAY) }),
    });
    await review(expired.id);
    // (c) declared, and nobody else has reviewed it.
    await prisma.agentSpendingAuthority.create({ data: envelope(T1, A.paying, 'AP4M') });
    // (b) reviewed, then a kill asked for its suspension, and nobody has resolved it.
    const suspended = await prisma.agentSpendingAuthority.create({ data: envelope(T1, A.paying, 'OTHER') });
    await review(suspended.id);
    await prisma.agentSpendingAuthority.update({
        where: { id: suspended.id },
        data: { status: 'SUSPENDED_REQUESTED', suspensionRequestedAt: new Date(Date.now() - 2 * DAY) },
    });
    // Nothing to propose: reviewed and live; and already withdrawn.
    const live = await prisma.agentSpendingAuthority.create({ data: envelope(T1, A.clean, 'AGENT_PAY_TOKEN') });
    await review(live.id);
    const gone = await prisma.agentSpendingAuthority.create({ data: envelope(T1, A.clean, 'AP4M') });
    await prisma.agentSpendingAuthority.update({
        where: { id: gone.id },
        data: { status: 'WITHDRAWN', withdrawnAt: new Date(Date.now() - DAY), withdrawnByUserId: users[T1].declarer },
    });
}

async function freshCampaign(dueAt?: Date): Promise<string> {
    await seedEnvelopes();
    const r = await createAgentAccessReview(as(T1, 'owner'), {
        name: 'spending recertification',
        reviewerUserId: users[T1].reviewer,
        preparerAgentId: A.preparer,
        ...(dueAt ? { dueAt: dueAt.toISOString() } : {}),
    });
    await prepareAgentReviewPacks(as(T1, 'owner'), r.accessReviewId);
    return r.accessReviewId;
}

const withdrawalOn = (accessReviewId: string, rail: AgentSpendingRail) =>
    prisma.accessReviewAgentSpendingWithdrawal.findFirstOrThrow({ where: { accessReviewId, rail } });
const envelopeOn = (agentId: string, rail: AgentSpendingRail) =>
    prisma.agentSpendingAuthority.findFirstOrThrow({ where: { tenantId: T1, agentId, rail } });
const decisionFor = (accessReviewId: string, agentId: string) =>
    prisma.accessReviewConnectedDecision.findFirstOrThrow({ where: { accessReviewId, subjectAgentId: agentId } });

/** Run as `app_user` in a tenant's context — the RLS path the application takes. */
async function asTenant<T>(tenantId: string, fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
    return prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE app_user`);
        await tx.$executeRawUnsafe(`SELECT set_config('app.tenant_id', '${tenantId}', true)`);
        return fn(tx as unknown as PrismaClient);
    });
}

beforeAll(async () => {
    await clearOwnRows();
    for (const tenantId of TENANTS) {
        await prisma.tenant.create({ data: { id: tenantId, name: tenantId, slug: tenantId } });
        users[tenantId] = {} as Record<Person, string>;
        for (const who of PEOPLE) {
            const email = emailOf(tenantId, who);
            users[tenantId][who] = (await prisma.user.create({ data: { email, emailHash: hashForLookup(email) } })).id;
            await prisma.tenantMembership.create({
                data: { tenantId, userId: users[tenantId][who], role: ROLE[who], status: 'ACTIVE' },
            });
        }
        contexts[tenantId] = {} as Record<Person, RequestContext>;
        for (const who of PEOPLE) {
            const resolved = await resolveTenantContext({ tenantId }, users[tenantId][who]);
            contexts[tenantId][who] = makeRequestContext(resolved.role, {
                tenantId, tenantSlug: tenantId, userId: users[tenantId][who],
                permissions: resolved.permissions, appPermissions: resolved.appPermissions,
            });
        }
    }
    A.preparer = await makeAgent(T1, 'owner');
    A.paying = await makeAgent(T1, 'agentOwner');
    A.clean = await makeAgent(T1, 'owner');
    A.solo = await makeAgent(T2, 'owner');
    for (const [tenantId, agentId] of [[T1, A.preparer], [T2, A.solo]] as const) {
        await prisma.registeredAgentTool.create({
            data: { tenantId, agentId, toolName: AGENT_RECERTIFICATION_EVIDENCE_TOOL, grantedByUserId: users[tenantId].owner },
        });
    }
});

afterAll(async () => {
    await clearOwnRows();
    await prisma.$disconnect();
});

afterEach(async () => {
    await clearCampaigns();
    // The owner may have been moved by a test.
    await prisma.registeredAgent.update({ where: { id: A.paying }, data: { ownerUserId: users[T1].agentOwner } });
});

// ─── The proposals ─────────────────────────────────────────────────────

describe('a pack proposes withdrawing an envelope on each ground, and records which', () => {
    it('one proposal per ground on the paying agent, none for a reviewed live envelope or a withdrawn one', async () => {
        const id = await freshCampaign();
        const rows = await prisma.accessReviewAgentSpendingWithdrawal.findMany({
            where: { accessReviewId: id },
            orderBy: { rail: 'asc' },
        });
        expect(rows.map((w) => [w.agentId, w.rail, w.grounds, w.statusAtPack, w.outcome])).toEqual([
            [A.paying, 'AGENT_PAY_TOKEN', ['EXPIRED_BY_WINDOW_END'], 'REVIEWED', 'PENDING'],
            [A.paying, 'AP4M', ['NEVER_REVIEWED'], 'DECLARED', 'PENDING'],
            [A.paying, 'OTHER', ['SUSPENDED_AFTER_KILL'], 'SUSPENDED_REQUESTED', 'PENDING'],
        ]);
        // Each names the declaration the pack read, and the owner frozen.
        for (const w of rows) {
            expect(w.declaredAt.getTime()).toBe((await envelopeOn(A.paying, w.rail)).declaredAt.getTime());
            expect(w.subjectOwnerUserId).toBe(users[T1].agentOwner);
        }
    });

    it('a pack’s stored hash still recomputes from its stored sections, and the read returns the proposals', async () => {
        const id = await freshCampaign();
        for (const p of await prisma.accessReviewAgentPack.findMany({ where: { accessReviewId: id } })) {
            expect(p.contentHash).toBe(sha256Of(p.sectionsJson));
        }
        const read = await getAgentReviewPacks(as(T1, 'reviewer'), id);
        expect(read.spendingWithdrawals).toHaveLength(3);
        // No token reference reaches a reader: the row holds none.
        expect(JSON.stringify(read.spendingWithdrawals)).not.toContain(TOKEN_REFERENCE);
    });
});

describe('(a) an envelope that lapses before the campaign ends (owner decision, 2026-11-20)', () => {
    it('is proposed when it expires before the campaign’s due date, and not when the campaign has none', async () => {
        // The clean agent's live envelope lapses in 90 days.
        const due = await freshCampaign(new Date(Date.now() + 120 * DAY));
        const proposed = await prisma.accessReviewAgentSpendingWithdrawal.findMany({
            where: { accessReviewId: due, agentId: A.clean },
        });
        expect(proposed.map((w) => [w.rail, w.grounds, w.statusAtPack])).toEqual([
            ['AGENT_PAY_TOKEN', ['EXPIRES_DURING_CAMPAIGN'], 'REVIEWED'],
        ]);
        // The lapsed one is still named for its lapse alone.
        expect((await prisma.accessReviewAgentSpendingWithdrawal.findFirstOrThrow({
            where: { accessReviewId: due, agentId: A.paying, rail: 'AGENT_PAY_TOKEN' },
        })).grounds).toEqual(['EXPIRED_BY_WINDOW_END']);
        await clearCampaigns();

        const undated = await freshCampaign();
        expect(await prisma.accessReviewAgentSpendingWithdrawal.count({
            where: { accessReviewId: undated, agentId: A.clean },
        })).toBe(0);
    });
});

// ─── Ground (d): a person confirms the agent cannot pay ────────────────

describe('the reviewer confirms an agent can no longer pay (owner decision, 2026-11-20)', () => {
    it('opens a PENDING withdrawal naming who confirmed it, and accepting it withdraws the envelope', async () => {
        const id = await freshCampaign();
        const clean = await decisionFor(id, A.clean);
        const res = await confirmAgentHasNoPaymentAbility(as(T1, 'reviewer'), id, {
            decisionId: clean.id, rail: 'AGENT_PAY_TOKEN',
        });
        expect(res.grounds).toEqual(['NO_PAYMENT_ABILITY_CONFIRMED']);
        const w = await prisma.accessReviewAgentSpendingWithdrawal.findUniqueOrThrow({ where: { id: res.withdrawalId } });
        expect([w.agentId, w.rail, w.grounds, w.proposedByUserId, w.statusAtPack, w.outcome]).toEqual([
            A.clean, 'AGENT_PAY_TOKEN', ['NO_PAYMENT_ABILITY_CONFIRMED'], users[T1].reviewer, 'REVIEWED', 'PENDING',
        ]);
        expect(w.declaredAt.getTime()).toBe((await envelopeOn(A.clean, 'AGENT_PAY_TOKEN')).declaredAt.getTime());
        expect(await prisma.auditLog.count({
            where: { tenantId: T1, action: 'ACCESS_REVIEW_AGENT_SPENDING_WITHDRAWAL_PROPOSED', entityId: w.id },
        })).toBe(1);
        // Confirming withdraws nothing by itself, and holds the verdict.
        expect((await envelopeOn(A.clean, 'AGENT_PAY_TOKEN')).status).toBe('REVIEWED');
        await expect(submitAgentDecision(as(T1, 'reviewer'), clean.id, { decision: 'CONFIRM' }))
            .rejects.toThrow(/WITHDRAWALS_PENDING: 1/);

        const decided = await decideAgentSpendingWithdrawal(as(T1, 'reviewer'), id, w.id, { outcome: 'ACCEPT' });
        expect(decided.executionResult).toBe('ENVELOPE_WITHDRAWN');
        expect((await envelopeOn(A.clean, 'AGENT_PAY_TOKEN')).status).toBe('WITHDRAWN');
    });

    it('refuses the agent’s owner with a 403 and an AUTHZ_DENIED row, and writes nothing', async () => {
        const id = await freshCampaign();
        const clean = await decisionFor(id, A.clean);
        // The clean agent's owner is the tenant's OWNER — admin enough to decide anything else.
        await expect(confirmAgentHasNoPaymentAbility(as(T1, 'owner'), id, {
            decisionId: clean.id, rail: 'AGENT_PAY_TOKEN',
        })).rejects.toThrow(/agent_owner_cannot_confirm_no_payment_ability/);
        expect(await prisma.auditLog.count({
            where: { tenantId: T1, action: 'AUTHZ_DENIED', entity: 'AccessReviewConnectedDecision', entityId: clean.id },
        })).toBe(1);
        expect(await prisma.accessReviewAgentSpendingWithdrawal.count({ where: { accessReviewId: id, agentId: A.clean } })).toBe(0);
    });

    it('refuses a rail the pack does not describe, a withdrawn envelope, a second proposal and a decided subject', async () => {
        const id = await freshCampaign();
        const clean = await decisionFor(id, A.clean);
        const paying = await decisionFor(id, A.paying);
        const reviewer = as(T1, 'reviewer');
        await expect(confirmAgentHasNoPaymentAbility(reviewer, id, { decisionId: clean.id, rail: 'OTHER' }))
            .rejects.toThrow(/ENVELOPE_NOT_IN_PACK/);
        await expect(confirmAgentHasNoPaymentAbility(reviewer, id, { decisionId: clean.id, rail: 'AP4M' }))
            .rejects.toThrow(/ENVELOPE_ALREADY_WITHDRAWN/);
        // The pack already proposed this one; decide that instead.
        await expect(confirmAgentHasNoPaymentAbility(reviewer, id, { decisionId: paying.id, rail: 'AP4M' }))
            .rejects.toThrow(/WITHDRAWAL_ALREADY_PROPOSED/);
        await confirmAgentHasNoPaymentAbility(reviewer, id, { decisionId: clean.id, rail: 'AGENT_PAY_TOKEN' });
        await expect(confirmAgentHasNoPaymentAbility(reviewer, id, { decisionId: clean.id, rail: 'AGENT_PAY_TOKEN' }))
            .rejects.toThrow(/WITHDRAWAL_ALREADY_PROPOSED/);

        const preparer = await decisionFor(id, A.preparer);
        await submitAgentDecision(reviewer, preparer.id, { decision: 'CONFIRM' });
        await prisma.agentSpendingAuthority.create({ data: envelope(T1, A.preparer, 'OTHER') });
        await expect(confirmAgentHasNoPaymentAbility(reviewer, id, { decisionId: preparer.id, rail: 'OTHER' }))
            .rejects.toThrow(/SUBJECT_DECIDED/);
        // Someone who is neither the reviewer nor an admin.
        await expect(confirmAgentHasNoPaymentAbility(as(T2, 'reviewer'), id, { decisionId: clean.id, rail: 'AGENT_PAY_TOKEN' }))
            .rejects.toThrow(/not found/i);
    });

    it('a CHECK pairs the ground with its confirmer, alone, and never the agent’s owner', async () => {
        const id = await freshCampaign();
        const pack = await prisma.accessReviewAgentPack.findFirstOrThrow({ where: { accessReviewId: id, agentId: A.clean } });
        const probe = {
            tenantId: T1, accessReviewId: id, decisionId: pack.decisionId, packId: pack.id, agentId: A.clean,
            rail: 'OTHER' as const, declaredAt: new Date(), statusAtPack: 'REVIEWED', expiresAt: new Date(),
            subjectOwnerUserId: users[T1].owner,
        };
        const check = /AccessReviewAgentSpendingWithdrawal_person_ground/;
        await expect(prisma.accessReviewAgentSpendingWithdrawal.create({
            data: { ...probe, grounds: ['NO_PAYMENT_ABILITY_CONFIRMED'] },
        })).rejects.toThrow(check);
        await expect(prisma.accessReviewAgentSpendingWithdrawal.create({
            data: { ...probe, grounds: ['NEVER_REVIEWED'], proposedByUserId: users[T1].reviewer },
        })).rejects.toThrow(check);
        await expect(prisma.accessReviewAgentSpendingWithdrawal.create({
            data: { ...probe, grounds: ['NEVER_REVIEWED', 'NO_PAYMENT_ABILITY_CONFIRMED'], proposedByUserId: users[T1].reviewer },
        })).rejects.toThrow(check);
        await expect(prisma.accessReviewAgentSpendingWithdrawal.create({
            data: { ...probe, grounds: ['NO_PAYMENT_ABILITY_CONFIRMED'], proposedByUserId: users[T1].owner },
        })).rejects.toThrow(check);
        // And the confirmer is frozen with the rest of the proposal.
        const ok = await prisma.accessReviewAgentSpendingWithdrawal.create({
            data: { ...probe, grounds: ['NO_PAYMENT_ABILITY_CONFIRMED'], proposedByUserId: users[T1].reviewer },
        });
        await expect(prisma.accessReviewAgentSpendingWithdrawal.update({
            where: { id: ok.id }, data: { proposedByUserId: users[T1].admin2 },
        })).rejects.toThrow(/ACCESS_REVIEW_WITHDRAWAL_FROZEN/);
    });
});

// ─── Deciding ──────────────────────────────────────────────────────────

describe('accepting a withdrawal withdraws the envelope and opens the owner’s task', () => {
    it('withdraws the declaration through the writer, stamps the row, and assigns the owner a task naming the requestor', async () => {
        const id = await freshCampaign();
        const w = await withdrawalOn(id, 'AP4M');
        const res = await decideAgentSpendingWithdrawal(as(T1, 'reviewer'), id, w.id, { outcome: 'ACCEPT' });
        expect(res).toMatchObject({ outcome: 'ACCEPTED', executionResult: 'ENVELOPE_WITHDRAWN' });

        const env = await envelopeOn(A.paying, 'AP4M');
        expect(env.status).toBe('WITHDRAWN');
        expect(env.withdrawnByUserId).toBe(users[T1].reviewer);

        const row = await prisma.accessReviewAgentSpendingWithdrawal.findUniqueOrThrow({ where: { id: w.id } });
        expect(row).toMatchObject({
            outcome: 'ACCEPTED', decidedByUserId: users[T1].reviewer, executionResult: 'ENVELOPE_WITHDRAWN',
            ownerTaskId: res.ownerTaskId,
        });
        expect(row.executedAt).not.toBeNull();

        const task = await prisma.task.findUniqueOrThrow({ where: { id: res.ownerTaskId! } });
        expect(task.assigneeUserId).toBe(users[T1].agentOwner);
        expect(task.title).toContain('Example Agent Platform');
        expect(task.title).not.toContain(TOKEN_REFERENCE);
        expect(task.metadataJson).toMatchObject({ kind: 'AGENT_SPENDING_WITHDRAWAL', agentId: A.paying, rail: 'AP4M', accessReviewId: id });

        const audit = await prisma.auditLog.findMany({
            where: { tenantId: T1, action: { in: ['SPENDING_AUTHORITY_WITHDRAWN', 'ACCESS_REVIEW_AGENT_SPENDING_WITHDRAWAL_DECIDED'] } },
            select: { action: true, entityId: true },
        });
        expect(audit).toEqual(expect.arrayContaining([
            { action: 'SPENDING_AUTHORITY_WITHDRAWN', entityId: env.id },
            { action: 'ACCESS_REVIEW_AGENT_SPENDING_WITHDRAWAL_DECIDED', entityId: w.id },
        ]));
        // Decided once.
        await expect(
            decideAgentSpendingWithdrawal(as(T1, 'reviewer'), id, w.id, { outcome: 'REJECT' }),
        ).rejects.toThrow(/ALREADY_DECIDED/);
    });

    it('rejecting leaves the envelope as it is and opens no task', async () => {
        const id = await freshCampaign();
        const w = await withdrawalOn(id, 'OTHER');
        const before = await envelopeOn(A.paying, 'OTHER');
        const res = await decideAgentSpendingWithdrawal(as(T1, 'admin2'), id, w.id, { outcome: 'REJECT' });
        expect(res).toMatchObject({ outcome: 'REJECTED', executionResult: null, ownerTaskId: null });
        const after = await envelopeOn(A.paying, 'OTHER');
        expect(after.status).toBe('SUSPENDED_REQUESTED');
        expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
        expect(await prisma.task.count({ where: { tenantId: T1 } })).toBe(0);
        const row = await prisma.accessReviewAgentSpendingWithdrawal.findUniqueOrThrow({ where: { id: w.id } });
        expect([row.outcome, row.executedAt, row.ownerTaskId]).toEqual(['REJECTED', null, null]);
    });

    it('leaves a declaration made again since the pack alone, and opens no task', async () => {
        const id = await freshCampaign();
        const w = await withdrawalOn(id, 'AP4M');
        // A re-declaration: a new declaredAt on the same row, as the writer does.
        await prisma.agentSpendingAuthority.update({
            where: { id: (await envelopeOn(A.paying, 'AP4M')).id },
            data: { declaredAt: new Date(), declaredByUserId: users[T1].admin2 },
        });
        const res = await decideAgentSpendingWithdrawal(as(T1, 'reviewer'), id, w.id, { outcome: 'ACCEPT' });
        expect(res).toMatchObject({ outcome: 'ACCEPTED', executionResult: 'ENVELOPE_REDECLARED', ownerTaskId: null });
        expect((await envelopeOn(A.paying, 'AP4M')).status).toBe('DECLARED');
        expect(await prisma.task.count({ where: { tenantId: T1 } })).toBe(0);
    });

    it('an envelope withdrawn on the register first still gets the owner’s task', async () => {
        const id = await freshCampaign();
        const w = await withdrawalOn(id, 'AGENT_PAY_TOKEN');
        await prisma.agentSpendingAuthority.update({
            where: { id: (await envelopeOn(A.paying, 'AGENT_PAY_TOKEN')).id },
            data: { status: 'WITHDRAWN', withdrawnAt: new Date(), withdrawnByUserId: users[T1].declarer },
        });
        const res = await decideAgentSpendingWithdrawal(as(T1, 'reviewer'), id, w.id, { outcome: 'ACCEPT' });
        expect(res.executionResult).toBe('ENVELOPE_ALREADY_WITHDRAWN');
        expect(res.ownerTaskId).not.toBeNull();
        // Still the register's withdrawal, not rewritten by the campaign.
        expect((await envelopeOn(A.paying, 'AGENT_PAY_TOKEN')).withdrawnByUserId).toBe(users[T1].declarer);
    });
});

describe('the agent’s owner may not decide its withdrawal', () => {
    it('refuses the frozen owner with a 403 and an AUTHZ_DENIED row, and the row stays pending', async () => {
        const id = await freshCampaign();
        const w = await withdrawalOn(id, 'AP4M');
        await expect(
            decideAgentSpendingWithdrawal(as(T1, 'agentOwner'), id, w.id, { outcome: 'ACCEPT' }),
        ).rejects.toThrow(/agent_owner_cannot_decide/);
        expect(await prisma.auditLog.count({
            where: { tenantId: T1, action: 'AUTHZ_DENIED', entity: 'AccessReviewAgentSpendingWithdrawal', entityId: w.id },
        })).toBe(1);
        expect((await withdrawalOn(id, 'AP4M')).outcome).toBe('PENDING');
        expect((await envelopeOn(A.paying, 'AP4M')).status).toBe('DECLARED');
    });

    it('refuses the CURRENT owner after the agent changed hands', async () => {
        const id = await freshCampaign();
        await prisma.registeredAgent.update({ where: { id: A.paying }, data: { ownerUserId: users[T1].admin2 } });
        const w = await withdrawalOn(id, 'AP4M');
        await expect(
            decideAgentSpendingWithdrawal(as(T1, 'admin2'), id, w.id, { outcome: 'REJECT' }),
        ).rejects.toThrow(/agent_owner_cannot_decide/);
    });

    it('a CHECK refuses the frozen owner as the decider for any writer', async () => {
        const id = await freshCampaign();
        const w = await withdrawalOn(id, 'AP4M');
        await expect(prisma.accessReviewAgentSpendingWithdrawal.update({
            where: { id: w.id },
            data: { outcome: 'REJECTED', decidedAt: new Date(), decidedByUserId: users[T1].agentOwner },
        })).rejects.toThrow(/owner_not_decider/);
    });
});

describe('a pending withdrawal holds the verdict and the close', () => {
    it('refuses the subject’s verdict, then the close, until every withdrawal is decided', async () => {
        const id = await freshCampaign();
        const paying = await decisionFor(id, A.paying);
        await expect(
            submitAgentDecision(as(T1, 'reviewer'), paying.id, { decision: 'CONFIRM' }),
        ).rejects.toThrow(/WITHDRAWALS_PENDING: 3/);
        // Every other subject decided, the paying one held: still not closable.
        for (const agentId of [A.preparer, A.clean]) {
            await submitAgentDecision(as(T1, 'reviewer'), (await decisionFor(id, agentId)).id, { decision: 'CONFIRM' });
        }
        await expect(closeAgentAccessReview(as(T1, 'owner'), id)).rejects.toThrow(/SUBJECTS_PENDING/);

        // Decide two, and the close is held by the third — by name.
        for (const rail of ['AGENT_PAY_TOKEN', 'AP4M'] as const) {
            await decideAgentSpendingWithdrawal(as(T1, 'reviewer'), id, (await withdrawalOn(id, rail)).id, { outcome: 'REJECT' });
        }
        await expect(
            submitAgentDecision(as(T1, 'reviewer'), paying.id, { decision: 'CONFIRM' }),
        ).rejects.toThrow(/WITHDRAWALS_PENDING: 1/);
        // Decided behind the usecase's back, the subject verdict lands; the
        // close still refuses while a withdrawal is pending.
        await prisma.accessReviewConnectedDecision.update({
            where: { id: paying.id },
            data: { decision: 'CONFIRM', decidedAt: new Date(), decidedByUserId: users[T1].reviewer },
        });
        await expect(closeAgentAccessReview(as(T1, 'owner'), id)).rejects.toThrow(/WITHDRAWALS_PENDING: 1/);
        expect((await prisma.accessReview.findUniqueOrThrow({ where: { id } })).status).not.toBe('CLOSED');
    });

    it('closes once all are decided, and the evidence carries the withdrawals and recomputes', async () => {
        const id = await freshCampaign();
        await decideAgentSpendingWithdrawal(as(T1, 'reviewer'), id, (await withdrawalOn(id, 'AP4M')).id, { outcome: 'ACCEPT' });
        for (const rail of ['AGENT_PAY_TOKEN', 'OTHER'] as const) {
            await decideAgentSpendingWithdrawal(as(T1, 'reviewer'), id, (await withdrawalOn(id, rail)).id, { outcome: 'REJECT' });
        }
        for (const agentId of [A.preparer, A.paying, A.clean]) {
            await submitAgentDecision(as(T1, 'reviewer'), (await decisionFor(id, agentId)).id, { decision: 'CONFIRM' });
        }
        const closed = await closeAgentAccessReview(as(T1, 'owner'), id, new Date(), { seed: 'test-seed' });
        expect(closed.contentHash).not.toBeNull();

        const { document, contentHash } = await recomputeAgentCampaignEvidence(as(T1, 'owner'), id);
        expect(contentHash).toBe(closed.contentHash);
        const bySubject = new Map(document.subjects.map((s) => [s.subjectAgentId, s]));
        const paying = bySubject.get(A.paying) as { spendingWithdrawals?: Array<{ rail: string; outcome: string; executionResult: string | null; grounds: string[] }> };
        expect(paying.spendingWithdrawals?.map((w) => [w.rail, w.outcome, w.executionResult, w.grounds])).toEqual(
            expect.arrayContaining([
                ['AP4M', 'ACCEPTED', 'ENVELOPE_WITHDRAWN', ['NEVER_REVIEWED']],
                ['AGENT_PAY_TOKEN', 'REJECTED', null, ['EXPIRED_BY_WINDOW_END']],
                ['OTHER', 'REJECTED', null, ['SUSPENDED_AFTER_KILL']],
            ]),
        );
        // A subject with none carries no key, so a campaign without withdrawals
        // rebuilds to the bytes it always had.
        expect('spendingWithdrawals' in bySubject.get(A.clean)!).toBe(false);
        // And a decided campaign cannot be decided again.
        await expect(
            decideAgentSpendingWithdrawal(as(T1, 'reviewer'), id, (await withdrawalOn(id, 'OTHER')).id, { outcome: 'ACCEPT' }),
        ).rejects.toThrow(/CAMPAIGN_CLOSED/);
    });
});

// ─── One-way, in the database ──────────────────────────────────────────

describe('a withdrawal is a one-way record', () => {
    it('refuses editing the proposal, re-deciding a decided row and rewriting an executed stamp', async () => {
        const id = await freshCampaign();
        const accepted = await withdrawalOn(id, 'AP4M');
        await decideAgentSpendingWithdrawal(as(T1, 'reviewer'), id, accepted.id, { outcome: 'ACCEPT' });
        const pending = await withdrawalOn(id, 'OTHER');

        await expect(prisma.accessReviewAgentSpendingWithdrawal.update({
            where: { id: pending.id }, data: { grounds: ['NEVER_REVIEWED'] },
        })).rejects.toThrow(/ACCESS_REVIEW_WITHDRAWAL_FROZEN/);
        await expect(prisma.accessReviewAgentSpendingWithdrawal.update({
            where: { id: pending.id }, data: { declaredAt: new Date() },
        })).rejects.toThrow(/ACCESS_REVIEW_WITHDRAWAL_FROZEN/);
        await expect(prisma.accessReviewAgentSpendingWithdrawal.update({
            where: { id: accepted.id }, data: { outcome: 'REJECTED' },
        })).rejects.toThrow(/ACCESS_REVIEW_WITHDRAWAL_STAMPED/);
        await expect(prisma.accessReviewAgentSpendingWithdrawal.update({
            where: { id: accepted.id }, data: { ownerTaskId: 'another-task' },
        })).rejects.toThrow(/ACCESS_REVIEW_WITHDRAWAL_STAMPED/);
    });

    it('refuses an empty or unknown ground, and a task beside an envelope left alone', async () => {
        const id = await freshCampaign();
        const w = await withdrawalOn(id, 'AP4M');
        const base = {
            tenantId: T1, accessReviewId: id, decisionId: w.decisionId, packId: w.packId, agentId: A.paying,
            declaredAt: new Date(), statusAtPack: 'DECLARED', expiresAt: new Date(), subjectOwnerUserId: users[T1].owner,
        };
        // `(packId, rail)` is unique and the paying agent's pack holds all
        // three rails, so the probes ride the clean agent's pack.
        const otherPack = await prisma.accessReviewAgentPack.findFirstOrThrow({ where: { accessReviewId: id, agentId: A.clean } });
        const probe = { ...base, decisionId: otherPack.decisionId, packId: otherPack.id, agentId: A.clean, rail: 'OTHER' as const };
        await expect(prisma.accessReviewAgentSpendingWithdrawal.create({ data: { ...probe, grounds: [] } }))
            .rejects.toThrow(/AccessReviewAgentSpendingWithdrawal_grounds/);
        await expect(prisma.accessReviewAgentSpendingWithdrawal.create({ data: { ...probe, grounds: ['REDUCE_LIMIT'] } }))
            .rejects.toThrow(/AccessReviewAgentSpendingWithdrawal_grounds/);
        await expect(prisma.accessReviewAgentSpendingWithdrawal.create({
            data: {
                ...probe, grounds: ['NEVER_REVIEWED'], outcome: 'ACCEPTED', decidedAt: new Date(), decidedByUserId: users[T1].reviewer,
                executedAt: new Date(), executionResult: 'ENVELOPE_REDECLARED', ownerTaskId: 'task',
            },
        })).rejects.toThrow(/AccessReviewAgentSpendingWithdrawal_stamp_consistent/);
    });

    it('app_user may not delete a withdrawal', async () => {
        await freshCampaign();
        await expect(
            asTenant(T1, (tx) => tx.$executeRawUnsafe(`DELETE FROM "AccessReviewAgentSpendingWithdrawal" WHERE "tenantId" = '${T1}'`)),
        ).rejects.toThrow(/permission denied/);
    });
});

// ─── Tenant isolation ──────────────────────────────────────────────────

describe('withdrawals are tenant-isolated', () => {
    it('another tenant’s context reads none of them and cannot insert one', async () => {
        const id = await freshCampaign();
        const count = (tx: PrismaClient) => tx.accessReviewAgentSpendingWithdrawal.count({ where: { accessReviewId: id } });
        expect(await asTenant(T1, count)).toBe(3);
        expect(await asTenant(T2, count)).toBe(0);
        const w = await withdrawalOn(id, 'AP4M');
        await expect(asTenant(T2, (tx) => tx.accessReviewAgentSpendingWithdrawal.create({
            data: {
                tenantId: T1, accessReviewId: id, decisionId: w.decisionId, packId: w.packId, agentId: A.paying,
                rail: 'AP4M', declaredAt: new Date(), statusAtPack: 'DECLARED', expiresAt: new Date(),
                grounds: ['NEVER_REVIEWED'], subjectOwnerUserId: users[T1].agentOwner,
            },
        }))).rejects.toThrow();
        // Nor update one: the row is invisible, so nothing matches.
        expect(await asTenant(T2, (tx) => tx.accessReviewAgentSpendingWithdrawal.updateMany({
            where: { id: w.id }, data: { outcome: 'REJECTED', decidedAt: new Date(), decidedByUserId: users[T2].owner },
        }))).toEqual({ count: 0 });
    });

    it('a T2 caller cannot decide a T1 withdrawal through the usecase, and T1’s envelope is untouched', async () => {
        const id = await freshCampaign();
        const w = await withdrawalOn(id, 'AP4M');
        await expect(
            decideAgentSpendingWithdrawal(as(T2, 'owner'), id, w.id, { outcome: 'ACCEPT' }),
        ).rejects.toThrow(/not found/i);
        expect((await withdrawalOn(id, 'AP4M')).outcome).toBe('PENDING');
        expect((await envelopeOn(A.paying, 'AP4M')).status).toBe('DECLARED');
    });
});
