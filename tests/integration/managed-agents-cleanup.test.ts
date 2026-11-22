/**
 * PURGE, CONNECTION REMOVAL AND DSAR REACH THE PROVIDER (Step 5c of
 * `docs/claude-managed-agents-design.md`, #4166), over a real database and a
 * faux Anthropic workspace (`tests/helpers/managed-agents-faux.ts`).
 *
 * Every scenario writes what 5b writes — `WorkflowRun` rows on the
 * MANAGED_AGENTS driver, `managed-agents-session` SYNTHESIS steps through the
 * real `recordStep`, `AgentProfileProvision` rows — and puts the objects they
 * name in the faux workspace, beside objects no run created: a FOREIGN agent
 * and its session, a session naming another tenant, a session naming a run the
 * tenant does not hold. Then the real triggers run: `purgeSoftDeletedTenants`,
 * `removeIntegrationConnection`, `eraseUser`, and the data-lifecycle passes
 * (`retryOpenManagedAgentsCleanups`, `reconcileLostSessionDeletes`).
 *
 * Two tenants share one faux workspace throughout, so "the clean-up of one
 * never touches the other's sessions, agents or records" is asserted on every
 * scenario, not in one of its own.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import { ManagedAgentsFaux } from '../helpers/managed-agents-faux';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants, deleteAuditRowsForUsers } from '../helpers/audit-cleanup';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';
import { encryptField, hashForLookup } from '@/lib/security/encryption';
import { createTenantWithDek } from '@/lib/security/tenant-key-manager';
import { recordStep } from '@/lib/agentic/drivers/step-recorder';
import { sessionMetadataFor } from '@/lib/agentic/managed-agents/definition';
import { SESSION_STEP_LABEL, type SessionLifecycle } from '@/lib/agentic/managed-agents/execute';
import { runInTenantContext } from '@/lib/db/rls-middleware';
import { purgeSoftDeletedTenants, TENANT_PURGE_RETAINED } from '@/app-layer/usecases/tenant-purge';
import { removeIntegrationConnection } from '@/app-layer/usecases/integrations';
import {
    CLEANUP_ABANDON_AFTER_DAYS,
    reconcileLostSessionDeletes,
    retryOpenManagedAgentsCleanups,
} from '@/app-layer/usecases/managed-agents-cleanup';
import { eraseUser } from '@/app-layer/jobs/dsar-erasure';
import { appendAuditEntry } from '@/lib/audit/audit-writer';
import * as metrics from '@/lib/observability/integration-metrics';
import { prisma as appPrisma } from '@/lib/prisma';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }), transactionOptions: TENANT_TX_OPTIONS });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(180_000);

const SUITE = `macl-${randomUUID().slice(0, 8)}`;
const KEY = 'sk-ant-faux-workspace-key-for-cleanup'; // pragma: allowlist secret -- a placeholder for the faux
const ctxOf = (tenantId: string) => makeRequestContext('OWNER', { tenantId, tenantSlug: tenantId, userId: `${tenantId}-owner` });

let faux: ManagedAgentsFaux;
const cleanupSpy = jest.spyOn(metrics, 'recordManagedAgentsCleanup');
const lostDeleteSpy = jest.spyOn(metrics, 'recordManagedAgentsLostDelete');

/** One tenant's world: its connection, its recorded agent, and named sessions. */
interface World {
    readonly tenantId: string;
    readonly connectionId: string;
    readonly agentId: string;
    readonly runId: string;
    /** Recorded SESSION_KEPT. */
    readonly kept: string;
    /** Recorded SESSION_CREATED and nothing after: a run that crashed mid-way. */
    readonly createdOnly: string;
    /** Recorded SESSION_DELETE_FAILED. */
    readonly deleteFailed: string;
    /** Recorded CREATED then DELETED, and gone from the workspace. */
    readonly deleted: string;
    /** In the workspace on the recorded agent, this tenant's metadata, NO step: the crash window. */
    readonly crashWindow: string;
    /** On the recorded agent, metadata naming this tenant and a run it does NOT hold. */
    readonly unheldRun: string;
}

