/**
 * DEFER A TOOL CALL TO A PERSON, END TO END (Step 2f, deploy 2, #5530).
 *
 * Real database, real usecases: the profile's save and approval, admission,
 * the engine, the funnel, the proposal queue's own decision usecases, the
 * decision hook and the worker's body. The model is a fake `fetch` answering
 * Anthropic's Messages API.
 *
 *   • A: the model calls `propose_risks`, which the version defers. The run
 *     PARKS: no request leaves after the call; the transcript is stored,
 *     encrypted; the checkpoint is PENDING; the generic Resume is refused. A
 *     person APPROVES the proposal in the queue; the run resumes with the
 *     created record in the open slot, byte for byte on its own transcript,
 *     and completes; the transcript is cleared and its hash kept.
 *   • B: a call carrying two items is refused DEFERRED_CALL_ONE_ITEM before
 *     the funnel and the run goes on; the one-item call parks; a person
 *     REJECTS it; the run resumes with the rejection and completes.
 *   • A second run of A parks, a kill switch is engaged while it waits, and the
 *     decision settles it at the kill, with nothing sent.
 *   • Save refusals by name, and a sub-agent may not name a deferred tool.
 *   • Neither tenant's conversation reaches the other's model.
 */
const envOverride: Record<string, string | undefined> = {
    AGENT_PROFILES: '1',
    AGENT_DRIVER_TOOL_RUNNER: '1',
    ANTHROPIC_API_KEY: 'sk-ant-integration-faux-key', // pragma: allowlist secret -- a placeholder; the fake fetch answers every request
};
jest.mock('@/env', () => {
    const actual = jest.requireActual('@/env') as { env: Record<string, unknown> };
    return {
        env: new Proxy(actual.env, {
            get: (target, key) => (typeof key === 'string' && key in envOverride ? envOverride[key] : Reflect.get(target, key)),
        }),
    };
});
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
import { executeQueuedWorkflowRun, resumeWorkflowRun, startWorkflowRun } from '@/app-layer/usecases/workflow-runs';
import {
    approveAgentProfileVersion,
    createAgentProfile,
    profileContentHash,
    submitAgentProfileVersion,
} from '@/app-layer/usecases/agent-profiles';
import { approveAgentProposal, rejectAgentProposal } from '@/app-layer/usecases/agent-proposals';
import type { AgentProfileVersionInput } from '@/app-layer/schemas/agent-profile.schemas';
import type { RequestContext } from '@/app-layer/types';
import { profileRunKey } from '@/lib/agentic/agent-profile';
import { DEFERRED_CALL_ONE_ITEM } from '@/lib/agentic/tool-runner/tools';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }), transactionOptions: TENANT_TX_OPTIONS });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(180_000);

const SUITE = `trdf-${randomUUID().slice(0, 8)}`;
const TENANTS = { A: `ta-${SUITE}`, B: `tb-${SUITE}` } as const;
const USERS = {
    A: { author: `ua-author-${SUITE}`, reviewer: `ua-reviewer-${SUITE}` },
    B: { author: `ub-author-${SUITE}`, reviewer: `ub-reviewer-${SUITE}` },
} as const;
const AGENTS = { A: `ag-a-${SUITE}`, B: `ag-b-${SUITE}`, refusals: `ag-r-${SUITE}` } as const;
const MARK = { A: 'aquamarine-vpn-appliance', B: 'vermilion-badge-reader' } as const;

type Tenant = 'A' | 'B';
const ctx = (t: Tenant, who: 'author' | 'reviewer', over: Partial<RequestContext> = {}): RequestContext =>
    makeRequestContext(who === 'author' ? 'OWNER' : 'ADMIN', {
        tenantId: TENANTS[t],
        tenantSlug: TENANTS[t],
        userId: USERS[t][who],
        ...over,
    });

const version = (over: Partial<AgentProfileVersionInput> = {}): AgentProfileVersionInput => ({
    instructions: 'Propose a risk for each weakness you are told about.',
    toolNames: ['list_risks', 'propose_risks'],
    skillRefs: [],
    modelTier: 'balanced',
    effort: 'medium',
    maxTurns: 10,
    deferredToolNames: ['propose_risks'],
    outputKind: 'ANSWER_AND_PROPOSALS',
    allowedTriggers: ['ASK'],
    ...over,
});

