/**
 * CONTEXT COMPACTION ON THE TOOL RUNNER ENGINE, END TO END (Step 2g, #5531).
 *
 * Real database, real usecases, admission, resolver, funnel, ledger and
 * Art 12 writer, the worker's own body; the model is a fake `fetch` answering
 * Anthropic's Messages API. Two tenants, each running a Test run of its own
 * agent's profile version:
 *
 *   • A's version lowers the threshold to 10,000 tokens, and its first tool
 *     round reports 12,000: the run summarises once. Every original step stays
 *     in the ledger, the compaction is ONE added MODEL_CALL step naming the
 *     digests before and after, and every model call, the summary's included,
 *     has its Art 12 row under the digest its step names;
 *   • B's version turns compaction off, and the same round compacts nothing;
 *   • neither tenant's summary reaches the other's model (the two-tenant cell).
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
jest.mock('@/app-layer/jobs/queue', () => ({
    ...jest.requireActual('@/app-layer/jobs/queue'),
    enqueue: jest.fn(async () => undefined),
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
import type { AgentProfileVersionInput } from '@/app-layer/schemas/agent-profile.schemas';
import type { RequestContext } from '@/app-layer/types';
import { RUN_STATE_OPEN, RUN_SUMMARY_OPEN } from '@/lib/agentic/tool-runner/compaction';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }), transactionOptions: TENANT_TX_OPTIONS });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(120_000);

const SUITE = `trcmp-${randomUUID().slice(0, 8)}`;
const TENANTS = { A: `ta-${SUITE}`, B: `tb-${SUITE}` } as const;
const USERS = {
    A: { author: `ua-author-${SUITE}`, reviewer: `ua-reviewer-${SUITE}` },
    B: { author: `ub-author-${SUITE}`, reviewer: `ub-reviewer-${SUITE}` },
} as const;
const AGENTS = { A: `ag-a-${SUITE}`, B: `ag-b-${SUITE}` } as const;
const SUMMARY = { A: 'Summary for A: the aquamarine register was read.', B: 'Summary for B: the vermilion register was read.' } as const;

type Tenant = keyof typeof TENANTS;
const ctx = (t: Tenant, who: 'author' | 'reviewer'): RequestContext =>
    makeRequestContext(who === 'author' ? 'OWNER' : 'ADMIN', { tenantId: TENANTS[t], tenantSlug: TENANTS[t], userId: USERS[t][who] });

const version = (t: Tenant): AgentProfileVersionInput => ({
    instructions: 'Answer questions about the open risks.',
    toolNames: ['list_risks'],
    skillRefs: [],
    modelTier: 'balanced',
    effort: 'medium',
    maxTurns: 10,
    // A lowers the engine's threshold; B turns compaction off.
    compactionThresholdTokens: t === 'A' ? 10_000 : 0,
    outputKind: 'ANSWER_ONLY',
    allowedTriggers: ['TEST_RUN'],
});

// ─── The fake model ─────────────────────────────────────────────────

const wire = { bodies: [] as Array<Record<string, unknown>> };
const originalFetch = global.fetch;

/** A big tool round, the summary (when one is asked for), and the answer. */
function installFakeModel(t: Tenant): void {
    wire.bodies = [];
    global.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const n = wire.bodies.length;
        wire.bodies.push(body);
        const isSummary = JSON.stringify(body.tool_choice) === '{"type":"none"}';
        const answer =
            n === 0
                ? {
                      content: [{ type: 'tool_use', id: 'toolu_round_0', name: 'list_risks', input: {} }],
                      stop_reason: 'tool_use',
                      usage: { input_tokens: 12_000, output_tokens: 5 },
                  }
                : isSummary
                  ? { content: [{ type: 'text', text: SUMMARY[t] }], stop_reason: 'end_turn', usage: { input_tokens: 12_100, output_tokens: 20 } }
                  : { content: [{ type: 'text', text: 'No open risk.' }], stop_reason: 'end_turn', usage: { input_tokens: 500, output_tokens: 5 } };
        return new Response(
            JSON.stringify({ id: `msg_${n}`, type: 'message', role: 'assistant', model: String(body.model), stop_sequence: null, ...answer }),
            { status: 200, headers: { 'content-type': 'application/json' } },
        );
    }) as typeof fetch;
}

