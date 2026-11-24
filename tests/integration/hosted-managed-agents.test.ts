/**
 * HOSTED MANAGED AGENTS, BEHIND A CONSTANT THAT IS FALSE (Step 6b of
 * `docs/claude-managed-agents-design.md`, shape MA-C1), over a real database
 * and a faux Anthropic workspace (`tests/helpers/managed-agents-faux.ts`)
 * that stands for INFLECT's own workspace, shared by two tenants.
 *
 *   • The opt-in has one writer: OWNER-tier, a person, audited. ADMIN, an API
 *     key, an agent and a job are refused; while the constant is false no
 *     workspace can opt in at all.
 *   • Capacity: the per-tenant and the deployment-wide caps hold under
 *     concurrent claims, one tenant's burst leaves a slot for another, and a
 *     run that stops executing stops counting.
 *   • Shared workspace: opting out and the purge delete and archive only the
 *     tenant's own recorded ids, with the other tenant's session and a foreign
 *     one present. The purge of Inflect's workspace is retried, because its key
 *     is not destroyed with the tenant's rows (decision 7 is about the
 *     customer's key).
 *   • With the constant false, nothing reaches the workspace with Inflect's
 *     key: not a clean-up, not a reconciliation.
 *
 * ═══ THE MODULE SEAM ═══
 *
 * `HOSTED_MANAGED_AGENTS_ACTIVE` is read through a getter on a `jest.mock`
 * of its leaf module, so a test can hold it true. Production has no such
 * seam; `tests/guards/hosted-managed-agents-activation.test.ts` holds that
 * nothing in `src/` writes the constant.
 */
const mockActivation = { active: true };
jest.mock('@/lib/agentic/managed-agents/hosted-activation', () => ({
    get HOSTED_MANAGED_AGENTS_ACTIVE() {
        return mockActivation.active;
    },
}));

const HOSTED_KEY = 'sk-ant-inflect-hosted-faux-key'; // pragma: allowlist secret -- a placeholder for the faux
const HOSTED_WORKSPACE = 'wrkspc_inflect_hosted_faux';
const envOverride: Record<string, string | undefined> = {
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

// The plan entitlement: no plan includes hosting (the owner opens one), so the
// writes below that need it hold it through this seam; `null` is the real one.
const mockEntitled: { value: boolean | null } = { value: true };
jest.mock('@/lib/billing/entitlements', () => {
    const actual = jest.requireActual('@/lib/billing/entitlements') as typeof import('@/lib/billing/entitlements');
    return {
        ...actual,
        isEntitledTo: jest.fn(async (ctx: Parameters<typeof actual.isEntitledTo>[0], feature: Parameters<typeof actual.isEntitledTo>[1]) =>
            mockEntitled.value === null ? actual.isEntitledTo(ctx, feature) : mockEntitled.value,
        ),
    };
});

import { PrismaClient } from '@prisma/client';
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
import { recordStep } from '@/lib/agentic/drivers/step-recorder';
import { sessionMetadataFor } from '@/lib/agentic/managed-agents/definition';
import { SESSION_STEP_LABEL, type SessionLifecycle } from '@/lib/agentic/managed-agents/execute';
import { INFLECT_HOSTED_CONNECTION_ID, resolveManagedAgentsWorkspace } from '@/lib/agentic/managed-agents/workspace';
import {
    HOSTED_MAX_CONCURRENT_RUNS,
    HOSTED_MAX_CONCURRENT_RUNS_PER_TENANT,
    claimHostedSlot,
} from '@/lib/agentic/managed-agents/hosted-capacity';
import { buildSystemContext } from '@/app-layer/context-system';
import { getHostedManagedAgentsSetting, setHostedManagedAgentsOptIn } from '@/app-layer/usecases/hosted-managed-agents-opt-in';
import { purgeSoftDeletedTenants } from '@/app-layer/usecases/tenant-purge';
import { reconcileLostSessionDeletes, retryOpenManagedAgentsCleanups } from '@/app-layer/usecases/managed-agents-cleanup';
import type { RequestContext } from '@/app-layer/types';
import { prisma as appPrisma } from '@/lib/prisma';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }), transactionOptions: TENANT_TX_OPTIONS });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(180_000);

