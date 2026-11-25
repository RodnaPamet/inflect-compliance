/**
 * A HOSTED WORKSPACE CONNECTS ITS OWN ANTHROPIC WORKSPACE (#4173, owner
 * decision 3 of 2026-11-25), over a real database and a faux Anthropic
 * workspace (`tests/helpers/managed-agents-faux.ts`) that stands for INFLECT's
 * own workspace, shared by two tenants.
 *
 *   • Saving an enabled `anthropic-workspace` connection, through the real
 *     integrations usecase, opens Step 5c's clean-up of the tenant's records in
 *     Inflect's workspace (a `CONNECTION_REMOVED` record under
 *     `inflect-hosted`), after the save, and withdraws the hosted opt-in,
 *     audited with the cause.
 *   • With the constant false (as in production until Step 6c), not one
 *     request reaches the workspace: the record stays OPEN, named
 *     `HOSTED_NOT_ACTIVE`, for data-lifecycle.
 *   • With the constant true (the module seam), it deletes and archives only
 *     that tenant's recorded ids; another tenant's hosted session and agent in
 *     the same workspace stay, and every request carries Inflect's key, never
 *     the key the tenant just saved.
 *   • A tenant with no hosted records, a later save, and a disabled connection
 *     open nothing.
 *
 * `HOSTED_MANAGED_AGENTS_ACTIVE` is read through a getter on a `jest.mock` of
 * its leaf module, as in 6b's suites; nothing in `src/` writes it.
 */
const mockActivation = { active: false };
jest.mock('@/lib/agentic/managed-agents/hosted-activation', () => ({
    get HOSTED_MANAGED_AGENTS_ACTIVE() {
        return mockActivation.active;
    },
}));

const HOSTED_KEY = 'sk-ant-inflect-hosted-faux-own-ws'; // pragma: allowlist secret -- a placeholder for the faux
const HOSTED_WORKSPACE = 'wrkspc_inflect_hosted_own_ws';
const envOverride: Record<string, string | undefined> = {
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
import { INFLECT_HOSTED_CONNECTION_ID } from '@/lib/agentic/managed-agents/workspace';
import { upsertIntegrationConnection } from '@/app-layer/usecases/integrations';
import { retryOpenManagedAgentsCleanups } from '@/app-layer/usecases/managed-agents-cleanup';
import type { RequestContext } from '@/app-layer/types';
import { prisma as appPrisma } from '@/lib/prisma';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }), transactionOptions: TENANT_TX_OPTIONS });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(180_000);

const SUITE = `hmow-${randomUUID().slice(0, 8)}`;
const OWN_KEY = 'sk-ant-the-tenants-own-faux-key'; // pragma: allowlist secret -- a placeholder for the faux
const OWN_WORKSPACE = 'wrkspc_01TenantsOwnFaux';
const tenants: string[] = [];
const users: string[] = [];

const adminOf = (tenantId: string) => `${tenantId}-admin`;
// An ADMIN saves the connection: the integrations save asks `canAdmin`, and
// the withdrawal is that save's narrowing, not the owner's opt-in writer.
const adminCtx = (tenantId: string): RequestContext =>
    makeRequestContext('ADMIN', { tenantId, tenantSlug: tenantId, userId: adminOf(tenantId) });

let faux: ManagedAgentsFaux;

async function newTenant(label: string): Promise<string> {
    const tenantId = `t-${SUITE}-${label}`;
    tenants.push(tenantId);
    await createTenantWithDek({ id: tenantId, name: `Tenant ${label} Ltd`, slug: tenantId });
    const admin = adminOf(tenantId);
    users.push(admin);
    await prisma.user.create({ data: { id: admin, email: `${admin}@example.test`, emailHash: hashForLookup(`${admin}@example.test`) } });
    await prisma.tenantMembership.create({ data: { tenantId, userId: admin, role: 'ADMIN', status: 'ACTIVE' } });
    return tenantId;
}

async function seq(tenantId: string, runId: string): Promise<number> {
    return (await prisma.workflowStep.count({ where: { tenantId, runId } })) + 1;
}

interface HostedWorld {
    readonly tenantId: string;
    readonly agentId: string;
    readonly createdOnly: string;
    readonly deleteFailed: string;
}

