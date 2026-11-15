/**
 * #5317 (owner decision 2026-11-15) — a large AGENT campaign is prepared off
 * the request, by the `agent-recert-packs-prepare` job, as the person who
 * asked.
 *
 *   - a campaign needing more than `SYNC_PACK_RUN_LIMIT` pack runs is
 *     ENQUEUED by the prepare request (202), with a job id fixed per campaign,
 *     and nothing is prepared in the request;
 *   - a second press while the job is live joins it; a press after a failed
 *     job removes it and queues again;
 *   - the job re-reads its requester when it runs: one who lost the key or
 *     left the workspace is refused, and one whose campaign's preparer stopped
 *     qualifying is refused — each writes nothing;
 *   - a job naming another workspace's campaign finds nothing there and writes
 *     nothing in either (two-tenant behaviour);
 *   - otherwise the job prepares a pack for every subject, reporting progress
 *     up to every subject.
 *
 * The queue is not run: `enqueue` and the job lookup are mocked, and the job's
 * body (`runAgentRecertPackPreparation`) is called as the worker would.
 */
const mockEnqueue = jest.fn(async (..._args: unknown[]) => ({ id: 'job' }));
const mockFindTenantJob = jest.fn(async (..._args: unknown[]): Promise<unknown> => null);
jest.mock('@/app-layer/jobs/queue', () => ({
    ...jest.requireActual('@/app-layer/jobs/queue'),
    enqueue: (...a: unknown[]) => mockEnqueue(...a),
}));
jest.mock('@/app-layer/jobs/tenant-job-lookup', () => ({
    findTenantJob: (...a: unknown[]) => mockFindTenantJob(...a),
}));

import { PrismaClient, Role } from '@prisma/client';

import { prismaTestClient } from '../helpers/db';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { makeRequestContext } from '../helpers/make-context';
import { hashForLookup } from '@/lib/security/encryption';
import { resolveTenantContext } from '@/lib/tenant-context';
import type { RequestContext } from '@/app-layer/types';
import {
    AGENT_RECERT_PACKS_JOB,
    SYNC_PACK_RUN_LIMIT,
    agentPackPreparationJobId,
    createAgentAccessReview,
    requestAgentReviewPacks,
} from '@/app-layer/usecases/access-review-agent';
import { runAgentRecertPackPreparation } from '@/app-layer/jobs/agent-recert-pack-preparation';
import { AGENT_RECERTIFICATION_EVIDENCE_TOOL, PACK_PAGE_SIZE } from '@/lib/agentic/agent-recertification';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(240_000);

const T = 'arc-pack-job';
const T2 = 'arc-pack-job-other';
/** Enough of the preparer's subjects for one run more than a request prepares. */
const SUBJECTS = SYNC_PACK_RUN_LIMIT * PACK_PAGE_SIZE + 1;

const users: Record<'owner' | 'admin', string> = { owner: '', admin: '' };
const ctxs: Record<'owner' | 'admin', RequestContext> = {} as never;
let preparer = '';
let campaignId = '';

