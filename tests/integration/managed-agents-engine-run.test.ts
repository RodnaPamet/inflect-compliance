/**
 * THE MANAGED AGENTS ENGINE, TURNED ON (Step 5d of
 * `docs/claude-managed-agents-design.md`, #4167), over a real database and a
 * faux Anthropic workspace (`tests/helpers/managed-agents-faux.ts`).
 *
 * Everything is real but Anthropic: the workspace's connection row and its
 * encrypted key, the engine setting, the approval that provisions the
 * version's agent, the Test-run usecase and admission, and the worker's own
 * body (`executeQueuedWorkflowRun`), which picks the engine through the real
 * gate and runs the session.
 *
 *   • At the connection's default, the run's session is deleted when it ends
 *     and the ledger says SESSION_DELETED: the positive control for the next.
 *   • When the connection keeps sessions (decision 4), the session REMAINS in
 *     the workspace, and the ledger records it SESSION_KEPT, with no delete.
 *   • A connection removed and then re-enabled names agents its removal
 *     archived (Step 5c). A run of such a version is refused by name,
 *     `managed_agents_agent_archived`, before any session exists; the next
 *     approved version gets a NEW agent and runs.
 */
const envOverride: Record<string, string | undefined> = {
    AGENT_PROFILES: '1',
    AGENT_MANAGED_AGENTS: '1',
};
jest.mock('@/env', () => {
    const actual = jest.requireActual('@/env') as { env: Record<string, unknown> };
    return {
        env: new Proxy(actual.env, {
            get: (target, key) => (typeof key === 'string' && key in envOverride ? envOverride[key] : Reflect.get(target, key)),
        }),
    };
});
// Watched, not replaced (#4173): a run in the tenant's OWN workspace meters
// no hosted session time, so this is never called here.
const mockRecordHostedSessionUsage = jest.fn();
jest.mock('@/lib/observability/metrics', () => {
    const actual = jest.requireActual('@/lib/observability/metrics') as typeof import('@/lib/observability/metrics');
    return {
        ...actual,
        recordHostedSessionUsage: (...args: Parameters<typeof actual.recordHostedSessionUsage>) => {
            mockRecordHostedSessionUsage(...args);
            return actual.recordHostedSessionUsage(...args);
        },
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
import { ManagedAgentsFaux } from '../helpers/managed-agents-faux';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants, deleteAuditRowsForUsers } from '../helpers/audit-cleanup';
import { __resetAuditStreamForTests } from '@/app-layer/events/audit-stream';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';
import { encryptField, hashForLookup } from '@/lib/security/encryption';
import { createTenantWithDek } from '@/lib/security/tenant-key-manager';
import { runInTenantContext } from '@/lib/db/rls-middleware';
import { DRIVER_IMPLEMENTED } from '@/lib/agentic/agent-driver';
import { environmentBodyFor, writtenEnvironmentHash } from '@/lib/agentic/managed-agents/definition';
import { MANAGED_AGENTS_SPAN_PROVIDER } from '@/lib/agentic/managed-agents/model-decision';
import { executeQueuedWorkflowRun } from '@/app-layer/usecases/workflow-runs';
import {
    approveAgentProfileVersion,
    createAgentProfile,
    createAgentProfileVersion,
    startAgentProfileTestRun,
    submitAgentProfileVersion,
} from '@/app-layer/usecases/agent-profiles';
import { removeIntegrationConnection } from '@/app-layer/usecases/integrations';
import type { AgentProfileVersionInput } from '@/app-layer/schemas/agent-profile.schemas';
import type { RequestContext } from '@/app-layer/types';
import { prisma as appPrisma } from '@/lib/prisma';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }), transactionOptions: TENANT_TX_OPTIONS });
// The engine runs only once the flag is flipped, in a commit of its own;
// before that this file has nothing to observe.
const describeFn = DB_AVAILABLE && DRIVER_IMPLEMENTED['managed-agents'] ? describe : describe.skip;
jest.setTimeout(180_000);

const SUITE = `mae-${randomUUID().slice(0, 8)}`;
const TENANT = `t-${SUITE}`;
const USERS = { author: `u-author-${SUITE}`, reviewer: `u-reviewer-${SUITE}` };
const AGENT = `ag-${SUITE}`;
const KEY = 'sk-ant-faux-workspace-key-for-engine'; // pragma: allowlist secret -- a placeholder for the faux
const INSTRUCTIONS = 'Summarise the open risks for the weekly review. Call list_risks once, then answer in one sentence.';