async function recordLifecycle(tenantId: string, runId: string, sessionId: string, lifecycles: SessionLifecycle[]): Promise<void> {
    for (const lifecycle of lifecycles) {
        await recordStep(adminCtx(tenantId), runId, await seq(tenantId, runId), 'SYNTHESIS', {
            status: lifecycle === 'SESSION_DELETE_FAILED' ? 'FAILED' : 'DONE',
            label: SESSION_STEP_LABEL,
            input: { lifecycle, sessionId, connectionId: INFLECT_HOSTED_CONNECTION_ID, workspaceKind: 'HOSTED' },
        });
    }
}

/** One tenant's records in Inflect's workspace: an opt-in, a provision, a hosted run's ledger, and the objects they name. */
async function seedHosted(tenantId: string, label: string): Promise<HostedWorld> {
    await prisma.tenantSecuritySettings.upsert({
        where: { tenantId },
        create: { tenantId, hostedManagedAgentsOptIn: true },
        update: { hostedManagedAgentsOptIn: true },
    });
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
    const { id: runId } = await prisma.workflowRun.create({
        data: { tenantId, workflowKey: 'agent-profile:p@v1', status: 'COMPLETED', driver: 'MANAGED_AGENTS', hostedManagedAgents: true },
        select: { id: true },
    });
    const meta = sessionMetadataFor(tenantId, runId);
    const createdOnly = faux.seedSession({ agentId, metadata: meta });
    const deleteFailed = faux.seedSession({ agentId, metadata: meta });
    await recordLifecycle(tenantId, runId, createdOnly, ['SESSION_CREATED']);
    await recordLifecycle(tenantId, runId, deleteFailed, ['SESSION_CREATED', 'SESSION_DELETE_FAILED']);
    return { tenantId, agentId, createdOnly, deleteFailed };
}

function held(w: HostedWorld): Record<string, boolean> {
    return {
        createdOnly: faux.holdsSession(w.createdOnly),
        deleteFailed: faux.holdsSession(w.deleteFailed),
        agentArchived: faux.isArchived(w.agentId),
    };
}
const UNTOUCHED = { createdOnly: true, deleteFailed: true, agentArchived: false };
const CLEANED = { createdOnly: false, deleteFailed: false, agentArchived: true };

/** The tenant's own workspace, saved through the real integrations usecase, as the Integrations card does. */
async function connectOwnWorkspace(tenantId: string, over: { isEnabled?: boolean } = {}) {
    return upsertIntegrationConnection(adminCtx(tenantId), {
        provider: 'anthropic-workspace',
        name: 'Our Anthropic workspace',
        configJson: { workspaceId: OWN_WORKSPACE, keepSessions: false },
        secrets: { apiKey: OWN_KEY },
        ...over,
    });
}

async function records(tenantId: string) {
    return prisma.managedAgentsCleanup.findMany({ where: { tenantId }, orderBy: { createdAt: 'asc' } });
}

async function optedIn(tenantId: string): Promise<boolean | null> {
    return (await prisma.tenantSecuritySettings.findUnique({ where: { tenantId }, select: { hostedManagedAgentsOptIn: true } }))?.hostedManagedAgentsOptIn ?? null;
}

