/**
 * Agent Pay Phase 1.4 (#5333) — an AGENT campaign's reviewer pack carries the
 * agent's spending authority.
 *
 * The register records an agent's declared spending envelope; recertification
 * is where a second look at every privilege happens, so the pack a reviewer
 * decides on must show it: each rail, its status, whether anybody but the
 * declarer reviewed it, the limits, how wide the merchant scope is and when it
 * lapses. The token reference is NOT in the pack — it is an identifier at a
 * third party, and the section reaches the model that prepares the pack.
 *
 * The section sits in `sectionsJson`, so the pack's `contentHash` — which the
 * campaign's closing evidence carries — covers it, recomputable from the
 * stored row.
 */
import { PrismaClient, Role } from '@prisma/client';

import { prismaTestClient } from '../helpers/db';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { makeRequestContext } from '../helpers/make-context';
import { hashForLookup } from '@/lib/security/encryption';
import { resolveTenantContext } from '@/lib/tenant-context';
import type { RequestContext } from '@/app-layer/types';
import { createAgentAccessReview, prepareAgentReviewPacks } from '@/app-layer/usecases/access-review-agent';
import { sha256Of } from '@/lib/agentic/agent-recertification-hash';
import { readAgentRecertificationEvidence } from '@/app-layer/usecases/agent-recertification-evidence';
import { AGENT_RECERTIFICATION_EVIDENCE_TOOL, type SubjectEvidence } from '@/lib/agentic/agent-recertification';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(120_000);

const T = 'arc-spending-section';
const DAY = 86_400_000;
const TOKEN_REFERENCE = 'DWSPMC000000000132d72d4fcb2f4136';

const people: Record<'owner' | 'declarer' | 'reviewer', string> = { owner: '', declarer: '', reviewer: '' };
let ownerCtx: RequestContext;
let seq = 0;
const agents: Record<'preparer' | 'paying' | 'plain', string> = { preparer: '', paying: '', plain: '' };
let campaignId = '';

