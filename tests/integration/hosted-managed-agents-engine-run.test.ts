/**
 * A HOSTED MANAGED AGENTS RUN, END TO END, THROUGH THE MODULE SEAM (Step 6b
 * of `docs/claude-managed-agents-design.md`, shape MA-C1), over a real
 * database and a faux Anthropic workspace standing for INFLECT's own.
 *
 * Everything is real but Anthropic and the two seams: the owner's opt-in, the
 * engine setting (which accepts the engine for a workspace with no connection
 * of its own because Inflect's workspace resolves), the approval that
 * provisions the version's agent, the Test-run usecase and admission, and the
 * worker's own body (`executeQueuedWorkflowRun`: the run lease, the hosted
 * slot, the session, the settle).
 *
 *   • Nothing tenant-authored, and no tenant name, slug or agent name, is in
 *     an agent body, an agent or environment name, or session metadata: those
 *     are stored in a workspace every hosted tenant shares, and an agent can
 *     only be archived, never deleted.
 *   • Every request carries Inflect's key and workspace, the session is always
 *     deleted at settle (decision 4 is MA-C2's only), the ledger records the
 *     workspace kind, and the run holds a hosted slot.
 *   • The session time Inflect pays for (`usage.active_seconds`) is read
 *     before the delete and recorded on the run (#4173); a read that fails is
 *     recorded as unknown, never zero, and the session is still deleted.
 *   • A worker that dies mid-run is taken over, and the takeover RECONNECTS
 *     to the hosted session and continues there, as a run in a tenant's own
 *     workspace does (#5854, owner decision 2026-11-25); the session is still
 *     deleted at settle. A run the SIGTERM drain pauses keeps its hosted
 *     session for a person's resume, which reconnects to it the same way (the
 *     owner's second decision of that day), and it is deleted at settle too.
 *   • A response from another workspace fails the run by name, as it does in a
 *     tenant's own (#5854 finding 4): the event stream's answer is never read,
 *     no tool runs, and the session is still deleted through answers from
 *     Inflect's own workspace. A response naming none passes.
 *   • With the constant false, the same tenant's engine choice is refused and
 *     its run is refused by name before anything is sent.
 *
 * ═══ THE SEAMS ═══
 *
 * `HOSTED_MANAGED_AGENTS_ACTIVE` through a getter on a `jest.mock` of its leaf
 * module (production has no such seam, and nothing in `src/` writes it), and
 * the plan entitlement (no plan includes hosting until the owner opens one).
 */
const mockActivation = { active: true };
jest.mock('@/lib/agentic/managed-agents/hosted-activation', () => ({
    get HOSTED_MANAGED_AGENTS_ACTIVE() {
        return mockActivation.active;
    },
}));
jest.mock('@/lib/billing/entitlements', () => ({
    ...jest.requireActual('@/lib/billing/entitlements'),
    isEntitledTo: jest.fn(async () => true),
}));

const HOSTED_KEY = 'sk-ant-inflect-hosted-faux-engine-key'; // pragma: allowlist secret -- a placeholder for the faux
const HOSTED_WORKSPACE = 'wrkspc_inflect_hosted_engine';
const envOverride: Record<string, string | undefined> = {
    AGENT_PROFILES: '1',
    AGENT_MANAGED_AGENTS: '1',
    AGENT_MANAGED_AGENTS_HOSTED_API_KEY: HOSTED_KEY,
    AGENT_MANAGED_AGENTS_HOSTED_WORKSPACE_ID: HOSTED_WORKSPACE,
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
import { FAUX_SESSION_ACTIVE_SECONDS, ManagedAgentsFaux } from '../helpers/managed-agents-faux';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants, deleteAuditRowsForUsers } from '../helpers/audit-cleanup';
import { __resetAuditStreamForTests } from '@/app-layer/events/audit-stream';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';
import { hashForLookup } from '@/lib/security/encryption';
import { createTenantWithDek } from '@/lib/security/tenant-key-manager';
import { runInTenantContext } from '@/lib/db/rls-middleware';
import { DRIVER_IMPLEMENTED } from '@/lib/agentic/agent-driver';
import { INFLECT_HOSTED_CONNECTION_ID } from '@/lib/agentic/managed-agents/workspace';
import { executeQueuedWorkflowRun, resumeWorkflowRun } from '@/app-layer/usecases/workflow-runs';
import { enqueue } from '@/app-layer/jobs/queue';
import type { AgentRunExecutePayload } from '@/app-layer/jobs/types';
import { _resetInFlightRunsForTesting, pauseInFlightRuns } from '@/lib/agentic/in-flight-runs';
import {
    approveAgentProfileVersion,
    createAgentProfile,
    startAgentProfileTestRun,
    submitAgentProfileVersion,
} from '@/app-layer/usecases/agent-profiles';
import { setAgentDriverSetting } from '@/app-layer/usecases/agent-driver-setting';
import { setHostedManagedAgentsOptIn } from '@/app-layer/usecases/hosted-managed-agents-opt-in';
import type { AgentProfileVersionInput } from '@/app-layer/schemas/agent-profile.schemas';
import type { RequestContext } from '@/app-layer/types';
import { prisma as appPrisma } from '@/lib/prisma';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }), transactionOptions: TENANT_TX_OPTIONS });
const describeFn = DB_AVAILABLE && DRIVER_IMPLEMENTED['managed-agents'] ? describe : describe.skip;
jest.setTimeout(180_000);

