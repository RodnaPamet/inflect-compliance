/**
 * A RUN PARKED ON A DEFERRED TOOL CALL, AND EVERYTHING THAT READS IT (Step 2f
 * of `docs/claude-tool-runner-design.md`, deploy 1, #5530).
 *
 * Real database: the table, its RLS, its trigger and its grants; the queue's
 * own decision usecases; the nightly expiry sweep; the generic resume and
 * abort; the retirement cascade. The parked rows are written here the way the
 * engine's park writes them, because deploy 1 has no writer: it teaches every
 * reader what a parked run means before any exists.
 */
const enqueued: Array<{ name: string; payload: Record<string, unknown> }> = [];
jest.mock('@/app-layer/jobs/queue', () => ({
    ...jest.requireActual('@/app-layer/jobs/queue'),
    enqueue: jest.fn(async (name: string, payload: Record<string, unknown>) => {
        enqueued.push({ name, payload });
        return undefined;
    }),
}));

import { PrismaClient, type Role } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { createTenantWithDek } from '@/lib/security/tenant-key-manager';
import { runInTenantContext } from '@/lib/db-context';
import { abortWorkflowRun, resumeWorkflowRun } from '@/app-layer/usecases/workflow-runs';
import { rejectAgentProposal } from '@/app-layer/usecases/agent-proposals';
import {
    DEFERRAL_AGENT_RETIRED_MESSAGE,
    DEFERRAL_EXPIRED_MESSAGE,
    settleDeferralForProposal,
} from '@/app-layer/usecases/workflow-run-deferrals';
import { retireRegisteredAgent } from '@/app-layer/usecases/agent-registry';
import { readProposalsRunsWaitOn, readRunDeferralView } from '@/app-layer/usecases/workflow-run-deferral-views';
import { runAgentProposalExpiry } from '@/app-layer/jobs/agent-proposal-expiry';
import { sealTranscript, TRANSCRIPT_FORMAT } from '@/lib/agentic/tool-runner/transcript';
import type { RequestContext } from '@/app-layer/types';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }), transactionOptions: TENANT_TX_OPTIONS });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(120_000);

const SUITE = `wrd-${randomUUID().slice(0, 8)}`;
const TENANTS = { A: `ta-${SUITE}`, B: `tb-${SUITE}` } as const;
type Tenant = keyof typeof TENANTS;
const OWNER = { A: `ua-owner-${SUITE}`, B: `ub-owner-${SUITE}` } as const;
const DECIDER = { A: `ua-decider-${SUITE}`, B: `ub-decider-${SUITE}` } as const;
const AGENT = { A: `ag-a-${SUITE}`, B: `ag-b-${SUITE}` } as const;
/** A string that is in every transcript and must never be in its column at rest. */
const MARKER = 'aquamarine-ledger-entry-for-the-isolation-check';

const ctx = (t: Tenant, who: 'owner' | 'decider' = 'decider'): RequestContext =>
    makeRequestContext(who === 'owner' ? 'OWNER' : 'ADMIN', {
        tenantId: TENANTS[t],
        tenantSlug: TENANTS[t],
        userId: who === 'owner' ? OWNER[t] : DECIDER[t],
    });

function transcript(toolUseId: string) {
    return sealTranscript({
        format: TRANSCRIPT_FORMAT,
        model: 'claude-test-model',
        system: [{ type: 'text', text: 'system' }],
        tools: [{ name: 'propose_risks', description: 'd', input_schema: { type: 'object' } }],
        messages: [
            { role: 'user', content: `Read the register. ${MARKER}` },
            {
                role: 'assistant',
                content: [
                    { type: 'thinking', thinking: 'deciding', signature: 'sig-abc' },
                    { type: 'tool_use', id: toolUseId, name: 'propose_risks', input: { items: [{ title: 'x' }] } },
                ],
            },
        ],
        pendingResults: [{ type: 'tool_result', tool_use_id: toolUseId, content: '' }],
        toolUseId,
    });
}