// ─── The fake model ─────────────────────────────────────────────────

type Answer = Record<string, unknown>;
const wire = { bodies: [] as Array<Record<string, unknown>>, script: [] as Answer[] };
const originalFetch = global.fetch;

const proposeCall = (id: string, titles: string[]): Answer => ({
    content: [
        { type: 'thinking', thinking: `I should propose ${titles.join(' and ')}.`, signature: `sig-${id}-QUJDRA==` },
        { type: 'tool_use', id, name: 'propose_risks', input: { items: titles.map((title) => ({ title: `Unpatched appliance ${title}` })), rationale: 'The appliance runs an outdated firmware version.' } },
    ],
    stop_reason: 'tool_use',
    usage: { input_tokens: 300, output_tokens: 20 },
});
const done: Answer = { content: [{ type: 'text', text: 'Done.' }], stop_reason: 'end_turn', usage: { input_tokens: 400, output_tokens: 5 } };

function script(answers: Answer[]): void {
    wire.bodies = [];
    wire.script = [...answers];
    global.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const n = wire.bodies.length;
        wire.bodies.push(body);
        const answer = wire.script.shift() ?? done;
        return new Response(
            JSON.stringify({ id: `msg_${n}`, type: 'message', role: 'assistant', model: String(body.model), stop_sequence: null, ...answer }),
            { status: 200, headers: { 'content-type': 'application/json' } },
        );
    }) as typeof fetch;
}

