/**
 * INLINE SUB-AGENTS ON THE TOOL RUNNER ENGINE, END TO END (Step 2e, #4594).
 *
 * Real database, real usecases, real admission, resolver, funnel and ledger,
 * the worker's own body; the model is a fake `fetch` answering Anthropic's
 * Messages API. Two tenants, each running a Test run of its own agent's
 * profile version, which defines one sub-agent:
 *
 *   • the delegation runs the child under its own instructions and subset, and
 *     every child call is in the ledger UNDER THE PARENT RUN, labelled with the
 *     sub-agent, in its column and in the hash-chained audit row;
 *   • the marker closes the span, carrying neither the task nor the answer;
 *   • neither tenant's sub-agent text reaches the other's model, and neither
 *     run's ledger holds the other tenant's rows (the two-tenant cell).
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
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }), transactionOptions: TENANT_TX_OPTIONS });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(120_000);

const SUITE = `trsub-${randomUUID().slice(0, 8)}`;
const TENANTS = { A: `ta-${SUITE}`, B: `tb-${SUITE}` } as const;
const USERS = {
    A: { author: `ua-author-${SUITE}`, reviewer: `ua-reviewer-${SUITE}` },
    B: { author: `ub-author-${SUITE}`, reviewer: `ub-reviewer-${SUITE}` },
} as const;
const AGENTS = { A: `ag-a-${SUITE}`, B: `ag-b-${SUITE}` } as const;
/** Each tenant's sub-agent text, marked so its absence from the other's requests can be checked. */
const MARKER = { A: 'Mention the aquamarine register.', B: 'Mention the vermilion register.' } as const;
const TASK = 'List the open risks for the quarterly review, with each owner.';
const CHILD_ANSWER = 'Risk one is owned by the platform team, per the register.';

type Tenant = keyof typeof TENANTS;
const ctx = (t: Tenant, who: 'author' | 'reviewer'): RequestContext =>
    makeRequestContext(who === 'author' ? 'OWNER' : 'ADMIN', { tenantId: TENANTS[t], tenantSlug: TENANTS[t], userId: USERS[t][who] });

const version = (t: Tenant): AgentProfileVersionInput => ({
    instructions: 'Answer questions about the open risks. Delegate the reading to risk_reader.',
    toolNames: ['list_risks', 'list_controls'],
    skillRefs: [],
    modelTier: 'balanced',
    effort: 'medium',
    maxTurns: 10,
    outputKind: 'ANSWER_ONLY',
    allowedTriggers: ['TEST_RUN'],
    subagents: [
        {
            name: 'risk_reader',
            instructions: `Read the open risks with list_risks and name each owner. ${MARKER[t]}`,
            toolNames: ['list_risks'],
            skillRefs: [],
            maxTurns: 3,
        },
    ],
});

// ─── The fake model ─────────────────────────────────────────────────

const wire = { bodies: [] as Array<Record<string, unknown>> };
const originalFetch = global.fetch;
const SCRIPT = [
    { content: [{ type: 'tool_use', id: 'toolu_parent_0', name: 'delegate', input: { subagent: 'risk_reader', task: TASK } }], stop_reason: 'tool_use' },
    { content: [{ type: 'tool_use', id: 'toolu_child_0', name: 'list_risks', input: {} }], stop_reason: 'tool_use' },
    { content: [{ type: 'text', text: CHILD_ANSWER }], stop_reason: 'end_turn' },
    { content: [{ type: 'text', text: 'The platform team owns the one open risk.' }], stop_reason: 'end_turn' },
];

