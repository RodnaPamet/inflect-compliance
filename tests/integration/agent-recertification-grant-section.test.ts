/**
 * #5317 (owner decision 2026-11-15) — the reviewer pack's grant section, read
 * per agent and with a granted tool's name cut at `TOOL_NAME_IN_PACK`.
 *
 * Two pages fit a run's context only because the grant section shrank: 100
 * grants an agent rather than 200, and a name of at most 64 characters rather
 * than 200, carried twice (the grant and its narrowing). Three things must hold
 * with it:
 *
 *   - the grant read is PER AGENT. It was one read for the page,
 *     `pageSize × cap + 1` rows, so with two agents on a page one agent
 *     holding more than its share marked BOTH truncated, and a truncated
 *     subject plans no narrowing: the quiet agent's unused grant was never
 *     proposed for deletion;
 *   - a truncated subject plans nothing — a narrowing comes only from a whole
 *     grant list — and an agent with exactly the cap is read whole;
 *   - a cut name is flagged in the pack, and the narrowing a reviewer accepts
 *     names the tool WHOLE, read from the grant.
 *
 * Agent ids are chosen so the busy and the quiet agent share page 0.
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
import {
    GRANTS_PER_AGENT,
    readAgentRecertificationEvidence,
} from '@/app-layer/usecases/agent-recertification-evidence';
import {
    AGENT_RECERTIFICATION_EVIDENCE_TOOL,
    PACK_PAGE_SIZE,
    TOOL_NAME_IN_PACK,
    type SubjectEvidence,
} from '@/lib/agentic/agent-recertification';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(180_000);

const T = 'arc-grant-section';
const DAY = 86_400_000;

/** An external tool's qualified name, longer than the pack carries. */
const LONG_TOOL = `mcp__c${'0'.repeat(24)}__${'microsoft_graph_list_users_by_department_and_manager_'.repeat(2)}`;

let ownerId = '';
let ownerCtx: RequestContext;
// Sorted by `subjectRef` (`agent:<id>`): busy and quiet are page 0, the
// exact-cap agent and the preparer page 1.
const agents = { busy: 'arcgs-1-busy', quiet: 'arcgs-2-quiet', exact: 'arcgs-3-exact', preparer: 'arcgs-4-preparer' };