const SUITE = `hma-${randomUUID().slice(0, 8)}`;
const tenants: string[] = [];
const users: string[] = [];

const ownerOf = (tenantId: string) => `${tenantId}-owner`;
const ownerCtx = (tenantId: string, over: Partial<RequestContext> = {}): RequestContext =>
    makeRequestContext('OWNER', { tenantId, tenantSlug: tenantId, userId: ownerOf(tenantId), ...over });

let faux: ManagedAgentsFaux;

async function newTenant(label: string): Promise<string> {
    const tenantId = `t-${SUITE}-${label}`;
    tenants.push(tenantId);
    await createTenantWithDek({ id: tenantId, name: `Tenant ${label} Ltd`, slug: tenantId });
    const owner = ownerOf(tenantId);
    users.push(owner);
    await prisma.user.create({ data: { id: owner, email: `${owner}@example.test`, emailHash: hashForLookup(`${owner}@example.test`) } });
    await prisma.tenantMembership.create({ data: { tenantId, userId: owner, role: 'OWNER', status: 'ACTIVE' } });
    return tenantId;
}

async function seq(tenantId: string, runId: string): Promise<number> {
    return (await prisma.workflowStep.count({ where: { tenantId, runId } })) + 1;
}

async function newRun(tenantId: string, status: 'COMPLETED' | 'RUNNING' = 'COMPLETED'): Promise<string> {
    return (
        await prisma.workflowRun.create({
            data: { tenantId, workflowKey: 'agent-profile:p@v1', status, driver: 'MANAGED_AGENTS' },
            select: { id: true },
        })
    ).id;
}

/** One tenant's records in Inflect's workspace: a provision, a ledger, and the objects they name. */
interface HostedWorld {
    readonly tenantId: string;
    readonly agentId: string;
    readonly runId: string;
    /** Recorded CREATED only: a run a worker died in. */
    readonly createdOnly: string;
    /** Recorded DELETE_FAILED. */
    readonly deleteFailed: string;
    /** On the recorded agent, this tenant's metadata, no step: the crash window. */
    readonly crashWindow: string;
}

async function recordLifecycle(tenantId: string, runId: string, sessionId: string, lifecycles: SessionLifecycle[]): Promise<void> {
    for (const lifecycle of lifecycles) {
        await recordStep(ownerCtx(tenantId), runId, await seq(tenantId, runId), 'SYNTHESIS', {
            status: lifecycle === 'SESSION_DELETE_FAILED' ? 'FAILED' : 'DONE',
            label: SESSION_STEP_LABEL,
            input: { lifecycle, sessionId, connectionId: INFLECT_HOSTED_CONNECTION_ID, workspaceKind: 'HOSTED' },
        });
    }
}

async function seedHosted(tenantId: string, label: string): Promise<HostedWorld> {
    const agentId = faux.seedAgent(`inflect-profile-${label}`);
    await prisma.agentProfileProvision.create({
        data: {
            tenantId,
            profileId: `profile-${label}`,
            profileVersionId: `version-${label}`,
            connectionId: INFLECT_HOSTED_CONNECTION_ID,
            anthropicAgentId: agentId,
            anthropicAgentVersion: 1,
            environmentId: 'env_faux',
            systemHash: 'a'.repeat(64),
            toolsHash: 'b'.repeat(64),
        },
    });
    const runId = await newRun(tenantId);
    const meta = sessionMetadataFor(tenantId, runId);
    const createdOnly = faux.seedSession({ agentId, metadata: meta });
    const deleteFailed = faux.seedSession({ agentId, metadata: meta });
    await recordLifecycle(tenantId, runId, createdOnly, ['SESSION_CREATED']);
    await recordLifecycle(tenantId, runId, deleteFailed, ['SESSION_CREATED', 'SESSION_DELETE_FAILED']);
    const crashWindow = faux.seedSession({ agentId, metadata: sessionMetadataFor(tenantId, await newRun(tenantId)) });
    return { tenantId, agentId, runId, createdOnly, deleteFailed, crashWindow };
}