beforeEach(() => {
    mockActivation.active = false;
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
    await prisma.integrationConnection.deleteMany({ where: { tenantId: { in: tenants } } });
    await prisma.tenantSecuritySettings.deleteMany({ where: { tenantId: { in: tenants } } });
    await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = ANY($1)`, tenants);
        await tx.$executeRawUnsafe(`DELETE FROM "ManagedAgentsCleanup" WHERE "tenantId" = ANY($1)`, tenants);
    });
    await deleteAuditRowsForTenants(prisma, tenants).catch(() => undefined);
    await deleteAuditRowsForUsers(prisma, users).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await prisma.tenant.deleteMany({ where: { id: { in: tenants } } });
    await appPrisma.$disconnect();
    await prisma.$disconnect();
    __resetAuditStreamForTests();
});

describeFn('#4173 — connecting an own Anthropic workspace cleans up the tenant\'s hosted records', () => {
    it('with the constant false: the clean-up is opened for that tenant only, OPEN and named, and NOT ONE request leaves', async () => {
        const a = await seedHosted(await newTenant('off-a'), 'off-a');
        const b = await seedHosted(await newTenant('off-b'), 'off-b');

        const saved = await connectOwnWorkspace(a.tenantId);

        // The save itself is untouched by the clean-up.
        expect(saved).toMatchObject({ provider: 'anthropic-workspace', isEnabled: true });
        expect(await records(a.tenantId)).toEqual([
            expect.objectContaining({
                trigger: 'CONNECTION_REMOVED',
                connectionId: INFLECT_HOSTED_CONNECTION_ID,
                status: 'OPEN',
                outcome: 'HOSTED_NOT_ACTIVE',
                closedAt: null,
            }),
        ]);
        expect(await records(b.tenantId)).toEqual([]);
        // The opt-in is withdrawn, audited with the cause; B's stands.
        expect(await optedIn(a.tenantId)).toBe(false);
        expect(await optedIn(b.tenantId)).toBe(true);
        const audit = await prisma.auditLog.findMany({ where: { tenantId: a.tenantId, action: 'HOSTED_MANAGED_AGENTS_OPT_IN_CHANGED' } });
        expect(audit).toHaveLength(1);
        expect(audit[0]).toMatchObject({ userId: adminOf(a.tenantId) });
        expect(audit[0].detailsJson).toMatchObject({ operation: 'revoke' });
        expect(JSON.stringify(audit)).not.toContain(OWN_KEY);

        // data-lifecycle retries it, and still sends nothing while the constant is false.
        await retryOpenManagedAgentsCleanups();
        expect(faux.requests).toEqual([]);
        expect(held(a)).toEqual(UNTOUCHED);
        expect(held(b)).toEqual(UNTOUCHED);
        expect((await records(a.tenantId))[0]).toMatchObject({ status: 'OPEN', outcome: 'HOSTED_NOT_ACTIVE' });
    });

    it('with the constant true: only the connecting tenant\'s recorded ids go, every request with Inflect\'s key; a later save sends nothing', async () => {
        mockActivation.active = true;
        const a = await seedHosted(await newTenant('on-a'), 'on-a');
        const b = await seedHosted(await newTenant('on-b'), 'on-b');
        // A session on A's recorded agent that names B: never A's to delete.
        const namesB = faux.seedSession({ agentId: a.agentId, metadata: sessionMetadataFor(b.tenantId, 'run-of-b') });

        await connectOwnWorkspace(a.tenantId);

        expect(held(a)).toEqual(CLEANED);
        expect(held(b)).toEqual(UNTOUCHED);
        expect(faux.holdsSession(namesB)).toBe(true);
        expect(faux.archives).toEqual([a.agentId]);
        expect(faux.requests.length).toBeGreaterThan(0);
        for (const r of faux.requests) {
            expect({ key: r.headers.get('authorization'), workspace: r.headers.get('anthropic-workspace-id') }).toEqual({
                key: `Bearer ${HOSTED_KEY}`,
                workspace: HOSTED_WORKSPACE,
            });
        }
        expect(await records(a.tenantId)).toEqual([
            expect.objectContaining({ trigger: 'CONNECTION_REMOVED', connectionId: INFLECT_HOSTED_CONNECTION_ID, workspaceId: HOSTED_WORKSPACE, status: 'DONE' }),
        ]);
        expect(await records(b.tenantId)).toEqual([]);

        // Saving the connection again (a rename): everything is covered, nothing is sent or opened.
        const before = faux.requests.length;
        const [connection] = await prisma.integrationConnection.findMany({ where: { tenantId: a.tenantId }, select: { id: true } });
        await upsertIntegrationConnection(adminCtx(a.tenantId), { id: connection.id, provider: 'anthropic-workspace', name: 'Renamed' });
        expect(faux.requests.length).toBe(before);
        expect(await records(a.tenantId)).toHaveLength(1);
    });

    it('a tenant with no hosted records, and a connection saved disabled, open nothing', async () => {
        mockActivation.active = true;
        const plain = await newTenant('plain');
        await connectOwnWorkspace(plain);
        expect(await records(plain)).toEqual([]);

        const c = await seedHosted(await newTenant('disabled'), 'disabled');
        await connectOwnWorkspace(c.tenantId, { isEnabled: false });
        expect(await records(c.tenantId)).toEqual([]);
        expect(await optedIn(c.tenantId)).toBe(true);
        expect(held(c)).toEqual(UNTOUCHED);
        expect(faux.requests).toEqual([]);
    });
});
