/**
 * THE MANAGED AGENTS SWITCH IS THE WORKSPACE'S (#5964, owner decisions
 * 2026-11-25), over a real database and a faux Anthropic workspace
 * (`tests/helpers/managed-agents-faux.ts`).
 *
 * `AGENT_MANAGED_AGENTS` is UNSET here, which is production today: each
 * workspace's owner decides on Admin → AI features.
 *
 *   • The decision: the three states of the variable against the workspace's
 *     column, read from the database, the operator's veto included.
 *   • The writer: an ADMIN, an API key, an agent and a job are refused and
 *     nothing is written; an owner in person writes, audited.
 *   • On: the provider is listed, a connection saves, the engine is offered
 *     and chosen, and a run proceeds.
 *   • Off: the provider is not listed, a save and a Test are refused by name,
 *     a new run is refused by name, a queued one fails by name, a paused one
 *     does not resume, and the connection and the engine choice are kept.
 *   • Another workspace, whose owner turned it on, is unaffected.
 *   • The clean-up still reaches the switched-off workspace's connection.
 */
const envOverride: Record<string, string | undefined> = {
    AGENT_PROFILES: '1',
    AGENT_MANAGED_AGENTS: undefined,
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
import { ManagedAgentsFaux } from '../helpers/managed-agents-faux';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants, deleteAuditRowsForUsers } from '../helpers/audit-cleanup';
import { __resetAuditStreamForTests } from '@/app-layer/events/audit-stream';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';
import { hashForLookup } from '@/lib/security/encryption';
import { createTenantWithDek } from '@/lib/security/tenant-key-manager';
import { DRIVER_IMPLEMENTED } from '@/lib/agentic/agent-driver';
import { profileRunKey } from '@/lib/agentic/agent-profile';
import { managedAgentsDecisionFor } from '@/lib/agentic/agent-switches-policy';
import { resolveDriverForTenant } from '@/lib/agentic/agent-driver-policy';
import { buildSystemContext } from '@/app-layer/context-system';
import { getAgentDriverSetting, setAgentDriverSetting } from '@/app-layer/usecases/agent-driver-setting';
import { getManagedAgentsSwitch, setManagedAgentsSwitch } from '@/app-layer/usecases/managed-agents-switch';
import { runManagedAgentsProvisionInForce } from '@/app-layer/jobs/managed-agents-provision-in-force';
import {
    listAvailableProvidersFor,
    removeIntegrationConnection,
    testConnectionCredentials,
    upsertIntegrationConnection,
} from '@/app-layer/usecases/integrations';
import {
    approveAgentProfileVersion,
    createAgentProfile,
    createAgentProfileVersion,
    startAgentProfileTestRun,
    submitAgentProfileVersion,
} from '@/app-layer/usecases/agent-profiles';
import { executeQueuedWorkflowRun, resumeWorkflowRun, startWorkflowRun } from '@/app-layer/usecases/workflow-runs';
import type { AgentProfileVersionInput } from '@/app-layer/schemas/agent-profile.schemas';
import type { RequestContext } from '@/app-layer/types';
import { prisma as appPrisma } from '@/lib/prisma';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }), transactionOptions: TENANT_TX_OPTIONS });
const describeFn = DB_AVAILABLE && DRIVER_IMPLEMENTED['managed-agents'] ? describe : describe.skip;
jest.setTimeout(180_000);

const SUITE = `maws-${randomUUID().slice(0, 8)}`;
const TENANT = `t-${SUITE}`;
const OTHER = `t-${SUITE}-b`;
const USERS = { owner: `u-owner-${SUITE}`, admin: `u-admin-${SUITE}`, otherOwner: `u-owner-b-${SUITE}` };
const AGENT = `ag-${SUITE}`;
const WORKSPACE_ID = 'wrkspc_workspaceSwitch';
const KEY = 'sk-ant-faux-workspace-key-for-switch'; // pragma: allowlist secret -- a placeholder for the faux

const ctxFor = (tenantId: string, role: Role, userId: string, over: Partial<RequestContext> = {}): RequestContext =>
    makeRequestContext(role, { tenantId, tenantSlug: tenantId, userId, ...over });
const owner = (over: Partial<RequestContext> = {}) => ctxFor(TENANT, 'OWNER', USERS.owner, over);
const admin = () => ctxFor(TENANT, 'ADMIN', USERS.admin);
const otherOwner = () => ctxFor(OTHER, 'OWNER', USERS.otherOwner);