function installFakeModel(): void {
    wire.bodies = [];
    global.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const n = wire.bodies.length;
        wire.bodies.push(body);
        return new Response(
            JSON.stringify({
                id: `msg_${n}`,
                type: 'message',
                role: 'assistant',
                model: String(body.model),
                stop_sequence: null,
                usage: { input_tokens: 10, output_tokens: 5 },
                ...(SCRIPT[n] ?? SCRIPT[3]),
            }),
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

/** Run one tenant's Test run to its end; returns the run id and the requests its model received. */
async function runTenant(t: Tenant): Promise<{ runId: string; bodies: Array<Record<string, unknown>> }> {
    installFakeModel();
    const started = await startAgentProfileTestRun(ctx(t, 'reviewer'), AGENTS[t], 1);
    expect(await executeQueuedWorkflowRun(TENANTS[t], started.runId)).toMatchObject({ status: 'COMPLETED' });
    return { runId: started.runId, bodies: [...wire.bodies] };
}

describeFn('inline sub-agents on the Tool Runner engine (real DB, fake model)', () => {
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
            for (const toolName of ['list_risks', 'list_controls']) {
                await prisma.registeredAgentTool.create({ data: { tenantId, agentId: AGENTS[t], toolName, grantedByUserId: USERS[t].author } });
            }
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

    it('runs the child under its own instructions and subset, and the parent reads its answer', () => {
        const { bodies } = runs.B!;
        expect(bodies).toHaveLength(4);
        const toolsOf = (b: Record<string, unknown>) => ((b.tools ?? []) as Array<{ name: string }>).map((x) => x.name).sort();
        expect(toolsOf(bodies[0])).toEqual(['delegate', 'list_controls', 'list_risks']);
        expect(toolsOf(bodies[1])).toEqual(['list_risks']);
        const childSystem = ((bodies[1].system ?? []) as Array<{ text: string }>).map((b) => b.text).join('\n');
        expect(childSystem).toContain(MARKER.B);
        // Nothing of the child's text reaches the parent's requests.
        expect(JSON.stringify(bodies[0])).not.toContain(MARKER.B);
        expect(JSON.stringify(bodies[1].messages)).toContain(TASK);
        // The parent's last request carries the child's answer, fenced.
        expect(JSON.stringify(bodies[3].messages)).toContain('<subagent_answer name=\\"risk_reader\\">');
    });

    it('every child call is in the ledger under the parent run, labelled with the sub-agent, in the column and the audit row', async () => {
        const { runId } = runs.B!;
        const steps = await prisma.workflowStep.findMany({
            where: { runId },
            orderBy: { seq: 'asc' },
            select: { seq: true, kind: true, toolCalled: true, status: true, subagentName: true, tenantId: true },
        });
        expect(steps.map((s) => [s.seq, s.kind, s.toolCalled, s.subagentName])).toEqual([
            [0, 'MODEL_CALL', null, null],
            [1, 'MODEL_CALL', null, 'risk_reader'],
            [2, 'TOOL_CALL', 'list_risks', 'risk_reader'],
            [3, 'MODEL_CALL', null, 'risk_reader'],
            [4, 'TOOL_CALL', 'delegate', null],
            [5, 'MODEL_CALL', null, null],
        ]);
        expect(steps.every((s) => s.tenantId === TENANTS.B && s.status === 'DONE')).toBe(true);
        // Read back decrypted, through the tenant's own context: the marker
        // carries the span, never the task or the answer.
        const decrypted = await runInTenantContext(ctx('B', 'reviewer'), (db) =>
            db.workflowStep.findMany({ where: { runId }, orderBy: { seq: 'asc' }, select: { inputJson: true, outputJson: true } }),
        );
        expect(JSON.parse(decrypted[4].inputJson ?? '{}')).toMatchObject({ agent: 'risk_reader', taskId: 'toolu_parent_0', fromSeq: 0 });
        expect(JSON.stringify(decrypted)).toContain('risk_reader');
        expect(JSON.stringify(decrypted)).not.toContain(TASK);
        expect(JSON.stringify(decrypted)).not.toContain(CHILD_ANSWER);

        const audit = await prisma.auditLog.findMany({
            where: { tenantId: TENANTS.B, action: 'WORKFLOW_STEP', entityId: { startsWith: `${runId}:` } },
            select: { entityId: true, detailsJson: true },
        });
        const subagentOf = new Map(audit.map((a) => [a.entityId, (a.detailsJson as { subagent?: unknown }).subagent]));
        expect([0, 1, 2, 3, 4, 5].map((seq) => subagentOf.get(`${runId}:${seq}`))).toEqual([
            null,
            'risk_reader',
            'risk_reader',
            'risk_reader',
            null,
            null,
        ]);

        // The run's step count covers the child's steps.
        const run = await prisma.workflowRun.findUniqueOrThrow({ where: { id: runId }, select: { stepCount: true } });
        expect(run.stepCount).toBe(6);
    });

    it('two tenants: neither sub-agent\'s text reaches the other\'s model, and neither ledger holds the other\'s rows', async () => {
        expect(JSON.stringify(runs.A!.bodies)).toContain(MARKER.A);
        expect(JSON.stringify(runs.A!.bodies)).not.toContain(MARKER.B);
        expect(JSON.stringify(runs.B!.bodies)).not.toContain(MARKER.A);
        const crossed = await prisma.workflowStep.count({
            where: {
                OR: [
                    { runId: runs.A!.runId, tenantId: { not: TENANTS.A } },
                    { runId: runs.B!.runId, tenantId: { not: TENANTS.B } },
                ],
            },
        });
        expect(crossed).toBe(0);
        expect(await prisma.workflowStep.count({ where: { runId: runs.A!.runId, subagentName: 'risk_reader' } })).toBe(3);
    });
});