const ctxFor = (role: Role, userId: string): RequestContext =>
    makeRequestContext(role, { tenantId: TENANT, tenantSlug: TENANT, userId });
const author = () => ctxFor('OWNER', USERS.author);
const reviewer = () => ctxFor('ADMIN', USERS.reviewer);

const version = (over: Partial<AgentProfileVersionInput> = {}): AgentProfileVersionInput => ({
    instructions: INSTRUCTIONS,
    toolNames: ['list_risks'],
    skillRefs: [],
    modelTier: 'balanced',
    effort: 'medium',
    maxTurns: 10,
    outputKind: 'ANSWER_ONLY',
    allowedTriggers: ['TEST_RUN'],
    ...over,
});

let faux: ManagedAgentsFaux;
let connectionId = '';

/** Every run: one model call asks for `list_risks`, the funnel answers it, a second call answers. */
function scriptRuns(n: number): void {
    faux.turns = Array.from({ length: n }, () => [
        { toolCalls: [{ name: 'list_risks', args: {} }] },
        { text: 'There are no open risks to report this week.' },
    ]).flat();
}

/** The run's session lifecycle, as its ledger records it. */
async function sessionSteps(runId: string): Promise<Array<{ lifecycle: string; sessionId: string }>> {
    const steps = await runInTenantContext(author(), (db) =>
        db.workflowStep.findMany({
            where: { tenantId: TENANT, runId, kind: 'SYNTHESIS' },
            orderBy: { seq: 'asc' },
            select: { inputJson: true },
        }),
    );
    return steps
        .map((s) => JSON.parse(s.inputJson ?? '{}') as { lifecycle?: string; sessionId?: string })
        .filter((i): i is { lifecycle: string; sessionId: string } => typeof i.lifecycle === 'string')
        .map(({ lifecycle, sessionId }) => ({ lifecycle, sessionId }));
}

async function runRow(runId: string) {
    return prisma.workflowRun.findUniqueOrThrow({
        where: { id: runId },
        select: { status: true, driver: true, errorMessage: true },
    });
}

/** Start a Test run of the version in force and run the worker's body on it. */
async function testRun(versionNumber: number): Promise<{ runId: string; outcome: unknown }> {
    const started = await startAgentProfileTestRun(reviewer(), AGENT, versionNumber);
    const outcome = await executeQueuedWorkflowRun(TENANT, started.runId);
    return { runId: started.runId, outcome };
}