async function cleanup(): Promise<void> {
    const tenants = Object.values(TENANTS);
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

async function runTenant(t: Tenant): Promise<{ runId: string; bodies: Array<Record<string, unknown>> }> {
    installFakeModel(t);
    const started = await startAgentProfileTestRun(ctx(t, 'reviewer'), AGENTS[t], 1);
    expect(await executeQueuedWorkflowRun(TENANTS[t], started.runId)).toMatchObject({ status: 'COMPLETED' });
    return { runId: started.runId, bodies: [...wire.bodies] };
}

describeFn('context compaction on the Tool Runner engine (real DB, fake model)', () => {
    const runs: Partial<Record<Tenant, { runId: string; bodies: Array<Record<string, unknown>> }>> = {};

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
            await prisma.registeredAgentTool.create({ data: { tenantId, agentId: AGENTS[t], toolName: 'list_risks', grantedByUserId: USERS[t].author } });
            await prisma.tenantSecuritySettings.create({ data: { tenantId, agentDriver: 'TOOL_RUNNER' } });
            await createAgentProfile(ctx(t, 'author'), AGENTS[t], version(t));
            await submitAgentProfileVersion(ctx(t, 'author'), AGENTS[t], 1);
        }
        runs.A = await runTenant('A');
        runs.B = await runTenant('B');
    });

    afterAll(async () => {
        global.fetch = originalFetch;
        await cleanup();
        await prisma.$disconnect();
    });

    it('a version below its threshold summarises once, and the request after it is rebuilt by code', () => {
        const { bodies } = runs.A!;
        expect(bodies).toHaveLength(3);
        expect(bodies[1].tool_choice).toEqual({ type: 'none' });
        const next = JSON.stringify(bodies[2].messages);
        expect(next).toContain(RUN_STATE_OPEN.replace(/"/g, '\\"'));
        expect(next).toContain(RUN_SUMMARY_OPEN.replace(/"/g, '\\"'));
        expect(next).toContain(SUMMARY.A);
    });

    it('every original step stays in the ledger; the compaction is one added MODEL_CALL naming the digests before and after', async () => {
        const { runId } = runs.A!;
        const steps = await runInTenantContext(ctx('A', 'reviewer'), (db) =>
            db.workflowStep.findMany({
                where: { runId },
                orderBy: { seq: 'asc' },
                select: { seq: true, kind: true, toolCalled: true, status: true, inputJson: true, outputJson: true },
            }),
        );
        expect(steps.map((s) => [s.seq, s.kind, s.toolCalled, s.status])).toEqual([
            [0, 'MODEL_CALL', null, 'DONE'],
            [1, 'TOOL_CALL', 'list_risks', 'DONE'],
            [2, 'MODEL_CALL', null, 'DONE'],
            [3, 'MODEL_CALL', null, 'DONE'],
        ]);
        const input = steps.map((s) => JSON.parse(s.inputJson ?? '{}') as Record<string, unknown>);
        expect(input[2].purpose).toBe('compaction');
        expect(input[2].compactedFromDigest).toBe(input[0].decisionDigest);
        expect(JSON.parse(steps[2].outputJson ?? '{}').compactedToDigest).toBe(input[3].decisionDigest);
        // The summary's text is in no step.
        expect(JSON.stringify(steps)).not.toContain(SUMMARY.A);

        // Every model call, the summary's included, has its Art 12 row under the digest its step names.
        const rows = await prisma.aiDecisionLog.findMany({ where: { tenantId: TENANTS.A, sessionRef: runId }, select: { inputDigest: true } });
        expect(rows.map((r) => r.inputDigest).sort()).toEqual([input[0], input[2], input[3]].map((i) => String(i.decisionDigest)).sort());

        // The run's tokens: every call's, the summary's 12,120 included.
        const run = await prisma.workflowRun.findUniqueOrThrow({ where: { id: runId }, select: { costTokens: true, stepCount: true } });
        expect(run.costTokens).toBe(12_005 + 12_120 + 505);
        expect(run.stepCount).toBe(4);
    });

    it('a version that turned compaction off is never summarised', async () => {
        expect(runs.B!.bodies).toHaveLength(2);
        expect(runs.B!.bodies.some((b) => JSON.stringify(b.tool_choice) === '{"type":"none"}')).toBe(false);
        const kinds = await prisma.workflowStep.findMany({ where: { runId: runs.B!.runId }, orderBy: { seq: 'asc' }, select: { kind: true } });
        expect(kinds.map((k) => k.kind)).toEqual(['MODEL_CALL', 'TOOL_CALL', 'MODEL_CALL']);
    });

    it('two tenants: neither summary reaches the other\'s model, and neither ledger holds the other\'s rows', async () => {
        expect(JSON.stringify(runs.B!.bodies)).not.toContain(SUMMARY.A);
        expect(JSON.stringify(runs.A!.bodies)).not.toContain(SUMMARY.B);
        const crossed = await prisma.workflowStep.count({
            where: {
                OR: [
                    { runId: runs.A!.runId, tenantId: { not: TENANTS.A } },
                    { runId: runs.B!.runId, tenantId: { not: TENANTS.B } },
                ],
            },
        });
        expect(crossed).toBe(0);
    });
});
