/**
 * The lease that gives the kill switch subjects — #4568.
 *
 * #4568 measured the gap: no sandbox id was persisted anywhere, so "delete the
 * sandboxes of any agent that runs in one" enumerated an EMPTY SET and the
 * drill's sandbox arm reported `not_exercised_unreachable`.
 *
 * Owner decision 2026-10-30: execution-lifetime only. The row exists exactly
 * while the sandbox does, so nothing accumulates and the kill switch cannot
 * enumerate ghosts — which was the argument against a durable per-agent id.
 *
 * ═══ EVERY CALL GOES THROUGH A TENANT CONTEXT ═══
 *
 * Not scaffolding for its own sake. The table carries `FORCE ROW LEVEL
 * SECURITY`, so a call on the global client has no `app.tenant_id` and the
 * insert's `WITH CHECK` refuses it. Running them this way is what the
 * production path does, and it is what makes the isolation case at the end
 * mean something rather than merely pass.
 *
 * @module unit/agentic/openshell-sandbox-lease
 */

import { prisma } from '@/lib/prisma';
import { runInTenantContext, type PrismaTx } from '@/lib/db-context';
import { buildSystemContext } from '@/app-layer/context-system';
import {
    closeSandboxLease,
    listOpenSandboxLeases,
    maintainSandboxLease,
    openSandboxLease,
    sweepOpenSandboxLeases,
} from '@/app-layer/integrations/openshell-sandbox-leases';
import { DELETION_IS_SETTLED } from '@/lib/agentic/openshell/transport';
import type { SandboxDecision } from '@/lib/agentic/openshell/sandbox-decisions';

const inTenant = <T>(tid: string, fn: (db: PrismaTx) => Promise<T>): Promise<T> =>
    runInTenantContext(buildSystemContext({ tenantId: tid, job: 'lease-test' }), fn);

let tenantId = '';

const slug = (p: string) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

beforeAll(async () => {
    const t = await prisma.tenant.create({
        data: { name: 'lease-test', slug: slug('lease') },
        select: { id: true },
    });
    tenantId = t.id;
});

afterEach(async () => {
    await prisma.openShellSandboxLease.deleteMany({ where: { tenantId } });
});

afterAll(async () => {
    await prisma.openShellSandboxLease.deleteMany({ where: { tenantId } });
    await prisma.tenant.delete({ where: { id: tenantId } }).catch(() => undefined);
});

const created = (sandboxId: string): SandboxDecision => ({ kind: 'sandbox-created', sandboxId });
const deletedWith = (sandboxId: string, outcome: string): SandboxDecision => ({
    kind: 'sandbox-deleted',
    sandboxId,
    outcome,
    settled: (DELETION_IS_SETTLED as readonly string[]).includes(outcome),
});

/** Open one lease, through a tenant context. */
const open = (sandboxId: string, providerName = 'inflect-collector', ownerJob = 'j') =>
    inTenant(tenantId, (db) =>
        openSandboxLease(db, { tenantId, sandboxId, providerName, ownerJob }),
    );

const live = () => inTenant(tenantId, (db) => listOpenSandboxLeases(db, tenantId));

const maintain = (decision: SandboxDecision, ownerJob = 'gcp-posture-collect') =>
    inTenant(tenantId, (db) =>
        maintainSandboxLease(db, {
            tenantId,
            ownerJob,
            providerName: 'inflect-collector',
            decision,
        }),
    );

describe('the row exists exactly while the sandbox does', () => {
    it('a create opens a lease, and a settled delete closes it', async () => {
        await maintain(created('sbx-1'));
        expect(await live()).toHaveLength(1);
        await maintain(deletedWith('sbx-1', 'DELETION_OUTCOME_COMPLETED'));
        expect(await live()).toHaveLength(0);
    });

    it("records the provider NAME, not the job — that is the column's purpose", async () => {
        // An earlier draft filled `providerName` with `ownerJob`, which defeats
        // the only reason the column exists: chasing a leaked sandbox to what it
        // could REACH. They are different facts; this asserts they stay so.
        await maintain(created('sbx-2'), 'aws-posture-collect');
        const [lease] = await live();
        expect(lease.ownerJob).toBe('aws-posture-collect');
        expect(lease.providerName).toBe('inflect-collector');
        expect(lease.providerName).not.toBe(lease.ownerJob);
    });

    it('an ACCEPTED delete does NOT close the lease — admitted is not performed', async () => {
        // The gateway's own help text for ACCEPTED reads "Does not wait for".
        // Closing on it would delete the row for a sandbox that is still
        // running — this design's failure in the dangerous direction, because
        // the kill switch would stop seeing something real.
        await open('sbx-3');
        const r = await inTenant(tenantId, (db) =>
            closeSandboxLease(db, { sandboxId: 'sbx-3', outcome: 'DELETION_OUTCOME_ACCEPTED' }),
        );
        expect(r.closed).toBe(false);
        expect(await live()).toHaveLength(1);
    });

    it('the proto3 ZERO does not close it either — a zero is not an assurance', async () => {
        await open('sbx-4');
        const r = await inTenant(tenantId, (db) =>
            closeSandboxLease(db, { sandboxId: 'sbx-4', outcome: 'DELETION_OUTCOME_UNSPECIFIED' }),
        );
        expect(r.closed).toBe(false);
        expect(await live()).toHaveLength(1);
    });

    it('ALREADY_ABSENT closes it — the sandbox is gone, which is the point', async () => {
        await open('sbx-5');
        const r = await inTenant(tenantId, (db) =>
            closeSandboxLease(db, { sandboxId: 'sbx-5', outcome: 'DELETION_OUTCOME_ALREADY_ABSENT' }),
        );
        expect(r.closed).toBe(true);
        expect(await live()).toHaveLength(0);
    });

    it('a repeated create does not fail, and does not make a second lease', async () => {
        // The recorder runs from a hook the executor isolates, so a transient
        // failure can be followed by a repeat. Losing the lease for a sandbox
        // that really exists would be worse than a duplicate.
        await open('sbx-6');
        await open('sbx-6');
        expect(await live()).toHaveLength(1);
    });

    it('a refusal maintains nothing — there is no sandbox to lease', async () => {
        const r = await maintain({ kind: 'execution-refused', reason: 'creation-failed' });
        expect(r).toBe('not-applicable');
        expect(await live()).toHaveLength(0);
    });
});

