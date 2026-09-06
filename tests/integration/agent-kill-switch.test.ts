/**
 * THE KILL SWITCH — it stops an agent that is ALREADY RUNNING, at three scopes,
 * and pulling it is privileged and audited.
 *
 * Real database, real RLS, the real MCP funnel, the real workflow engine, the
 * real route handlers. Only `getTenantCtx` is mocked, and only for the two
 * route-driven blocks — everything below it (`requirePermission`,
 * `assertPermission`, `appendAuditEntry`, the usecase, RLS) is real.
 *
 * ## What each block proves, and why the obvious weaker test would not
 *
 *   1. MID-RUN. The engine resolves ONE `McpInvocation` per execution and drives
 *      every step on it. A control checked at DISPATCH and a control checked at
 *      the TOOL BOUNDARY are indistinguishable by status code — both refuse the
 *      next REQUEST — so the property is stated as "NO FURTHER TOOL EXECUTED"
 *      and asserted with a spy on the tool's own `run`. The kill is engaged from
 *      INSIDE the first tool call, which is the only way to make "mid-run" mean
 *      what it says. The paired positive (an identical run with no kill reaching
 *      all three steps) is what stops the assertion passing on a workflow that
 *      could never have got past step one.
 *
 *   2. THREE SCOPES, each proved by what it does NOT stop. An AGENT kill that
 *      also stopped the tenant's other agent would pass a test that only checked
 *      the killed one; a TENANT kill that also stopped another tenant would pass
 *      a test that only checked its own. So every scope is asserted against a
 *      NEIGHBOUR that must keep running, and the platform scope against the
 *      neighbour tenant that nothing narrower could reach.
 *
 *   3. FRESHNESS. Two calls on the SAME invocation with the kill engaged between
 *      them. A cached kill state — even one scoped to a single execution — would
 *      pass every other block in this file and fail here, which is the point:
 *      a cache that lags by one execution cycle is this control failing at the
 *      one moment it matters.
 *
 *   4. PRIVILEGE + AUDIT. The refused principal holds the NEIGHBOURING agent
 *      keys and not this one, because that is the composition the separate key
 *      exists to prevent and it is invisible to a test that only refuses a
 *      READER. Exactly one `AUTHZ_DENIED` row, the body never echoing the key,
 *      and — the half that matters most — NO kill row written by the refused
 *      request.
 *
 *   5. A PROPOSAL IN FLIGHT leaves no half-applied state. `runProposeTool`
 *      queues one `AgentProposal` per item in a loop; the gate runs before the
 *      loop is entered, so the assertion is that a killed propose step queues
 *      ZERO of its items, not "fewer".
 *
 *   6. TWO TENANTS. Tenant B cannot read, lift, or be stopped by tenant A's
 *      kill — the behavioural half of `AgentKillSwitch`'s RLS.
 */
const getTenantCtxMock = jest.fn();
jest.mock('@/app-layer/context', () => ({
    getTenantCtx: (params: unknown, req: unknown) => getTenantCtxMock(params, req),
}));

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { NextRequest } from 'next/server';
import { randomUUID } from 'crypto';

import { listMcpResources } from '@/lib/mcp/resources';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { getPermissionsForRole } from '@/lib/permissions';
import { resolveRoutePermission } from '@/lib/security/route-permissions';
import { verifyAuditChain } from '@/lib/audit';
import { registerWorkflow } from '@/lib/agentic/workflow-registry';
import { startWorkflowRun, getWorkflowRun } from '@/app-layer/usecases/workflow-runs';
import { resolveMcpInvocation } from '@/lib/mcp/auth';
import { runReadTool } from '@/lib/mcp/tools/registry';
import { getTenantContextTool } from '@/lib/mcp/tools/context-tools';
import {
    engagePlatformKill,
    liftPlatformKill,
    killRefusalMessage,
} from '@/lib/agentic/kill-switch';
import {
    engageKillSwitch,
    liftKillSwitch,
    listKillSwitches,
} from '@/app-layer/usecases/agent-kill-switch';
import { POST as KILL_POST, PATCH as KILL_PATCH } from '@/app/api/t/[tenantSlug]/admin/agents/kill-switch/route';
import { makeRequestContext } from '../helpers/make-context';
import type { RequestContext } from '@/app-layer/types';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(120_000);

