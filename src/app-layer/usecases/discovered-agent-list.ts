/**
 * THE DISCOVERED AGENTS A PERSON CAN PICK FROM (#4472, owner decision
 * 2026-10-29) — the list behind the discovered-agent review's start form on
 * `/agents/runs`.
 *
 * The `discovered-agent-review` workflow takes one input, `discoveredAgentId`,
 * an internal id nobody would type. Until this read existed the runs page had
 * no way to offer one, so the workflow could not be started from the product
 * by a person at all.
 *
 * ── THE GATE IS THE ONE EVERY DISCOVERED-AGENT READ TAKES ──────────────────
 *
 * `mayReadAgentInventory`: the read-only `admin.agent_registry_view`, or the
 * register key whose holders always could (#3710). It is what
 * `getDiscoveredAgentFacts` (the `get_discovered_agent` tool the run then
 * calls), `listHarnessScans` and `getHarnessMatrix` assert, so the picker
 * offers no row that the run started from it could not then read. The route
 * spells the same keys as a literal `requirePermission`, so a refusal writes
 * the hash-chained `AUTHZ_DENIED` row; this assert is the usecase's floor.
 *
 * ── WHAT IT RETURNS, AND WHAT IT LEAVES OUT ────────────────────────────────
 *
 * Enough to choose an agent by and no more: the id to send, the id the source
 * gave it, the sources that saw it, when it was last seen, and the register
 * row's name when one is linked. Not the owner the source records
 * (`ownerRef`, an identifier in the source's namespace), not the level, not
 * the reach. The facts read hands those to the run; a picker has no use for
 * them.
 *
 * ── BOUNDED, AND THE BOUND IS A FACT ───────────────────────────────────────
 *
 * Newest seen first, `take` one past the cap, so `truncated` is something this
 * read KNOWS rather than something a caller would have to infer from a list
 * that happens to stop at the cap. Tenant-scoped twice, as everywhere: RLS
 * through `runInTenantContext`, and the explicit `tenantId` filter.
 *
 * READ-ONLY. The harness ingest stays the only writer of `DiscoveredAgent`
 * (`tests/guards/agent-harness-single-write-seam.test.ts`).
 */
import type { RequestContext } from '../types';
import { runInTenantContext } from '@/lib/db-context';
import { forbidden } from '@/lib/errors/types';
import { mayReadAgentInventory } from '@/lib/permissions';

/** The most discovered agents one picker read returns. */
export const DISCOVERED_AGENT_PICKER_CAP = 200;

export interface DiscoveredAgentOption {
    /** `DiscoveredAgent.id` — what the run is started with. */
    readonly id: string;
    /** The id the source gave it, e.g. `entra:sp:<objectId>`. */
    readonly discoveredId: string;
    readonly discoveredVia: readonly string[];
    readonly lastSeenAt: string;
    /** The linked register row's name, or `null` — a SHADOW agent, or a row since deleted. */
    readonly registeredAgentName: string | null;
}

export interface DiscoveredAgentOptions {
    readonly rows: readonly DiscoveredAgentOption[];
    /** More discovered agents exist than `rows` holds. */
    readonly truncated: boolean;
}

export async function listDiscoveredAgentOptions(ctx: RequestContext): Promise<DiscoveredAgentOptions> {
    if (!mayReadAgentInventory(ctx.appPermissions.admin)) {
        throw forbidden('Listing discovered agents requires admin.agent_registry_view');
    }
    const found = await runInTenantContext(ctx, (db) =>
        db.discoveredAgent.findMany({
            where: { tenantId: ctx.tenantId },
            // `id` breaks ties so a page of equal timestamps has one order.
            orderBy: [{ lastSeenAt: 'desc' }, { id: 'asc' }],
            take: DISCOVERED_AGENT_PICKER_CAP + 1,
            select: {
                id: true,
                discoveredId: true,
                discoveredVia: true,
                lastSeenAt: true,
                registeredAgent: { select: { name: true, deletedAt: true } },
            },
        }),
    );
    return {
        rows: found.slice(0, DISCOVERED_AGENT_PICKER_CAP).map((a) => ({
            id: a.id,
            discoveredId: a.discoveredId,
            discoveredVia: a.discoveredVia,
            lastSeenAt: a.lastSeenAt.toISOString(),
            registeredAgentName:
                a.registeredAgent && a.registeredAgent.deletedAt === null ? a.registeredAgent.name : null,
        })),
        truncated: found.length > DISCOVERED_AGENT_PICKER_CAP,
    };
}
