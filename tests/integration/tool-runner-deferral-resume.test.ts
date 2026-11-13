/**
 * A RUN PARKED ON A DEFERRED CALL RESUMES FROM ITS OWN TRANSCRIPT (Step 2f,
 * deploy 1, #5530).
 *
 * Real database, the queue's own decision usecase, the decision hook, the
 * worker's body and the Tool Runner engine; the model is a fake `fetch`
 * answering Anthropic's Messages API. Each tenant's run is parked the way the
 * engine's park writes it (deploy 1 has no writer), then decided in the queue:
 *
 *   • A's proposal is REJECTED through `rejectAgentProposal`. The resumed
 *     request's `system`, `tools`, `model` and every earlier message, its
 *     thinking block and signature included, are byte for byte the transcript;
 *     the decision reaches the model as an error result naming no reason; a tool
 *     withdrawn during the wait is refused at the resume, and a tool granted
 *     during it is not offered; the run COMPLETES although it started three
 *     hours ago, because its clock starts at the unattended time it had spent
 *     when it parked; and the transcript is cleared while its hash is kept.
 *   • B's proposal is APPROVED: the model reads the record it created.
 *   • Neither tenant's transcript reaches the other's model.
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
import { executeQueuedWorkflowRun } from '@/app-layer/usecases/workflow-runs';
import { runInTenantContext } from '@/lib/db-context';
import { createAgentProfile, startAgentProfileTestRun, submitAgentProfileVersion } from '@/app-layer/usecases/agent-profiles';
import { rejectAgentProposal } from '@/app-layer/usecases/agent-proposals';
import { settleDeferralForProposal } from '@/app-layer/usecases/workflow-run-deferrals';
import type { AgentProfileVersionInput } from '@/app-layer/schemas/agent-profile.schemas';
import type { RequestContext } from '@/app-layer/types';
import { sealTranscript, TRANSCRIPT_FORMAT, type DeferralTranscript } from '@/lib/agentic/tool-runner/transcript';
import { toolRunnerModelFor } from '@/lib/agentic/tool-runner/client';
import { TOOL_WITHDRAWN_DURING_WAIT } from '@/lib/agentic/tool-runner/tools';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }), transactionOptions: TENANT_TX_OPTIONS });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(120_000);

const SUITE = `trdef-${randomUUID().slice(0, 8)}`;
const TENANTS = { A: `ta-${SUITE}`, B: `tb-${SUITE}` } as const;
const USERS = {
    A: { author: `ua-author-${SUITE}`, reviewer: `ua-reviewer-${SUITE}` },
    B: { author: `ub-author-${SUITE}`, reviewer: `ub-reviewer-${SUITE}` },
} as const;
const AGENTS = { A: `ag-a-${SUITE}`, B: `ag-b-${SUITE}` } as const;
const MARK = { A: 'aquamarine-register-row', B: 'vermilion-register-row' } as const;

type Tenant = keyof typeof TENANTS;
const ctx = (t: Tenant, who: 'author' | 'reviewer'): RequestContext =>
    makeRequestContext(who === 'author' ? 'OWNER' : 'ADMIN', { tenantId: TENANTS[t], tenantSlug: TENANTS[t], userId: USERS[t][who] });

const version = (): AgentProfileVersionInput => ({
    instructions: 'Answer questions about the open risks.',
    // list_controls is granted and in the version, but not in the parked
    // transcript: it stands for a tool granted while the run waited.
    toolNames: ['list_controls', 'list_risks'],
    skillRefs: [],
    modelTier: 'balanced',
    effort: 'medium',
    maxTurns: 10,
    outputKind: 'ANSWER_ONLY',
    allowedTriggers: ['TEST_RUN'],
});

// ─── The parked conversation ────────────────────────────────────────

const TOOL_USE = 'toolu_deferred_0';
function parkedTranscript(t: Tenant): DeferralTranscript {
    return {
        format: TRANSCRIPT_FORMAT,
        model: toolRunnerModelFor('balanced'),
        system: [{ type: 'text', text: `Inflect system for ${t}.`, cache_control: { type: 'ephemeral' } }],
        tools: [
            { type: 'custom', name: 'list_risks', description: 'List risks.', input_schema: { type: 'object', properties: {} } },
            // Held when the run parked, withdrawn while it waited.
            { type: 'custom', name: 'list_assets', description: 'List assets.', input_schema: { type: 'object', properties: {} } },
        ],
        messages: [
            { role: 'user', content: 'What is open?' },
            {
                role: 'assistant',
                content: [
                    { type: 'thinking', thinking: `Read ${MARK[t]} first.`, signature: `sig-${t}-Zm9vYmFy` },
                    { type: 'text', text: 'I will propose a risk.' },
                    { type: 'tool_use', id: TOOL_USE, name: 'propose_risks', input: { items: [{ title: MARK[t] }] } },
                ],
            },
        ],
        pendingResults: [{ type: 'tool_result', tool_use_id: TOOL_USE, content: '' }],
        toolUseId: TOOL_USE,
    } as unknown as DeferralTranscript;
}

/** Park the started run on one proposal, as the engine's park writes it. */
async function park(t: Tenant, runId: string): Promise<{ proposalId: string; deferralId: string; hash: string; transcript: DeferralTranscript }> {
    const tenantId = TENANTS[t];
    const proposalId = `prop-${SUITE}-${t}`;
    await prisma.workflowRun.update({
        where: { id: runId },
        data: {
            status: 'AWAITING_APPROVAL',
            stepCount: 2,
            approvalExpiresAt: new Date(Date.now() + 86_400_000),
            // Three hours ago: a clock measured from the start would halt the resume at RUNTIME_MS.
            startedAt: new Date(Date.now() - 3 * 3_600_000),
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
            agentId: AGENTS[t],
            kind: 'RISK',
            payloadJson: '{}',
            status: 'PENDING',
            runId,
            stepSeq: 0,
            expiresAt: new Date(Date.now() + 86_400_000),
        },
    });
    const transcript = parkedTranscript(t);
    const sealed = sealTranscript(transcript);
    const row = await runInTenantContext(ctx(t, 'reviewer'), (db) =>
        db.workflowRunDeferral.create({
            data: {
                tenantId,
                runId,
                stepSeq: 0,
                toolUseId: TOOL_USE,
                toolCalled: 'propose_risks',
                proposalId,
                transcriptJson: sealed.json,
                transcriptHash: sealed.hash,
                model: transcript.model,
                elapsedMsAtPark: 4_000,
            },
        }),
    );
    return { proposalId, deferralId: row.id, hash: sealed.hash, transcript };
}