let n = 0;
/** A run parked on one proposal, written as the engine's park writes it. */
async function park(
    t: Tenant,
    opts: { agentId?: string; expiresAt?: Date; elapsedMsAtPark?: number; startedAt?: Date } = {},
): Promise<{ runId: string; proposalId: string; deferralId: string; hash: string }> {
    n += 1;
    const tenantId = TENANTS[t];
    const runId = `run-${SUITE}-${n}`;
    const proposalId = `prop-${SUITE}-${n}`;
    const toolUseId = `toolu_${n}`;
    await prisma.workflowRun.create({
        data: {
            id: runId,
            tenantId,
            workflowKey: 'audit-prep',
            status: 'AWAITING_APPROVAL',
            stepCount: 2,
            startedByUserId: OWNER[t],
            approvalExpiresAt: opts.expiresAt ?? new Date(Date.now() + 86_400_000),
            ...(opts.startedAt ? { startedAt: opts.startedAt } : {}),
            ...(opts.agentId ? { agentId: opts.agentId } : {}),
        },
    });
    await prisma.workflowStep.createMany({
        data: [
            { runId, tenantId, seq: 0, kind: 'TOOL_CALL', toolCalled: 'propose_risks', status: 'DONE' },
            { runId, tenantId, seq: 1, kind: 'HUMAN_CHECKPOINT', status: 'PENDING' },
        ],
    });
    await prisma.agentProposal.create({
        data: {
            id: proposalId,
            tenantId,
            kind: 'RISK',
            payloadJson: '{}',
            status: 'PENDING',
            runId,
            stepSeq: 0,
            expiresAt: opts.expiresAt ?? new Date(Date.now() + 86_400_000),
            ...(opts.agentId ? { agentId: opts.agentId } : {}),
        },
    });
    const sealed = transcript(toolUseId);
    const row = await runInTenantContext(ctx(t), (db) =>
        db.workflowRunDeferral.create({
            data: {
                tenantId,
                runId,
                stepSeq: 0,
                toolUseId,
                toolCalled: 'propose_risks',
                proposalId,
                transcriptJson: sealed.json,
                transcriptHash: sealed.hash,
                model: 'claude-test-model',
                elapsedMsAtPark: opts.elapsedMsAtPark ?? 1_000,
            },
        }),
    );
    return { runId, proposalId, deferralId: row.id, hash: sealed.hash };
}

const deferralOf = (id: string) => prisma.workflowRunDeferral.findUniqueOrThrow({ where: { id } });
const runOf = (id: string) =>
    prisma.workflowRun.findUniqueOrThrow({ where: { id }, select: { status: true, errorMessage: true } });

