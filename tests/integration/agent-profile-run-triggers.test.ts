/**
 * A PROFILE VERSION'S `allowedTriggers` IS HELD ON EVERY START PATH (#5367).
 *
 * `resolveRunDefinition` checked the version's triggers only when its caller
 * named one, and only the Test-run usecase did. So a version that allowed only
 * TEST_RUN ran from an automation rule's `INVOKE_AGENT`, from the generic
 * `POST /agent-runs` (a person or a key) and from the Ask path. Now a profile
 * key requires a trigger, each path names its own, and the version decides.
 *
 * One cell per path, each with its positive control where the path has a
 * trigger: the same path with a version that allows it starts a run, so a
 * refusal below cannot pass for a path that never reached admission. Runs are
 * admitted and enqueued, never executed — admission is the subject.
 */
const envOverride: Record<string, string | undefined> = {
    AGENT_PROFILES: '1',
    AGENT_DRIVER_TOOL_RUNNER: '1',
    AGENT_INTERACTIVE_RUNS: '1',
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
// The route's own authentication is not the subject: its context is handed in.
const tenantCtx = jest.fn();
jest.mock('@/app-layer/context', () => ({
    ...jest.requireActual('@/app-layer/context'),
    getTenantCtx: (...a: unknown[]) => tenantCtx(...a),
}));

import { NextRequest } from 'next/server';
import { PrismaClient, type Role } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { createTenantWithDek } from '@/lib/security/tenant-key-manager';
import { startWorkflowRun } from '@/app-layer/usecases/workflow-runs';
import { startInteractiveRun } from '@/app-layer/usecases/interactive-agent-runs';
import { runAgentInvokeDispatch } from '@/app-layer/jobs/agent-invoke-dispatch';
import { POST as START_RUN } from '@/app/api/t/[tenantSlug]/agent-runs/route';
import {
    approveAgentProfileVersion,
    createAgentProfile,
    submitAgentProfileVersion,
} from '@/app-layer/usecases/agent-profiles';
import type { AgentProfileVersionInput } from '@/app-layer/schemas/agent-profile.schemas';
import { profileRunKey, type ProfileTrigger } from '@/lib/agentic/agent-profile';
import type { RequestContext } from '@/app-layer/types';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }), transactionOptions: TENANT_TX_OPTIONS });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(120_000);

const SUITE = `aprt-${randomUUID().slice(0, 8)}`;
const TENANT = `t-${SUITE}`;
const USERS = { author: `u-author-${SUITE}`, reviewer: `u-reviewer-${SUITE}` };
/** One agent per allowed-trigger set; the agent's name says what its version allows. */
const AGENTS = {
    testRunOnly: `ag-test-${SUITE}`,
    automation: `ag-auto-${SUITE}`,
    ask: `ag-ask-${SUITE}`,
} as const;
const KEYS: Record<keyof typeof AGENTS, string> = { testRunOnly: '', automation: '', ask: '' };

const ctxFor = (role: Role, userId: string, over: Partial<RequestContext> = {}): RequestContext =>
    makeRequestContext(role, { tenantId: TENANT, tenantSlug: TENANT, userId, ...over });
const author = () => ctxFor('OWNER', USERS.author);
const reviewer = (over: Partial<RequestContext> = {}) => ctxFor('ADMIN', USERS.reviewer, over);

const version = (allowedTriggers: ProfileTrigger[]): AgentProfileVersionInput => ({
    instructions: 'Summarise the open risks for the weekly review in one sentence.',
    toolNames: ['list_risks'],
    skillRefs: [],
    modelTier: 'balanced',
    effort: 'medium',
    maxTurns: 10,
    // Read-only, so the Ask path's read authority is never what refuses.
    outputKind: 'ANSWER_ONLY',
    allowedTriggers,
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

const runsOf = (key: string) => prisma.workflowRun.count({ where: { tenantId: TENANT, workflowKey: key } });

async function designateForAsk(agentId: string): Promise<void> {
    await prisma.tenantSecuritySettings.update({ where: { tenantId: TENANT }, data: { interactiveAgentId: agentId } });
}

async function postStart(ctx: RequestContext, workflowKey: string): Promise<{ status: number; body: { error?: { message?: string } | string; message?: string } }> {
    tenantCtx.mockResolvedValue(ctx);
    const req = new NextRequest(`http://localhost/api/t/${TENANT}/agent-runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workflowKey }),
    });
    const res = await START_RUN(req, { params: Promise.resolve({ tenantSlug: TENANT }) } as never);
    return { status: res.status, body: (await res.json().catch(() => ({}))) as never };
}

const invoke = (agentId: string, workflowKey: string) =>
    runAgentInvokeDispatch({
        tenantId: TENANT,
        ownerUserId: USERS.author,
        agentId,
        workflowKey,
        inputMapping: {},
        parentExecutionId: `exec-${SUITE}`,
        triggerEvent: 'RISK_CREATED',
        data: {},
        depth: 1,
    });

async function cleanup(): Promise<void> {
    await prisma.workflowStep.deleteMany({ where: { tenantId: TENANT } });
    await prisma.aiDecisionLog.deleteMany({ where: { tenantId: TENANT } });
    await prisma.workflowRun.deleteMany({ where: { tenantId: TENANT } });
    await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        await tx.$executeRawUnsafe(`DELETE FROM "AgentProfileVersion" WHERE "tenantId" = $1`, TENANT);
        await tx.$executeRawUnsafe(`DELETE FROM "AgentProfile" WHERE "tenantId" = $1`, TENANT);
        await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = $1`, TENANT);
    });
    await prisma.tenantSecuritySettings.deleteMany({ where: { tenantId: TENANT } });
    await prisma.registeredAgentTool.deleteMany({ where: { tenantId: TENANT } });
    await prisma.registeredAgent.deleteMany({ where: { tenantId: TENANT } });
    await prisma.aiSystem.deleteMany({ where: { tenantId: TENANT } });
    await deleteAuditRowsForTenants(prisma, TENANT);
    await prisma.user.deleteMany({ where: { id: { in: Object.values(USERS) } } });
    await prisma.tenant.deleteMany({ where: { id: TENANT } });
}

