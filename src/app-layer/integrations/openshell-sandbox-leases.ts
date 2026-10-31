/**
 * The lease that gives the kill switch something to enumerate — #4568.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE ROW IS THE LEASE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * #4568 measured the gap: `grep -rn "sandboxId" prisma/schema.prisma` returned
 * nothing, so "delete the sandboxes of any agent that runs in one" enumerated
 * an EMPTY SET and the drill's sandbox arm reported
 * `not_exercised_unreachable`.
 *
 * Owner decision 2026-10-30: **execution-lifetime only.** A row exists exactly
 * while its sandbox does — opened when the gateway confirms a create, deleted
 * when a delete SETTLES. Nothing accumulates, which is the whole argument
 * against the alternative: a durable per-agent id would describe sandboxes that
 * no longer exist, and a kill switch that enumerates ghosts reports success
 * against nothing.
 *
 * So the guarantee is narrower than the issue's original wording and the
 * narrowing is the decision: a kill reaches the sandboxes of CURRENTLY-RUNNING
 * work. The other half of the coverage — a sandbox that outlives its execution
 * — is the leak the executor already logs at `error`, and now it is also a row
 * somebody can query.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WRITTEN FROM THE DECISION SEAM, NOT FROM THE EXECUTOR
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 5.1 (#3971) already routes every lifecycle decision through one hook, and
 * #4563 made the posture scans pass one. That hook is the only place in this
 * product that observes a create and a delete, so it is where the lease is
 * maintained. The executor keeps its ownership property — it still never hands
 * the id out — and this module never touches a transport.
 *
 * @module app-layer/integrations/openshell-sandbox-leases
 */

import type { PrismaTx } from '@/lib/db-context';
import { DELETION_IS_SETTLED } from '@/lib/agentic/openshell/transport';
import type { SandboxDecision } from '@/lib/agentic/openshell/sandbox-decisions';

export interface SandboxLease {
    readonly sandboxId: string;
    readonly providerName: string;
    readonly ownerJob: string;
    readonly openedAt: Date;
}

/** Open a lease. Idempotent on the sandbox id, which the gateway makes unique. */
/*
    EVERY FUNCTION TAKES THE TENANT-SCOPED `db`, never the global client.

    The table carries `FORCE ROW LEVEL SECURITY` with a `tenant_isolation`
    policy, so a write on the global client has no `app.tenant_id` set and the
    insert's `WITH CHECK` refuses it. That is the correct direction — a lease
    nobody's kill can reach is worse than no lease — and it is why the caller
    wraps these in `runInTenantContext` rather than reaching for `prisma`.
*/
export async function openSandboxLease(db: PrismaTx, input: {
    readonly tenantId: string;
    readonly sandboxId: string;
    readonly providerName: string;
    readonly ownerJob: string;
}): Promise<void> {
    /*
        `upsert` rather than `create`, and the reason is not tidiness: a retried
        decision — the recorder is called from a hook the executor isolates, so
        a transient failure can be followed by a repeat — must not fail the
        second time and lose the lease for a sandbox that really exists. The
        unique index still means one row per sandbox.
    */
    await db.openShellSandboxLease.upsert({
        where: { sandboxId: input.sandboxId },
        create: {
            tenantId: input.tenantId,
            sandboxId: input.sandboxId,
            providerName: input.providerName,
            ownerJob: input.ownerJob,
        },
        update: {},
    });
}

/**
 * Close a lease, but ONLY when the deletion settled.
 *
 * `DELETION_OUTCOME_ACCEPTED` means admitted, not performed — the gateway's own
 * help text for it reads "Does not wait for" — and the proto3 zero carries no
 * assurance at all. Closing on either would delete the row for a sandbox that
 * is still running, which is exactly the ghost this design exists to avoid,
 * pointing the other way: the kill switch would stop seeing something real.
 */
export async function closeSandboxLease(db: PrismaTx, input: {
    readonly sandboxId: string;
    /** As the gateway spelled it. A `string`, because the decision carries one. */
    readonly outcome: string;
}): Promise<{ readonly closed: boolean }> {
    /*
        Membership in `DELETION_IS_SETTLED` is the single authority, tested on
        the STRING rather than on a cast. The decision also carries a `settled`
        boolean the executor computed, and trusting that instead would make two
        sources for one fact — a wrong one there would close the lease for a
        live sandbox, which is this design's failure in the dangerous direction.
    */
    const settled = (DELETION_IS_SETTLED as readonly string[]).includes(input.outcome);
    if (!settled) return { closed: false };
    // `deleteMany` rather than `delete`: a lease that is already gone is not an
    // error, and a throw here would surface as a recording failure.
    const res = await db.openShellSandboxLease.deleteMany({
        where: { sandboxId: input.sandboxId },
    });
    return { closed: res.count > 0 };
}