const SUITE = `hmr-${randomUUID().slice(0, 8)}`;
const TENANT = `t-${SUITE}`;
// Names a tenant or a person would recognise. None may reach the workspace.
const TENANT_NAME = 'Quillfeather Hosted Holdings';
const TENANT_SLUG = `quillfeather-${SUITE}`;
const AGENT_NAME = 'Marmalade Risk Concierge';
const USERS = { author: `u-author-${SUITE}`, reviewer: `u-reviewer-${SUITE}` };
const AGENT = `ag-${SUITE}`;
const INSTRUCTIONS = 'Summarise the open risks for the weekly review. Call list_risks once, then answer in one sentence.';

const ctxFor = (role: Role, userId: string): RequestContext =>
    makeRequestContext(role, { tenantId: TENANT, tenantSlug: TENANT_SLUG, userId });
const author = () => ctxFor('OWNER', USERS.author);
const reviewer = () => ctxFor('ADMIN', USERS.reviewer);

const version = (): AgentProfileVersionInput => ({
    instructions: INSTRUCTIONS,
    toolNames: ['list_risks'],
    skillRefs: [],
    modelTier: 'balanced',
    effort: 'medium',
    maxTurns: 10,
    outputKind: 'ANSWER_ONLY',
    allowedTriggers: ['TEST_RUN'],
});

let faux: ManagedAgentsFaux;

async function sessionSteps(runId: string): Promise<Array<Record<string, unknown>>> {
    const steps = await runInTenantContext(author(), (db) =>
        db.workflowStep.findMany({ where: { tenantId: TENANT, runId, kind: 'SYNTHESIS' }, orderBy: { seq: 'asc' }, select: { inputJson: true } }),
    );
    return steps.map((s) => JSON.parse(s.inputJson ?? '{}') as Record<string, unknown>).filter((i) => typeof i.lifecycle === 'string');
}

async function modelCallSteps(runId: string): Promise<Array<Record<string, unknown>>> {
    const steps = await runInTenantContext(author(), (db) =>
        db.workflowStep.findMany({ where: { tenantId: TENANT, runId, kind: 'MODEL_CALL' }, orderBy: { seq: 'asc' }, select: { inputJson: true } }),
    );
    return steps.map((s) => JSON.parse(s.inputJson ?? '{}') as Record<string, unknown>);
}