/**
 * The tool's REAL implementation, captured at import time — before any spy.
 *
 * `jest.requireActual` returns the SAME module object the spy was installed on
 * (the registry holds one instance and `runReadTool` resolves through it), so a
 * "call through to the real thing" written that way recurses until the stack
 * runs out. Capturing the function itself is the only reference that survives
 * the spy.
 */
const REAL_PROBE_RUN = getTenantContextTool.run;

const SUITE = `ks-${randomUUID().slice(0, 8)}`;
const TENANT_A = `ka-${SUITE}`;
const TENANT_B = `kb-${SUITE}`;
const PROBE_TOOL = getTenantContextTool.name;
const WF_READS = `ks-reads-${SUITE}`;
const WF_PROPOSE = `ks-propose-${SUITE}`;

let agentA1 = '';
let agentA2 = '';
let agentB1 = '';

// ─── Seeding ────────────────────────────────────────────────────────

async function seedUser(suffix: string): Promise<string> {
    const userId = `u-${suffix}`;
    const email = `${suffix}@example.test`;
    await prisma.user.upsert({
        where: { id: userId },
        update: {},
        create: { id: userId, email, emailHash: hashForLookup(email) },
    });
    return userId;
}

async function seedAgent(tenantId: string, ownerUserId: string, name: string): Promise<string> {
    const aiSystem = await prisma.aiSystem.create({
        data: { tenantId, name: `${name} host`, ownerUserId },
    });
    const agent = await prisma.registeredAgent.create({
        data: {
            tenantId,
            aiSystemId: aiSystem.id,
            name,
            autonomyLevel: 4,
            dataAccessScope: 'READ_TENANT_DATA',
            reversibility: 'REVERSIBLE',
            provenance: 'FIRST_PARTY',
            ownerUserId,
            status: 'ACTIVE',
            // Scored LOW so the TIER term is never what refuses: an UNSCORED
            // agent is denied every tool, and an unscored fixture would make
            // every refusal below pass for the wrong reason.
            riskTier: 'LOW',
            riskTierScoredAt: new Date(),
        },
    });
    for (const toolName of [PROBE_TOOL, 'propose_risks']) {
        await prisma.registeredAgentTool.create({
            data: { tenantId, agentId: agent.id, toolName, grantedByUserId: ownerUserId },
        });
    }
    return agent.id;
}

async function seedTenant(tenantId: string): Promise<string> {
    await prisma.tenant.upsert({
        where: { id: tenantId },
        update: {},
        create: { id: tenantId, name: tenantId, slug: tenantId },
    });
    const owner = await seedUser(`${tenantId}-owner`);
    await prisma.tenantMembership.upsert({
        where: { tenantId_userId: { tenantId, userId: owner } },
        update: { role: 'OWNER', status: 'ACTIVE' },
        create: { tenantId, userId: owner, role: 'OWNER', status: 'ACTIVE' },
    });
    return owner;
}

// ─── Contexts ───────────────────────────────────────────────────────

function ownerCtx(tenantId: string, overrides: Partial<RequestContext> = {}): RequestContext {
    return makeRequestContext('OWNER', {
        tenantId,
        tenantSlug: tenantId,
        userId: `u-${tenantId}-owner`,
        ...overrides,
    });
}

/** An OWNER acting AS a specific registered agent, the way a run does. */
function agentCtx(tenantId: string, agentId: string): RequestContext {
    return ownerCtx(tenantId, { agentId });
}

/**
 * An ADMIN whose custom role holds the NEIGHBOURING agent keys and not this one.
 *
 * The principal the separate key exists for: somebody trusted to manage the
 * register and widen an approved agent's tool list, who must not thereby hold
 * the switch. A test that refused a READER would pass on a route gated by
 * `admin.manage`.
 */
function neighbourKeyCtx(tenantId: string): RequestContext {
    const base = getPermissionsForRole('ADMIN');
    return makeRequestContext('ADMIN', {
        tenantId,
        tenantSlug: tenantId,
        userId: `u-${tenantId}-owner`,
        appPermissions: {
            ...base,
            admin: {
                ...base.admin,
                agent_registry: true,
                agent_tool_exposure: true,
                agent_policy_card: true,
                agent_kill_switch: false,
            },
        },
    });
}

// ─── Probing the boundary ───────────────────────────────────────────