function held(w: HostedWorld): Record<string, boolean> {
    return {
        createdOnly: faux.holdsSession(w.createdOnly),
        deleteFailed: faux.holdsSession(w.deleteFailed),
        crashWindow: faux.holdsSession(w.crashWindow),
        agentArchived: faux.isArchived(w.agentId),
    };
}
const UNTOUCHED = { createdOnly: true, deleteFailed: true, crashWindow: true, agentArchived: false };
const CLEANED = { createdOnly: false, deleteFailed: false, crashWindow: false, agentArchived: true };

/** Every request the faux took was sent with Inflect's own key, to Inflect's own workspace. */
function everyRequestIsInflects(): void {
    expect(faux.requests.length).toBeGreaterThan(0);
    for (const r of faux.requests) {
        // SDK 1.x sends the key as a bearer token.
        expect({ key: r.headers.get('authorization'), workspace: r.headers.get('anthropic-workspace-id') }).toEqual({
            key: `Bearer ${HOSTED_KEY}`,
            workspace: HOSTED_WORKSPACE,
        });
    }
}

async function records(tenantId: string) {
    return prisma.managedAgentsCleanup.findMany({ where: { tenantId }, orderBy: { createdAt: 'asc' } });
}

async function optInRow(tenantId: string, optIn: boolean): Promise<void> {
    await prisma.tenantSecuritySettings.upsert({
        where: { tenantId },
        create: { tenantId, hostedManagedAgentsOptIn: optIn },
        update: { hostedManagedAgentsOptIn: optIn },
    });
}

beforeEach(() => {
    mockActivation.active = true;
    mockEntitled.value = true;
    faux = new ManagedAgentsFaux();
    faux.install();
});

afterEach(() => {
    faux.uninstall();
});