/** Every live sandbox of one tenant, oldest first so a leak is at the top. */
export async function listOpenSandboxLeases(db: PrismaTx, tenantId: string): Promise<SandboxLease[]> {
    const rows = await db.openShellSandboxLease.findMany({
        where: { tenantId },
        orderBy: { openedAt: 'asc' },
        select: { sandboxId: true, providerName: true, ownerJob: true, openedAt: true },
    });
    return rows;
}

/**
 * Maintain the lease for one decision.
 *
 * Returns what it did, so a caller can assert it rather than infer it. The
 * three kinds are handled explicitly and `execution-refused` maintains nothing
 * — a refusal that never created a sandbox has no lease to open, and one that
 * refused AFTER a create still has its own `sandbox-deleted` decision.
 */
export async function maintainSandboxLease(db: PrismaTx, input: {
    readonly tenantId: string;
    readonly ownerJob: string;
    /**
     * The gateway-side credential provider's NAME.
     *
     * Passed in rather than read off the decision, because `sandbox-created`
     * carries only the sandbox id — and an earlier draft of this function
     * filled the column with `ownerJob` instead, which defeats the column's
     * only purpose: chasing a leaked sandbox to what it could reach.
     */
    readonly providerName: string;
    readonly decision: SandboxDecision;
}): Promise<'opened' | 'closed' | 'unsettled' | 'not-applicable'> {
    const { decision } = input;
    if (decision.kind === 'sandbox-created') {
        await openSandboxLease(db, {
            tenantId: input.tenantId,
            sandboxId: decision.sandboxId,
            providerName: input.providerName,
            ownerJob: input.ownerJob,
        });
        return 'opened';
    }
    if (decision.kind === 'sandbox-deleted') {
        const { closed } = await closeSandboxLease(db, {
            sandboxId: decision.sandboxId,
            outcome: decision.outcome,
        });
        return closed ? 'closed' : 'unsettled';
    }
    return 'not-applicable';
}

/**
 * What a kill actually reached, and what it could not — #4568's other half.
 *
 * The decision owes a coverage statement: "a row reading 'sandboxes deleted'
 * where the guarantee is 'sandboxes of running agents deleted' is the same
 * overclaim this phase keeps catching elsewhere." So this returns the counts
 * and the reason, and the caller writes them verbatim.
 *
 * ═══ WHY IT NEVER THROWS ═══
 *
 * The kill switch is the safety control; deleting a sandbox is cleanup after
 * it. A kill that failed because a gateway was unreachable would be the control
 * failing for a reason outside its own job — so every failure here becomes a
 * COUNT and a reason, and the kill proceeds either way.
 *
 * ═══ WHY `transport-absent` IS NOT A PASS ═══
 *
 * With no transport configured — production today — this enumerates the leases
 * and deletes nothing. That is recorded as `transport-absent` with the number
 * it would have reached, which is the honest reading and the one an auditor
 * needs. Reporting `0 sandboxes deleted` with no qualifier would read as "there
 * were none".
 */
export interface SandboxSweep {
    readonly attempted: number;
    readonly deleted: number;
    readonly failed: number;
    /** Why the sweep covered what it did. Never a bare count. */
    readonly coverage:
        | 'running-work-only'
        | 'transport-absent'
        | 'agent-scoped-no-subjects';
}

export async function sweepOpenSandboxLeases(db: PrismaTx, input: {
    readonly tenantId: string;
    /** Null for a TENANT or PLATFORM kill; an id narrows it. */
    readonly agentId: string | null;
    /** Absent in production today. Without one, nothing is deleted. */
    readonly deleteSandbox?: (sandboxId: string) => Promise<void>;
}): Promise<SandboxSweep> {
    /*
        AGENT-SCOPED KILLS REACH NOTHING, and that is stated rather than
        silently returning zero. A lease's owner today is a posture collection,
        not a registered agent, so there is no attribution to filter on —
        inventing one would make an AGENT kill appear to cover sandboxes it
        cannot. A TENANT or PLATFORM kill reaches every live sandbox of the
        tenant, which is a guarantee this schema can actually keep.
    */
    if (input.agentId !== null) {
        return { attempted: 0, deleted: 0, failed: 0, coverage: 'agent-scoped-no-subjects' };
    }

    const leases = await listOpenSandboxLeases(db, input.tenantId);
    if (input.deleteSandbox === undefined) {
        return {
            attempted: leases.length,
            deleted: 0,
            failed: 0,
            coverage: 'transport-absent',
        };
    }

    let deleted = 0;
    let failed = 0;
    for (const lease of leases) {
        try {
            await input.deleteSandbox(lease.sandboxId);
            // The LEASE is closed by the delete's own decision, through the
            // same hook that opened it — not from here. Two writers for one row
            // is how a lease gets closed for a sandbox that is still running.
            deleted += 1;
        } catch {
            // Counted, never rethrown. See the note above: the kill is the
            // control, this is cleanup after it.
            failed += 1;
        }
    }
    return { attempted: leases.length, deleted, failed, coverage: 'running-work-only' };
}