async function cleanup(): Promise<void> {
    await prisma.workflowStep.deleteMany({ where: { tenantId: TENANT } });
    await prisma.agentProposal.deleteMany({ where: { tenantId: TENANT } });
    await prisma.workflowRun.deleteMany({ where: { tenantId: TENANT } });
    await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        for (const table of ['AiDecisionLog', 'AgentProfileVersion', 'AgentProfile', 'TenantMembership', 'ManagedAgentsCleanup']) {
            await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "tenantId" = $1`, TENANT);
        }
    });
    await prisma.agentProfileProvision.deleteMany({ where: { tenantId: TENANT } });
    await prisma.registeredAgentTool.deleteMany({ where: { tenantId: TENANT } });
    await prisma.registeredAgent.deleteMany({ where: { tenantId: TENANT } });
    await prisma.aiSystem.deleteMany({ where: { tenantId: TENANT } });
    await prisma.tenantSecuritySettings.deleteMany({ where: { tenantId: TENANT } });
    await deleteAuditRowsForTenants(prisma, [TENANT]).catch(() => undefined);
    await deleteAuditRowsForUsers(prisma, Object.values(USERS)).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: { in: Object.values(USERS) } } });
    await prisma.tenant.deleteMany({ where: { id: TENANT } });
}

describeFn('a hosted Managed Agents run, through the module seam (real DB, faux Inflect workspace)', () => {
    beforeAll(async () => {
        await prisma.$connect();
        faux = new ManagedAgentsFaux();
        faux.install();
        await createTenantWithDek({ id: TENANT, name: TENANT_NAME, slug: TENANT_SLUG });
        for (const [id, role] of [[USERS.author, 'OWNER'], [USERS.reviewer, 'ADMIN']] as const) {
            const email = `${id}@example.test`;
            await prisma.user.create({ data: { id, email, emailHash: hashForLookup(email) } });
            await prisma.tenantMembership.create({ data: { tenantId: TENANT, userId: id, role, status: 'ACTIVE' } });
        }
        const sys = await prisma.aiSystem.create({ data: { tenantId: TENANT, name: `sys-${AGENT}` } });
        await prisma.registeredAgent.create({
            data: {
                id: AGENT,
                tenantId: TENANT,
                aiSystemId: sys.id,
                name: AGENT_NAME,
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
            data: { tenantId: TENANT, agentId: AGENT, toolName: 'list_risks', grantedByUserId: USERS.author },
        });
        faux.turns = Array.from({ length: 10 }, () => [
            { toolCalls: [{ name: 'list_risks', args: {} }] },
            { text: 'There are no open risks to report this week.' },
        ]).flat();
    });

    afterAll(async () => {
        _resetInFlightRunsForTesting();
        await cleanup();
        faux.uninstall();
        await appPrisma.$disconnect();
        await prisma.$disconnect();
        __resetAuditStreamForTests();
    });

    it('with the constant false, the engine cannot be chosen for a workspace with no connection of its own, and nothing is sent', async () => {
        mockActivation.active = false;
        await expect(setAgentDriverSetting(author(), 'MANAGED_AGENTS')).rejects.toMatchObject({
            status: 409,
            details: { reason: 'MANAGED_AGENTS_NO_WORKSPACE' },
        });
        expect(faux.requests).toEqual([]);
        mockActivation.active = true;
    });

    it('opted in, the engine is chosen, approval provisions in Inflect\'s workspace, and a Test run completes there', async () => {
        await setHostedManagedAgentsOptIn(author(), true);
        const setting = await setAgentDriverSetting(author(), 'MANAGED_AGENTS');
        expect(setting.managedAgents).toMatchObject({ workspace: 'HOSTED', hostedRefusal: null });

        const v1 = await createAgentProfile(author(), AGENT, version());
        await submitAgentProfileVersion(author(), AGENT, 1);
        await approveAgentProfileVersion(reviewer(), AGENT, 1, { instructionsHash: v1.instructionsHash });
        expect(await prisma.agentProfileProvision.count({ where: { tenantId: TENANT, connectionId: INFLECT_HOSTED_CONNECTION_ID } })).toBe(1);

        const started = await startAgentProfileTestRun(reviewer(), AGENT, 1);
        const outcome = await executeQueuedWorkflowRun(TENANT, started.runId);
        expect(outcome).toMatchObject({ status: 'COMPLETED' });

        // The run took a hosted slot, and its ledger records the workspace kind.
        const run = await prisma.workflowRun.findUniqueOrThrow({
            where: { id: started.runId },
            select: { hostedManagedAgents: true, costTokens: true, hostedSessionSeconds: true, hostedSessionsUnmetered: true },
        });
        expect(run.hostedManagedAgents).toBe(true);
        // The session time Inflect pays for, read off the session's usage
        // before the delete, recorded per tenant beside the tokens (#4173).
        expect(run).toMatchObject({ hostedSessionSeconds: FAUX_SESSION_ACTIVE_SECONDS, hostedSessionsUnmetered: 0 });
        expect(run.costTokens).toBeGreaterThan(0);
        const steps = await sessionSteps(started.runId);
        expect(steps.map((s) => s.lifecycle)).toEqual(['SESSION_CREATED', 'SESSION_DELETED']);
        expect(steps[0]).toMatchObject({ connectionId: INFLECT_HOSTED_CONNECTION_ID, workspaceKind: 'HOSTED' });
        // Always deleted at settle: decision 4's keep choice is MA-C2's only.
        expect(faux.holdsSession(steps[0].sessionId as string)).toBe(false);
        // Each model call records the workspace it ran in, with its tokens.
        const calls = await modelCallSteps(started.runId);
        expect(calls.length).toBeGreaterThan(0);
        for (const c of calls) expect(c).toMatchObject({ workspace: 'HOSTED', spanDerived: true });
    });

    it('a worker that dies mid-run is taken over: the takeover reconnects to the hosted session, sends the kept result, and still deletes the session (#5854)', async () => {
        const started = await startAgentProfileTestRun(reviewer(), AGENT, 1);
        const { startedAt } = await prisma.workflowRun.findUniqueOrThrow({ where: { id: started.runId }, select: { startedAt: true } });
        const opts = { leaseTiming: { ttlMs: 2_000, renewMs: 150 }, segment: startedAt.getTime() };
        const dropped: Array<Record<string, unknown>> = [];
        faux.beforeEventsPost = async (_sid, events) => {
            if (!events.some((e) => e.type === 'user.custom_tool_result')) return undefined;
            faux.beforeEventsPost = null;
            dropped.push(...events);
            // The worker dies as it sends the result: the session never gets it.
            await prisma.$executeRaw`UPDATE "WorkflowRun" SET "leaseHolder" = 'a-worker-that-died', "leaseExpiresAt" = now() - interval '1 second' WHERE "id" = ${started.runId}`;
            return 'DROP';
        };
        expect(await executeQueuedWorkflowRun(TENANT, started.runId, opts)).toEqual({ skipped: 'LEASE_LOST' });
        faux.beforeEventsPost = null;
        const [created] = await sessionSteps(started.runId);
        const sessionId = created.sessionId as string;
        expect(faux.holdsSession(sessionId)).toBe(true);

        expect(await executeQueuedWorkflowRun(TENANT, started.runId, opts)).toMatchObject({ status: 'COMPLETED' });
        // ONE session, reconnected to, then deleted: decision 4 is MA-C2's only.
        expect((await sessionSteps(started.runId)).map((s) => [s.lifecycle, s.sessionId])).toEqual([
            ['SESSION_CREATED', sessionId],
            ['SESSION_DELETED', sessionId],
        ]);
        expect(faux.holdsSession(sessionId)).toBe(false);
        const callId = String(dropped[0].custom_tool_use_id);
        expect(faux.toolResults.filter((r) => r.id === callId)).toEqual([
            { id: callId, isError: false, text: String((dropped[0].content as Array<{ text: string }>)[0].text) },
        ]);
        const calls = await modelCallSteps(started.runId);
        expect(calls.find((c) => c.reconnectedToSession === sessionId)).toMatchObject({ workspace: 'HOSTED' });
        // One session, metered once, by the segment that settled it (#4173).
        expect(await prisma.workflowRun.findUniqueOrThrow({
            where: { id: started.runId },
            select: { hostedSessionSeconds: true, hostedSessionsUnmetered: true },
        })).toEqual({ hostedSessionSeconds: FAUX_SESSION_ACTIVE_SECONDS, hostedSessionsUnmetered: 0 });
    });

    it('a session whose usage cannot be read is recorded as UNKNOWN, never zero, and is still deleted (#4173)', async () => {
        faux.failSessionRetrieve = 503;
        try {
            const started = await startAgentProfileTestRun(reviewer(), AGENT, 1);
            expect(await executeQueuedWorkflowRun(TENANT, started.runId)).toMatchObject({ status: 'COMPLETED' });
            const steps = await sessionSteps(started.runId);
            expect(steps.map((s) => s.lifecycle)).toEqual(['SESSION_CREATED', 'SESSION_DELETED']);
            expect(faux.holdsSession(steps[0].sessionId as string)).toBe(false);
            expect(await prisma.workflowRun.findUniqueOrThrow({
                where: { id: started.runId },
                select: { hostedSessionSeconds: true, hostedSessionsUnmetered: true },
            })).toEqual({ hostedSessionSeconds: null, hostedSessionsUnmetered: 1 });
        } finally {
            faux.failSessionRetrieve = null;
        }
    });

    it('a run the SIGTERM drain pauses keeps its hosted session for the person\'s resume, which reconnects, and the session is still deleted at settle (#5854)', async () => {
        _resetInFlightRunsForTesting();
        const started = await startAgentProfileTestRun(reviewer(), AGENT, 1);
        const { startedAt } = await prisma.workflowRun.findUniqueOrThrow({ where: { id: started.runId }, select: { startedAt: true } });
        const leaseTiming = { ttlMs: 2_000, renewMs: 150 };
        const dropped: Array<Record<string, unknown>> = [];
        faux.beforeEventsPost = async (_sid, events) => {
            if (!events.some((e) => e.type === 'user.custom_tool_result')) return undefined;
            faux.beforeEventsPost = null;
            dropped.push(...events);
            // The drain pauses the run as the worker sends the result: the session never gets it.
            expect(await pauseInFlightRuns(5_000)).toMatchObject({ paused: 1 });
            return 'DROP';
        };
        expect(await executeQueuedWorkflowRun(TENANT, started.runId, { leaseTiming, segment: startedAt.getTime() })).toEqual({ skipped: 'LEASE_LOST' });
        faux.beforeEventsPost = null;
        const [created] = await sessionSteps(started.runId);
        const sessionId = created.sessionId as string;
        // Paused, and the hosted session left open for the resume.
        expect((await prisma.workflowRun.findUniqueOrThrow({ where: { id: started.runId }, select: { status: true } })).status).toBe('PAUSED');
        expect(faux.holdsSession(sessionId)).toBe(true);
        expect(faux.interrupts).not.toContain(sessionId);

        const queue = enqueue as unknown as jest.Mock;
        queue.mockClear();
        await resumeWorkflowRun(reviewer(), started.runId);
        const job = queue.mock.calls.find((c) => c[0] === 'agent-run-execute')?.[1] as AgentRunExecutePayload;
        expect(job.pausedAt).toEqual(expect.any(Number));
        expect(await executeQueuedWorkflowRun(TENANT, started.runId, { leaseTiming, segment: job.segment, pausedAt: job.pausedAt })).toMatchObject({ status: 'COMPLETED' });
        // ONE session across the pause, reconnected to, then deleted: decision 4 is MA-C2's only.
        expect((await sessionSteps(started.runId)).map((s) => [s.lifecycle, s.sessionId])).toEqual([
            ['SESSION_CREATED', sessionId],
            ['SESSION_DELETED', sessionId],
        ]);
        expect(faux.holdsSession(sessionId)).toBe(false);
        const callId = String(dropped[0].custom_tool_use_id);
        expect(faux.toolResults.filter((r) => r.id === callId)).toEqual([
            { id: callId, isError: false, text: String((dropped[0].content as Array<{ text: string }>)[0].text) },
        ]);
        const calls = await modelCallSteps(started.runId);
        expect(calls.find((c) => c.reconnectedToSession === sessionId)).toMatchObject({ workspace: 'HOSTED' });
    });

    it('a hosted run whose event stream answers from another workspace fails by name, runs no tool, and its session is still deleted (#5854 finding 4)', async () => {
        const resultsBefore = faux.toolResults.length;
        faux.answerWorkspace = { answer: 'OTHER', method: 'GET', path: /\/events\/stream$/ };
        try {
            const started = await startAgentProfileTestRun(reviewer(), AGENT, 1);
            await executeQueuedWorkflowRun(TENANT, started.runId);
            const row = await prisma.workflowRun.findUniqueOrThrow({ where: { id: started.runId }, select: { status: true, errorMessage: true } });
            expect(row.status).toBe('FAILED');
            expect(row.errorMessage).toMatch(/^managed_agents_workspace_mismatch: a response from Anthropic named a different workspace/);
            expect(row.errorMessage).not.toContain(HOSTED_WORKSPACE);
            // Nothing behind the stream's answer was read: no tool ran, nothing was answered.
            expect(await prisma.workflowStep.count({ where: { tenantId: TENANT, runId: started.runId, kind: 'TOOL_CALL' } })).toBe(0);
            expect(faux.toolResults.length).toBe(resultsBefore);
            // Settled through answers from Inflect's own workspace: deleted, and recorded so.
            const steps = await sessionSteps(started.runId);
            expect(steps.map((s) => s.lifecycle)).toEqual(['SESSION_CREATED', 'SESSION_DELETED']);
            expect(faux.holdsSession(steps[0].sessionId as string)).toBe(false);
        } finally {
            faux.answerWorkspace = null;
        }
    });

    it('a hosted run whose responses name no workspace completes: a missing header passes (#5854 finding 4)', async () => {
        faux.answerWorkspace = { answer: 'NONE' };
        try {
            const started = await startAgentProfileTestRun(reviewer(), AGENT, 1);
            expect(await executeQueuedWorkflowRun(TENANT, started.runId)).toMatchObject({ status: 'COMPLETED' });
            const steps = await sessionSteps(started.runId);
            expect(steps.map((s) => s.lifecycle)).toEqual(['SESSION_CREATED', 'SESSION_DELETED']);
        } finally {
            faux.answerWorkspace = null;
        }
    });

    it('every request carried Inflect\'s key and workspace', () => {
        expect(faux.requests.length).toBeGreaterThan(0);
        for (const r of faux.requests) {
            expect({ key: r.headers.get('authorization'), workspace: r.headers.get('anthropic-workspace-id') }).toEqual({
                key: `Bearer ${HOSTED_KEY}`,
                workspace: HOSTED_WORKSPACE,
            });
        }
    });

    it('nothing tenant-authored, and no tenant or agent name or slug, is in an agent body, a name, or session metadata', () => {
        const forbidden = [TENANT_NAME, TENANT_SLUG, AGENT_NAME, INSTRUCTIONS, 'Quillfeather', 'Marmalade'];
        // The denominator: something of each kind was written.
        expect(faux.agentWrites.length).toBeGreaterThan(0);
        expect(faux.environments.length).toBeGreaterThan(0);
        expect(faux.sessionCreates.length).toBeGreaterThan(0);
        const agentBodies = JSON.stringify(faux.agentWrites.map((w) => w.body));
        const environmentBodies = JSON.stringify(faux.environments);
        const sessionMetadata = JSON.stringify(faux.sessionCreates.map((s) => s.metadata));
        for (const text of forbidden) {
            expect({ text, inAgent: agentBodies.includes(text) }).toEqual({ text, inAgent: false });
            expect({ text, inEnvironment: environmentBodies.includes(text) }).toEqual({ text, inEnvironment: false });
            expect({ text, inMetadata: sessionMetadata.includes(text) }).toEqual({ text, inMetadata: false });
        }
        // What they DO carry: opaque ids only.
        for (const w of faux.agentWrites) expect(w.body.name).toMatch(/^inflect-profile-[a-z0-9]+$/);
        for (const s of faux.sessionCreates) expect(Object.keys(s.metadata as object).sort()).toEqual(['inflect_run', 'inflect_tenant']);
        // The instructions went only into the session's override, which is deleted.
        expect(JSON.stringify(faux.sessionCreates.map((s) => s.agent))).toContain(INSTRUCTIONS);
    });

    it('with the constant false again, the run is refused by name before anything is sent', async () => {
        mockActivation.active = false;
        const before = faux.requests.length;
        const started = await startAgentProfileTestRun(reviewer(), AGENT, 1);
        await executeQueuedWorkflowRun(TENANT, started.runId);
        const row = await prisma.workflowRun.findUniqueOrThrow({ where: { id: started.runId }, select: { status: true, errorMessage: true, hostedManagedAgents: true } });
        expect(row.status).toBe('FAILED');
        expect(row.errorMessage).toMatch(/^managed_agents_no_workspace: /);
        expect(row.hostedManagedAgents).toBe(false);
        expect(faux.requests.length).toBe(before);
        mockActivation.active = true;
    });
});