const tenants: string[] = [];
const users: string[] = [];

async function seq(tenantId: string, runId: string): Promise<number> {
    return (await prisma.workflowStep.count({ where: { tenantId, runId } })) + 1;
}

async function recordLifecycle(world: { tenantId: string; connectionId: string }, runId: string, sessionId: string, lifecycles: SessionLifecycle[]): Promise<void> {
    for (const lifecycle of lifecycles) {
        await recordStep(ctxOf(world.tenantId), runId, await seq(world.tenantId, runId), 'SYNTHESIS', {
            status: lifecycle === 'SESSION_DELETE_FAILED' ? 'FAILED' : 'DONE',
            label: SESSION_STEP_LABEL,
            input: { lifecycle, sessionId, connectionId: world.connectionId },
        });
    }
}

async function newRun(tenantId: string): Promise<string> {
    const run = await prisma.workflowRun.create({
        data: { tenantId, workflowKey: 'agent-profile:p@v1', status: 'COMPLETED', driver: 'MANAGED_AGENTS' },
        select: { id: true },
    });
    return run.id;
}

async function seedWorld(label: string): Promise<World> {
    const tenantId = `t-${SUITE}-${label}`;
    tenants.push(tenantId);
    await createTenantWithDek({ id: tenantId, name: tenantId, slug: tenantId });
    const owner = `${tenantId}-owner`;
    users.push(owner);
    await prisma.user.create({ data: { id: owner, email: `${owner}@example.test`, emailHash: hashForLookup(`${owner}@example.test`) } });
    const connectionId = (
        await prisma.integrationConnection.create({
            data: {
                tenantId,
                provider: 'anthropic-workspace',
                name: 'Anthropic workspace',
                configJson: { workspaceId: `wrkspc_${label}`, keepSessions: true },
                secretEncrypted: encryptField(JSON.stringify({ apiKey: KEY })),
            },
            select: { id: true },
        })
    ).id;
    const agentId = faux.seedAgent(`inflect-${label}`);
    await prisma.agentProfileProvision.create({
        data: {
            tenantId,
            profileId: `profile-${label}`,
            profileVersionId: `version-${label}`,
            connectionId,
            anthropicAgentId: agentId,
            anthropicAgentVersion: 1,
            environmentId: 'env_faux',
            systemHash: 'a'.repeat(64),
            toolsHash: 'b'.repeat(64),
        },
    });
    const runId = await newRun(tenantId);
    const meta = sessionMetadataFor(tenantId, runId);
    const world = { tenantId, connectionId };
    const kept = faux.seedSession({ agentId, metadata: meta });
    const createdOnly = faux.seedSession({ agentId, metadata: meta });
    const deleteFailed = faux.seedSession({ agentId, metadata: meta });
    const deleted = `sesn_gone_${label}`;
    await recordLifecycle(world, runId, kept, ['SESSION_CREATED', 'SESSION_KEPT']);
    await recordLifecycle(world, runId, createdOnly, ['SESSION_CREATED']);
    await recordLifecycle(world, runId, deleteFailed, ['SESSION_CREATED', 'SESSION_DELETE_FAILED']);
    await recordLifecycle(world, runId, deleted, ['SESSION_CREATED', 'SESSION_DELETED']);
    const crashRun = await newRun(tenantId);
    const crashWindow = faux.seedSession({ agentId, metadata: sessionMetadataFor(tenantId, crashRun) });
    const unheldRun = faux.seedSession({ agentId, metadata: sessionMetadataFor(tenantId, `run-not-${label}`) });
    return { tenantId, connectionId, agentId, runId, kept, createdOnly, deleteFailed, deleted, crashWindow, unheldRun };
}