/**
 * Call a real read tool through the real funnel, and report the refusal.
 *
 * Returns `null` when the call was ALLOWED — which is what "the kill did
 * nothing" looks like, and is asserted explicitly rather than inferred from an
 * absent throw.
 */
async function callProbeTool(ctx: RequestContext): Promise<string | null> {
    try {
        const inv = await resolveMcpInvocation(ctx);
        await runReadTool(inv, PROBE_TOOL, {});
        return null;
    } catch (err) {
        return err instanceof Error ? err.message : String(err);
    }
}

/**
 * The OTHER door. `listMcpResources` reaches tenant data without going through
 * `runReadTool`, so a stop wired only into the tool funnel leaves it open — and
 * nothing pinned that half, which is how a guarantee stated in a docstring
 * becomes decoration.
 */
async function callProbeResource(ctx: RequestContext): Promise<string | null> {
    try {
        const inv = await resolveMcpInvocation(ctx);
        await listMcpResources(inv);
        return null;
    } catch (err) {
        return err instanceof Error ? err.message : String(err);
    }
}

const routeArgs = (tenantId: string) => ({ params: Promise.resolve({ tenantSlug: tenantId }) });

function req(tenantId: string, method: string, body?: unknown): NextRequest {
    return new NextRequest(`http://localhost/api/t/${tenantId}/admin/agents/kill-switch`, {
        method,
        headers: new Headers({ 'content-type': 'application/json' }),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
}

async function countDenials(tenantId: string): Promise<number> {
    return prisma.auditLog.count({ where: { tenantId, action: 'AUTHZ_DENIED' } });
}

/** Lift everything this suite could have left in force. */
async function liftAll(): Promise<void> {
    await prisma.agentKillSwitch
        .updateMany({
            where: { tenantId: { in: [TENANT_A, TENANT_B] }, liftedAt: null },
            data: { liftedAt: new Date(), liftedByUserId: 'test', liftReason: 'cleanup' },
        })
        .catch(() => {});
    await liftPlatformKill({ liftedByRef: 'test', liftReason: 'cleanup' }).catch(() => {});
}

describeFn('the agent kill switch stops a run already in flight (real DB)', () => {
    beforeAll(async () => {
        await prisma.$connect();
        const ownerA = await seedTenant(TENANT_A);
        const ownerB = await seedTenant(TENANT_B);
        agentA1 = await seedAgent(TENANT_A, ownerA, 'A one');
        agentA2 = await seedAgent(TENANT_A, ownerA, 'A two');
        agentB1 = await seedAgent(TENANT_B, ownerB, 'B one');

        registerWorkflow({
            key: WF_READS,
            name: 'Three reads',
            description: 'three read steps, so a kill after the first has somewhere to land',
            steps: [
                { kind: 'READ', label: 'one', tool: PROBE_TOOL },
                { kind: 'READ', label: 'two', tool: PROBE_TOOL },
                { kind: 'READ', label: 'three', tool: PROBE_TOOL },
            ],
        });
        registerWorkflow({
            key: WF_PROPOSE,
            name: 'Read then propose',
            description: 'a read step, then a propose step with three items',
            steps: [
                { kind: 'READ', label: 'one', tool: PROBE_TOOL },
                {
                    kind: 'PROPOSE',
                    label: 'proposed',
                    tool: 'propose_risks',
                    buildItems: () => [
                        { title: `${SUITE} risk 1`, description: 'x' },
                        { title: `${SUITE} risk 2`, description: 'x' },
                        { title: `${SUITE} risk 3`, description: 'x' },
                    ],
                },
            ],
        });
    });

    afterEach(async () => {
        jest.restoreAllMocks();
        await liftAll();
    });

    afterAll(async () => {
        for (const t of [TENANT_A, TENANT_B]) {
            await prisma.agentKillSwitch.deleteMany({ where: { tenantId: t } }).catch(() => {});
            await prisma.agentKillSwitchDrill.deleteMany({ where: { tenantId: t } }).catch(() => {});
            await prisma.workflowStep.deleteMany({ where: { tenantId: t } }).catch(() => {});
            await prisma.workflowRun.deleteMany({ where: { tenantId: t } }).catch(() => {});
            await prisma.agentProposal.deleteMany({ where: { tenantId: t } }).catch(() => {});
            await prisma.registeredAgentTool.deleteMany({ where: { tenantId: t } }).catch(() => {});
            await prisma.mcpToolManifestPin.deleteMany({ where: { tenantId: t } }).catch(() => {});
            await prisma.registeredAgent.deleteMany({ where: { tenantId: t } }).catch(() => {});
            await prisma.aiSystem.deleteMany({ where: { tenantId: t } }).catch(() => {});
            await prisma.$transaction(async (tx) => {
                await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
                await tx.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE "tenantId" = $1`, t);
                await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = $1`, t);
            }).catch(() => {});
            await prisma.tenant.deleteMany({ where: { id: t } }).catch(() => {});
        }
        await prisma.platformAgentKillSwitch.deleteMany({}).catch(() => {});
        await prisma.$disconnect();
    });

    // ── 1. MID-RUN ──────────────────────────────────────────────────

    it('a run with no kill reaches every step — the paired positive', async () => {
        const spy = jest.spyOn(getTenantContextTool, 'run');
        const result = await startWorkflowRun(agentCtx(TENANT_A, agentA1), WF_READS, {});
        expect(result.status).toBe('COMPLETED');
        // THREE. Without this the assertion below is equally consistent with a
        // workflow that could never have reached step two.
        expect(spy).toHaveBeenCalledTimes(3);
    });

    it('a kill issued MID-RUN stops the agent at the NEXT tool boundary — no further tool executed', async () => {
        const ctx = agentCtx(TENANT_A, agentA1);
        const spy = jest.spyOn(getTenantContextTool, 'run');
        let killed = false;
        spy.mockImplementation(async (toolCtx, args) => {
            const out = await REAL_PROBE_RUN.call(getTenantContextTool, toolCtx, args);
            if (!killed) {
                killed = true;
                // THE KILL, from inside the first tool call. This is what makes
                // "mid-run" mean what it says: the engine has already resolved
                // its one invocation and is between steps of a single execution.
                await engageKillSwitch(ownerCtx(TENANT_A), {
                    agentId: agentA1,
                    reason: 'Suspected runaway agent — integration test',
                });
            }
            return out;
        });

        const result = await startWorkflowRun(ctx, WF_READS, {});

        // THE ASSERTION. Not "the run ended" — the specific thing.
        expect(spy).toHaveBeenCalledTimes(1);

        expect(result.status).toBe('FAILED');
        const run = await getWorkflowRun(ctx, result.runId);
        expect(run.errorMessage).toContain('kill switch');
        // Step 0 completed (it ran before the kill), step 1 is the one that was
        // refused. A run that recorded the kill as a step-0 failure would be
        // reporting the wrong step to whoever reads the trail.
        expect(run.steps.find((s) => s.seq === 0)?.status).toBe('DONE');
        expect(run.steps.find((s) => s.seq === 1)?.status).toBe('FAILED');
    });

    // ── 2. THREE SCOPES ─────────────────────────────────────────────

    it('AGENT scope stops that agent and leaves the tenant\'s other agent running', async () => {
        await engageKillSwitch(ownerCtx(TENANT_A), { agentId: agentA1, reason: 'one agent only' });

        expect(await callProbeTool(agentCtx(TENANT_A, agentA1))).toBe(killRefusalMessage('AGENT'));
        // The neighbour that must NOT be stopped. Without it an AGENT kill that
        // silently behaved as a tenant kill would pass.
        expect(await callProbeTool(agentCtx(TENANT_A, agentA2))).toBeNull();
        expect(await callProbeTool(agentCtx(TENANT_B, agentB1))).toBeNull();
    });

    it('TENANT scope stops every agent in the tenant and leaves the other tenant running', async () => {
        await engageKillSwitch(ownerCtx(TENANT_A), { reason: 'stop everything here' });

        expect(await callProbeTool(agentCtx(TENANT_A, agentA1))).toBe(killRefusalMessage('TENANT'));
        expect(await callProbeTool(agentCtx(TENANT_A, agentA2))).toBe(killRefusalMessage('TENANT'));
        // Covers an UNREGISTERED caller too — a credential that resolved to no
        // agent. "Stop this tenant's agents" that left those running would stop
        // only the agents somebody had bothered to write down.
        expect(await callProbeTool(ownerCtx(TENANT_A))).toBe(killRefusalMessage('TENANT'));
        expect(await callProbeTool(agentCtx(TENANT_B, agentB1))).toBeNull();
    });

    it('PLATFORM scope stops agents in EVERY tenant, and outranks a tenant kill', async () => {
        // A tenant kill is in force first, so this also proves the precedence:
        // reporting AGENT or TENANT here would tell an operator who stopped the
        // deployment that a tenant admin can lift it.
        await engageKillSwitch(ownerCtx(TENANT_A), { agentId: agentA1, reason: 'narrower kill' });
        await engagePlatformKill({ reason: 'deployment-wide halt', engagedByRef: 'INC-1' });

        expect(await callProbeTool(agentCtx(TENANT_A, agentA1))).toBe(killRefusalMessage('PLATFORM'));
        expect(await callProbeTool(agentCtx(TENANT_B, agentB1))).toBe(killRefusalMessage('PLATFORM'));

        // …and lifting it lets the OTHER tenant run again while the narrower
        // tenant-A kill still bites. Two facts one assertion could not separate.
        await liftPlatformKill({ liftedByRef: 'INC-1', liftReason: 'incident closed' });
        expect(await callProbeTool(agentCtx(TENANT_B, agentB1))).toBeNull();
        expect(await callProbeTool(agentCtx(TENANT_A, agentA1))).toBe(killRefusalMessage('AGENT'));
    });

    it('lifting a kill lets the agent run again', async () => {
        const engaged = await engageKillSwitch(ownerCtx(TENANT_A), {
            agentId: agentA1,
            reason: 'temporary',
        });
        expect(await callProbeTool(agentCtx(TENANT_A, agentA1))).toBe(killRefusalMessage('AGENT'));

        await liftKillSwitch(ownerCtx(TENANT_A), engaged.id, { liftReason: 'all clear' });
        expect(await callProbeTool(agentCtx(TENANT_A, agentA1))).toBeNull();

        // The row SURVIVES the lift — it is the evidence that agents were
        // stopped between two timestamps, and a control that erases its own
        // history by being used is not auditable.
        const row = await prisma.agentKillSwitch.findFirstOrThrow({ where: { id: engaged.id } });
        expect(row.liftedAt).not.toBeNull();
        expect(row.liftedByUserId).toBe(`u-${TENANT_A}-owner`);
    });

    // ── 3. FRESHNESS ────────────────────────────────────────────────

    it('the kill state is re-read at EVERY tool call, not cached for the invocation', async () => {
        const ctx = agentCtx(TENANT_A, agentA1);
        // ONE invocation, reused — exactly what the workflow engine holds for a
        // whole execution.
        const inv = await resolveMcpInvocation(ctx);

        await expect(runReadTool(inv, PROBE_TOOL, {})).resolves.toBeDefined();

        await engageKillSwitch(ownerCtx(TENANT_A), { agentId: agentA1, reason: 'mid-invocation' });

        // A cache keyed on the invocation — even one scoped to a single
        // execution — passes the line above and fails here.
        await expect(runReadTool(inv, PROBE_TOOL, {})).rejects.toThrow(killRefusalMessage('AGENT'));
    });

    it('the kill is checked BEFORE the credential and exposure checks — the refusal names the kill', async () => {
        // ORDERING, behaviourally. A gate that checked the kill LAST would still
        // refuse this call — by something else — and every status code would
        // look right while the stop control was dead. So the agent is put in a
        // state where TWO later steps would also refuse: its tool grant is taken
        // away (step 4, `tool_not_granted`) and its registration is suspended
        // (which refuses at assembly). The refusal that comes back must still be
        // the KILL's.
        //
        // This is the property the nightly drill deliberately does NOT assert —
        // a job module may not import the gate (see the drill's
        // `probeBoundaryDecision`) — so it is asserted here, in CI, where a
        // compile-time fact belongs.
        await engageKillSwitch(ownerCtx(TENANT_A), { agentId: agentA2, reason: 'ordering' });
        await prisma.registeredAgentTool.deleteMany({
            where: { tenantId: TENANT_A, agentId: agentA2, toolName: PROBE_TOOL },
        });

        expect(await callProbeTool(agentCtx(TENANT_A, agentA2))).toBe(killRefusalMessage('AGENT'));

        // The paired negative: with the kill lifted, the SAME call is refused —
        // by the exposure check. Without this the assertion above would pass on
        // a gate that had simply stopped enforcing the grant.
        const inForce = await prisma.agentKillSwitch.findFirstOrThrow({
            where: { tenantId: TENANT_A, agentId: agentA2, liftedAt: null },
        });
        await liftKillSwitch(ownerCtx(TENANT_A), inForce.id, { liftReason: 'ordering probe done' });
        const afterLift = await callProbeTool(agentCtx(TENANT_A, agentA2));
        expect(afterLift).toContain('not granted');
        expect(afterLift).not.toBe(killRefusalMessage('AGENT'));

        await prisma.registeredAgentTool.create({
            data: {
                tenantId: TENANT_A,
                agentId: agentA2,
                toolName: PROBE_TOOL,
                grantedByUserId: `u-${TENANT_A}-owner`,
            },
        });
    });

    // ── 4. PRIVILEGE + AUDIT ────────────────────────────────────────

    it('the declarative map resolves this path to its own key, above the register catch-all', () => {
        for (const method of ['GET', 'POST', 'PATCH'] as const) {
            expect(
                resolveRoutePermission(`/api/t/${TENANT_A}/admin/agents/kill-switch`, method)
                    ?.permission,
            ).toBe('admin.agent_kill_switch');
        }
        // The neighbour still resolves to the neighbour's key — so the above is
        // about ORDERING, not a rule that matches everything under admin/agents.
        expect(
            resolveRoutePermission(`/api/t/${TENANT_A}/admin/agents/${agentA1}/tools`, 'POST')
                ?.permission,
        ).toBe('admin.agent_tool_exposure');
    });

    it('a principal holding the NEIGHBOURING agent keys is refused, audited once, and told nothing', async () => {
        getTenantCtxMock.mockResolvedValue(neighbourKeyCtx(TENANT_A));
        const before = await countDenials(TENANT_A);
        const killsBefore = await prisma.agentKillSwitch.count({ where: { tenantId: TENANT_A } });

        const res = await KILL_POST(
            req(TENANT_A, 'POST', { agentId: agentA1, reason: 'nope' }),
            routeArgs(TENANT_A),
        );
        expect(res.status).toBe(403);

        // The 403 never echoes the key — otherwise the permission namespace is
        // enumerable one request at a time.
        const body = JSON.stringify(await res.json());
        expect(body).not.toContain('agent_kill_switch');
        expect(body).not.toContain('admin.');

        // EXACTLY one row. A second gate a layer down would double every denial
        // and make the trail count refusals rather than attempts.
        expect(await countDenials(TENANT_A)).toBe(before + 1);
        const row = await prisma.auditLog.findFirstOrThrow({
            where: { tenantId: TENANT_A, action: 'AUTHZ_DENIED' },
            orderBy: { createdAt: 'desc' },
        });
        expect(row.entity).toBe('Permission');
        expect(row.entityId).toBe('admin.agent_kill_switch');
        expect(row.entryHash).not.toBeNull();

        // …and NOTHING was written. A route that audited the denial and then ran
        // the handler anyway would pass every assertion above.
        expect(await prisma.agentKillSwitch.count({ where: { tenantId: TENANT_A } })).toBe(
            killsBefore,
        );
    });

    it('a principal holding the key CAN engage and lift, and both are audited into a chain that verifies', async () => {
        getTenantCtxMock.mockResolvedValue(ownerCtx(TENANT_A));

        const engaged = await KILL_POST(
            req(TENANT_A, 'POST', { agentId: agentA1, reason: 'suspected runaway' }),
            routeArgs(TENANT_A),
        );
        expect(engaged.status).toBe(201);
        const engagedBody = (await engaged.json()) as { id: string; scope: string };
        expect(engagedBody.scope).toBe('AGENT');

        const lifted = await KILL_PATCH(
            req(TENANT_A, 'PATCH', { switchId: engagedBody.id, liftReason: 'cleared' }),
            routeArgs(TENANT_A),
        );
        expect(lifted.status).toBe(200);

        for (const action of ['AGENT_KILL_ENGAGED', 'AGENT_KILL_LIFTED']) {
            const found = await prisma.auditLog.findFirst({
                where: { tenantId: TENANT_A, action, entityId: engagedBody.id },
            });
            expect(found).not.toBeNull();
        }

        // A row appended under a privileged act is still a row in the tenant's
        // hash chain; a broken link would make every later entry unverifiable.
        const chain = await verifyAuditChain(TENANT_A);
        expect(chain.valid).toBe(true);
    });

    // ── 5. A PROPOSAL IN FLIGHT ─────────────────────────────────────

    it('an agent killed while a proposal is in flight leaves NO half-applied state', async () => {
        const ctx = agentCtx(TENANT_A, agentA1);
        const proposalsBefore = await prisma.agentProposal.count({ where: { tenantId: TENANT_A } });
        const risksBefore = await prisma.risk.count({ where: { tenantId: TENANT_A } });

        const spy = jest.spyOn(getTenantContextTool, 'run');
        spy.mockImplementation(async (toolCtx, args) => {
            const out = await REAL_PROBE_RUN.call(getTenantContextTool, toolCtx, args);
            await engageKillSwitch(ownerCtx(TENANT_A), {
                agentId: agentA1,
                reason: 'killed between the read and the propose',
            });
            return out;
        });

        const result = await startWorkflowRun(ctx, WF_PROPOSE, {});
        expect(result.status).toBe('FAILED');

        // ZERO, not "fewer". `runProposeTool` queues one AgentProposal per item
        // in a loop; the gate runs before the loop is entered, so a killed
        // propose step must queue none of its three — a partial batch is the
        // half-applied state this asserts against.
        expect(await prisma.agentProposal.count({ where: { tenantId: TENANT_A } })).toBe(
            proposalsBefore,
        );
        // And nothing was committed for real either — the propose-not-commit
        // property still holds on the way out.
        expect(await prisma.risk.count({ where: { tenantId: TENANT_A } })).toBe(risksBefore);

        const run = await getWorkflowRun(ctx, result.runId);
        expect(run.steps.find((s) => s.seq === 1)?.status).toBe('FAILED');
    });

    // ── 6. TWO TENANTS ──────────────────────────────────────────────

    it('tenant B can neither see nor lift tenant A\'s kill', async () => {
        const engaged = await engageKillSwitch(ownerCtx(TENANT_A), {
            agentId: agentA1,
            reason: 'A only',
        });

        const bView = await listKillSwitches(ownerCtx(TENANT_B));
        expect(bView.history.map((k) => k.id)).not.toContain(engaged.id);
        expect(bView.inForce).toHaveLength(0);

        // Not "returns nothing" — REFUSES. A lift that silently no-op'd would
        // look identical to a tenant with no such switch, and the operator in
        // tenant B would be told they had lifted something.
        await expect(
            liftKillSwitch(ownerCtx(TENANT_B), engaged.id, { liftReason: 'not mine' }),
        ).rejects.toThrow();

        // Still in force in A — the refusal above did not partially apply.
        const stillDown = await prisma.agentKillSwitch.findFirstOrThrow({
            where: { id: engaged.id },
        });
        expect(stillDown.liftedAt).toBeNull();
        expect(await callProbeTool(agentCtx(TENANT_A, agentA1))).toBe(killRefusalMessage('AGENT'));
    });

    it('a kill naming another tenant\'s agent id is refused rather than written', async () => {
        await expect(
            engageKillSwitch(ownerCtx(TENANT_B), { agentId: agentA1, reason: 'cross-tenant' }),
        ).rejects.toThrow();
        expect(
            await prisma.agentKillSwitch.count({ where: { tenantId: TENANT_B, agentId: agentA1 } }),
        ).toBe(0);
    });

    describe('the stop covers BOTH doors, not just the tool funnel', () => {
        it('a killed agent cannot read through the resources surface either', async () => {
            // Deleting `assertNotKilled` from `authorizeResourceRead` left the whole
            // kill suite green, so this half of the guarantee was untested. A stop
            // that covers one of two doors is a stop somebody walks around.
            expect(await callProbeResource(agentCtx(TENANT_A, agentA1))).toBeNull();

            await engageKillSwitch(ownerCtx(TENANT_A), {
                agentId: agentA1,
                reason: 'Resources-door coverage — integration test',
            });

            expect(await callProbeResource(agentCtx(TENANT_A, agentA1))).toBe(
                killRefusalMessage('AGENT'),
            );
            // …and the tool door agrees, so this is not a resources-only artefact.
            expect(await callProbeTool(agentCtx(TENANT_A, agentA1))).toBe(
                killRefusalMessage('AGENT'),
            );
            // The neighbour is untouched on BOTH doors.
            expect(await callProbeResource(agentCtx(TENANT_A, agentA2))).toBeNull();
        });
    });
});