async function clearTenant(t: string): Promise<void> {
    const w = { tenantId: t };
    await prisma.accessReviewAgentNarrowing.deleteMany({ where: w });
    await prisma.accessReviewAgentPack.deleteMany({ where: w });
    await prisma.accessReviewConnectedDecision.deleteMany({ where: w });
    await prisma.accessReview.deleteMany({ where: w });
    await prisma.workflowStep.deleteMany({ where: w });
    await prisma.workflowRun.deleteMany({ where: w });
    await prisma.registeredAgentTool.deleteMany({ where: w });
    await prisma.registeredAgent.deleteMany({ where: w });
    await prisma.aiSystem.deleteMany({ where: w });
    await deleteAuditRowsForTenants(prisma, [t]);
    await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = $1`, t);
    });
    await prisma.tenant.deleteMany({ where: { id: t } });
}

async function clear(): Promise<void> {
    await clearTenant(T);
    await clearTenant(T2);
    await prisma.user.deleteMany({
        where: { emailHash: { in: [hashForLookup(`owner@${T}.test`), hashForLookup(`admin@${T}.test`)] } },
    });
}

let seq = 0;
async function makeAgent(): Promise<string> {
    seq += 1;
    const sys = await prisma.aiSystem.create({ data: { tenantId: T, name: `job host ${seq}`, ownerUserId: users.owner } });
    const agent = await prisma.registeredAgent.create({
        data: {
            tenantId: T,
            aiSystemId: sys.id,
            name: `job agent ${seq}`,
            autonomyLevel: 1,
            dataAccessScope: 'READ_TENANT_DATA',
            reversibility: 'REVERSIBLE',
            provenance: 'FIRST_PARTY',
            ownerUserId: users.owner,
            status: 'ACTIVE',
            riskTier: 'LOW',
            riskTierScoredAt: new Date(),
        },
    });
    return agent.id;
}

async function ctxFor(tenantId: string, userId: string): Promise<RequestContext> {
    const resolved = await resolveTenantContext({ tenantId }, userId);
    return makeRequestContext(resolved.role, {
        tenantId, tenantSlug: tenantId, userId,
        permissions: resolved.permissions, appPermissions: resolved.appPermissions,
    });
}

const packCount = (accessReviewId: string) =>
    prisma.accessReviewAgentPack.count({ where: { tenantId: T, accessReviewId } });

/** The payload `requestAgentReviewPacks` enqueued last. */
function lastPayload(): { tenantId: string; accessReviewId: string; requestedByUserId: string; requestId?: string } {
    const call = mockEnqueue.mock.calls[mockEnqueue.mock.calls.length - 1];
    return call[1] as never;
}

beforeAll(async () => {
    await clear();
    await prisma.tenant.create({ data: { id: T, name: T, slug: T } });
    await prisma.tenant.create({ data: { id: T2, name: T2, slug: T2 } });
    for (const who of ['owner', 'admin'] as const) {
        const email = `${who}@${T}.test`;
        users[who] = (await prisma.user.create({ data: { email, emailHash: hashForLookup(email) } })).id;
    }
    await prisma.tenantMembership.create({ data: { tenantId: T, userId: users.owner, role: Role.OWNER, status: 'ACTIVE' } });
    await prisma.tenantMembership.create({ data: { tenantId: T, userId: users.admin, role: Role.ADMIN, status: 'ACTIVE' } });
    // The owner owns the other workspace too, so a job naming it is not
    // refused for want of a membership.
    await prisma.tenantMembership.create({ data: { tenantId: T2, userId: users.owner, role: Role.OWNER, status: 'ACTIVE' } });
    ctxs.owner = await ctxFor(T, users.owner);
    ctxs.admin = await ctxFor(T, users.admin);

    preparer = await makeAgent();
    for (let i = 0; i < SUBJECTS; i++) await makeAgent();
    await prisma.registeredAgentTool.create({
        data: { tenantId: T, agentId: preparer, toolName: AGENT_RECERTIFICATION_EVIDENCE_TOOL, grantedByUserId: users.owner },
    });

    campaignId = (await createAgentAccessReview(ctxs.owner, {
        name: 'large recertification',
        reviewerUserId: users.owner,
        preparerAgentId: preparer,
    })).accessReviewId;
});

afterAll(async () => {
    await clear();
    await prisma.$disconnect();
});

beforeEach(() => {
    mockEnqueue.mockClear();
    mockFindTenantJob.mockReset();
    mockFindTenantJob.mockResolvedValue(null);
});

describe('a large AGENT campaign is prepared by the job (#5317)', () => {
    it('the prepare request enqueues it with a fixed id and prepares nothing itself', async () => {
        const r = await requestAgentReviewPacks(ctxs.admin, campaignId);
        expect(r).toMatchObject({ mode: 'QUEUED', jobId: agentPackPreparationJobId(campaignId), alreadyQueued: false });
        expect(r.mode === 'QUEUED' && r.runs).toBeGreaterThan(SYNC_PACK_RUN_LIMIT);
        expect(mockEnqueue).toHaveBeenCalledTimes(1);
        expect(mockEnqueue).toHaveBeenCalledWith(
            AGENT_RECERT_PACKS_JOB,
            { tenantId: T, accessReviewId: campaignId, requestedByUserId: users.admin, requestId: ctxs.admin.requestId },
            { jobId: agentPackPreparationJobId(campaignId) },
        );
        expect(await packCount(campaignId)).toBe(0);
        const queued = await prisma.auditLog.count({ where: { tenantId: T, action: 'ACCESS_REVIEW_AGENT_PACKS_QUEUED', entityId: campaignId } });
        expect(queued).toBe(1);
    });

    it('a press while the job is live joins it; a press after a failed job removes it and queues again', async () => {
        const live = { getState: jest.fn(async () => 'active'), remove: jest.fn() };
        mockFindTenantJob.mockResolvedValue(live);
        const joined = await requestAgentReviewPacks(ctxs.admin, campaignId);
        expect(joined).toMatchObject({ mode: 'QUEUED', alreadyQueued: true });
        expect(mockEnqueue).not.toHaveBeenCalled();
        expect(live.remove).not.toHaveBeenCalled();
        expect(mockFindTenantJob).toHaveBeenCalledWith(agentPackPreparationJobId(campaignId), T, AGENT_RECERT_PACKS_JOB);

        const failed = { getState: jest.fn(async () => 'failed'), remove: jest.fn(async () => undefined) };
        mockFindTenantJob.mockResolvedValue(failed);
        const again = await requestAgentReviewPacks(ctxs.admin, campaignId);
        expect(again).toMatchObject({ mode: 'QUEUED', alreadyQueued: false });
        expect(failed.remove).toHaveBeenCalledTimes(1);
        expect(mockEnqueue).toHaveBeenCalledTimes(1);
    });

    it('a requester who lost the key by the time the job runs is refused, and nothing is written', async () => {
        await requestAgentReviewPacks(ctxs.admin, campaignId);
        const payload = lastPayload();
        await prisma.tenantMembership.update({
            where: { tenantId_userId: { tenantId: T, userId: users.admin } },
            data: { role: Role.EDITOR },
        });
        try {
            await expect(runAgentRecertPackPreparation(payload)).rejects.toThrow(/^REQUESTER_NOT_AUTHORISED:/);
            expect(await packCount(campaignId)).toBe(0);
        } finally {
            await prisma.tenantMembership.update({
                where: { tenantId_userId: { tenantId: T, userId: users.admin } },
                data: { role: Role.ADMIN },
            });
        }
    });

    it('a requester who left the workspace is refused, never run as anybody else', async () => {
        await expect(runAgentRecertPackPreparation({
            tenantId: T, accessReviewId: campaignId, requestedByUserId: 'usr-not-a-member',
        })).rejects.toThrow(/^REQUESTER_NOT_AUTHORISED:/);
        expect(await packCount(campaignId)).toBe(0);
    });

    it('a preparer that stopped qualifying after the request is refused when the job runs', async () => {
        await requestAgentReviewPacks(ctxs.admin, campaignId);
        const payload = lastPayload();
        await prisma.registeredAgent.update({ where: { id: preparer }, data: { status: 'SUSPENDED' } });
        try {
            await expect(runAgentRecertPackPreparation(payload)).rejects.toThrow(/^PREPARER_NOT_ACTIVE:/);
            expect(await packCount(campaignId)).toBe(0);
        } finally {
            await prisma.registeredAgent.update({ where: { id: preparer }, data: { status: 'ACTIVE' } });
        }
    });

    it('a job naming another workspace finds no campaign there and writes nothing in either', async () => {
        await expect(runAgentRecertPackPreparation({
            tenantId: T2, accessReviewId: campaignId, requestedByUserId: users.owner,
        })).rejects.toThrow(/not found/i);
        expect(await packCount(campaignId)).toBe(0);
        expect(await prisma.accessReviewAgentPack.count({ where: { tenantId: T2 } })).toBe(0);
        expect(await prisma.workflowRun.count({ where: { tenantId: T2 } })).toBe(0);
    });

    it('the job prepares a pack for every subject, as the requester, reporting progress up to every subject', async () => {
        await requestAgentReviewPacks(ctxs.admin, campaignId);
        const payload = lastPayload();
        const progress: Array<{ done: number; total: number }> = [];
        const result = await runAgentRecertPackPreparation(payload, (p) => { progress.push(p); });

        const subjects = await prisma.accessReviewConnectedDecision.count({ where: { tenantId: T, accessReviewId: campaignId } });
        expect(subjects).toBe(SUBJECTS + 1);
        expect(result.packs).toBe(subjects);
        expect(result.runIds.length).toBeGreaterThan(SYNC_PACK_RUN_LIMIT);
        const packs = await prisma.accessReviewAgentPack.findMany({
            where: { tenantId: T, accessReviewId: campaignId },
            select: { decisionId: true, preparedByUserId: true, preparedByAgentId: true, agentId: true },
        });
        expect(new Set(packs.map((p) => p.decisionId)).size).toBe(subjects);
        // As the requester, and no agent prepared its own pack.
        for (const p of packs) {
            expect(p.preparedByUserId).toBe(users.admin);
            expect(p.preparedByAgentId).not.toBe(p.agentId);
        }

        expect(progress[0]).toEqual({ done: 0, total: subjects });
        expect(progress[progress.length - 1]).toEqual({ done: subjects, total: subjects });
        const dones = progress.map((p) => p.done);
        expect(dones).toEqual([...dones].sort((a, b) => a - b));

        // And once prepared, a press is refused rather than queued again.
        await expect(requestAgentReviewPacks(ctxs.admin, campaignId)).rejects.toThrow(/^PACKS_ALREADY_PREPARED:/);
    });
});