describe('what a kill reaches, and what it says it reached', () => {
    const sweep = (agentId: string | null, deleteSandbox?: (id: string) => Promise<void>) =>
        inTenant(tenantId, (db) => sweepOpenSandboxLeases(db, { tenantId, agentId, deleteSandbox }));

    it('reports transport-absent WITH the count it would have reached', async () => {
        // Production today. `0 deleted` with no qualifier would read as "there
        // were none", which is the overclaim this decision owes a statement
        // against. The count is what makes the row honest.
        await open('sbx-7');
        await open('sbx-8');
        expect(await sweep(null)).toEqual({
            attempted: 2,
            deleted: 0,
            failed: 0,
            coverage: 'transport-absent',
        });
    });

    it('deletes every live sandbox when a transport is supplied', async () => {
        await open('sbx-9');
        await open('sbx-10');
        const seen: string[] = [];
        const res = await sweep(null, async (id) => {
            seen.push(id);
        });
        expect(seen.sort()).toEqual(['sbx-10', 'sbx-9']);
        expect(res).toEqual({ attempted: 2, deleted: 2, failed: 0, coverage: 'running-work-only' });
    });

    it('a failing delete is COUNTED, never thrown — the kill is the control', async () => {
        // A kill that failed because a gateway was unreachable would be the
        // safety control failing for a reason outside its own job.
        await open('sbx-11');
        await open('sbx-12');
        const res = await sweep(null, async (id) => {
            if (id === 'sbx-11') throw new Error('gateway refused');
        });
        expect(res.attempted).toBe(2);
        expect(res.deleted).toBe(1);
        expect(res.failed).toBe(1);
        expect(res.coverage).toBe('running-work-only');
    });

    it('an AGENT-scoped kill says it has no subjects rather than reporting zero', async () => {
        // A lease's owner today is a posture collection, not a registered
        // agent, so there is no attribution to filter on. A bare zero would
        // read as "that agent had no sandboxes"; the named coverage says "this
        // scope cannot reach them", which is the true statement.
        await open('sbx-13');
        const res = await sweep('agent-1');
        expect(res.coverage).toBe('agent-scoped-no-subjects');
        expect(res.attempted).toBe(0);
        // And it did not delete the tenant's live sandbox on the way past.
        expect(await live()).toHaveLength(1);
    });

    it('the sweep does not close leases itself — the delete decision does', async () => {
        // Two writers for one row is how a lease gets closed for a sandbox that
        // is still running. The sweep asks for deletion; the gateway's own
        // `sandbox-deleted` decision, through the hook that opened the lease,
        // is what closes it.
        await open('sbx-14');
        await sweep(null, async () => undefined);
        expect(await live()).toHaveLength(1);
    });

    it("is scoped to its tenant — a kill never reaches another tenant's sandboxes", async () => {
        const other = await prisma.tenant.create({
            data: { name: 'other', slug: slug('other') },
            select: { id: true },
        });
        await open('sbx-15');
        await inTenant(other.id, (db) =>
            openSandboxLease(db, {
                tenantId: other.id,
                sandboxId: 'sbx-16',
                providerName: 'p',
                ownerJob: 'j',
            }),
        );
        const seen: string[] = [];
        await sweep(null, async (id) => {
            seen.push(id);
        });
        // RLS enforces this in the database as well as the query, which is why
        // the calls run in a context rather than on the global client.
        expect(seen).toEqual(['sbx-15']);
        await prisma.openShellSandboxLease.deleteMany({ where: { tenantId: other.id } });
        await prisma.tenant.delete({ where: { id: other.id } }).catch(() => undefined);
    });
});