describeFn("a profile version's allowedTriggers decides every start path (real DB)", () => {
    beforeAll(async () => {
        await prisma.$connect();
        await cleanup();
        await createTenantWithDek({ id: TENANT, name: TENANT, slug: TENANT });
        for (const [id, role] of [[USERS.author, 'OWNER'], [USERS.reviewer, 'ADMIN']] as const) {
            const email = `${id}@example.test`;
            await prisma.user.create({ data: { id, email, emailHash: hashForLookup(email) } });
            await prisma.tenantMembership.create({ data: { tenantId: TENANT, userId: id, role, status: 'ACTIVE' } });
        }
        await prisma.tenantSecuritySettings.create({ data: { tenantId: TENANT, agentDriver: 'TOOL_RUNNER' } });

        const triggers: Record<keyof typeof AGENTS, ProfileTrigger[]> = {
            testRunOnly: ['TEST_RUN'],
            automation: ['AUTOMATION'],
            ask: ['ASK'],
        };
        for (const [name, id] of Object.entries(AGENTS) as Array<[keyof typeof AGENTS, string]>) {
            const sys = await prisma.aiSystem.create({ data: { tenantId: TENANT, name: `sys-${id}` } });
            await prisma.registeredAgent.create({
                data: {
                    id,
                    tenantId: TENANT,
                    aiSystemId: sys.id,
                    name: `agent ${id}`,
                    autonomyLevel: 1,
                    dataAccessScope: 'READ_TENANT_DATA',
                    reversibility: 'REVERSIBLE',
                    provenance: 'FIRST_PARTY',
                    ownerUserId: USERS.author,
                    status: 'ACTIVE',
                    riskTier: 'LOW',
                    riskTierScoredAt: new Date(),
                },
            });
            await prisma.registeredAgentTool.create({
                data: { tenantId: TENANT, agentId: id, toolName: 'list_risks', grantedByUserId: USERS.author },
            });
            const created = await createAgentProfile(author(), id, version(triggers[name]));
            await submitAgentProfileVersion(author(), id, 1);
            await approveAgentProfileVersion(reviewer(), id, 1, { instructionsHash: created.instructionsHash });
            KEYS[name] = profileRunKey(created.profileId, 1);
        }
    });

    afterAll(async () => {
        await cleanup();
        await prisma.$disconnect();
    });

    describe('an automation rule (INVOKE_AGENT) is the AUTOMATION trigger', () => {
        it('a version that does not allow AUTOMATION is refused, before any run row', async () => {
            expect(await reasonOf(invoke(AGENTS.testRunOnly, KEYS.testRunOnly))).toBe('PROFILE_TRIGGER_NOT_ALLOWED');
            expect(await runsOf(KEYS.testRunOnly)).toBe(0);
        });

        it('a version that allows it starts a run', async () => {
            const out = await invoke(AGENTS.automation, KEYS.automation);
            expect(out.refusal).toBeNull();
            expect(out.runId).not.toBeNull();
            expect(await runsOf(KEYS.automation)).toBe(1);
        });
    });

    describe('the Ask path is the ASK trigger', () => {
        it('a version that does not allow ASK is refused, before any run row', async () => {
            await designateForAsk(AGENTS.testRunOnly);
            expect(await reasonOf(startInteractiveRun(reviewer(), KEYS.testRunOnly))).toBe('PROFILE_TRIGGER_NOT_ALLOWED');
            expect(await runsOf(KEYS.testRunOnly)).toBe(0);
        });

        it('a version that allows it starts a run', async () => {
            await designateForAsk(AGENTS.ask);
            const started = await startInteractiveRun(reviewer(), KEYS.ask);
            expect(await prisma.workflowRun.findUniqueOrThrow({ where: { id: started.runId }, select: { workflowKey: true } }))
                .toEqual({ workflowKey: KEYS.ask });
        });
    });

    describe('POST /agent-runs is no trigger, so it starts no profile', () => {
        it('a person is refused PROFILE_TRIGGER_REQUIRED, whatever the version allows', async () => {
            for (const name of Object.keys(AGENTS) as Array<keyof typeof AGENTS>) {
                const before = await runsOf(KEYS[name]);
                const res = await postStart(reviewer({ agentId: AGENTS[name] }), KEYS[name]);
                expect(res.status).toBe(400);
                expect(JSON.stringify(res.body)).toContain('PROFILE_TRIGGER_REQUIRED');
                expect(await runsOf(KEYS[name])).toBe(before);
            }
        });

        it('an API key with mcp:orchestrate, bound to the agent, is refused the same way', async () => {
            const key = reviewer({
                agentId: AGENTS.automation,
                apiKeyId: `key-${SUITE}`,
                apiKeyScopes: ['mcp:orchestrate', 'risks:read'],
            });
            const before = await runsOf(KEYS.automation);
            const res = await postStart(key, KEYS.automation);
            expect(res.status).toBe(400);
            expect(JSON.stringify(res.body)).toContain('PROFILE_TRIGGER_REQUIRED');
            expect(await runsOf(KEYS.automation)).toBe(before);
        });
    });
});
