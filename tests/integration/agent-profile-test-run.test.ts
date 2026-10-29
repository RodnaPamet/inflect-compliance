/**
 * A TEST RUN OF AN AGENT PROFILE, END TO END ON THE TOOL RUNNER (Step 2c, #4150).
 *
 * The owner chose to prove completion here rather than in the browser
 * (decision of 2026-10-29 on #4150): the E2E harness has no model and no
 * worker. Everything below is real but the model, which is a fake `fetch`
 * answering Anthropic's Messages API:
 *
 *   • the Test-run usecase starts the run, as the agent, from a person's context;
 *   • admission runs for real (the version, its trigger, the engine, the
 *     agent's standing) and writes the run row with its pinned version;
 *   • the worker's own body, `executeQueuedWorkflowRun`, rebuilds the
 *     definition from the PIN, picks the Tool Runner engine through the real
 *     gate, and runs it: one model call asks for `list_risks`, the funnel runs
 *     it, a second model call answers.
 *
 * What the cells hold: the run COMPLETES; it records MODEL_CALL and TOOL_CALL
 * steps; it is READ-ONLY — no proposal rows, and the model was offered no
 * propose tool, although the profile's own output kind would allow proposals;
 * the instructions went to the model; and every way the start should refuse
 * does, by name.
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
const enqueued: unknown[][] = [];
jest.mock('@/app-layer/jobs/queue', () => ({
    ...jest.requireActual('@/app-layer/jobs/queue'),
    enqueue: jest.fn(async (...a: unknown[]) => {
        enqueued.push(a);
    }),
}));

import { PrismaClient, type Role } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { createTenantWithDek } from '@/lib/security/tenant-key-manager';
import { executeQueuedWorkflowRun, startWorkflowRun } from '@/app-layer/usecases/workflow-runs';
import {
    createAgentProfile,
    getAgentProfile,
    startAgentProfileTestRun,
    submitAgentProfileVersion,
} from '@/app-layer/usecases/agent-profiles';
import type { AgentProfileVersionInput } from '@/app-layer/schemas/agent-profile.schemas';
import { profileRunKey } from '@/lib/agentic/agent-profile';
import type { RequestContext } from '@/app-layer/types';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }), transactionOptions: TENANT_TX_OPTIONS });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(120_000);

const SUITE = `aptr-${randomUUID().slice(0, 8)}`;
const TENANT = `t-${SUITE}`;
const USERS = { author: `u-author-${SUITE}`, reviewer: `u-reviewer-${SUITE}` };
const AGENTS = { main: `ag-main-${SUITE}`, askOnly: `ag-ask-${SUITE}` };

const INSTRUCTIONS =
    'Summarise the open risks for the weekly review. Call list_risks once, then answer in one sentence.';

const ctxFor = (role: Role, userId: string, over: Partial<RequestContext> = {}): RequestContext =>
    makeRequestContext(role, { tenantId: TENANT, tenantSlug: TENANT, userId, ...over });
const author = () => ctxFor('OWNER', USERS.author);
const reviewer = (over: Partial<RequestContext> = {}) => ctxFor('ADMIN', USERS.reviewer, over);

const version = (over: Partial<AgentProfileVersionInput> = {}): AgentProfileVersionInput => ({
    instructions: INSTRUCTIONS,
    // A propose tool the agent is granted and its rung allows: only the Test
    // run's read-only definition can withhold it from the model.
    toolNames: ['list_risks', 'propose_risks'],
    skillRefs: [],
    modelTier: 'balanced',
    effort: 'medium',
    maxTurns: 10,
    // Would allow proposals in force: the Test run must be read-only anyway.
    outputKind: 'ANSWER_AND_PROPOSALS',
    allowedTriggers: ['TEST_RUN'],
    ...over,
});

async function reasonOf(p: Promise<unknown>): Promise<string> {
    try {
        await p;
    } catch (err) {
        const details = (err as { details?: { reason?: string } }).details;
        return details?.reason ?? (err instanceof Error ? err.message.split(':')[0] : String(err));
    }
    throw new Error('expected a refusal');
}

// ─── The fake model ─────────────────────────────────────────────────

const wire = { bodies: [] as Array<Record<string, unknown>>, urls: [] as string[] };
const SCRIPT: Array<{ content: unknown[]; stop_reason: string }> = [
    { content: [{ type: 'tool_use', id: 'toolu_1', name: 'list_risks', input: {} }], stop_reason: 'tool_use' },
    { content: [{ type: 'text', text: 'There are no open risks to report this week.' }], stop_reason: 'end_turn' },
];
const originalFetch = global.fetch;

function installFakeModel(): void {
    global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const n = wire.bodies.length;
        wire.bodies.push(body);
        wire.urls.push(String(input));
        const answer = SCRIPT[n] ?? SCRIPT[SCRIPT.length - 1];
        return new Response(
            JSON.stringify({
                id: `msg_${n}`,
                type: 'message',
                role: 'assistant',
                model: String(body.model),
                stop_sequence: null,
                usage: { input_tokens: 10, output_tokens: 5 },
                ...answer,
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
        );
    }) as typeof fetch;
}

async function cleanup(): Promise<void> {
    await prisma.workflowStep.deleteMany({ where: { tenantId: TENANT } }).catch(() => {});
    await prisma.agentProposal.deleteMany({ where: { tenantId: TENANT } }).catch(() => {});
    await prisma.aiDecisionLog.deleteMany({ where: { tenantId: TENANT } }).catch(() => {});
    await prisma.workflowRun.deleteMany({ where: { tenantId: TENANT } }).catch(() => {});
    await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        await tx.$executeRawUnsafe(`DELETE FROM "AgentProfileVersion" WHERE "tenantId" = $1`, TENANT);
        await tx.$executeRawUnsafe(`DELETE FROM "AgentProfile" WHERE "tenantId" = $1`, TENANT);
        await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = $1`, TENANT);
    }).catch(() => {});
    await prisma.registeredAgentTool.deleteMany({ where: { tenantId: TENANT } }).catch(() => {});
    await prisma.registeredAgent.deleteMany({ where: { tenantId: TENANT } }).catch(() => {});
    await prisma.aiSystem.deleteMany({ where: { tenantId: TENANT } }).catch(() => {});
    await prisma.tenantSecuritySettings.deleteMany({ where: { tenantId: TENANT } }).catch(() => {});
    await deleteAuditRowsForTenants(prisma, TENANT).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: Object.values(USERS) } } }).catch(() => {});
    await prisma.tenant.deleteMany({ where: { id: TENANT } }).catch(() => {});
}

describeFn('a Test run of an agent profile, on the Tool Runner engine (real DB, fake model)', () => {
    beforeAll(async () => {
        await prisma.$connect();
        await cleanup();
        await createTenantWithDek({ id: TENANT, name: TENANT, slug: TENANT });
        for (const [id, role] of [[USERS.author, 'OWNER'], [USERS.reviewer, 'ADMIN']] as const) {
            const email = `${id}@example.test`;
            await prisma.user.create({ data: { id, email, emailHash: hashForLookup(email) } });
            await prisma.tenantMembership.create({ data: { tenantId: TENANT, userId: id, role, status: 'ACTIVE' } });
        }
        for (const id of Object.values(AGENTS)) {
            const sys = await prisma.aiSystem.create({ data: { tenantId: TENANT, name: `sys-${id}` } });
            await prisma.registeredAgent.create({
                data: {
                    id,
                    tenantId: TENANT,
                    aiSystemId: sys.id,
                    name: `agent ${id}`,
                    // Rung 2, where a propose tool is within the agent's reach.
                    autonomyLevel: 2,
                    dataAccessScope: 'READ_TENANT_DATA',
                    reversibility: 'REVERSIBLE',
                    provenance: 'FIRST_PARTY',
                    ownerUserId: USERS.author,
                    status: 'ACTIVE',
                    riskTier: 'LOW',
                    riskTierScoredAt: new Date(),
                },
            });
            for (const toolName of ['list_risks', 'propose_risks']) {
                await prisma.registeredAgentTool.create({
                    data: { tenantId: TENANT, agentId: id, toolName, grantedByUserId: USERS.author },
                });
            }
        }
        await prisma.tenantSecuritySettings.create({ data: { tenantId: TENANT, agentDriver: 'TOOL_RUNNER' } });

        // The version a reviewer is asked to approve: SUBMITTED, not in force.
        await createAgentProfile(author(), AGENTS.main, version());
        await submitAgentProfileVersion(author(), AGENTS.main, 1);
        // One that does not allow Test runs.
        await createAgentProfile(author(), AGENTS.askOnly, version({ allowedTriggers: ['ASK'] }));
        await submitAgentProfileVersion(author(), AGENTS.askOnly, 1);
    });

    afterAll(async () => {
        global.fetch = originalFetch;
        await cleanup();
        await prisma.$disconnect();
    });

    it('the Behaviour tab is told a Test run can start', async () => {
        expect((await getAgentProfile(reviewer(), AGENTS.main)).testRun).toEqual({ available: true });
    });

    it('starts as the agent, completes read-only, and records MODEL_CALL and TOOL_CALL steps', async () => {
        installFakeModel();
        const started = await startAgentProfileTestRun(reviewer(), AGENTS.main, 1);
        expect(started.status).toBe('RUNNING');
        expect(started.runKey).toMatch(/:test-run$/);
        // A reasoning-engine run is handed to the worker, not executed inline.
        expect(enqueued.some(([name]) => name === 'agent-run-execute')).toBe(true);

        const outcome = await executeQueuedWorkflowRun(TENANT, started.runId);
        expect(outcome).toMatchObject({ status: 'COMPLETED' });

        const run = await prisma.workflowRun.findUniqueOrThrow({
            where: { id: started.runId },
            select: { status: true, driver: true, agentId: true, startedByUserId: true, workflowKey: true, profileVersionId: true },
        });
        expect(run).toMatchObject({
            status: 'COMPLETED',
            driver: 'TOOL_RUNNER',
            agentId: AGENTS.main,
            startedByUserId: USERS.reviewer,
            workflowKey: started.runKey,
        });
        expect(run.profileVersionId).not.toBeNull();

        const kinds = (
            await prisma.workflowStep.findMany({ where: { runId: started.runId }, select: { kind: true }, orderBy: { seq: 'asc' } })
        ).map((s) => s.kind);
        expect(kinds).toEqual(expect.arrayContaining(['MODEL_CALL', 'TOOL_CALL']));

        // READ-ONLY: nothing was proposed, and no propose tool was offered,
        // although this profile's output kind would allow proposals in force.
        expect(await prisma.agentProposal.count({ where: { tenantId: TENANT } })).toBe(0);
        const offered = ((wire.bodies[0]?.tools ?? []) as Array<{ name: string }>).map((t) => t.name);
        expect(offered).toContain('list_risks');
        expect(offered).not.toContain('propose_risks');

        // The model got the instructions, at Anthropic's Messages API.
        expect(wire.urls[0]).toBe('https://api.anthropic.com/v1/messages');
        expect(JSON.stringify(wire.bodies[0])).toContain(INSTRUCTIONS);
        expect(wire.bodies).toHaveLength(2);
    });

    it('a Test-run key is refused by every other start path', async () => {
        const profile = await prisma.agentProfile.findFirstOrThrow({ where: { tenantId: TENANT, agentId: AGENTS.main } });
        const key = profileRunKey(profile.id, 1, { testRun: true });
        expect(await reasonOf(startWorkflowRun(reviewer({ agentId: AGENTS.main }), key))).toBe('PROFILE_TEST_RUN_KEY');
    });

    it('a version that does not allow Test runs is refused, by name', async () => {
        expect(await reasonOf(startAgentProfileTestRun(reviewer(), AGENTS.askOnly, 1))).toBe('TEST_RUN_TRIGGER_NOT_ALLOWED');
    });

    it('an API key is not a person, and cannot start one', async () => {
        expect(
            await reasonOf(startAgentProfileTestRun(reviewer({ apiKeyId: 'key-1', apiKeyScopes: ['*'] }), AGENTS.main, 1)),
        ).toBe('TESTER_NOT_A_PERSON');
    });

    it('a workspace on an engine that does not run profiles is refused, naming the engine', async () => {
        await prisma.tenantSecuritySettings.update({ where: { tenantId: TENANT }, data: { agentDriver: 'FLUE' } });
        try {
            const runsBefore = await prisma.workflowRun.count({ where: { tenantId: TENANT } });
            let refusal: { details?: { reason?: string; state?: unknown } } = {};
            await startAgentProfileTestRun(reviewer(), AGENTS.main, 1).catch((err) => {
                refusal = err;
            });
            expect(refusal.details).toEqual({
                reason: 'TEST_RUN_UNAVAILABLE',
                state: { available: false, reason: 'ENGINE_DOES_NOT_RUN_PROFILES', engine: 'FLUE' },
            });
            expect(await prisma.workflowRun.count({ where: { tenantId: TENANT } })).toBe(runsBefore);
        } finally {
            await prisma.tenantSecuritySettings.update({ where: { tenantId: TENANT }, data: { agentDriver: 'TOOL_RUNNER' } });
        }
    });
});