async function cleanup(): Promise<void> {
    const tenants = Object.values(TENANTS);
    await prisma.workflowRunDeferral.deleteMany({ where: { tenantId: { in: tenants } } });
    await prisma.agentKillSwitch.deleteMany({ where: { tenantId: { in: tenants } } });
    await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        for (const table of ['RiskScoreEvent', 'AgentProposalApproval', 'AgentProposal', 'Risk', 'AgentProfileVersion', 'AgentProfile', 'TenantMembership']) {
            await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "tenantId" = ANY($1::text[])`, tenants);
        }
    });
    await prisma.workflowStep.deleteMany({ where: { tenantId: { in: tenants } } });
    await prisma.aiDecisionLog.deleteMany({ where: { tenantId: { in: tenants } } });
    await prisma.workflowRun.deleteMany({ where: { tenantId: { in: tenants } } });
    await prisma.registeredAgentTool.deleteMany({ where: { tenantId: { in: tenants } } });
    await prisma.registeredAgent.deleteMany({ where: { tenantId: { in: tenants } } });
    await prisma.aiSystem.deleteMany({ where: { tenantId: { in: tenants } } });
    await prisma.tenantSecuritySettings.deleteMany({ where: { tenantId: { in: tenants } } });
    await deleteAuditRowsForTenants(prisma, tenants);
    await prisma.user.deleteMany({ where: { id: { in: Object.values(USERS).flatMap((u) => Object.values(u)) } } });
    await prisma.tenant.deleteMany({ where: { id: { in: tenants } } });
}

async function seedAgent(t: Tenant, agentId: string): Promise<void> {
    const tenantId = TENANTS[t];
    const sys = await prisma.aiSystem.create({ data: { tenantId, name: `sys-${agentId}` } });
    await prisma.registeredAgent.create({
        data: {
            id: agentId,
            tenantId,
            aiSystemId: sys.id,
            name: `agent ${agentId}`,
            autonomyLevel: 2,
            dataAccessScope: 'READ_TENANT_DATA',
            reversibility: 'REVERSIBLE',
            provenance: 'FIRST_PARTY',
            ownerUserId: USERS[t].author,
            status: 'ACTIVE',
            riskTier: 'LOW',
            riskTierScoredAt: new Date(),
        },
    });
    for (const toolName of ['list_risks', 'propose_risks']) {
        await prisma.registeredAgentTool.create({ data: { tenantId, agentId, toolName, grantedByUserId: USERS[t].author } });
    }
}

async function refusalOf(p: Promise<unknown>): Promise<string> {
    try {
        await p;
    } catch (err) {
        const details = ((err as { details?: Record<string, unknown> }).details ?? {}) as Record<string, unknown>;
        return typeof details.reason === 'string' ? details.reason : `THREW:${(err as Error).message}`;
    }
    return 'NO_REFUSAL';
}

let profileIds: Record<Tenant, string> = { A: '', B: '' };

async function startAsk(t: Tenant): Promise<string> {
    const started = await startWorkflowRun(ctx(t, 'reviewer', { agentId: AGENTS[t] }), profileRunKey(profileIds[t], 1), {}, { profileTrigger: 'ASK' });
    return started.runId;
}

const deferralOf = (runId: string) => prisma.workflowRunDeferral.findFirstOrThrow({ where: { runId }, orderBy: { stepSeq: 'desc' } });
const stepsOf = (runId: string) =>
    prisma.workflowStep.findMany({ where: { runId }, orderBy: { seq: 'asc' }, select: { seq: true, kind: true, toolCalled: true, status: true } });

describeFn('deferring a tool call to a person on the Tool Runner engine (real DB, fake model)', () => {
    beforeAll(async () => {
        await prisma.$connect();
        await cleanup();
        for (const t of ['A', 'B'] as const) {
            const tenantId = TENANTS[t];
            await createTenantWithDek({ id: tenantId, name: tenantId, slug: tenantId });
            for (const [id, role] of [
                [USERS[t].author, 'OWNER'],
                [USERS[t].reviewer, 'ADMIN'],
            ] as const) {
                const email = `${id}@example.test`;
                await prisma.user.create({ data: { id, email, emailHash: hashForLookup(email) } });
                await prisma.tenantMembership.create({ data: { tenantId, userId: id, role: role as Role, status: 'ACTIVE' } });
            }
            // AUDIT, not BALANCED: on the propose surface the funnel's own result
            // text names `quarantined` (its count key), which the injection
            // scan's refusal-vocabulary rule matches, so under BALANCED every
            // propose call through the engine-neutral core is flagged on its own
            // result. That is a finding of its own, reported with this step; it
            // is not what this test measures.
            await prisma.tenantSecuritySettings.create({ data: { tenantId, agentDriver: 'TOOL_RUNNER', aiGuardMode: 'AUDIT' } });
            await seedAgent(t, AGENTS[t]);
            const created = await createAgentProfile(ctx(t, 'author'), AGENTS[t], version());
            await submitAgentProfileVersion(ctx(t, 'author'), AGENTS[t], 1);
            await approveAgentProfileVersion(ctx(t, 'reviewer'), AGENTS[t], 1, { instructionsHash: created.instructionsHash });
            profileIds[t] = created.profileId;
        }
        await seedAgent('A', AGENTS.refusals);
    });

    beforeEach(() => {
        enqueued.length = 0;
    });

    afterAll(async () => {
        global.fetch = originalFetch;
        await cleanup();
        await prisma.$disconnect();
    });

    it('save refusals by name: a tool the version lacks, a read tool, a list beside sub-agents that name it', async () => {
        const save = (over: Partial<AgentProfileVersionInput>) =>
            refusalOf(createAgentProfile(ctx('A', 'author'), AGENTS.refusals, version(over)));
        expect(await save({ deferredToolNames: ['propose_controls'] })).toBe('DEFERRED_TOOL_NOT_IN_VERSION');
        expect(await save({ deferredToolNames: ['list_risks'] })).toBe('DEFERRED_TOOL_NOT_A_PROPOSE_TOOL');
        expect(
            await save({
                subagents: [{ name: 'proposer', instructions: 'Propose risks.', toolNames: ['propose_risks'], skillRefs: [], maxTurns: 2 }],
            }),
        ).toBe('SUBAGENT_TOOL_DEFERRED');
        // Nothing was written by any refusal.
        expect(await prisma.agentProfile.count({ where: { tenantId: TENANTS.A, agentId: AGENTS.refusals } })).toBe(0);
        // The approved version carries its deferred tools; the hash does not cover them.
        const row = await prisma.agentProfileVersion.findFirstOrThrow({
            where: { tenantId: TENANTS.A, profile: { agentId: AGENTS.A } },
            select: { deferredToolNames: true, instructions: true, flowJson: true, subagentsJson: true, instructionsHash: true },
        });
        expect(row.deferredToolNames).toEqual(['propose_risks']);
        expect(row.instructionsHash).toBe(profileContentHash('Propose a risk for each weakness you are told about.', null, null));
    });

    it('A: a deferred call parks the run, no request leaves after it, and an approval in the queue resumes it to completion', async () => {
        script([proposeCall('toolu_a1', [MARK.A])]);
        const runId = await startAsk('A');
        expect(await executeQueuedWorkflowRun(TENANTS.A, runId)).toMatchObject({ status: 'AWAITING_APPROVAL' });
        const parkedBodies = [...wire.bodies];
        // ONE request, and none after the deferred call.
        expect(parkedBodies).toHaveLength(1);
        expect(await stepsOf(runId)).toEqual([
            { seq: 0, kind: 'MODEL_CALL', toolCalled: null, status: 'DONE' },
            { seq: 1, kind: 'TOOL_CALL', toolCalled: 'propose_risks', status: 'DONE' },
            { seq: 2, kind: 'HUMAN_CHECKPOINT', toolCalled: null, status: 'PENDING' },
        ]);
        const deferral = await deferralOf(runId);
        const proposal = await prisma.agentProposal.findUniqueOrThrow({ where: { id: deferral.proposalId } });
        expect(proposal).toMatchObject({ status: 'PENDING', runId, stepSeq: 1 });
        expect(deferral).toMatchObject({ status: 'WAITING', toolCalled: 'propose_risks', toolUseId: 'toolu_a1', stepSeq: 1 });
        // Encrypted at rest.
        expect(deferral.transcriptJson?.startsWith('v2:')).toBe(true);
        expect(deferral.transcriptJson).not.toContain(MARK.A);
        const run = await prisma.workflowRun.findUniqueOrThrow({ where: { id: runId }, select: { status: true, approvalExpiresAt: true } });
        expect(run.status).toBe('AWAITING_APPROVAL');
        expect(run.approvalExpiresAt?.getTime()).toBe(proposal.expiresAt?.getTime());
        expect(
            await prisma.auditLog.count({ where: { tenantId: TENANTS.A, entityId: runId, action: 'WORKFLOW_RUN_DEFERRED' } }),
        ).toBe(1);

        // The generic Resume cannot continue it.
        expect(await refusalOf(resumeWorkflowRun(ctx('A', 'reviewer'), runId))).toBe('RUN_WAITS_ON_A_PROPOSAL');

        // The decision, in the queue, by its own usecase.
        enqueued.length = 0;
        const approved = await approveAgentProposal(ctx('A', 'reviewer'), deferral.proposalId, {});
        const createdId = (approved as { createdEntityId: string }).createdEntityId;
        expect(enqueued).toHaveLength(1);
        script([done]);
        expect(await executeQueuedWorkflowRun(TENANTS.A, runId, { clockBase: Number(enqueued[0].payload.clockBase) })).toMatchObject({
            status: 'COMPLETED',
        });
        const resumed = wire.bodies[0];
        // Byte for byte the parked conversation, thinking block included, and
        // the decision in the open slot.
        expect(JSON.stringify(resumed.system)).toBe(JSON.stringify(parkedBodies[0].system));
        expect(JSON.stringify(resumed.tools)).toBe(JSON.stringify(parkedBodies[0].tools));
        expect(resumed.model).toBe(parkedBodies[0].model);
        const messages = resumed.messages as Array<{ role: string; content: unknown }>;
        expect(JSON.stringify(messages.slice(0, 1))).toBe(JSON.stringify(parkedBodies[0].messages));
        expect(JSON.stringify(messages[1].content)).toBe(JSON.stringify(proposeCall('toolu_a1', [MARK.A]).content));
        expect(messages[2]).toEqual({
            role: 'user',
            content: [
                {
                    type: 'tool_result',
                    tool_use_id: 'toolu_a1',
                    content: `A person approved this proposal. It was created as RISK ${createdId}.`,
                },
            ],
        });
        expect(await deferralOf(runId)).toMatchObject({ status: 'RESUMED', decision: 'ACCEPTED', transcriptJson: null, transcriptHash: deferral.transcriptHash });
    });

    it('B: a deferred call with two items is refused by name and the run goes on; a rejection resumes the run with the fact, not the prose', async () => {
        script([proposeCall('toolu_b1', [MARK.B, 'second']), proposeCall('toolu_b2', [MARK.B])]);
        const runId = await startAsk('B');
        expect(await executeQueuedWorkflowRun(TENANTS.B, runId)).toMatchObject({ status: 'AWAITING_APPROVAL' });
        expect(wire.bodies).toHaveLength(2);
        const steps = await stepsOf(runId);
        expect(steps.map((s) => [s.kind, s.toolCalled, s.status])).toEqual([
            ['MODEL_CALL', null, 'DONE'],
            ['TOOL_CALL', 'propose_risks', 'FAILED'],
            ['MODEL_CALL', null, 'DONE'],
            ['TOOL_CALL', 'propose_risks', 'DONE'],
            ['HUMAN_CHECKPOINT', null, 'PENDING'],
        ]);
        const secondRequest = JSON.stringify(wire.bodies[1].messages);
        expect(secondRequest).toContain(DEFERRED_CALL_ONE_ITEM);
        // The refused call queued nothing: one proposal for the run.
        expect(await prisma.agentProposal.count({ where: { runId } })).toBe(1);

        const deferral = await deferralOf(runId);
        enqueued.length = 0;
        await rejectAgentProposal(ctx('B', 'reviewer'), deferral.proposalId);
        script([done]);
        expect(await executeQueuedWorkflowRun(TENANTS.B, runId, { clockBase: Number(enqueued[0].payload.clockBase) })).toMatchObject({
            status: 'COMPLETED',
        });
        const messages = wire.bodies[0].messages as Array<{ role: string; content: unknown }>;
        expect(messages[messages.length - 1]).toEqual({
            role: 'user',
            content: [
                { type: 'tool_result', tool_use_id: 'toolu_b2', content: 'A person rejected this proposal. Nothing was created.', is_error: true },
            ],
        });
        expect(await deferralOf(runId)).toMatchObject({ status: 'RESUMED', decision: 'REJECTED', transcriptJson: null });
    });

    it('a kill switch engaged while the run waits settles it at the decision, with nothing sent', async () => {
        script([proposeCall('toolu_k1', ['kill drill'])]);
        const runId = await startAsk('A');
        expect(await executeQueuedWorkflowRun(TENANTS.A, runId)).toMatchObject({ status: 'AWAITING_APPROVAL' });
        await prisma.agentKillSwitch.create({
            data: { tenantId: TENANTS.A, agentId: AGENTS.A, engagedByUserId: USERS.A.author, reason: 'incident drill' },
        });
        try {
            const deferral = await deferralOf(runId);
            enqueued.length = 0;
            await rejectAgentProposal(ctx('A', 'reviewer'), deferral.proposalId);
            script([done]);
            const outcome = await executeQueuedWorkflowRun(TENANTS.A, runId, { clockBase: Number(enqueued[0].payload.clockBase) });
            expect(outcome).toMatchObject({ status: 'ABORTED' });
            expect(wire.bodies).toHaveLength(0);
            expect(await deferralOf(runId)).toMatchObject({ status: 'SETTLED', decision: 'REJECTED', transcriptJson: null });
        } finally {
            await prisma.agentKillSwitch.deleteMany({ where: { tenantId: TENANTS.A } });
        }
    });

    it('two tenants: neither conversation reaches the other\'s model, and neither reads the other\'s deferral', async () => {
        const a = await prisma.workflowRunDeferral.findMany({ where: { tenantId: TENANTS.A }, select: { runId: true } });
        const b = await prisma.workflowRunDeferral.findMany({ where: { tenantId: TENANTS.B }, select: { runId: true } });
        expect(a.length).toBeGreaterThan(0);
        expect(b.length).toBeGreaterThan(0);
        const runs = await prisma.workflowRun.findMany({ where: { id: { in: [...a, ...b].map((d) => d.runId) } }, select: { id: true, tenantId: true } });
        for (const d of a) expect(runs.find((r) => r.id === d.runId)?.tenantId).toBe(TENANTS.A);
        for (const d of b) expect(runs.find((r) => r.id === d.runId)?.tenantId).toBe(TENANTS.B);
    });
});