async function cleanup(): Promise<void> {
    const tenants = Object.values(TENANTS);
    await prisma.workflowRunDeferral.deleteMany({ where: { tenantId: { in: tenants } } });
    await prisma.agentProposal.deleteMany({ where: { tenantId: { in: tenants } } });
    await prisma.workflowStep.deleteMany({ where: { tenantId: { in: tenants } } });
    await prisma.aiDecisionLog.deleteMany({ where: { tenantId: { in: tenants } } });
    await prisma.workflowRun.deleteMany({ where: { tenantId: { in: tenants } } });
    await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        for (const table of ['RegisteredAgent', 'TenantMembership']) {
            await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "tenantId" = ANY($1::text[])`, tenants);
        }
    });
    await prisma.aiSystem.deleteMany({ where: { tenantId: { in: tenants } } });
    await deleteAuditRowsForTenants(prisma, tenants);
    await prisma.user.deleteMany({ where: { id: { in: [...Object.values(OWNER), ...Object.values(DECIDER)] } } });
    await prisma.tenant.deleteMany({ where: { id: { in: tenants } } });
}

describeFn('a run parked on a deferred tool call (real DB)', () => {
    beforeAll(async () => {
        await prisma.$connect();
        await cleanup();
        for (const t of ['A', 'B'] as const) {
            const tenantId = TENANTS[t];
            await createTenantWithDek({ id: tenantId, name: tenantId, slug: tenantId });
            for (const [id, role] of [
                [OWNER[t], 'OWNER'],
                [DECIDER[t], 'ADMIN'],
            ] as const) {
                const email = `${id}@example.test`;
                await prisma.user.create({ data: { id, email, emailHash: hashForLookup(email) } });
                await prisma.tenantMembership.create({ data: { tenantId, userId: id, role: role as Role, status: 'ACTIVE' } });
            }
            const sys = await prisma.aiSystem.create({ data: { tenantId, name: `sys-${AGENT[t]}` } });
            await prisma.registeredAgent.create({
                data: {
                    id: AGENT[t],
                    tenantId,
                    aiSystemId: sys.id,
                    name: `agent ${AGENT[t]}`,
                    autonomyLevel: 1,
                    dataAccessScope: 'READ_TENANT_DATA',
                    reversibility: 'REVERSIBLE',
                    provenance: 'FIRST_PARTY',
                    ownerUserId: OWNER[t],
                    status: 'ACTIVE',
                    riskTier: 'LOW',
                    riskTierScoredAt: new Date(),
                },
            });
        }
    });

    beforeEach(() => {
        enqueued.length = 0;
    });

    afterAll(async () => {
        await cleanup();
        await prisma.$disconnect();
    });

    it('two tenants: neither reads nor writes the other\'s deferrals', async () => {
        const a = await park('A');
        const seenByB = await runInTenantContext(ctx('B'), (db) => db.workflowRunDeferral.findMany({ where: {} }));
        expect(seenByB.map((d) => d.id)).not.toContain(a.deferralId);
        const seenByA = await runInTenantContext(ctx('A'), (db) => db.workflowRunDeferral.findMany({ where: {} }));
        expect(seenByA.map((d) => d.id)).toContain(a.deferralId);
        // B's context cannot insert a row naming A.
        await expect(
            runInTenantContext(ctx('B'), (db) =>
                db.workflowRunDeferral.create({
                    data: {
                        tenantId: TENANTS.A,
                        runId: a.runId,
                        stepSeq: 3,
                        toolUseId: 'toolu_x',
                        toolCalled: 'propose_risks',
                        proposalId: `foreign-${SUITE}`,
                        transcriptJson: '{}',
                        transcriptHash: 'a'.repeat(64),
                        model: 'm',
                        elapsedMsAtPark: 0,
                    },
                }),
            ),
        ).rejects.toThrow();
        // B's decision hook finds nothing of A's: the proposal id is A's.
        expect(await settleDeferralForProposal(ctx('B'), a.proposalId)).toBe('NO_DEFERRAL');
    });

    it('the transcript is encrypted at rest; its hash is not', async () => {
        const a = await park('A');
        const [raw] = await prisma.$queryRawUnsafe<Array<{ transcriptJson: string; transcriptHash: string }>>(
            `SELECT "transcriptJson", "transcriptHash" FROM "WorkflowRunDeferral" WHERE "id" = $1`,
            a.deferralId,
        );
        expect(raw.transcriptJson.startsWith('v2:')).toBe(true);
        expect(raw.transcriptJson).not.toContain(MARKER);
        expect(raw.transcriptHash).toBe(a.hash);
        // Read through the app's client, it is the plaintext, byte for byte.
        const read = await runInTenantContext(ctx('A'), (db) =>
            db.workflowRunDeferral.findFirstOrThrow({ where: { id: a.deferralId }, select: { transcriptJson: true } }),
        );
        expect(read.transcriptJson).toContain(MARKER);
    });

    it('the trigger holds the row one way, the transcript frozen but for the clear, and app_user holds no DELETE', async () => {
        const a = await park('A');
        await expect(
            prisma.workflowRunDeferral.update({ where: { id: a.deferralId }, data: { transcriptHash: 'b'.repeat(64) } }),
        ).rejects.toThrow(/IMMUTABLE_WORKFLOW_RUN_DEFERRAL/);
        // A rewrite in the clear is refused; ciphertext to `v2:` ciphertext with
        // nothing else changed is the rotation sweeps' re-wrap, and admitted.
        await expect(
            prisma.workflowRunDeferral.update({ where: { id: a.deferralId }, data: { transcriptJson: '{"rewritten":true}' } }),
        ).rejects.toThrow(/WORKFLOW_RUN_DEFERRAL_TRANSCRIPT_FROZEN/);
        await prisma.workflowRunDeferral.update({ where: { id: a.deferralId }, data: { transcriptJson: 'v2:rewrapped' } });
        // A clear without leaving WAITING breaks the shape: an open row holds its transcript.
        await expect(
            prisma.workflowRunDeferral.update({ where: { id: a.deferralId }, data: { transcriptJson: null } }),
        ).rejects.toThrow();
        await prisma.workflowRunDeferral.update({
            where: { id: a.deferralId },
            data: { status: 'SETTLED', decision: 'NOT_RESUMED', settledAt: new Date(), transcriptJson: null },
        });
        await expect(
            prisma.workflowRunDeferral.update({ where: { id: a.deferralId }, data: { status: 'WAITING' } }),
        ).rejects.toThrow(/WORKFLOW_RUN_DEFERRAL_ONE_WAY/);
        await expect(
            prisma.$transaction(async (tx) => {
                await tx.$executeRawUnsafe(`SET LOCAL ROLE app_user`);
                await tx.$executeRawUnsafe(`SELECT set_config('app.tenant_id', $1, true)`, TENANTS.A);
                await tx.$executeRawUnsafe(`DELETE FROM "WorkflowRunDeferral" WHERE "id" = $1`, a.deferralId);
            }),
        ).rejects.toThrow(/permission denied/);
    });

    it('the readers\' views: the run page sees the wait and its deadline, the proposals page sees which proposal is waited on', async () => {
        const a = await park('A');
        const view = await readRunDeferralView(ctx('A'), a.runId);
        expect(view).toMatchObject({ status: 'WAITING', proposalId: a.proposalId, proposalKind: 'RISK', toolCalled: 'propose_risks' });
        expect(view?.deadline).not.toBeNull();
        expect(JSON.stringify(view)).not.toContain(MARKER);
        expect([...(await readProposalsRunsWaitOn(ctx('A'), [a.proposalId, 'none']))]).toEqual([a.proposalId]);
        // Another tenant sees neither.
        expect(await readRunDeferralView(ctx('B'), a.runId)).toBeNull();
        expect([...(await readProposalsRunsWaitOn(ctx('B'), [a.proposalId]))]).toEqual([]);
    });

    it('the generic Resume refuses a run that waits on a proposal, naming it', async () => {
        const a = await park('A');
        await expect(resumeWorkflowRun(ctx('A'), a.runId)).rejects.toThrow(
            new RegExp(`RUN_WAITS_ON_A_PROPOSAL: .*${a.proposalId}`),
        );
        expect((await runOf(a.runId)).status).toBe('AWAITING_APPROVAL');
        expect(enqueued).toHaveLength(0);
    });

    it('a rejection in the queue resumes the run once: DECIDED, claimed, checkpoint closed by the decider, enqueued', async () => {
        const startedAt = new Date(Date.now() - 3 * 3_600_000);
        const a = await park('A', { elapsedMsAtPark: 5_000, startedAt });
        await rejectAgentProposal(ctx('A'), a.proposalId);
        const d = await deferralOf(a.deferralId);
        expect(d).toMatchObject({ status: 'DECIDED', decision: 'REJECTED', decidedByUserId: DECIDER.A });
        // The transcript is kept until the resumed segment's first step.
        expect(d.transcriptJson).not.toBeNull();
        expect((await runOf(a.runId)).status).toBe('RUNNING');
        const checkpoint = await prisma.workflowStep.findFirstOrThrow({ where: { runId: a.runId, seq: 1 } });
        expect(checkpoint).toMatchObject({ status: 'DONE', actorUserId: DECIDER.A });
        expect(enqueued).toHaveLength(1);
        expect(enqueued[0]).toMatchObject({ name: 'agent-run-execute', payload: { tenantId: TENANTS.A, runId: a.runId } });
        // The clock base leaves the wait out: about five seconds of unattended time, not three hours.
        const base = Number(enqueued[0].payload.clockBase);
        expect(Date.now() - base).toBeGreaterThanOrEqual(5_000);
        expect(Date.now() - base).toBeLessThan(60_000);
        const audit = await prisma.auditLog.findFirst({
            where: { tenantId: TENANTS.A, entityId: a.runId, action: 'WORKFLOW_RUN_RESUMED' },
        });
        expect(audit?.detailsJson).toMatchObject({ reason: 'DEFERRAL_DECIDED', proposalId: a.proposalId });
    });

    it('two decisions racing on one deferral resume the run exactly once', async () => {
        const a = await park('A');
        await prisma.agentProposal.update({
            where: { id: a.proposalId },
            data: { status: 'REJECTED', reviewedByUserId: DECIDER.A, reviewedAt: new Date() },
        });
        const outcomes = await Promise.all([
            settleDeferralForProposal(ctx('A'), a.proposalId),
            settleDeferralForProposal(ctx('A'), a.proposalId),
            settleDeferralForProposal(ctx('A'), a.proposalId),
        ]);
        expect(outcomes.filter((o) => o === 'RESUMING')).toHaveLength(1);
        expect(enqueued.filter((e) => e.payload.runId === a.runId)).toHaveLength(1);
    });

    it('an expiry settles the run FAILED with a named reason, and the deferral SETTLED with its transcript cleared', async () => {
        const a = await park('A', { expiresAt: new Date(Date.now() - 60_000) });
        await runAgentProposalExpiry(prisma, { tenantId: TENANTS.A });
        expect(await runOf(a.runId)).toEqual({ status: 'FAILED', errorMessage: DEFERRAL_EXPIRED_MESSAGE });
        const d = await deferralOf(a.deferralId);
        expect(d).toMatchObject({ status: 'SETTLED', decision: 'EXPIRED', transcriptJson: null, transcriptHash: a.hash });
        expect(enqueued).toHaveLength(0);
    });

    it('the sweep heals a deferral left WAITING behind a decided proposal, under the decider the queue recorded', async () => {
        const a = await park('A');
        await prisma.agentProposal.update({
            where: { id: a.proposalId },
            data: { status: 'ACCEPTED', reviewedByUserId: DECIDER.A, reviewedAt: new Date(), createdEntityId: 'risk-1' },
        });
        await runAgentProposalExpiry(prisma, { tenantId: TENANTS.A });
        expect(await deferralOf(a.deferralId)).toMatchObject({ status: 'DECIDED', decision: 'ACCEPTED', decidedByUserId: DECIDER.A });
        expect(enqueued.filter((e) => e.payload.runId === a.runId)).toHaveLength(1);
    });

    it('an abort settles the deferral NOT_RESUMED, clears the transcript, and leaves the proposal in the queue', async () => {
        const a = await park('A');
        await abortWorkflowRun(ctx('A'), a.runId);
        expect((await runOf(a.runId)).status).toBe('ABORTED');
        expect(await deferralOf(a.deferralId)).toMatchObject({ status: 'SETTLED', decision: 'NOT_RESUMED', transcriptJson: null });
        expect((await prisma.agentProposal.findUniqueOrThrow({ where: { id: a.proposalId } })).status).toBe('PENDING');
        // A decision taken on it afterwards resumes nothing.
        await rejectAgentProposal(ctx('A'), a.proposalId);
        expect(enqueued).toHaveLength(0);
    });

    it('a retirement settles the agent\'s parked runs FAILED, named, in the cascade', async () => {
        const a = await park('B', { agentId: AGENT.B });
        await retireRegisteredAgent(ctx('B', 'owner'), AGENT.B);
        expect(await runOf(a.runId)).toEqual({ status: 'FAILED', errorMessage: DEFERRAL_AGENT_RETIRED_MESSAGE });
        expect(await deferralOf(a.deferralId)).toMatchObject({ status: 'SETTLED', decision: 'EXPIRED', transcriptJson: null });
        expect((await prisma.agentProposal.findUniqueOrThrow({ where: { id: a.proposalId } })).status).toBe('EXPIRED');
        expect(enqueued).toHaveLength(0);
    });
});
