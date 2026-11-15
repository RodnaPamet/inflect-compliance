/**
 * #5317 — the reviewer pack's kill-engagement section is not cut short by
 * somebody else's history, and says when its own is.
 *
 * The section used to be ONE read of 500 kill rows for the whole page of
 * agents, oldest first, with no flag. One agent killed and lifted often filled
 * every row: every other agent on the page was filed with
 * `killEngagements: []`, and the busy agent's newest rows — the kill still in
 * force among them — were dropped. The pack is filed as evidence, so an
 * incomplete list read as a complete one.
 *
 * Now each agent is read on its own, capped at `KILLS_PER_AGENT`, with
 * `killsTruncated` when the cap is hit; a kill still in force is read before
 * any lifted one, so the cap never drops it.
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
    KILLS_PER_AGENT,
    readAgentRecertificationEvidence,
} from '@/app-layer/usecases/agent-recertification-evidence';
import { AGENT_RECERTIFICATION_EVIDENCE_TOOL, type SubjectEvidence } from '@/lib/agentic/agent-recertification';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(120_000);

const T = 'arc-kill-engagements';
const DAY = 86_400_000;
const HOUR = 3_600_000;

let ownerId = '';
let ownerCtx: RequestContext;
let seq = 0;
const agents: Record<'preparer' | 'busy' | 'quiet', string> = { preparer: '', busy: '', quiet: '' };
const at: Record<string, Date> = {};

async function clear(): Promise<void> {
    const t = { tenantId: T };
    await prisma.accessReviewAgentNarrowing.deleteMany({ where: t });
    await prisma.accessReviewAgentPack.deleteMany({ where: t });
    await prisma.accessReviewConnectedDecision.deleteMany({ where: t });
    await prisma.accessReview.deleteMany({ where: t });
    await prisma.workflowStep.deleteMany({ where: t });
    await prisma.workflowRun.deleteMany({ where: t });
    await prisma.agentKillSwitch.deleteMany({ where: t });
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

async function makeAgent(): Promise<string> {
    seq += 1;
    const sys = await prisma.aiSystem.create({ data: { tenantId: T, name: `kill host ${seq}`, ownerUserId: ownerId } });
    const agent = await prisma.registeredAgent.create({
        data: {
            tenantId: T,
            aiSystemId: sys.id,
            name: `kill agent ${seq}`,
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
    return agent.id;
}

function kill(agentId: string, engagedAt: Date, liftedAt: Date | null) {
    return {
        tenantId: T,
        agentId,
        reason: 'test kill',
        engagedByUserId: ownerId,
        engagedAt,
        liftedAt,
        liftedByUserId: liftedAt ? ownerId : null,
    };
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

    agents.preparer = await makeAgent();
    agents.busy = await makeAgent();
    agents.quiet = await makeAgent();
    await prisma.registeredAgentTool.create({
        data: { tenantId: T, agentId: agents.preparer, toolName: AGENT_RECERTIFICATION_EVIDENCE_TOOL, grantedByUserId: ownerId },
    });

    const now = Date.now();
    // The busy agent: killed and lifted every three hours for 75 days — 600
    // rows, more than the whole page's old 500-row read, every one OLDER than
    // the quiet agent's kill.
    await prisma.agentKillSwitch.createMany({
        data: Array.from({ length: 600 }, (_, i) => {
            const engaged = new Date(now - 80 * DAY + i * 3 * HOUR);
            return kill(agents.busy, engaged, new Date(engaged.getTime() + HOUR));
        }),
    });
    // ...and it is killed now: the newest row, and the one a reviewer must see.
    at.busyInForce = new Date(now - 2 * HOUR);
    await prisma.agentKillSwitch.create({ data: kill(agents.busy, at.busyInForce, null) });
    // Lifted before the window began: not this window's.
    at.busyStale = new Date(now - 200 * DAY);
    await prisma.agentKillSwitch.create({ data: kill(agents.busy, at.busyStale, new Date(now - 199 * DAY)) });

    // The quiet agent: one kill, newer than every lifted busy row.
    at.quiet = new Date(now - 3 * DAY);
    await prisma.agentKillSwitch.create({ data: kill(agents.quiet, at.quiet, new Date(now - 2 * DAY)) });

    const r = await createAgentAccessReview(ownerCtx, {
        name: 'kill recertification',
        reviewerUserId: ownerId,
        preparerAgentId: agents.preparer,
    });
    campaignId = r.accessReviewId;
});

afterAll(async () => {
    await clear();
    await prisma.$disconnect();
});

/** Every subject of the campaign, whatever the page size. */
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

describe('the kill-engagement section of a reviewer pack (#5317)', () => {
    it('one busy agent does not empty the section for any other agent', async () => {
        const s = await subjects();
        expect(s.get(agents.quiet)!.killEngagements.map((k) => k.engagedAt)).toEqual([at.quiet.toISOString()]);
        expect(s.get(agents.quiet)!.killsTruncated).toBe(false);
        expect(s.get(agents.preparer)!.killEngagements).toEqual([]);
        expect(s.get(agents.preparer)!.killsTruncated).toBe(false);
    });

    it('the busy agent is capped and SAYS so, rather than presenting a partial list as whole', async () => {
        const busy = (await subjects()).get(agents.busy)!;
        expect(busy.killsTruncated).toBe(true);
        expect(busy.killEngagements).toHaveLength(KILLS_PER_AGENT);
    });

    it('a kill still in force is never the row the cap drops, and the section stays oldest first', async () => {
        const busy = (await subjects()).get(agents.busy)!;
        expect(busy.killEngagements.filter((k) => k.liftedAt === null).map((k) => k.engagedAt))
            .toEqual([at.busyInForce.toISOString()]);
        const engaged = busy.killEngagements.map((k) => k.engagedAt);
        expect(engaged).toEqual([...engaged].sort());
        expect(engaged).not.toContain(at.busyStale.toISOString());
    });

    it('the flag reaches the FILED pack, whose stored hash is the hash of its stored sections', async () => {
        await prepareAgentReviewPacks(ownerCtx, campaignId);
        const packs = await prisma.accessReviewAgentPack.findMany({ where: { accessReviewId: campaignId } });
        expect(packs).toHaveLength(3);
        const byAgent = new Map(packs.map((p) => [p.agentId, p]));
        expect((byAgent.get(agents.busy)!.sectionsJson as { killsTruncated?: boolean }).killsTruncated).toBe(true);
        expect((byAgent.get(agents.quiet)!.sectionsJson as { killsTruncated?: boolean }).killsTruncated).toBe(false);
        for (const p of packs) expect(p.contentHash).toBe(sha256Of(p.sectionsJson));
    });
});