afterAll(async () => {
    await prisma.workflowStep.deleteMany({ where: { tenantId: { in: tenants } } });
    await prisma.workflowRun.deleteMany({ where: { tenantId: { in: tenants } } });
    await prisma.agentProfileProvision.deleteMany({ where: { tenantId: { in: tenants } } });
    await prisma.tenantSecuritySettings.deleteMany({ where: { tenantId: { in: tenants } } });
    await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = ANY($1)`, tenants);
        await tx.$executeRawUnsafe(`DELETE FROM "ManagedAgentsCleanup" WHERE "tenantId" = ANY($1)`, tenants);
    });
    await deleteAuditRowsForTenants(prisma, tenants).catch(() => undefined);
    await deleteAuditRowsForUsers(prisma, users).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    for (const tenantId of tenants) {
        await prisma.tenant.delete({ where: { id: tenantId } }).catch(() => undefined);
    }
    await appPrisma.$disconnect();
    await prisma.$disconnect();
    __resetAuditStreamForTests();
});

describeFn('Step 6b — the opt-in has one writer: an owner, in person, audited', () => {
    let tenantId = '';
    beforeAll(async () => {
        tenantId = await newTenant('optin');
    });

    async function auditRows() {
        return prisma.auditLog.findMany({ where: { tenantId, action: 'HOSTED_MANAGED_AGENTS_OPT_IN_CHANGED' }, orderBy: { createdAt: 'asc' } });
    }

    it.each([
        ['an ADMIN', () => makeRequestContext('ADMIN', { tenantId, tenantSlug: tenantId, userId: ownerOf(tenantId) }), 'HOSTED_OPT_IN_IS_OWNER_TIER'],
        ['an API key, even an owner\'s', () => ownerCtx(tenantId, { apiKeyId: 'key-1', actorType: 'API_KEY' }), 'HOSTED_OPT_IN_NOT_A_PERSON'],
        ['an agent, even an owner\'s', () => ownerCtx(tenantId, { agentId: 'agent-1' }), 'HOSTED_OPT_IN_NOT_A_PERSON'],
        ['a job holding the owner key', () => ownerCtx(tenantId, { actorType: 'JOB' }), 'HOSTED_OPT_IN_NOT_A_PERSON'],
        ['a system job context', () => buildSystemContext({ tenantId, job: 'some-job' }), 'HOSTED_OPT_IN_IS_OWNER_TIER'],
    ] as const)('refuses %s, writing nothing', async (_label, ctxOf, reason) => {
        for (const optIn of [true, false]) {
            await expect(setHostedManagedAgentsOptIn(ctxOf(), optIn)).rejects.toMatchObject({ status: 403, details: { reason } });
        }
        await expect(getHostedManagedAgentsSetting(ctxOf())).rejects.toMatchObject({ status: 403 });
        expect(await prisma.tenantSecuritySettings.findUnique({ where: { tenantId }, select: { hostedManagedAgentsOptIn: true } })).toBeNull();
        expect(await auditRows()).toEqual([]);
    });

    it('while the constant is false, no workspace can opt in: HOSTED_NOT_OFFERED, nothing written', async () => {
        mockActivation.active = false;
        expect(await getHostedManagedAgentsSetting(ownerCtx(tenantId))).toMatchObject({ offered: false, optedIn: false, hostedRefusal: 'HOSTED_NOT_ACTIVE' });
        await expect(setHostedManagedAgentsOptIn(ownerCtx(tenantId), true)).rejects.toMatchObject({
            status: 409,
            details: { reason: 'HOSTED_NOT_OFFERED' },
        });
        expect(await auditRows()).toEqual([]);
    });

    it('a plan without the entitlement cannot opt in (the real entitlement: no plan includes it)', async () => {
        mockEntitled.value = null;
        await expect(setHostedManagedAgentsOptIn(ownerCtx(tenantId), true)).rejects.toMatchObject({
            status: 409,
            details: { reason: 'HOSTED_NOT_ENTITLED' },
        });
        expect(await auditRows()).toEqual([]);
    });

    it('an owner in person opts in and out; each change is audited with the terms beside it, and opting out runs the clean-up', async () => {
        const inResult = await setHostedManagedAgentsOptIn(ownerCtx(tenantId), true);
        expect(inResult).toMatchObject({ setting: { optedIn: true, offered: true, workspace: 'HOSTED' }, cleanup: null });
        // Saying it again changes nothing and writes no second row.
        await setHostedManagedAgentsOptIn(ownerCtx(tenantId), true);

        const outResult = await setHostedManagedAgentsOptIn(ownerCtx(tenantId), false);
        expect(outResult.setting).toMatchObject({ optedIn: false, hostedRefusal: 'HOSTED_NOT_OPTED_IN' });
        // Nothing was recorded there, and the clean-up says so.
        expect(outResult.cleanup).toEqual({ status: 'DONE', reason: 'NOTHING_RECORDED' });

        const rows = await auditRows();
        expect(rows.map((r) => (r.detailsJson as { operation?: string } | null)?.operation)).toEqual(['grant', 'revoke']);
        expect(rows[0]).toMatchObject({ userId: ownerOf(tenantId), actorType: 'USER' });
        expect(JSON.stringify(rows)).not.toContain(HOSTED_KEY);
    });
});

describeFn('Step 6b — capacity: both caps hold under concurrent runs', () => {
    const live = new Map<string, string>();

    /** A RUNNING run holding a live lease, as the worker's claim leaves it. */
    async function executingRun(tenantId: string): Promise<string> {
        const runId = await newRun(tenantId, 'RUNNING');
        const lease = `lease-${randomUUID()}`;
        await prisma.$executeRaw`
            UPDATE "WorkflowRun" SET "leaseHolder" = ${lease}, "leaseExpiresAt" = now() + interval '60 seconds' WHERE "id" = ${runId}`;
        live.set(runId, lease);
        return runId;
    }
    const claim = (tenantId: string, runId: string) => claimHostedSlot(ownerCtx(tenantId, { runLeaseToken: live.get(runId) }), runId);
    const outcome = (r: Awaited<ReturnType<typeof claimHostedSlot>>) => (r.ok ? 'CLAIMED' : r.reason);

    afterEach(async () => {
        // Settle every run this block started, so none counts against another file.
        await prisma.workflowRun.updateMany({ where: { id: { in: [...live.keys()] } }, data: { status: 'COMPLETED', leaseHolder: null, leaseExpiresAt: null } });
        live.clear();
    });

    it('the caps are below one another: a burst always leaves a slot', () => {
        expect(HOSTED_MAX_CONCURRENT_RUNS_PER_TENANT).toBeLessThan(HOSTED_MAX_CONCURRENT_RUNS);
    });

    it('a burst from one tenant takes its cap and no more, another tenant still runs, and the deployment cap holds across tenants', async () => {
        const [a, b, c] = [await newTenant('cap-a'), await newTenant('cap-b'), await newTenant('cap-c')];
        // Tenant A bursts: five runs claim at the same instant.
        const burst = await Promise.all(Array.from({ length: 5 }, () => executingRun(a)));
        const burstOutcomes = (await Promise.all(burst.map((r) => claim(a, r)))).map(outcome);
        expect(burstOutcomes.filter((o) => o === 'CLAIMED')).toHaveLength(HOSTED_MAX_CONCURRENT_RUNS_PER_TENANT);
        expect(burstOutcomes.filter((o) => o === 'HOSTED_CAPACITY_TENANT')).toHaveLength(5 - HOSTED_MAX_CONCURRENT_RUNS_PER_TENANT);

        // Tenant B is not starved by A's burst.
        const bRun = await executingRun(b);
        expect(outcome(await claim(b, bRun))).toBe('CLAIMED');

        // The deployment is now full: tenant C is refused by the deployment's cap.
        const cRun = await executingRun(c);
        expect(outcome(await claim(c, cRun))).toBe('HOSTED_CAPACITY_DEPLOYMENT');
        const slots = await prisma.workflowRun.count({ where: { hostedManagedAgents: true, status: 'RUNNING', id: { in: [...live.keys()] } } });
        expect(slots).toBe(HOSTED_MAX_CONCURRENT_RUNS);

        // A run that settles stops counting: C now gets its slot.
        const aClaimed = burst[burstOutcomes.indexOf('CLAIMED')];
        await prisma.workflowRun.update({ where: { id: aClaimed }, data: { status: 'COMPLETED', leaseHolder: null, leaseExpiresAt: null } });
        expect(outcome(await claim(c, cRun))).toBe('CLAIMED');

        // A dead worker's lapsed lease stops counting too.
        await prisma.$executeRaw`UPDATE "WorkflowRun" SET "leaseExpiresAt" = now() - interval '1 second' WHERE "id" = ${bRun}`;
        const aAgain = await executingRun(a);
        expect(outcome(await claim(a, aAgain))).toBe('CLAIMED');
    });

    it('concurrent claims across three tenants never exceed either cap', async () => {
        const ts = [await newTenant('race-a'), await newTenant('race-b'), await newTenant('race-c')];
        const runs = await Promise.all(ts.flatMap((t) => [executingRun(t), executingRun(t), executingRun(t)]));
        const owners = runs.map((_, i) => ts[Math.floor(i / 3)]);
        const outcomes = (await Promise.all(runs.map((r, i) => claim(owners[i], r)))).map(outcome);
        const claimed = outcomes.map((o, i) => (o === 'CLAIMED' ? owners[i] : null)).filter((t): t is string => t !== null);
        expect(claimed).toHaveLength(HOSTED_MAX_CONCURRENT_RUNS);
        for (const t of ts) expect(claimed.filter((x) => x === t).length).toBeLessThanOrEqual(HOSTED_MAX_CONCURRENT_RUNS_PER_TENANT);
    });

    it('a run the caller does not hold, or of another tenant, takes no slot', async () => {
        const [a, b] = [await newTenant('held-a'), await newTenant('held-b')];
        const run = await executingRun(a);
        expect(await claimHostedSlot(ownerCtx(a), run)).toEqual({ ok: false, reason: 'HOSTED_RUN_NOT_LEASED' });
        expect(await claimHostedSlot(ownerCtx(a, { runLeaseToken: 'not-the-lease' }), run)).toEqual({ ok: false, reason: 'HOSTED_RUN_NOT_LEASED' });
        expect(await claimHostedSlot(ownerCtx(b, { runLeaseToken: live.get(run) }), run)).toEqual({ ok: false, reason: 'HOSTED_RUN_NOT_LEASED' });
        expect((await prisma.workflowRun.findUniqueOrThrow({ where: { id: run } })).hostedManagedAgents).toBe(false);
    });
});

describeFn('Step 6b — one workspace, two tenants: a clean-up touches only its own tenant\'s recorded ids', () => {
    it('opting out deletes and archives exactly the tenant\'s recorded ids; the other tenant\'s and a foreign session stay', async () => {
        const a = await seedHosted(await newTenant('out-a'), 'out-a');
        const b = await seedHosted(await newTenant('out-b'), 'out-b');
        await optInRow(a.tenantId, true);
        await optInRow(b.tenantId, true);
        // A session on A's recorded agent that names B: never A's to delete.
        const namesB = faux.seedSession({ agentId: a.agentId, metadata: sessionMetadataFor(b.tenantId, b.runId) });
        const foreign = faux.seedSession({ agentId: faux.seedAgent('someone-else'), metadata: sessionMetadataFor(a.tenantId, a.runId) });

        const result = await setHostedManagedAgentsOptIn(ownerCtx(a.tenantId), false);

        expect(result.cleanup).toEqual({ status: 'DONE', reason: null });
        expect(held(a)).toEqual(CLEANED);
        expect(held(b)).toEqual(UNTOUCHED);
        expect(faux.holdsSession(namesB)).toBe(true);
        expect(faux.holdsSession(foreign)).toBe(true);
        expect(faux.archives).toEqual([a.agentId]);
        everyRequestIsInflects();
        // Never a list of the workspace: every session list names A's recorded agent.
        const lists = faux.requests.filter((r) => r.method === 'GET' && r.path === '/v1/sessions');
        expect(lists.length).toBeGreaterThan(0);
        expect(await records(b.tenantId)).toEqual([]);
        expect(await records(a.tenantId)).toEqual([
            expect.objectContaining({ trigger: 'CONNECTION_REMOVED', connectionId: INFLECT_HOSTED_CONNECTION_ID, workspaceId: HOSTED_WORKSPACE, status: 'DONE' }),
        ]);
    });

    it('the purge deletes and archives only the purged tenant\'s ids, and an unfinished purge of Inflect\'s workspace is RETRIED (its key is not destroyed)', async () => {
        const a = await seedHosted(await newTenant('purge-a'), 'purge-a');
        const b = await seedHosted(await newTenant('purge-b'), 'purge-b');
        await prisma.tenant.update({ where: { id: a.tenantId }, data: { deletedAt: new Date('2026-01-01T00:00:00Z') } });

        // The provider is down for the purge's one attempt.
        faux.unreachable = true;
        await purgeSoftDeletedTenants({ tenantId: a.tenantId });
        const [record] = await records(a.tenantId);
        expect(record).toMatchObject({
            trigger: 'TENANT_PURGE',
            connectionId: INFLECT_HOSTED_CONNECTION_ID,
            status: 'OPEN',
            outcome: 'PROVIDER_UNREACHABLE',
            pendingAgentIds: [a.agentId],
            closedAt: null,
        });
        expect(JSON.stringify(record)).not.toContain(HOSTED_KEY);
        // The tenant's rows are gone, the ids are on the record.
        expect(await prisma.agentProfileProvision.count({ where: { tenantId: a.tenantId } })).toBe(0);

        // Reachable again: data-lifecycle retries it from the record alone.
        faux.unreachable = false;
        await retryOpenManagedAgentsCleanups();
        expect((await records(a.tenantId))[0]).toMatchObject({ status: 'DONE', pendingSessionIds: [], pendingAgentIds: [] });
        expect({ createdOnly: faux.holdsSession(a.createdOnly), deleteFailed: faux.holdsSession(a.deleteFailed), archived: faux.isArchived(a.agentId) }).toEqual({
            createdOnly: false,
            deleteFailed: false,
            archived: true,
        });
        // B, in the same workspace, untouched; and every request was Inflect's.
        expect(held(b)).toEqual(UNTOUCHED);
        expect(await records(b.tenantId)).toEqual([]);
        everyRequestIsInflects();
    });

    it('the reconciliation reaches a hosted tenant: it retries the tenant\'s own failed delete and leaves the other tenant\'s', async () => {
        const a = await seedHosted(await newTenant('rec-a'), 'rec-a');
        const b = await seedHosted(await newTenant('rec-b'), 'rec-b');
        await reconcileLostSessionDeletes();
        expect(faux.holdsSession(a.deleteFailed)).toBe(false);
        expect(faux.holdsSession(b.deleteFailed)).toBe(false);
        // Each tenant's delete went by its own recorded id; nothing else of
        // either was deleted (the created-only sessions are too young to be
        // abandoned).
        expect(faux.deletes.sort()).toEqual([a.deleteFailed, b.deleteFailed].sort());
        everyRequestIsInflects();
    });
});

describeFn('Step 6b — with the constant false, nothing reaches the workspace with Inflect\'s key', () => {
    it('no resolution, opt-out clean-up, purge or reconciliation sends a single request; what is left stays OPEN, named', async () => {
        const a = await seedHosted(await newTenant('off-a'), 'off-a');
        await optInRow(a.tenantId, true);
        mockActivation.active = false;

        expect(await resolveManagedAgentsWorkspace(ownerCtx(a.tenantId))).toEqual({ ok: false, reason: 'HOSTED_NOT_ACTIVE' });

        // Opting out is always allowed, and the clean-up it runs cannot open
        // the workspace: it stays OPEN, named, for data-lifecycle.
        const out = await setHostedManagedAgentsOptIn(ownerCtx(a.tenantId), false);
        expect(out.cleanup).toEqual({ status: 'OPEN', reason: 'HOSTED_NOT_ACTIVE' });

        await reconcileLostSessionDeletes();
        await retryOpenManagedAgentsCleanups();
        await prisma.tenant.update({ where: { id: a.tenantId }, data: { deletedAt: new Date('2026-01-01T00:00:00Z') } });
        await purgeSoftDeletedTenants({ tenantId: a.tenantId });

        expect(faux.requests).toEqual([]);
        expect(held(a)).toEqual(UNTOUCHED);
        const purge = (await records(a.tenantId)).find((r) => r.trigger === 'TENANT_PURGE');
        expect(purge).toMatchObject({ status: 'OPEN', outcome: 'HOSTED_NOT_ACTIVE', pendingAgentIds: [a.agentId] });
    });
});