// ─── The fake model ─────────────────────────────────────────────────

const wire = { bodies: [] as Array<Record<string, unknown>> };
const originalFetch = global.fetch;

/** First the withdrawn tool, then the answer. */
function installFakeModel(): void {
    wire.bodies = [];
    global.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const n = wire.bodies.length;
        wire.bodies.push(body);
        const answer =
            n === 0
                ? {
                      content: [{ type: 'tool_use', id: 'toolu_after_0', name: 'list_assets', input: {} }],
                      stop_reason: 'tool_use',
                      usage: { input_tokens: 400, output_tokens: 5 },
                  }
                : { content: [{ type: 'text', text: 'Done.' }], stop_reason: 'end_turn', usage: { input_tokens: 500, output_tokens: 5 } };
        return new Response(
            JSON.stringify({ id: `msg_${n}`, type: 'message', role: 'assistant', model: String(body.model), stop_sequence: null, ...answer }),
            { status: 200, headers: { 'content-type': 'application/json' } },
        );
    }) as typeof fetch;
}

async function cleanup(): Promise<void> {
    const tenants = Object.values(TENANTS);
    await prisma.workflowRunDeferral.deleteMany({ where: { tenantId: { in: tenants } } });
    await prisma.agentProposal.deleteMany({ where: { tenantId: { in: tenants } } });
    await prisma.workflowStep.deleteMany({ where: { tenantId: { in: tenants } } });
    await prisma.aiDecisionLog.deleteMany({ where: { tenantId: { in: tenants } } });
    await prisma.workflowRun.deleteMany({ where: { tenantId: { in: tenants } } });
    await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        for (const table of ['AgentProfileVersion', 'AgentProfile', 'TenantMembership']) {
            await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "tenantId" = ANY($1::text[])`, tenants);
        }
    });
    await prisma.registeredAgentTool.deleteMany({ where: { tenantId: { in: tenants } } });
    await prisma.registeredAgent.deleteMany({ where: { tenantId: { in: tenants } } });
    await prisma.aiSystem.deleteMany({ where: { tenantId: { in: tenants } } });
    await prisma.tenantSecuritySettings.deleteMany({ where: { tenantId: { in: tenants } } });
    await deleteAuditRowsForTenants(prisma, tenants);
    await prisma.user.deleteMany({ where: { id: { in: [USERS.A.author, USERS.A.reviewer, USERS.B.author, USERS.B.reviewer] } } });
    await prisma.tenant.deleteMany({ where: { id: { in: tenants } } });
}

interface Resumed {
    runId: string;
    deferralId: string;
    hash: string;
    transcript: DeferralTranscript;
    bodies: Array<Record<string, unknown>>;
    status: unknown;
}

describeFn('a parked Tool Runner run resumes from its transcript once a person decides (real DB, fake model)', () => {
    const runs: Partial<Record<Tenant, Resumed>> = {};

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
            const sys = await prisma.aiSystem.create({ data: { tenantId, name: `sys-${AGENTS[t]}` } });
            await prisma.registeredAgent.create({
                data: {
                    id: AGENTS[t],
                    tenantId,
                    aiSystemId: sys.id,
                    name: `agent ${AGENTS[t]}`,
                    autonomyLevel: 1,
                    dataAccessScope: 'READ_TENANT_DATA',
                    reversibility: 'REVERSIBLE',
                    provenance: 'FIRST_PARTY',
                    ownerUserId: USERS[t].author,
                    status: 'ACTIVE',
                    riskTier: 'LOW',
                    riskTierScoredAt: new Date(),
                },
            });
            for (const toolName of ['list_risks', 'list_controls']) {
                await prisma.registeredAgentTool.create({ data: { tenantId, agentId: AGENTS[t], toolName, grantedByUserId: USERS[t].author } });
            }
            await prisma.tenantSecuritySettings.create({ data: { tenantId, agentDriver: 'TOOL_RUNNER' } });
            await createAgentProfile(ctx(t, 'author'), AGENTS[t], version());
            await submitAgentProfileVersion(ctx(t, 'author'), AGENTS[t], 1);
        }

        for (const t of ['A', 'B'] as const) {
            const started = await startAgentProfileTestRun(ctx(t, 'reviewer'), AGENTS[t], 1);
            const parked = await park(t, started.runId);
            enqueued.length = 0;
            if (t === 'A') {
                // Decided in the queue, by its own usecase.
                await rejectAgentProposal(ctx(t, 'reviewer'), parked.proposalId);
            } else {
                // An approval: the queue's row records the record it created.
                await prisma.agentProposal.update({
                    where: { id: parked.proposalId },
                    data: { status: 'ACCEPTED', reviewedByUserId: USERS[t].reviewer, reviewedAt: new Date(), createdEntityId: `risk-${SUITE}` },
                });
                expect(await settleDeferralForProposal(ctx(t, 'reviewer'), parked.proposalId)).toBe('RESUMING');
            }
            expect(enqueued).toHaveLength(1);
            installFakeModel();
            // NO clock base: a retry, or a payload from a build that sent none.
            // The engine's clock comes from the deferral, not from the run's start.
            const outcome = await executeQueuedWorkflowRun(TENANTS[t], started.runId);
            runs[t] = { runId: started.runId, ...parked, bodies: [...wire.bodies], status: outcome };
        }
    });

    afterAll(async () => {
        global.fetch = originalFetch;
        await cleanup();
        await prisma.$disconnect();
    });

    it('completes, its clock starting at the time it had spent when it parked, not at its start three hours ago', () => {
        expect(runs.A!.status).toMatchObject({ status: 'COMPLETED' });
        expect(runs.B!.status).toMatchObject({ status: 'COMPLETED' });
    });

    it('the resumed request sends the stored system, tools, model and messages byte for byte, thinking block included', () => {
        const { bodies, transcript } = runs.A!;
        const first = bodies[0];
        expect(JSON.stringify(first.system)).toBe(JSON.stringify(transcript.system));
        expect(JSON.stringify(first.tools)).toBe(JSON.stringify(transcript.tools));
        expect(first.model).toBe(transcript.model);
        const messages = first.messages as unknown[];
        expect(JSON.stringify(messages.slice(0, transcript.messages.length))).toBe(JSON.stringify(transcript.messages));
        expect(first.thread).toBeUndefined();
    });

    it('a rejection reaches the model as an error result naming no reason, from the proposal row', () => {
        const messages = runs.A!.bodies[0].messages as Array<{ role: string; content: unknown }>;
        expect(messages[messages.length - 1]).toEqual({
            role: 'user',
            content: [
                {
                    type: 'tool_result',
                    tool_use_id: TOOL_USE,
                    content: 'A person rejected this proposal. Nothing was created.',
                    is_error: true,
                },
            ],
        });
    });

    it('an approval reaches the model naming the record it created', () => {
        const messages = runs.B!.bodies[0].messages as Array<{ role: string; content: Array<{ content: string }> }>;
        expect(messages[messages.length - 1].content[0].content).toBe(
            `A person approved this proposal. It was created as RISK risk-${SUITE}.`,
        );
    });

    it('authority only narrows across the wait: a withdrawn tool is refused at the resume, a granted one is not offered', async () => {
        const names = (runs.A!.bodies[0].tools as Array<{ name: string }>).map((t) => t.name);
        expect(names).toEqual(['list_risks', 'list_assets']);
        expect(names).not.toContain('list_controls');
        const steps = await prisma.workflowStep.findMany({
            where: { runId: runs.A!.runId },
            orderBy: { seq: 'asc' },
            select: { seq: true, kind: true, toolCalled: true, status: true },
        });
        expect(steps.map((s) => [s.seq, s.kind, s.toolCalled, s.status])).toEqual([
            [0, 'TOOL_CALL', 'propose_risks', 'DONE'],
            [1, 'HUMAN_CHECKPOINT', null, 'DONE'],
            [2, 'MODEL_CALL', null, 'DONE'],
            [3, 'TOOL_CALL', 'list_assets', 'FAILED'],
            [4, 'MODEL_CALL', null, 'DONE'],
        ]);
        const refused = await runInTenantContext(ctx('A', 'reviewer'), (db) =>
            db.workflowStep.findFirstOrThrow({ where: { runId: runs.A!.runId, seq: 3 }, select: { outputJson: true } }),
        );
        expect(JSON.parse(refused.outputJson ?? '{}')).toEqual({ refused: TOOL_WITHDRAWN_DURING_WAIT });
    });

    it('the transcript is cleared once the run resumed, and its hash is kept', async () => {
        for (const t of ['A', 'B'] as const) {
            const d = await prisma.workflowRunDeferral.findUniqueOrThrow({ where: { id: runs[t]!.deferralId } });
            expect(d).toMatchObject({ status: 'RESUMED', transcriptJson: null, transcriptHash: runs[t]!.hash });
            expect(d.resumedAt).not.toBeNull();
        }
    });

    it('two tenants: neither transcript reaches the other\'s model', () => {
        expect(JSON.stringify(runs.A!.bodies)).not.toContain(MARK.B);
        expect(JSON.stringify(runs.B!.bodies)).not.toContain(MARK.A);
        expect(JSON.stringify(runs.A!.bodies)).toContain(MARK.A);
    });
});