async function clear(): Promise<void> {
    const t = { tenantId: T };
    await prisma.accessReviewAgentNarrowing.deleteMany({ where: t });
    await prisma.accessReviewAgentPack.deleteMany({ where: t });
    await prisma.accessReviewConnectedDecision.deleteMany({ where: t });
    await prisma.accessReview.deleteMany({ where: t });
    await prisma.workflowStep.deleteMany({ where: t });
    await prisma.workflowRun.deleteMany({ where: t });
    await prisma.registeredAgentTool.deleteMany({ where: t });
    await prisma.registeredAgent.deleteMany({ where: t });
    await prisma.aiSystem.deleteMany({ where: t });
    await deleteAuditRowsForTenants(prisma, [T]);
    await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = $1`, T);
    });
    await prisma.user.deleteMany({ where: { emailHash: hashForLookup(`owner@${T}.test`) } });
    await prisma.tenant.deleteMany({ where: { id: T } });
}

async function makeAgent(id: string): Promise<void> {
    const sys = await prisma.aiSystem.create({ data: { tenantId: T, name: `host ${id}`, ownerUserId: ownerId } });
    await prisma.registeredAgent.create({
        data: {
            id,
            tenantId: T,
            aiSystemId: sys.id,
            name: `agent ${id}`,
            autonomyLevel: 1,
            dataAccessScope: 'READ_TENANT_DATA',
            reversibility: 'REVERSIBLE',
            provenance: 'FIRST_PARTY',
            ownerUserId: ownerId,
            status: 'ACTIVE',
            riskTier: 'LOW',
            riskTierScoredAt: new Date(),
        },
    });
}

/** `n` grants, made before the observation window and never called. */
async function grants(agentId: string, n: number, prefix: string): Promise<void> {
    const old = new Date(Date.now() - 200 * DAY);
    await prisma.registeredAgentTool.createMany({
        data: Array.from({ length: n }, (_, i) => ({
            tenantId: T, agentId, toolName: `${prefix}_${String(i).padStart(4, '0')}`,
            grantedByUserId: ownerId, createdAt: new Date(old.getTime() + i * 1000),
        })),
    });
}

let campaignId = '';

beforeAll(async () => {
    await clear();
    await prisma.tenant.create({ data: { id: T, name: T, slug: T } });
    const email = `owner@${T}.test`;
    ownerId = (await prisma.user.create({ data: { email, emailHash: hashForLookup(email) } })).id;
    await prisma.tenantMembership.create({ data: { tenantId: T, userId: ownerId, role: Role.OWNER, status: 'ACTIVE' } });
    const resolved = await resolveTenantContext({ tenantId: T }, ownerId);
    ownerCtx = makeRequestContext(resolved.role, {
        tenantId: T, tenantSlug: T, userId: ownerId,
        permissions: resolved.permissions, appPermissions: resolved.appPermissions,
    });

    for (const id of Object.values(agents)) await makeAgent(id);
    await prisma.registeredAgentTool.create({
        data: { tenantId: T, agentId: agents.preparer, toolName: AGENT_RECERTIFICATION_EVIDENCE_TOOL, grantedByUserId: ownerId },
    });
    // The busy agent holds more than a whole page's old shared read
    // (`PACK_PAGE_SIZE × GRANTS_PER_AGENT + 1`).
    await grants(agents.busy, PACK_PAGE_SIZE * GRANTS_PER_AGENT + 1, 'busy_tool');
    // The quiet agent: one unused grant, and one with a long name.
    await grants(agents.quiet, 1, 'quiet_tool');
    await prisma.registeredAgentTool.create({
        data: { tenantId: T, agentId: agents.quiet, toolName: LONG_TOOL, grantedByUserId: ownerId, createdAt: new Date(Date.now() - 150 * DAY) },
    });
    // Exactly the cap: read whole.
    await grants(agents.exact, GRANTS_PER_AGENT, 'exact_tool');

    const r = await createAgentAccessReview(ownerCtx, {
        name: 'grant section recertification',
        reviewerUserId: ownerId,
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
    const pages: string[][] = [];
    for (let page = 0; ; page++) {
        const read = await readAgentRecertificationEvidence(ownerCtx, campaignId, page);
        out.push(...read.subjects);
        pages.push(read.subjects.map((s) => s.agentId));
        if ((page + 1) * read.pageSize >= read.total) break;
    }
    // The premise: busy and quiet are read in ONE run.
    expect(pages[0]).toEqual([agents.busy, agents.quiet]);
    return new Map(out.map((s) => [s.agentId, s]));
}

describe('the grant section of a reviewer pack (#5317)', () => {
    it('one agent with many grants does not truncate the other agent on its page', async () => {
        const quiet = (await subjects()).get(agents.quiet)!;
        expect(quiet.grantsTruncated).toBe(false);
        expect(quiet.grants).toHaveLength(2);
    });

    it('an agent over the cap is truncated at the cap and SAYS so; one at exactly the cap is read whole', async () => {
        const s = await subjects();
        expect(s.get(agents.busy)!.grantsTruncated).toBe(true);
        expect(s.get(agents.busy)!.grants).toHaveLength(GRANTS_PER_AGENT);
        expect(s.get(agents.exact)!.grantsTruncated).toBe(false);
        expect(s.get(agents.exact)!.grants).toHaveLength(GRANTS_PER_AGENT);
    });

    it('a long tool name is cut to the bound and flagged; a short one is whole and unflagged', async () => {
        const quiet = (await subjects()).get(agents.quiet)!;
        const long = quiet.grants.find((g) => g.toolName.startsWith('mcp__'))!;
        expect(long.toolName).toBe(LONG_TOOL.slice(0, TOOL_NAME_IN_PACK));
        expect(long.toolNameTruncated).toBe(true);
        const short = quiet.grants.find((g) => g.toolName.startsWith('quiet_tool'))!;
        expect(short).not.toHaveProperty('toolNameTruncated');
    });

    it('the filed packs: no narrowing from a truncated list, every one from a whole list, and the narrowing names the tool WHOLE', async () => {
        const result = await prepareAgentReviewPacks(ownerCtx, campaignId);
        expect(result.packs).toBe(4);

        const narrowings = await prisma.accessReviewAgentNarrowing.findMany({
            where: { tenantId: T, accessReviewId: campaignId },
            select: { agentId: true, toolName: true },
        });
        const byAgent = (id: string) => narrowings.filter((n) => n.agentId === id);
        expect(byAgent(agents.busy)).toEqual([]);
        expect(byAgent(agents.exact)).toHaveLength(GRANTS_PER_AGENT);
        expect(byAgent(agents.quiet).map((n) => n.toolName).sort()).toEqual([LONG_TOOL, 'quiet_tool_0000'].sort());

        const packs = await prisma.accessReviewAgentPack.findMany({ where: { tenantId: T, accessReviewId: campaignId } });
        expect(packs).toHaveLength(4);
        for (const p of packs) expect(p.contentHash).toBe(sha256Of(p.sectionsJson));
    });
});
