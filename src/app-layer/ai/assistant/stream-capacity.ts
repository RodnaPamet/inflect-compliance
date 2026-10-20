/**
 * How many assistant streams may be open at once (#3824).
 *
 * ═══ WHY A STREAM NEEDS ITS OWN BOUND ═══
 *
 * `checkRateLimit` already bounds assistant REQUESTS per user and per day. A
 * stream is a different cost: it HOLDS a connection for its lifetime, in the
 * same Node process as the notifications SSE route. So a flood is not merely an
 * AI-spend problem — it is a denial of service against unrelated features that
 * share the process, and a per-request quota cannot see it.
 *
 * Two bounds, because they fail differently. The per-tenant one stops one
 * customer monopolising the process; the global one stops the aggregate of
 * well-behaved tenants doing the same thing.
 *
 * ═══ IN-PROCESS, AND SAYING SO ═══
 *
 * These counters live in module scope, so they bound ONE Node process. That is
 * the right scope today for the same reason the notification bus gives:
 * `notifications/bus` notes "If multi-pod fanout becomes load-bearing, swap the
 * bus to Redis pub/sub" — the deployment is single-process, and a per-process
 * bound is exactly the resource being protected (this process's connections).
 *
 * It is NOT a tenant-wide quota across pods, and must not be described as one.
 * On a second pod each would admit its own allowance, so the global cap becomes
 * per-pod. Written down because the upgrade path is the bus's: a shared counter,
 * not a larger number here.
 *
 * Unlike the provider singleton this module's state is deliberately shared —
 * counting is the point. The hazard `model-selection.ts` describes is a shared
 * value being USED as if it were per-request; a counter is shared by intent and
 * carries no tenant's data.
 */

/** Per tenant. Low enough that one customer cannot fill the process. */
export const MAX_STREAMS_PER_TENANT = 4;

/** Across all tenants in this process. */
export const MAX_STREAMS_GLOBAL = 32;

const perTenant = new Map<string, number>();
let total = 0;

/**
 * Every open stream's cut callback (#3827).
 *
 * Held HERE rather than in a second registry because this module already owns
 * the question "which streams are open" — a separate set would be two sources
 * of truth for one population, and the one that drifted would be the quiet one.
 */
const openCuts = new Set<(reason: string) => void>();

export type CapacityRefusal = 'TENANT_AT_CAPACITY' | 'PROCESS_AT_CAPACITY';

export interface CapacityLease {
    /** Idempotent: calling twice does not double-decrement. */
    release(): void;
}

/**
 * Take a slot, or refuse with the term that is actually binding.
 *
 * The REASON is returned rather than a bare boolean because the two refusals
 * need different operator actions — one tenant is noisy, or the process is
 * full — and a refusal naming the wrong term sends someone to the wrong place.
 * That is the same argument `assertAutonomy` makes about its own refusals.
 *
 * Refuses the N+1 rather than degrading the N already open: converting one
 * caller's excess into everyone's latency is the worse failure, and it is
 * invisible from the refused request's point of view.
 */
export function acquireStreamSlot(
    tenantId: string,
    onCut?: (reason: string) => void,
): CapacityLease | CapacityRefusal {
    if (total >= MAX_STREAMS_GLOBAL) return 'PROCESS_AT_CAPACITY';
    const held = perTenant.get(tenantId) ?? 0;
    if (held >= MAX_STREAMS_PER_TENANT) return 'TENANT_AT_CAPACITY';

    perTenant.set(tenantId, held + 1);
    total += 1;
    if (onCut !== undefined) openCuts.add(onCut);

    let released = false;
    return {
        release: () => {
            // Idempotent because the release paths overlap by design: a client
            // abort and the stream's own completion can both fire, and a
            // double-decrement would leak capacity upward until the process
            // admitted more streams than the cap allows.
            if (released) return;
            released = true;
            if (onCut !== undefined) openCuts.delete(onCut);
            total -= 1;
            const now = (perTenant.get(tenantId) ?? 1) - 1;
            if (now <= 0) perTenant.delete(tenantId);
            else perTenant.set(tenantId, now);
        },
    };
}

/**
 * Tell every open stream the server is going away, so the client renders a
 * reason instead of a hang (#3827).
 *
 * ═══ CUT, NOT DRAIN — AND WHY ═══
 *
 * `shutdown.ts` bounds every stage by a budget, and its ordering is by cost of
 * loss: the agentic-run pause sits above OTel because "an abandoned run costs
 * more than a lost span". An assistant turn may legitimately run to its 60s
 * wall-clock bound, which no shutdown budget can accommodate — the ceiling for
 * ALL stages is 20s. So draining is not an option that was rejected on taste;
 * it does not fit.
 *
 * Cutting loses no data: the turn created nothing (proposals are a separate,
 * already-committed path) and the audit row for the turn is written by the
 * stage above this one. What it saves is the user staring at a dead connection,
 * which is why it sits above the observability-only stages and below the two
 * that protect records.
 *
 * Never throws: a cut that failed must not stop the remaining stages, the same
 * contract the audit and run-pause stages carry.
 */
export function cutAllOpenStreams(reason: string): number {
    const cuts = [...openCuts];
    for (const cut of cuts) {
        try {
            cut(reason);
        } catch {
            // One stream's teardown must not deny the others their message.
        }
    }
    return cuts.length;
}

/** For tests and diagnostics. Never used to make a decision. */
export function streamCapacitySnapshot(): { total: number; tenants: Record<string, number> } {
    return { total, tenants: Object.fromEntries(perTenant) };
}

/** Test-only reset, so one suite's leaked slot cannot fail the next. */
export function __resetStreamCapacity(): void {
    perTenant.clear();
    openCuts.clear();
    total = 0;
}