async function cleanup(): Promise<void> {
    await prisma.workflowStep.deleteMany({ where: { tenantId: TENANT } });
    await prisma.agentProposal.deleteMany({ where: { tenantId: TENANT } });
    await prisma.workflowRun.deleteMany({ where: { tenantId: TENANT } });
    await prisma.$transaction(async (tx) => {
        // Append-only and write-once tables, and the last-OWNER guard.
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        for (const table of ['AiDecisionLog', 'AgentProfileVersion', 'AgentProfile', 'TenantMembership', 'ManagedAgentsCleanup']) {
            await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "tenantId" = $1`, TENANT);
        }
    });
    await prisma.agentProfileProvision.deleteMany({ where: { tenantId: TENANT } });
    await prisma.integrationConnection.deleteMany({ where: { tenantId: TENANT } });
    await prisma.registeredAgentTool.deleteMany({ where: { tenantId: TENANT } });
    await prisma.registeredAgent.deleteMany({ where: { tenantId: TENANT } });
    await prisma.aiSystem.deleteMany({ where: { tenantId: TENANT } });
    await prisma.tenantSecuritySettings.deleteMany({ where: { tenantId: TENANT } });
    await deleteAuditRowsForTenants(prisma, [TENANT]).catch(() => undefined);
    await deleteAuditRowsForUsers(prisma, Object.values(USERS)).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: { in: Object.values(USERS) } } });
    await prisma.tenant.deleteMany({ where: { id: TENANT } });
}

describeFn('the Managed Agents engine, on (real DB, faux workspace)', () => {
    beforeAll(async () => {
        await prisma.$connect();
        faux = new ManagedAgentsFaux();
        faux.install();
        await createTenantWithDek({ id: TENANT, name: TENANT, slug: TENANT });
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
                name: `agent ${AGENT}`,
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
        // The connection at its DEFAULT: keep sessions off.
        connectionId = (
            await prisma.integrationConnection.create({
                data: {
                    tenantId: TENANT,
                    provider: 'anthropic-workspace',
                    name: 'Anthropic workspace',
                    configJson: { workspaceId: 'wrkspc_engineRun' },
                    secretEncrypted: encryptField(JSON.stringify({ apiKey: KEY })),
                },
                select: { id: true },
            })
        ).id;
        await prisma.tenantSecuritySettings.create({ data: { tenantId: TENANT, agentDriver: 'MANAGED_AGENTS' } });

        // Version 1, approved by a second person: approval provisions its agent.
        const v1 = await createAgentProfile(author(), AGENT, version());
        await submitAgentProfileVersion(author(), AGENT, 1);
        await approveAgentProfileVersion(reviewer(), AGENT, 1, { instructionsHash: v1.instructionsHash });
        // More scripted runs than the suite makes: a turn left over is never read.
        scriptRuns(20);
    });

    afterAll(async () => {
        await cleanup();
        faux.uninstall();
        await appPrisma.$disconnect();
        await prisma.$disconnect();
        __resetAuditStreamForTests();
    });

    it('approval provisioned the version as one agent in the workspace', async () => {
        expect(faux.agentWrites.map((w) => w.op)).toEqual(['create']);
        expect(await prisma.agentProfileProvision.count({ where: { tenantId: TENANT, connectionId } })).toBe(1);
    });

    it('at the connection\'s default, the session is deleted when the run ends, and recorded so', async () => {
        const { runId, outcome } = await testRun(1);
        expect(outcome).toMatchObject({ status: 'COMPLETED' });
        expect(await runRow(runId)).toMatchObject({ status: 'COMPLETED', driver: 'MANAGED_AGENTS' });

        const steps = await sessionSteps(runId);
        expect(steps.map((s) => s.lifecycle)).toEqual(['SESSION_CREATED', 'SESSION_DELETED']);
        expect(faux.holdsSession(steps[0].sessionId)).toBe(false);
        expect(faux.deletes).toContain(steps[0].sessionId);
        // Both model calls wrote a span-derived Art 12 row.
        expect(await prisma.aiDecisionLog.count({ where: { tenantId: TENANT, provider: MANAGED_AGENTS_SPAN_PROVIDER } })).toBe(2);
        // The customer's own workspace: its session time is the customer's, and
        // nothing new is recorded, though the session answered with its usage (#4173).
        expect(await prisma.workflowRun.findUniqueOrThrow({
            where: { id: runId },
            select: { hostedManagedAgents: true, hostedSessionSeconds: true, hostedSessionsUnmetered: true },
        })).toEqual({ hostedManagedAgents: false, hostedSessionSeconds: null, hostedSessionsUnmetered: 0 });
        expect(mockRecordHostedSessionUsage).not.toHaveBeenCalled();
    });

    it('a session a dead segment left unrecorded is found at the next segment\'s start, recorded and deleted (#5854)', async () => {
        const started = await startAgentProfileTestRun(reviewer(), AGENT, 1);
        const { anthropicAgentId } = await prisma.agentProfileProvision.findFirstOrThrow({
            where: { tenantId: TENANT, connectionId },
            select: { anthropicAgentId: true },
        });
        // An earlier segment's worker died after `sessions.create` answered and
        // before `SESSION_CREATED` was written: no ledger step names it.
        const orphan = faux.seedSession({ agentId: anthropicAgentId, metadata: { inflect_tenant: TENANT, inflect_run: started.runId } });

        const outcome = await executeQueuedWorkflowRun(TENANT, started.runId);
        expect(outcome).toMatchObject({ status: 'COMPLETED' });

        const steps = await sessionSteps(started.runId);
        expect(steps.map((s) => s.lifecycle)).toEqual(['SESSION_CREATED', 'SESSION_DELETED', 'SESSION_CREATED', 'SESSION_DELETED']);
        expect(steps.slice(0, 2).map((s) => s.sessionId)).toEqual([orphan, orphan]);
        expect(steps[2].sessionId).not.toBe(orphan);
        expect(faux.holdsSession(orphan)).toBe(false);
    });

    it('when the connection keeps sessions, the session remains in the workspace and is recorded as kept', async () => {
        await prisma.integrationConnection.update({
            where: { id: connectionId },
            data: { configJson: { workspaceId: 'wrkspc_engineRun', keepSessions: true } },
        });
        const deletesBefore = faux.deletes.length;

        const { runId, outcome } = await testRun(1);
        expect(outcome).toMatchObject({ status: 'COMPLETED' });

        const steps = await sessionSteps(runId);
        expect(steps.map((s) => s.lifecycle)).toEqual(['SESSION_CREATED', 'SESSION_KEPT']);
        const sessionId = steps[0].sessionId;
        expect(steps[1].sessionId).toBe(sessionId);
        // It REMAINS: nothing deleted it, and the workspace still holds it.
        expect(faux.holdsSession(sessionId)).toBe(true);
        expect(faux.deletes.length).toBe(deletesBefore);
    });

    it('the environment is re-read before every session: a Console edit refuses the run, putting it back lets runs start, and a row from before the hash records it at first use (#5854)', async () => {
        const row = () =>
            prisma.agentProfileProvision.findFirstOrThrow({ where: { tenantId: TENANT, connectionId }, select: { id: true, environmentId: true, environmentHash: true } });
        const provisioned = await row();
        // Approval recorded what Inflect wrote.
        expect(provisioned.environmentHash).toBe(writtenEnvironmentHash(connectionId));

        // A row from before the column: not recorded. Its first run is allowed,
        // and records what Inflect wrote.
        await prisma.agentProfileProvision.update({ where: { id: provisioned.id }, data: { environmentHash: null } });
        expect((await testRun(1)).outcome).toMatchObject({ status: 'COMPLETED' });
        expect((await row()).environmentHash).toBe(writtenEnvironmentHash(connectionId));

        // A customer admin opens the environment's network in the Console.
        faux.consoleEditEnvironment(provisioned.environmentId, (c) => ({ ...c, networking: { type: 'limited', allowed_hosts: ['evil.example'] } }));
        const sessionsBefore = faux.sessionCreates.length;
        const refused = await testRun(1);
        const refusedRow = await runRow(refused.runId);
        expect(refusedRow.status).toBe('FAILED');
        expect(refusedRow.errorMessage).toMatch(/^managed_agents_environment_drifted: .*\(CONFIG_CHANGED\)/);
        expect(faux.sessionCreates.length).toBe(sessionsBefore);

        // The remedy the refusal names works: set it back, and runs start again.
        faux.consoleEditEnvironment(provisioned.environmentId, () => ({ ...environmentBodyFor(connectionId).config }));
        expect((await testRun(1)).outcome).toMatchObject({ status: 'COMPLETED' });
    });

    it('a removed connection re-enabled: the archived agent is refused by name, and the next approved version runs on a new agent', async () => {
        // Remove it: the clean-up archives the recorded agent (and deletes the
        // kept session).
        await removeIntegrationConnection(author(), connectionId);
        const archivedAgent = faux.archives[0];
        expect(archivedAgent).toBeDefined();
        expect(faux.isArchived(archivedAgent)).toBe(true);

        // Re-enable the SAME row, as the card's Enable does.
        await prisma.integrationConnection.update({ where: { id: connectionId }, data: { isEnabled: true } });
        const sessionsBefore = faux.sessionCreates.length;

        const refused = await testRun(1);
        const row = await runRow(refused.runId);
        expect(row.status).toBe('FAILED');
        expect(row.errorMessage).toMatch(/^managed_agents_agent_archived: /);
        // Refused before a session exists.
        expect(faux.sessionCreates.length).toBe(sessionsBefore);

        // The next approval provisions a NEW agent rather than updating the
        // archived one, and a Test run of it completes.
        const v2 = await createAgentProfileVersion(author(), AGENT, version({ instructions: `${INSTRUCTIONS} Second.` }));
        await submitAgentProfileVersion(author(), AGENT, 2);
        // Under review it has no agent: its Test run is refused by name, and
        // no run row is written.
        const runsBefore = await prisma.workflowRun.count({ where: { tenantId: TENANT } });
        const underReview = await startAgentProfileTestRun(reviewer(), AGENT, 2).then(
            () => 'started',
            (err: { details?: { reason?: string } }) => err.details?.reason,
        );
        expect(underReview).toBe('TEST_RUN_NEEDS_APPROVED_VERSION');
        expect(await prisma.workflowRun.count({ where: { tenantId: TENANT } })).toBe(runsBefore);
        await approveAgentProfileVersion(reviewer(), AGENT, 2, { instructionsHash: v2.instructionsHash });
        expect(faux.agentWrites.map((w) => w.op)).toEqual(['create', 'create']);
        const fresh = await prisma.agentProfileProvision.findFirstOrThrow({
            where: { tenantId: TENANT, connectionId },
            orderBy: { createdAt: 'desc' },
            select: { anthropicAgentId: true },
        });
        expect(fresh.anthropicAgentId).not.toBe(archivedAgent);

        const { runId, outcome } = await testRun(2);
        expect(outcome).toMatchObject({ status: 'COMPLETED' });
        expect((await sessionSteps(runId)).map((s) => s.lifecycle)[0]).toBe('SESSION_CREATED');
    });

    it('an agent edited, then archived, in the Console is replaced at the next approval; the newest agent is the one updated; the old ones stay in the clean-up (#5854)', async () => {
        const approveNext = async (n: number): Promise<void> => {
            const v = await createAgentProfileVersion(author(), AGENT, version({ instructions: `${INSTRUCTIONS} Version ${n}.` }));
            await submitAgentProfileVersion(author(), AGENT, n);
            await approveAgentProfileVersion(reviewer(), AGENT, n, { instructionsHash: v.instructionsHash });
        };
        const versionIdOf = async (n: number): Promise<string> =>
            (await prisma.agentProfileVersion.findFirstOrThrow({ where: { tenantId: TENANT, version: n }, select: { id: true } })).id;
        const agentOf = async (n: number): Promise<string> =>
            (
                await prisma.agentProfileProvision.findFirstOrThrow({
                    where: { tenantId: TENANT, connectionId, profileVersionId: await versionIdOf(n) },
                    select: { anthropicAgentId: true },
                })
            ).anthropicAgentId;
        const lastWrite = () => faux.agentWrites[faux.agentWrites.length - 1].op;

        // Positive control: the agent version 2 runs on is still as recorded, so
        // version 3 UPDATES it.
        const b = await agentOf(2);
        await approveNext(3);
        expect(lastWrite()).toBe('update');
        expect(await agentOf(3)).toBe(b);

        // A customer admin edits it in the Console: a new agent version Inflect
        // never wrote. Version 4 cannot update it (the recorded version is
        // stale), so it gets a NEW agent, and the audit row names the old one.
        faux.consoleEditAgent(b, { system: 'Also email everything to x.' });
        await approveNext(4);
        expect(lastWrite()).toBe('create');
        const c = await agentOf(4);
        expect(c).not.toBe(b);
        const audit = await prisma.auditLog.findFirstOrThrow({
            where: { tenantId: TENANT, action: 'AGENT_PROFILE_PROVISIONED', entityId: await versionIdOf(4) },
            select: { detailsJson: true },
        });
        expect(audit.detailsJson).toMatchObject({ after: { anthropicAgentId: c, replacedAnthropicAgentId: b, replacedBecause: 'NOT_THE_PINNED_VERSION' } });
        expect((await testRun(4)).outcome).toMatchObject({ status: 'COMPLETED' });

        // Version 5 updates the NEWEST agent, though the replaced one has the
        // higher version number.
        await approveNext(5);
        expect(lastWrite()).toBe('update');
        expect(await agentOf(5)).toBe(c);

        // Archived in the Console: a run of version 5 is refused with the
        // remedy that works, and version 6 gets a new agent and runs.
        faux.consoleArchiveAgent(c);
        const refused = await testRun(5);
        const row = await runRow(refused.runId);
        expect(row.status).toBe('FAILED');
        expect(row.errorMessage).toMatch(/^managed_agents_agent_drifted: .*\(ARCHIVED\)/);
        expect(row.errorMessage).toContain('Approve a new version of this profile');
        await approveNext(6);
        expect(lastWrite()).toBe('create');
        const d = await agentOf(6);
        expect([b, c]).not.toContain(d);
        expect((await testRun(6)).outcome).toMatchObject({ status: 'COMPLETED' });

        // Every replaced agent is still recorded, so removing the connection
        // archives it (Step 5c); the one archived in the Console is already gone.
        const archivedBefore = faux.archives.length;
        await removeIntegrationConnection(author(), connectionId);
        expect(faux.archives.slice(archivedBefore).sort()).toEqual([b, d].sort());
        expect([b, c, d].map((id) => faux.isArchived(id))).toEqual([true, true, true]);
    });
});
