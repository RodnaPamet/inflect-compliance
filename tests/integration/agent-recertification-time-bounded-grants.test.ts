/**
 * #5317 item 9 — the reviewer pack's time-bounded-grant section is not cut
 * short by somebody else's history.
 *
 * The section used to be ONE read of 500 journal rows over ALL history for the
 * whole page of agents, newest first, with no flag. One agent issuing daily JIT
 * grants filled every row: every other agent on the page was filed with
 * `timeBoundedGrants: []`, and the busy agent's oldest rows — the grant the
 * expiry sweep raised as OUTLIVED_WINDOW among them — were dropped. The pack is
 * filed as evidence, so an incomplete list read as a complete one.
 *
 * Now each agent is read on its own, capped, with `timeBoundedTruncated` when
 * the cap is hit; an outlived grant is read before any other, so the cap drops
 * on-time rows first; and the read is bounded to the grants still relevant to
 * the observation window.
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
    TIME_BOUNDED_PER_AGENT,
    readAgentRecertificationEvidence,
} from '@/app-layer/usecases/agent-recertification-evidence';
import { AGENT_RECERTIFICATION_EVIDENCE_TOOL } from '@/lib/agentic/agent-recertification';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(120_000);

const T = 'arc-time-bounded';
const DAY = 86_400_000;
const HOUR = 3_600_000;
const GRANT_TOOL = 'grant_time_bounded_access';

let ownerId = '';
let ownerCtx: RequestContext;
let seq = 0;
const agents: Record<'preparer' | 'busy' | 'quietA' | 'quietB', string> = { preparer: '', busy: '', quietA: '', quietB: '' };
const rows: Record<string, string> = {};

async function clear(): Promise<void> {
    const t = { tenantId: T };
    await prisma.accessReviewAgentNarrowing.deleteMany({ where: t });
    await prisma.accessReviewAgentPack.deleteMany({ where: t });
    await prisma.accessReviewConnectedDecision.deleteMany({ where: t });
    await prisma.accessReview.deleteMany({ where: t });
    await prisma.workflowStep.deleteMany({ where: t });
    await prisma.workflowRun.deleteMany({ where: t });
    await prisma.externalWriteJournal.deleteMany({ where: t });
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
    const sys = await prisma.aiSystem.create({ data: { tenantId: T, name: `tb host ${seq}`, ownerUserId: ownerId } });
    const agent = await prisma.registeredAgent.create({
        data: {
            tenantId: T,
            aiSystemId: sys.id,
            name: `tb agent ${seq}`,
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

function journalRow(agentId: string, attemptedAt: Date, extra: { expiryVerifiedAt?: Date | null; expiryRaisedAt?: Date | null } = {}) {
    return {
        tenantId: T,
        connectionName: 'entra-pim',
        endpointUrl: 'https://mcp.example.test/entra',
        toolName: GRANT_TOOL,
        advertisedToolName: GRANT_TOOL,
        mode: 'AUTOMATIC',
        argumentsJson: JSON.stringify({ targetId: 'u-1', endDateTime: new Date(attemptedAt.getTime() + DAY).toISOString() }),
        priorStateJson: '{}',
        outcome: 'APPLIED' as const,
        attemptedAt,
        agentId,
        expiryVerifiedAt: extra.expiryVerifiedAt ?? null,
        expiryRaisedAt: extra.expiryRaisedAt ?? null,
    };
}

async function one(data: ReturnType<typeof journalRow>): Promise<string> {
    return (await prisma.externalWriteJournal.create({ data })).id;
}

let campaignId = '';
let campaignCreatedAt: Date;

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
    agents.quietA = await makeAgent();
    agents.quietB = await makeAgent();
    await prisma.registeredAgentTool.create({
        data: { tenantId: T, agentId: agents.preparer, toolName: AGENT_RECERTIFICATION_EVIDENCE_TOOL, grantedByUserId: ownerId },
    });

    const now = Date.now();
    // The busy agent: a JIT grant every three hours for 75 days — 600 rows,
    // more than the whole page's old 500-row read, every one newer than the
    // quiet agents' grants. Verified gone on time, every one.
    await prisma.externalWriteJournal.createMany({
        data: Array.from({ length: 600 }, (_, i) => {
            const at = new Date(now - DAY - i * 3 * HOUR);
            return journalRow(agents.busy, at, { expiryVerifiedAt: new Date(at.getTime() + 2 * DAY) });
        }),
    });
    // Its OLDEST grant in the window outlived its end: the sweep raised it.
    rows.busyOutlived = await one(journalRow(agents.busy, new Date(now - 85 * DAY), {
        expiryRaisedAt: new Date(now - 83 * DAY),
    }));
    // An outlived grant from before the window, ended before it began: a
    // control failure on the agent's record, kept whatever its age.
    rows.busyOutlivedOld = await one(journalRow(agents.busy, new Date(now - 200 * DAY), {
        expiryRaisedAt: new Date(now - 198 * DAY),
        expiryVerifiedAt: new Date(now - 190 * DAY),
    }));

    // Quiet agents: a grant each, older than every busy row.
    rows.quietAOnTime = await one(journalRow(agents.quietA, new Date(now - 89 * DAY), {
        expiryVerifiedAt: new Date(now - 87 * DAY),
    }));
    rows.quietBOutlived = await one(journalRow(agents.quietB, new Date(now - 88 * DAY), {
        expiryRaisedAt: new Date(now - 86 * DAY),
    }));
    // Made before the window and never verified gone: may still be live in it.
    rows.quietBUnverified = await one(journalRow(agents.quietB, new Date(now - 120 * DAY)));
    // Made, ended and verified gone before the window began: not this window's.
    rows.quietBStale = await one(journalRow(agents.quietB, new Date(now - 200 * DAY), {
        expiryVerifiedAt: new Date(now - 190 * DAY),
    }));
    // After the window ends: never in it.
    const r = await createAgentAccessReview(ownerCtx, {
        name: 'time-bounded recertification',
        reviewerUserId: ownerId,
        preparerAgentId: agents.preparer,
    });
    campaignId = r.accessReviewId;
    campaignCreatedAt = (await prisma.accessReview.findUniqueOrThrow({ where: { id: campaignId } })).createdAt;
    rows.quietAAfter = await one(journalRow(agents.quietA, new Date(campaignCreatedAt.getTime() + HOUR)));
});

afterAll(async () => {
    await clear();
    await prisma.$disconnect();
});

async function subjects() {
    const page = await readAgentRecertificationEvidence(ownerCtx, campaignId, 0);
    expect(page.subjects).toHaveLength(4);
    return new Map(page.subjects.map((s) => [s.agentId, s]));
}

describe('the time-bounded-grant section of a reviewer pack (#5317)', () => {
    it('one busy agent does not empty the section for every other agent on the page', async () => {
        const s = await subjects();
        expect(s.get(agents.quietA)!.timeBoundedGrants.map((g) => g.journalId)).toEqual([rows.quietAOnTime]);
        expect(s.get(agents.quietA)!.timeBoundedTruncated).toBe(false);
        expect(s.get(agents.quietB)!.timeBoundedTruncated).toBe(false);
        expect(s.get(agents.preparer)!.timeBoundedGrants).toEqual([]);
        expect(s.get(agents.preparer)!.timeBoundedTruncated).toBe(false);
    });

    it('the busy agent is capped and SAYS so, rather than presenting a partial list as whole', async () => {
        const busy = (await subjects()).get(agents.busy)!;
        expect(busy.timeBoundedTruncated).toBe(true);
        expect(busy.timeBoundedGrants).toHaveLength(TIME_BOUNDED_PER_AGENT);
    });

    it('an outlived grant is never the row the cap drops', async () => {
        const busy = (await subjects()).get(agents.busy)!;
        const outlived = busy.timeBoundedGrants.filter((g) => g.state === 'OUTLIVED_WINDOW');
        expect(outlived.map((g) => g.journalId).sort()).toEqual([rows.busyOutlived, rows.busyOutlivedOld].sort());
        expect(outlived.every((g) => g.expiredOnTime === false)).toBe(true);
        const quietB = (await subjects()).get(agents.quietB)!;
        expect(quietB.timeBoundedGrants.find((g) => g.journalId === rows.quietBOutlived)).toMatchObject({
            state: 'OUTLIVED_WINDOW', expiredOnTime: false,
        });
    });

    it('the cap keeps the NEWEST on-time rows, and the section stays newest first', async () => {
        const busy = (await subjects()).get(agents.busy)!;
        const grantedAt = busy.timeBoundedGrants.map((g) => g.grantedAt);
        expect(grantedAt).toEqual([...grantedAt].sort().reverse());
        const onTime = busy.timeBoundedGrants.filter((g) => g.state === 'EXPIRED_VERIFIED');
        expect(onTime).toHaveLength(TIME_BOUNDED_PER_AGENT - 2);
        // The newest busy row is 1 day old: it is kept.
        expect(Date.parse(onTime[0].grantedAt)).toBeGreaterThan(campaignCreatedAt.getTime() - 2 * DAY);
    });

    it('reads the grants still relevant to the window, and none from after it', async () => {
        const ids = (await subjects()).get(agents.quietB)!.timeBoundedGrants.map((g) => g.journalId);
        expect(ids).toContain(rows.quietBUnverified);
        expect(ids).not.toContain(rows.quietBStale);
        const quietA = (await subjects()).get(agents.quietA)!.timeBoundedGrants.map((g) => g.journalId);
        expect(quietA).not.toContain(rows.quietAAfter);
    });

    it('the flag reaches the FILED pack, whose stored hash is the hash of its stored sections', async () => {
        await prepareAgentReviewPacks(ownerCtx, campaignId);
        const packs = await prisma.accessReviewAgentPack.findMany({ where: { accessReviewId: campaignId } });
        expect(packs).toHaveLength(4);
        const byAgent = new Map(packs.map((p) => [p.agentId, p]));
        const busy = byAgent.get(agents.busy)!;
        expect((busy.sectionsJson as { timeBoundedTruncated?: boolean }).timeBoundedTruncated).toBe(true);
        expect((byAgent.get(agents.quietA)!.sectionsJson as { timeBoundedTruncated?: boolean }).timeBoundedTruncated).toBe(false);
        for (const p of packs) expect(p.contentHash).toBe(sha256Of(p.sectionsJson));
    });

    it('a subject read on its own is read the same way', async () => {
        const page = await readAgentRecertificationEvidence(ownerCtx, campaignId, 0, agents.quietA);
        expect(page.subjects.map((x) => x.timeBoundedGrants.map((g) => g.journalId))).toEqual([[rows.quietAOnTime]]);
    });
});