const version = (): AgentProfileVersionInput => ({
    instructions: 'Summarise the open risks for the weekly review. Call list_risks once, then answer in one sentence.',
    toolNames: ['list_risks'],
    skillRefs: [],
    modelTier: 'balanced',
    effort: 'medium',
    maxTurns: 10,
    outputKind: 'ANSWER_ONLY',
    allowedTriggers: ['TEST_RUN'],
});

let faux: ManagedAgentsFaux;
let connectionId = '';
let profileId = '';

async function switchRows(tenantId: string) {
    return prisma.auditLog.findMany({ where: { tenantId, action: 'MANAGED_AGENTS_SWITCH_CHANGED' }, orderBy: { createdAt: 'asc' } });
}

async function storedToggle(tenantId: string): Promise<boolean | null> {
    const row = await prisma.tenantSecuritySettings.findUnique({ where: { tenantId }, select: { managedAgentsEnabled: true } });
    return row?.managedAgentsEnabled ?? null;
}

const listsWorkspaceProvider = async (ctx: RequestContext) =>
    (await listAvailableProvidersFor(ctx)).some((p) => p.id === 'anthropic-workspace');

async function cleanup(): Promise<void> {
    for (const tenantId of [TENANT, OTHER]) {
        await prisma.workflowStep.deleteMany({ where: { tenantId } });
        await prisma.agentProposal.deleteMany({ where: { tenantId } });
        await prisma.workflowRun.deleteMany({ where: { tenantId } });
        await prisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
            for (const table of ['AiDecisionLog', 'AgentProfileVersion', 'AgentProfile', 'TenantMembership', 'ManagedAgentsCleanup']) {
                await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "tenantId" = $1`, tenantId);
            }
        });
        await prisma.agentProfileProvision.deleteMany({ where: { tenantId } });
        await prisma.integrationConnection.deleteMany({ where: { tenantId } });
        await prisma.registeredAgentTool.deleteMany({ where: { tenantId } });
        await prisma.registeredAgent.deleteMany({ where: { tenantId } });
        await prisma.aiSystem.deleteMany({ where: { tenantId } });
        await prisma.tenantSecuritySettings.deleteMany({ where: { tenantId } });
    }
    await deleteAuditRowsForTenants(prisma, [TENANT, OTHER]).catch(() => undefined);
    await deleteAuditRowsForUsers(prisma, Object.values(USERS)).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: { in: Object.values(USERS) } } });
    await prisma.tenant.deleteMany({ where: { id: { in: [TENANT, OTHER] } } });
}

describeFn('the Managed Agents switch is the workspace\'s (real DB, faux workspace)', () => {
    beforeAll(async () => {
        await prisma.$connect();
        faux = new ManagedAgentsFaux();
        faux.install();
        await createTenantWithDek({ id: TENANT, name: TENANT, slug: TENANT });
        await createTenantWithDek({ id: OTHER, name: OTHER, slug: OTHER });
        for (const [tenantId, id, role] of [
            [TENANT, USERS.owner, 'OWNER'],
            [TENANT, USERS.admin, 'ADMIN'],
            [OTHER, USERS.otherOwner, 'OWNER'],
        ] as const) {
            const email = `${id}@example.test`;
            await prisma.user.create({ data: { id, email, emailHash: hashForLookup(email) } });
            await prisma.tenantMembership.create({ data: { tenantId, userId: id, role, status: 'ACTIVE' } });
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
                ownerUserId: USERS.owner,
                status: 'ACTIVE',
                riskTier: 'LOW',
                riskTierScoredAt: new Date(),
            },
        });
        await prisma.registeredAgentTool.create({
            data: { tenantId: TENANT, agentId: AGENT, toolName: 'list_risks', grantedByUserId: USERS.owner },
        });
        faux.turns = Array.from({ length: 10 }, () => [
            { toolCalls: [{ name: 'list_risks', args: {} }] },
            { text: 'There are no open risks to report this week.' },
        ]).flat();
    });

    afterAll(async () => {
        await cleanup();
        faux.uninstall();
        await appPrisma.$disconnect();
        await prisma.$disconnect();
        __resetAuditStreamForTests();
    });

    describe('the decision: the variable\'s three states against the workspace\'s column', () => {
        afterEach(() => {
            envOverride.AGENT_MANAGED_AGENTS = undefined;
        });

        it.each([
            [undefined, false, { on: false, basis: 'WORKSPACE_OFF' }],
            [undefined, true, { on: true, basis: 'WORKSPACE_ON' }],
            ['1', false, { on: true, basis: 'DEPLOYMENT_ON' }],
            ['true', true, { on: true, basis: 'DEPLOYMENT_ON' }],
            // The veto: any other set value is off, over a workspace that turned it on.
            ['0', true, { on: false, basis: 'DEPLOYMENT_OFF' }],
            ['yes', false, { on: false, basis: 'DEPLOYMENT_OFF' }],
        ] as const)('variable %p, workspace column %p', async (variable, column, expected) => {
            await prisma.tenantSecuritySettings.upsert({
                where: { tenantId: OTHER },
                create: { tenantId: OTHER, managedAgentsEnabled: column },
                update: { managedAgentsEnabled: column },
            });
            envOverride.AGENT_MANAGED_AGENTS = variable;
            expect(await managedAgentsDecisionFor({ tenantId: OTHER })).toEqual(expected);
            // By slug too: the same row.
            expect(await managedAgentsDecisionFor({ tenantSlug: OTHER })).toEqual(expected);
        });

        it('a workspace with no settings row has not turned it on', async () => {
            expect(await managedAgentsDecisionFor({ tenantId: TENANT })).toEqual({ on: false, basis: 'WORKSPACE_OFF' });
        });
    });

    describe('the writer: an owner, in person, audited', () => {
        it.each([
            ['an ADMIN', () => admin(), 'MANAGED_AGENTS_SWITCH_IS_OWNER_TIER'],
            ['an API key, even an owner\'s', () => owner({ apiKeyId: 'key-1', actorType: 'API_KEY' }), 'MANAGED_AGENTS_SWITCH_NOT_A_PERSON'],
            ['an agent, even an owner\'s', () => owner({ agentId: AGENT }), 'MANAGED_AGENTS_SWITCH_NOT_A_PERSON'],
            ['a job holding the owner key', () => owner({ actorType: 'JOB' }), 'MANAGED_AGENTS_SWITCH_NOT_A_PERSON'],
            ['a system job context', () => buildSystemContext({ tenantId: TENANT, job: 'some-job' }), 'MANAGED_AGENTS_SWITCH_IS_OWNER_TIER'],
        ] as const)('refuses %s, writing nothing', async (_label, ctxOf, reason) => {
            await expect(setManagedAgentsSwitch(ctxOf(), true)).rejects.toMatchObject({ status: 403, details: { reason } });
            expect(await storedToggle(TENANT)).toBeNull();
            expect(await switchRows(TENANT)).toEqual([]);
        });

        it('an admin reads it, and an owner turns it on: audited with the override and both answers', async () => {
            expect(await getManagedAgentsSwitch(admin())).toEqual({
                enabled: false,
                deployment: 'UNSET',
                effective: { on: false, basis: 'WORKSPACE_OFF' },
            });
            const after = await setManagedAgentsSwitch(owner(), true);
            expect(after).toEqual({
                enabled: true,
                deployment: 'UNSET',
                effective: { on: true, basis: 'WORKSPACE_ON' },
                // Off to on: the job that provisions what was approved while off.
                provisioning: 'QUEUED',
            });
            // Saying it again changes nothing and writes no second row.
            await setManagedAgentsSwitch(owner(), true);

            const rows = await switchRows(TENANT);
            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject({ userId: USERS.owner, actorType: 'USER' });
            expect(rows[0].detailsJson).toMatchObject({ category: 'access', operation: 'grant' });
            expect(rows[0].metadataJson).toMatchObject({
                from: false,
                to: true,
                deployment: 'UNSET',
                effectiveBefore: false,
                effectiveBasisBefore: 'WORKSPACE_OFF',
                effectiveAfter: true,
                effectiveBasisAfter: 'WORKSPACE_ON',
            });
        });

        it('takes a write while the operator decides, and says the effective answer did not move', async () => {
            envOverride.AGENT_MANAGED_AGENTS = '0';
            try {
                const after = await setManagedAgentsSwitch(otherOwner(), true);
                expect(after).toEqual({
                    enabled: true,
                    deployment: 'OFF',
                    effective: { on: false, basis: 'DEPLOYMENT_OFF' },
                    // The effective answer did not move: nothing to provision.
                    provisioning: 'NOT_NEEDED',
                });
            } finally {
                envOverride.AGENT_MANAGED_AGENTS = undefined;
            }
            expect(await managedAgentsDecisionFor({ tenantId: OTHER })).toEqual({ on: true, basis: 'WORKSPACE_ON' });
        });
    });

    describe('on: the provider is listed, the engine is offered, and a run proceeds', () => {
        it('lists the provider and saves a connection', async () => {
            expect(await listsWorkspaceProvider(owner())).toBe(true);
            const saved = await upsertIntegrationConnection(admin(), {
                provider: 'anthropic-workspace',
                name: 'Anthropic workspace',
                configJson: { workspaceId: WORKSPACE_ID },
                secrets: { apiKey: KEY },
            });
            connectionId = saved.id;
        });

        it('offers the engine, and the owner chooses it', async () => {
            const view = await getAgentDriverSetting(admin());
            expect(view.managedAgents).toMatchObject({ envEnabled: true, basis: 'WORKSPACE_ON', workspace: 'CONNECTED' });
            await setAgentDriverSetting(owner(), 'MANAGED_AGENTS');
            expect((await getAgentDriverSetting(admin())).effective).toEqual({ driver: 'managed-agents', reason: null });
        });

        it('the run gate\'s short-circuit does not read the unset variable as off, with every other engine off', async () => {
            // Flue unset and the Tool Runner vetoed: before #5964 this was the
            // "every engine off" short-circuit, and it would answer
            // ENV_DISABLED before reading the workspace's toggle.
            envOverride.AGENT_DRIVER_FLUE = undefined;
            envOverride.AGENT_DRIVER_TOOL_RUNNER = '0';
            try {
                expect(await resolveDriverForTenant(TENANT)).toEqual({ driver: 'managed-agents', reason: null });
                // The other workspace has not chosen it: static, its own reason.
                expect((await resolveDriverForTenant(OTHER)).driver).toBe('static');
            } finally {
                delete envOverride.AGENT_DRIVER_FLUE;
                delete envOverride.AGENT_DRIVER_TOOL_RUNNER;
            }
        });

        it('approves a version (which provisions its agent) and a Test run completes on the engine', async () => {
            const v1 = await createAgentProfile(owner(), AGENT, version());
            profileId = v1.profileId;
            await submitAgentProfileVersion(owner(), AGENT, 1);
            await approveAgentProfileVersion(admin(), AGENT, 1, { instructionsHash: v1.instructionsHash });
            expect(await prisma.agentProfileProvision.count({ where: { tenantId: TENANT, connectionId } })).toBe(1);

            const started = await startAgentProfileTestRun(admin(), AGENT, 1);
            expect(await executeQueuedWorkflowRun(TENANT, started.runId)).toMatchObject({ status: 'COMPLETED' });
            expect(await prisma.workflowRun.findUniqueOrThrow({ where: { id: started.runId }, select: { driver: true } })).toEqual({
                driver: 'MANAGED_AGENTS',
            });
        });
    });

    describe('off: runs stop and the set-up is kept', () => {
        let queuedRunId = '';
        let pausedRunId = '';

        beforeAll(async () => {
            // Two runs admitted while on: one left queued, one parked for a person.
            queuedRunId = (await startAgentProfileTestRun(admin(), AGENT, 1)).runId;
            pausedRunId = (await startAgentProfileTestRun(admin(), AGENT, 1)).runId;
            await prisma.workflowRun.update({ where: { id: pausedRunId }, data: { status: 'PAUSED' } });
            await setManagedAgentsSwitch(owner(), false);
        });

        it('hides the provider from this workspace\'s list', async () => {
            expect(await listsWorkspaceProvider(owner())).toBe(false);
        });

        it('refuses a save and a Test by name', async () => {
            await expect(
                upsertIntegrationConnection(admin(), {
                    id: connectionId,
                    provider: 'anthropic-workspace',
                    name: 'Anthropic workspace',
                    configJson: { workspaceId: WORKSPACE_ID },
                }),
            ).rejects.toMatchObject({ status: 409, details: { reason: 'MANAGED_AGENTS_OFF', basis: 'WORKSPACE_OFF' } });
            await expect(
                testConnectionCredentials(admin(), { connectionId, provider: 'anthropic-workspace' }),
            ).rejects.toMatchObject({ status: 409, details: { reason: 'MANAGED_AGENTS_OFF' } });
        });

        it('refuses a new run by name, before a run row exists', async () => {
            const runsBefore = await prisma.workflowRun.count({ where: { tenantId: TENANT } });
            await expect(
                startWorkflowRun({ ...admin(), agentId: AGENT }, profileRunKey(profileId, 1, { testRun: true }), {}, {
                    readOnlyAuthority: true,
                    profileTrigger: 'TEST_RUN',
                }),
            ).rejects.toMatchObject({ status: 409, details: { reason: 'MANAGED_AGENTS_OFF' } });
            expect(await prisma.workflowRun.count({ where: { tenantId: TENANT } })).toBe(runsBefore);
        });

        it('fails a queued run by name rather than continuing it', async () => {
            const sessionsBefore = faux.sessionCreates.length;
            expect(await executeQueuedWorkflowRun(TENANT, queuedRunId)).toEqual({ skipped: 'MANAGED_AGENTS_OFF' });
            const row = await prisma.workflowRun.findUniqueOrThrow({ where: { id: queuedRunId }, select: { status: true, errorMessage: true } });
            expect(row.status).toBe('FAILED');
            expect(row.errorMessage).toMatch(/^managed_agents_off: /);
            expect(faux.sessionCreates.length).toBe(sessionsBefore);
        });

        it('does not resume a paused run, and leaves it paused', async () => {
            await expect(resumeWorkflowRun(owner(), pausedRunId)).rejects.toMatchObject({
                status: 409,
                details: { reason: 'MANAGED_AGENTS_OFF' },
            });
            expect(await prisma.workflowRun.findUniqueOrThrow({ where: { id: pausedRunId }, select: { status: true } })).toEqual({
                status: 'PAUSED',
            });
        });

        it('keeps the connection, its key and the engine choice, and the engine reads static naming the workspace', async () => {
            expect(
                await prisma.integrationConnection.findUniqueOrThrow({
                    where: { id: connectionId },
                    select: { isEnabled: true, provider: true, secretEncrypted: true },
                }),
            ).toMatchObject({ isEnabled: true, provider: 'anthropic-workspace', secretEncrypted: expect.any(String) });
            const view = await getAgentDriverSetting(admin());
            expect(view.mode).toBe('MANAGED_AGENTS');
            expect(view.managedAgents).toMatchObject({ envEnabled: false, basis: 'WORKSPACE_OFF', workspace: 'CONNECTED' });
            expect(view.effective).toEqual({ driver: 'static', reason: 'ENV_DISABLED' });
            // Nothing at Anthropic was touched by turning it off.
            expect(faux.archives).toEqual([]);
        });

        it('another workspace whose owner turned it on is unaffected', async () => {
            await prisma.tenantSecuritySettings.update({ where: { tenantId: OTHER }, data: { managedAgentsEnabled: true } });
            expect(await listsWorkspaceProvider(otherOwner())).toBe(true);
            expect(await managedAgentsDecisionFor({ tenantId: OTHER })).toEqual({ on: true, basis: 'WORKSPACE_ON' });
        });

        it('the engine cannot be chosen again while the switch is off; moving away from it can (owner decision 2026-11-25)', async () => {
            await setAgentDriverSetting(owner(), 'STATIC');
            expect((await getAgentDriverSetting(admin())).mode).toBe('STATIC');
            await expect(setAgentDriverSetting(owner(), 'MANAGED_AGENTS')).rejects.toMatchObject({
                status: 409,
                details: { reason: 'MANAGED_AGENTS_OFF', basis: 'WORKSPACE_OFF' },
            });
            expect((await getAgentDriverSetting(admin())).mode).toBe('STATIC');
        });
    });

    describe('the versions in force are provisioned when the engine becomes usable (owner decisions 2026-11-25)', () => {
        const enqueueMock = () => (jest.requireMock('@/app-layer/jobs/queue') as { enqueue: jest.Mock }).enqueue;
        const provisionJobs = () =>
            enqueueMock().mock.calls.filter(([name]) => name === 'managed-agents-provision-in-force');

        /** The one job the last write enqueued, with the payload it named. */
        function theJobJustEnqueued(jobsBefore: number, trigger: 'SWITCH_ON' | 'ENGINE_CHOSEN') {
            const jobs = provisionJobs();
            expect(jobs.length).toBe(jobsBefore + 1);
            const payload = jobs[jobs.length - 1][1];
            expect(payload).toEqual({ tenantId: TENANT, requestedByUserId: USERS.owner, trigger, requestId: expect.any(String) });
            return payload;
        }

        /** Turn the switch on, then run the job it enqueued with the worker's own body. */
        async function switchOnAndRunTheJob() {
            const jobsBefore = provisionJobs().length;
            const write = await setManagedAgentsSwitch(owner(), true);
            expect(write.provisioning).toBe('QUEUED');
            return runManagedAgentsProvisionInForce(theJobJustEnqueued(jobsBefore, 'SWITCH_ON'));
        }

        async function provisionRows() {
            return prisma.auditLog.findMany({
                where: { tenantId: TENANT, action: 'MANAGED_AGENTS_PROFILES_PROVISIONED' },
                orderBy: { createdAt: 'asc' },
                select: { metadataJson: true },
            });
        }

        it('the realistic order: approved while off, switch on (nothing to run on yet), connect, choose the engine; the version is provisioned and runs', async () => {
            // No workspace connected yet, and (from the test above) the engine
            // is not Managed Agents: the state of a workspace meeting the switch
            // for the first time.
            await prisma.integrationConnection.update({ where: { id: connectionId }, data: { isEnabled: false } });
            expect((await getAgentDriverSetting(admin())).mode).toBe('STATIC');

            const v2 = await createAgentProfileVersion(owner(), AGENT, version());
            await submitAgentProfileVersion(owner(), AGENT, v2.version);
            await approveAgentProfileVersion(admin(), AGENT, v2.version, { instructionsHash: v2.instructionsHash });
            const provisionedV2 = () => prisma.agentProfileProvision.count({ where: { tenantId: TENANT, profileVersionId: v2.versionId } });
            expect(await provisionedV2()).toBe(0);

            // 1. The switch goes on: its job finds nothing to run on, and provisions nothing.
            const writesBefore = faux.agentWrites.length;
            expect(await switchOnAndRunTheJob()).toMatchObject({ outcome: 'NO_WORKSPACE', versions: 0, failed: [] });
            expect(await provisionedV2()).toBe(0);

            // 2. The workspace is connected (re-enabled through the product's save).
            await upsertIntegrationConnection(admin(), {
                id: connectionId,
                provider: 'anthropic-workspace',
                configJson: { workspaceId: WORKSPACE_ID },
                isEnabled: true,
            });
            expect(await provisionedV2()).toBe(0);

            // 3. The owner chooses the engine: that write enqueues the job, and it provisions.
            const jobsBefore = provisionJobs().length;
            const chose = await setAgentDriverSetting(owner(), 'MANAGED_AGENTS');
            expect(chose.provisioning).toBe('QUEUED');
            const result = await runManagedAgentsProvisionInForce(theJobJustEnqueued(jobsBefore, 'ENGINE_CHOSEN'));
            expect(result).toMatchObject({ outcome: 'PROVISIONED', versions: 1, created: 1, alreadyProvisioned: 0, failed: [] });
            expect(await provisionedV2()).toBe(1);
            // Through the approval's own path: the profile's agent updated, as a later approval does.
            expect(faux.agentWrites.slice(writesBefore).map((w) => w.op)).toEqual(['update']);
            expect((await provisionRows()).at(-1)?.metadataJson).toMatchObject({ trigger: 'ENGINE_CHOSEN', outcome: 'PROVISIONED', created: 1 });

            // No re-approval: a Test run of the version approved while off completes on the faux.
            const started = await startAgentProfileTestRun(admin(), AGENT, v2.version);
            expect(await executeQueuedWorkflowRun(TENANT, started.runId)).toMatchObject({ status: 'COMPLETED' });
        });

        it('re-saving Managed Agents enqueues nothing', async () => {
            const jobsBefore = provisionJobs().length;
            const again = await setAgentDriverSetting(owner(), 'MANAGED_AGENTS');
            expect(again.provisioning).toBe('NOT_NEEDED');
            expect(provisionJobs().length).toBe(jobsBefore);
        });

        it('turning it on again provisions nothing twice', async () => {
            await setManagedAgentsSwitch(owner(), false);
            const writesBefore = faux.agentWrites.length;
            const provisionsBefore = await prisma.agentProfileProvision.count({ where: { tenantId: TENANT } });
            const result = await switchOnAndRunTheJob();
            expect(result).toMatchObject({ outcome: 'PROVISIONED', versions: 1, created: 0, alreadyProvisioned: 1, failed: [] });
            expect(faux.agentWrites.length).toBe(writesBefore);
            expect(await prisma.agentProfileProvision.count({ where: { tenantId: TENANT } })).toBe(provisionsBefore);
        });

        it('a provisioning failure leaves the switch on and is recorded', async () => {
            await setManagedAgentsSwitch(owner(), false);
            const v3 = await createAgentProfileVersion(owner(), AGENT, version());
            await submitAgentProfileVersion(owner(), AGENT, v3.version);
            await approveAgentProfileVersion(admin(), AGENT, v3.version, { instructionsHash: v3.instructionsHash });

            faux.unreachable = true;
            let result;
            try {
                result = await switchOnAndRunTheJob();
            } finally {
                faux.unreachable = false;
            }
            expect(result).toMatchObject({ outcome: 'PARTIAL', created: 0, failed: [{ versionId: v3.versionId, reason: 'PROVIDER_ERROR' }] });
            expect(await storedToggle(TENANT)).toBe(true);
            expect(await managedAgentsDecisionFor({ tenantId: TENANT })).toEqual({ on: true, basis: 'WORKSPACE_ON' });
            expect((await provisionRows()).at(-1)?.metadataJson).toMatchObject({
                outcome: 'PARTIAL',
                failed: [{ versionId: v3.versionId, reason: 'PROVIDER_ERROR' }],
            });
        });

        it('a job that cannot be enqueued leaves the switch on and is recorded', async () => {
            await setManagedAgentsSwitch(owner(), false);
            enqueueMock().mockRejectedValueOnce(new Error('redis is down'));
            const write = await setManagedAgentsSwitch(owner(), true);
            expect(write).toMatchObject({ enabled: true, effective: { on: true }, provisioning: 'ENQUEUE_FAILED' });
            expect(await storedToggle(TENANT)).toBe(true);
            expect((await provisionRows()).at(-1)?.metadataJson).toMatchObject({ outcome: 'ENQUEUE_FAILED' });
        });

        it('turning it off enqueues nothing', async () => {
            const before = provisionJobs().length;
            expect((await setManagedAgentsSwitch(owner(), false)).provisioning).toBe('NOT_NEEDED');
            expect(provisionJobs().length).toBe(before);
        });
    });

    describe('the clean-up, and a switch-on with no workspace', () => {
        it('the clean-up still reaches the switched-off workspace\'s connection', async () => {
            expect(await managedAgentsDecisionFor({ tenantId: TENANT })).toMatchObject({ on: false });
            const agentIds = (
                await prisma.agentProfileProvision.findMany({ where: { tenantId: TENANT, connectionId }, select: { anthropicAgentId: true } })
            ).map((r) => r.anthropicAgentId);
            expect(agentIds.length).toBeGreaterThan(0);
            await removeIntegrationConnection(admin(), connectionId);
            for (const id of agentIds) expect(faux.archives).toContain(id);
            const cleanups = await prisma.managedAgentsCleanup.findMany({ where: { tenantId: TENANT, connectionId }, select: { status: true } });
            expect(cleanups.map((c) => c.status)).toEqual(['DONE']);
        });

        it('turning it back on with no workspace connected lists the provider and provisions nothing, without failing', async () => {
            const writesBefore = faux.agentWrites.length;
            const write = await setManagedAgentsSwitch(owner(), true);
            expect(write.provisioning).toBe('QUEUED');
            expect(await listsWorkspaceProvider(owner())).toBe(true);
            const jobs = (jest.requireMock('@/app-layer/jobs/queue') as { enqueue: jest.Mock }).enqueue.mock.calls.filter(
                ([name]) => name === 'managed-agents-provision-in-force',
            );
            const result = await runManagedAgentsProvisionInForce(jobs[jobs.length - 1][1]);
            expect(result).toMatchObject({ outcome: 'NO_WORKSPACE', versions: 0, failed: [] });
            expect(faux.agentWrites.length).toBe(writesBefore);
            const ops = (await switchRows(TENANT)).map((r) => (r.detailsJson as { operation?: string }).operation);
            expect(ops[0]).toBe('grant');
            expect(ops.at(-1)).toBe('grant');
        });
    });
});