/** Objects in the workspace no run of the tenants created. */
interface Foreign {
    readonly agentId: string;
    /** On a foreign agent, metadata naming tenant A and A's run: never listed, because the agent is not recorded. */
    readonly onForeignAgent: string;
    /** On A's recorded agent, no metadata at all. */
    readonly noMetadata: string;
    /** On A's recorded agent, metadata naming a tenant that does not exist here. */
    readonly otherTenant: string;
}

function seedForeign(a: World): Foreign {
    const agentId = faux.seedAgent('customer-own');
    return {
        agentId,
        onForeignAgent: faux.seedSession({ agentId, metadata: sessionMetadataFor(a.tenantId, a.runId) }),
        noMetadata: faux.seedSession({ agentId: a.agentId }),
        otherTenant: faux.seedSession({ agentId: a.agentId, metadata: sessionMetadataFor('some-other-tenant', a.runId) }),
    };
}

function assertForeignUntouched(f: Foreign): void {
    expect(faux.isArchived(f.agentId)).toBe(false);
    expect(faux.holdsSession(f.onForeignAgent)).toBe(true);
    expect(faux.holdsSession(f.noMetadata)).toBe(true);
    expect(faux.holdsSession(f.otherTenant)).toBe(true);
}

/** Every session of a world still in the workspace, by name. */
function held(w: World): Record<string, boolean> {
    return {
        kept: faux.holdsSession(w.kept),
        createdOnly: faux.holdsSession(w.createdOnly),
        deleteFailed: faux.holdsSession(w.deleteFailed),
        crashWindow: faux.holdsSession(w.crashWindow),
        unheldRun: faux.holdsSession(w.unheldRun),
    };
}

const ALL_HELD = { kept: true, createdOnly: true, deleteFailed: true, crashWindow: true, unheldRun: true };

async function records(tenantId: string) {
    return prisma.managedAgentsCleanup.findMany({ where: { tenantId }, orderBy: { createdAt: 'asc' } });
}

async function softDelete(tenantId: string): Promise<void> {
    await prisma.tenant.update({ where: { id: tenantId }, data: { deletedAt: new Date('2026-01-01T00:00:00Z') } });
}

beforeEach(() => {
    faux = new ManagedAgentsFaux();
    faux.install();
    cleanupSpy.mockClear();
    lostDeleteSpy.mockClear();
});

afterEach(() => {
    faux.uninstall();
});

afterAll(async () => {
    await prisma.managedAgentsCleanup.deleteMany({ where: { tenantId: { in: tenants } } });
    for (const tenantId of tenants) {
        const t = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { id: true } });
        if (!t) continue;
        await softDelete(tenantId);
        await purgeSoftDeletedTenants({ tenantId, dryRun: false }).catch(() => undefined);
    }
    await prisma.managedAgentsCleanup.deleteMany({ where: { tenantId: { in: tenants } } });
    await deleteAuditRowsForTenants(prisma, tenants).catch(() => undefined);
    await deleteAuditRowsForUsers(prisma, users).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await prisma.tenant.deleteMany({ where: { id: { in: tenants } } });
    await appPrisma.$disconnect();
    await prisma.$disconnect();
});