async function clear(): Promise<void> {
    const t = { tenantId: T };
    await prisma.accessReviewAgentNarrowing.deleteMany({ where: t });
    await prisma.accessReviewAgentPack.deleteMany({ where: t });
    await prisma.accessReviewConnectedDecision.deleteMany({ where: t });
    await prisma.accessReview.deleteMany({ where: t });
    await prisma.workflowStep.deleteMany({ where: t });
    await prisma.workflowRun.deleteMany({ where: t });
    await prisma.agentSpendingAuthority.deleteMany({ where: t });
    await prisma.registeredAgentTool.deleteMany({ where: t });
    await prisma.registeredAgent.deleteMany({ where: t });
    await prisma.aiSystem.deleteMany({ where: t });
    await deleteAuditRowsForTenants(prisma, [T]);
    await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = $1`, T);
    });
    await prisma.user.deleteMany({
        where: { emailHash: { in: Object.keys(people).map((p) => hashForLookup(`${p}@${T}.test`)) } },
    });
    await prisma.tenant.deleteMany({ where: { id: T } });
}

async function makeAgent(): Promise<string> {
    seq += 1;
    const sys = await prisma.aiSystem.create({ data: { tenantId: T, name: `pay host ${seq}`, ownerUserId: people.owner } });
    const agent = await prisma.registeredAgent.create({
        data: {
            tenantId: T,
            aiSystemId: sys.id,
            name: `pay agent ${seq}`,
            autonomyLevel: 1,
            dataAccessScope: 'READ_TENANT_DATA',
            reversibility: 'REVERSIBLE',
            provenance: 'FIRST_PARTY',
            ownerUserId: people.owner,
            status: 'ACTIVE',
            riskTier: 'LOW',
            riskTierScoredAt: new Date(),
        },
    });
    return agent.id;
}

/** An envelope written as the register writer leaves it; the writer's rules have their own test. */
function envelope(agentId: string, rail: 'AGENT_PAY_TOKEN' | 'AP4M', over: Record<string, unknown> = {}) {
    const declaredAt = new Date(Date.now() - 10 * DAY);
    return {
        tenantId: T,
        agentId,
        rail,
        perTransactionLimitMinor: BigInt(5_000),
        periodBudgetMinor: BigInt(50_000),
        budgetPeriod: 'MONTH' as const,
        currency: 'EUR',
        merchantDomains: ['shop.example.com', 'travel.example.com'],
        merchantCategoryCodes: ['4511'],
        expiresAt: new Date(Date.now() + 90 * DAY),
        consentedByUserId: people.owner,
        tokenRequestor: 'Example Agent Platform',
        tokenReference: TOKEN_REFERENCE,
        declaredByUserId: people.declarer,
        declaredAt,
        ownerUserIdAtDeclaration: people.owner,
        ...over,
    };
}

beforeAll(async () => {
    await clear();
    await prisma.tenant.create({ data: { id: T, name: T, slug: T } });
    for (const who of Object.keys(people) as Array<keyof typeof people>) {
        const email = `${who}@${T}.test`;
        people[who] = (await prisma.user.create({ data: { email, emailHash: hashForLookup(email) } })).id;
        await prisma.tenantMembership.create({
            data: { tenantId: T, userId: people[who], role: who === 'owner' ? Role.OWNER : Role.ADMIN, status: 'ACTIVE' },
        });
    }
    const resolved = await resolveTenantContext({ tenantId: T }, people.owner);
    ownerCtx = makeRequestContext(resolved.role, {
        tenantId: T, tenantSlug: T, userId: people.owner,
        permissions: resolved.permissions, appPermissions: resolved.appPermissions,
    });

    agents.preparer = await makeAgent();
    agents.paying = await makeAgent();
    agents.plain = await makeAgent();
    await prisma.registeredAgentTool.create({
        data: { tenantId: T, agentId: agents.preparer, toolName: AGENT_RECERTIFICATION_EVIDENCE_TOOL, grantedByUserId: people.owner },
    });

    // One envelope a second person reviewed, and one nobody has: an AP4M budget
    // with no merchant scope at all, the widest there is.
    // Born DECLARED (a trigger), and reviewed as the writer reviews: a second
    // person's stamp.
    const reviewed = await prisma.agentSpendingAuthority.create({ data: envelope(agents.paying, 'AGENT_PAY_TOKEN') });
    await prisma.agentSpendingAuthority.update({
        where: { id: reviewed.id },
        data: { status: 'REVIEWED', reviewedByUserId: people.reviewer, reviewedAt: new Date(Date.now() - 9 * DAY) },
    });
    await prisma.agentSpendingAuthority.create({
        data: envelope(agents.paying, 'AP4M', { merchantDomains: [], merchantCategoryCodes: [] }),
    });

    const r = await createAgentAccessReview(ownerCtx, {
        name: 'spending recertification',
        reviewerUserId: people.reviewer,
        preparerAgentId: agents.preparer,
    });
    campaignId = r.accessReviewId;
});

afterAll(async () => {
    await clear();
    await prisma.$disconnect();
});

async function subjects(): Promise<Map<string, SubjectEvidence>> {
    const out: SubjectEvidence[] = [];
    for (let page = 0; ; page++) {
        const read = await readAgentRecertificationEvidence(ownerCtx, campaignId, page);
        out.push(...read.subjects);
        if ((page + 1) * read.pageSize >= read.total) break;
    }
    expect(out).toHaveLength(3);
    return new Map(out.map((s) => [s.agentId, s]));
}

describe('the spending-authority section of a reviewer pack (Agent Pay 1.4, #5333)', () => {
    it('lists every rail the agent declared, with its review standing, limits and the width of its merchant scope', async () => {
        const paying = (await subjects()).get(agents.paying)!;
        expect(paying.spendingAuthority).toHaveLength(2);
        // In the rail enum's order, as the register lists them.
        const [token, ap4m] = paying.spendingAuthority!;
        expect(ap4m).toMatchObject({
            rail: 'AP4M',
            status: 'DECLARED',
            unreviewed: true,
            reviewedAt: null,
            merchantScopeUnrestricted: true,
            merchantDomainCount: 0,
            merchantCategoryCodeCount: 0,
            expiredAtWindowEnd: false,
        });
        expect(token).toMatchObject({
            rail: 'AGENT_PAY_TOKEN',
            status: 'REVIEWED',
            unreviewed: false,
            reviewedByUserId: people.reviewer,
            perTransactionLimitMinor: '5000',
            periodBudgetMinor: '50000',
            budgetPeriod: 'MONTH',
            currency: 'EUR',
            merchantScopeUnrestricted: false,
            merchantDomainCount: 2,
            merchantCategoryCodeCount: 1,
            tokenRequestor: 'Example Agent Platform',
            declaredByUserId: people.declarer,
        });
    });

    it('an agent with no envelope reads as "none recorded", an empty list', async () => {
        expect((await subjects()).get(agents.plain)!.spendingAuthority).toEqual([]);
    });

    it('never carries the token reference or the merchant list itself', async () => {
        const serialised = JSON.stringify((await subjects()).get(agents.paying));
        expect(serialised).not.toContain(TOKEN_REFERENCE);
        expect(serialised).not.toContain('tokenReference');
        expect(serialised).not.toContain('shop.example.com');
    });

    it('reaches the FILED pack, whose stored hash is the hash of its stored sections, section included', async () => {
        await prepareAgentReviewPacks(ownerCtx, campaignId);
        const packs = await prisma.accessReviewAgentPack.findMany({ where: { accessReviewId: campaignId } });
        expect(packs).toHaveLength(3);
        const paying = packs.find((p) => p.agentId === agents.paying)!;
        const sections = paying.sectionsJson as { spendingAuthority?: Array<{ rail: string; unreviewed: boolean }> };
        expect(sections.spendingAuthority?.map((e) => [e.rail, e.unreviewed])).toEqual([
            ['AGENT_PAY_TOKEN', false],
            ['AP4M', true],
        ]);
        for (const p of packs) expect(p.contentHash).toBe(sha256Of(p.sectionsJson));
        // The hash moves with the section: a pack whose spending section were
        // dropped would not recompute to the stored hash.
        const { spendingAuthority: _dropped, ...without } = sections;
        void _dropped;
        expect(sha256Of(without)).not.toBe(paying.contentHash);
    });
});