describeFn('Step 5c — the remote clean-up (real DB, faux workspace)', () => {
    it('the purge deletes exactly the recorded sessions (kept included) and the crash window, archives exactly the recorded agents, and leaves foreign objects and the other tenant alone', async () => {
        const a = await seedWorld('purge-a');
        const b = await seedWorld('purge-b');
        const foreign = seedForeign(a);
        // A positive control: everything the assertions below say is gone is there now.
        expect(held(a)).toEqual(ALL_HELD);

        await softDelete(a.tenantId);
        const [result] = await purgeSoftDeletedTenants({ tenantId: a.tenantId });

        expect(held(a)).toEqual({ kept: false, createdOnly: false, deleteFailed: false, crashWindow: false, unheldRun: true });
        expect(faux.archives).toEqual([a.agentId]);
        assertForeignUntouched(foreign);
        // The other tenant, in the same workspace: untouched, and no record.
        expect(held(b)).toEqual(ALL_HELD);
        expect(faux.isArchived(b.agentId)).toBe(false);
        expect(await records(b.tenantId)).toEqual([]);
        // Recorded DELETED and already gone: not asked for again.
        expect(faux.requests.some((r) => r.path.endsWith(a.deleted))).toBe(false);

        // The record: retained, DONE, ids only.
        const [record] = await records(a.tenantId);
        expect(TENANT_PURGE_RETAINED.has('ManagedAgentsCleanup')).toBe(true);
        expect(record).toMatchObject({
            trigger: 'TENANT_PURGE',
            status: 'DONE',
            outcome: null,
            connectionId: a.connectionId,
            workspaceId: 'wrkspc_purge-a',
            pendingSessionIds: [],
            pendingAgentIds: [],
            archivedAgentIds: [a.agentId],
        });
        expect([...record.deletedSessionIds].sort()).toEqual([a.kept, a.createdOnly, a.deleteFailed, a.crashWindow].sort());
        expect(result.managedAgents?.records).toEqual([expect.objectContaining({ status: 'DONE', connectionId: a.connectionId })]);
        // The purge itself ran: the connection, its key, the ledger and the provisions are gone.
        expect(await prisma.integrationConnection.count({ where: { tenantId: a.tenantId } })).toBe(0);
        expect(await prisma.agentProfileProvision.count({ where: { tenantId: a.tenantId } })).toBe(0);
        expect(await prisma.workflowStep.count({ where: { tenantId: a.tenantId } })).toBe(0);
        expect(cleanupSpy).toHaveBeenCalledWith({ trigger: 'TENANT_PURGE', status: 'DONE', reason: 'NONE' });
    });

    it('an unreachable provider never marks the purge clean-up done: the purge goes on, and the ids are kept, with no key, in a terminal record that is never retried', async () => {
        const a = await seedWorld('dark-a');
        const b = await seedWorld('dark-b');
        await softDelete(a.tenantId);
        faux.unreachable = true;

        const [result] = await purgeSoftDeletedTenants({ tenantId: a.tenantId });

        // The purge was not blocked.
        expect(result.totalRows).toBeGreaterThan(0);
        expect(await prisma.integrationConnection.count({ where: { tenantId: a.tenantId } })).toBe(0);
        const [record] = await records(a.tenantId);
        expect(record).toMatchObject({
            trigger: 'TENANT_PURGE',
            status: 'PURGED_KEY_DESTROYED_UNFINISHED',
            outcome: 'PROVIDER_UNREACHABLE',
            pendingAgentIds: [a.agentId],
            deletedSessionIds: [],
        });
        expect([...record.pendingSessionIds].sort()).toEqual([a.kept, a.createdOnly, a.deleteFailed].sort());
        // No key, and no ciphertext of one, anywhere on the row.
        const serialised = JSON.stringify(record);
        expect(serialised).not.toContain(KEY);
        expect(serialised).not.toMatch(/v[12]:/);
        expect(cleanupSpy).toHaveBeenCalledWith({ trigger: 'TENANT_PURGE', status: 'PURGED_KEY_DESTROYED_UNFINISHED', reason: 'PROVIDER_UNREACHABLE' });

        // Reachable again: the data-lifecycle retry does not touch a purge record.
        faux.unreachable = false;
        await retryOpenManagedAgentsCleanups();
        expect((await records(a.tenantId))[0]).toMatchObject({ status: 'PURGED_KEY_DESTROYED_UNFINISHED', attempts: 1 });
        expect(held(a)).toEqual(ALL_HELD);
        expect(held(b)).toEqual(ALL_HELD);
    });

    it('disconnecting a workspace triggers the same clean-up; an unreachable provider leaves it OPEN, and the data-lifecycle retry finishes it once reachable', async () => {
        const a = await seedWorld('rm-a');
        const b = await seedWorld('rm-b');
        const foreign = seedForeign(a);
        faux.unreachable = true;

        await removeIntegrationConnection(ctxOf(a.tenantId), a.connectionId);

        // The removal itself went through: the row stays, disabled, with its key.
        expect((await prisma.integrationConnection.findUnique({ where: { id: a.connectionId } }))?.isEnabled).toBe(false);
        let [record] = await records(a.tenantId);
        expect(record).toMatchObject({ trigger: 'CONNECTION_REMOVED', status: 'OPEN', outcome: 'PROVIDER_UNREACHABLE', attempts: 1, closedAt: null });
        expect(held(a)).toEqual(ALL_HELD);

        faux.unreachable = false;
        const tally = await retryOpenManagedAgentsCleanups();
        expect(tally.done).toBeGreaterThanOrEqual(1);
        [record] = await records(a.tenantId);
        expect(record).toMatchObject({ status: 'DONE', outcome: null, attempts: 2, pendingSessionIds: [], pendingAgentIds: [], archivedAgentIds: [a.agentId] });
        expect(held(a)).toEqual({ kept: false, createdOnly: false, deleteFailed: false, crashWindow: false, unheldRun: true });
        expect(faux.archives).toEqual([a.agentId]);
        assertForeignUntouched(foreign);
        expect(held(b)).toEqual(ALL_HELD);
        expect(await records(b.tenantId)).toEqual([]);

        // A DONE record is not attempted again.
        await retryOpenManagedAgentsCleanups();
        expect((await records(a.tenantId))[0].attempts).toBe(2);
    });

    it('a 401 is never done: the record stays OPEN and is retried, a running session is its own named outcome, and after the limit the record ends ABANDONED', async () => {
        const a = await seedWorld('auth-a');
        faux.authStatus = 401;
        await removeIntegrationConnection(ctxOf(a.tenantId), a.connectionId);
        let [record] = await records(a.tenantId);
        expect(record).toMatchObject({ status: 'OPEN', outcome: 'AUTH_REFUSED' });

        await retryOpenManagedAgentsCleanups();
        [record] = await records(a.tenantId);
        expect(record).toMatchObject({ status: 'OPEN', outcome: 'AUTH_REFUSED', attempts: 2 });

        // The key works again, but the kept session is running: named, still open.
        faux.authStatus = null;
        faux.sessions.get(a.kept)!.status = 'running';
        await retryOpenManagedAgentsCleanups();
        [record] = await records(a.tenantId);
        expect(record).toMatchObject({ status: 'OPEN', outcome: 'SESSION_STILL_RUNNING', pendingSessionIds: [a.kept] });
        expect(faux.holdsSession(a.createdOnly)).toBe(false);

        // Past the limit, still unable: ABANDONED, alerted, never retried again.
        const later = new Date(record.createdAt.getTime() + (CLEANUP_ABANDON_AFTER_DAYS + 1) * 86_400_000);
        await retryOpenManagedAgentsCleanups({ now: later });
        [record] = await records(a.tenantId);
        expect(record).toMatchObject({ status: 'ABANDONED', outcome: 'SESSION_STILL_RUNNING' });
        expect(record.closedAt).not.toBeNull();
        expect(cleanupSpy).toHaveBeenCalledWith({ trigger: 'CONNECTION_REMOVED', status: 'ABANDONED', reason: 'SESSION_STILL_RUNNING' });
        faux.sessions.get(a.kept)!.status = 'idle';
        await retryOpenManagedAgentsCleanups();
        expect((await records(a.tenantId))[0].status).toBe('ABANDONED');
        expect(faux.holdsSession(a.kept)).toBe(true);
    });

    it('a DSAR erasure deletes the KEPT sessions only, in every tenant where the person acted, after the erasure commits, and archives no agent', async () => {
        const a = await seedWorld('dsar-a');
        const b = await seedWorld('dsar-b');
        const subject = `u-${SUITE}-subject`;
        users.push(subject);
        const email = `${subject}@example.test`;
        await prisma.user.create({ data: { id: subject, email, emailHash: hashForLookup(email) } });
        // The subject accepted an invite into A (an audit row naming them), and never set foot in B.
        await appendAuditEntry({
            tenantId: a.tenantId,
            userId: subject,
            actorType: 'USER',
            entity: 'TenantMembership',
            entityId: `m-${subject}`,
            action: 'MEMBER_INVITE_ACCEPTED',
            detailsJson: { category: 'entity_lifecycle', entityName: 'TenantMembership', operation: 'created' },
        });

        const receipt = await eraseUser(subject);
        expect(receipt.userDeleted).toBe(true);

        expect(held(a)).toEqual({ kept: false, createdOnly: true, deleteFailed: true, crashWindow: true, unheldRun: true });
        expect(faux.archives).toEqual([]);
        const [record] = await records(a.tenantId);
        expect(record).toMatchObject({ trigger: 'DSAR_ERASURE', status: 'DONE', deletedSessionIds: [a.kept], archivedAgentIds: [] });
        // The person's id is in no record.
        expect(JSON.stringify(record)).not.toContain(subject);
        expect(held(b)).toEqual(ALL_HELD);
        expect(await records(b.tenantId)).toEqual([]);
    });

    it('the reconciliation deletes a session recorded DELETED that still exists, and emits its metric', async () => {
        const a = await seedWorld('rec-a');
        const b = await seedWorld('rec-b');
        const lost = faux.seedSession({ agentId: a.agentId, metadata: sessionMetadataFor(a.tenantId, a.runId) });
        await recordLifecycle(a, a.runId, lost, ['SESSION_CREATED', 'SESSION_DELETED']);

        const tally = await reconcileLostSessionDeletes();

        expect(faux.holdsSession(lost)).toBe(false);
        expect(tally.deleted).toBeGreaterThanOrEqual(1);
        expect(lostDeleteSpy).toHaveBeenCalledWith({ outcome: 'deleted' });
        // Nothing recorded otherwise is touched by it.
        expect(held(a)).toEqual(ALL_HELD);
        expect(held(b)).toEqual(ALL_HELD);
    });

    it('two tenants: RLS binds the records to their tenant, and one tenant\'s purge leaves the other\'s open record open', async () => {
        const a = await seedWorld('iso-a');
        const b = await seedWorld('iso-b');
        faux.unreachable = true;
        await removeIntegrationConnection(ctxOf(a.tenantId), a.connectionId);
        await removeIntegrationConnection(ctxOf(b.tenantId), b.connectionId);
        faux.unreachable = false;

        // Through the tenant-bound client, B reads none of A's records and cannot write one for A.
        const seenByB = await runInTenantContext(ctxOf(b.tenantId), (db) => db.managedAgentsCleanup.findMany({ select: { tenantId: true } }));
        expect(seenByB.map((r) => r.tenantId)).toEqual([b.tenantId]);
        await expect(
            runInTenantContext(ctxOf(b.tenantId), (db) =>
                db.managedAgentsCleanup.create({
                    data: { tenantId: a.tenantId, trigger: 'CONNECTION_REMOVED', connectionId: 'x', workspaceId: 'w', status: 'OPEN', coversUntil: new Date() },
                }),
            ),
        ).rejects.toThrow();

        // A's purge supersedes A's open record, finishes A's clean-up, and leaves B's open.
        await softDelete(a.tenantId);
        await purgeSoftDeletedTenants({ tenantId: a.tenantId });
        const aRecords = await records(a.tenantId);
        expect(aRecords.map((r) => r.status).sort()).toEqual(['DONE', 'SUPERSEDED_BY_PURGE']);
        expect(await records(b.tenantId)).toEqual([expect.objectContaining({ status: 'OPEN', trigger: 'CONNECTION_REMOVED' })]);
        expect(held(b)).toEqual(ALL_HELD);
        expect(faux.isArchived(b.agentId)).toBe(false);
    });
});
