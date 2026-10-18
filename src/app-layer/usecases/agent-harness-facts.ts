/**
 * ONE DISCOVERED AGENT'S FACTS — what a scan observed about it, and nothing a
 * reader has concluded (#3668, step 1d of the agentic IAM roadmap).
 *
 * The read behind the `get_discovered_agent` MCP tool, which is how a run of
 * the `discovered-agent-review` workflow gives its two IAM skills their
 * required input. `harness-level-assessment` judges each criterion from these
 * observations; `nhi-ownership-attribution` proposes an owner from these
 * signals. So this returns OBSERVATIONS, and deliberately not the answers:
 *
 *   • no derived LEVEL and no `blockingNextRung`. The ladder derives the level
 *     from verdicts, and the assessment skill is told never to state one; a
 *     facts read that handed it the stored level would make the assessment an
 *     echo of the number it exists to check.
 *   • the owner AS THE SOURCE RECORDS IT — a reference in the source's own
 *     namespace, which is a signal for the attribution, never an Inflect user
 *     and never a register owner.
 *
 * READ-ONLY, like `agent-harness-matrix.ts`: `findFirst` and nothing else. The
 * three scan tables are written by `agent-harness-scans.ts` alone
 * (`tests/guards/agent-harness-single-write-seam.test.ts`).
 *
 * GATED ON `admin.agent_registry`, the key every harness read takes
 * (`listHarnessScans`, `getHarnessMatrix`). No API-key scope maps to it, so no
 * bearer token reaches this read today — see the roadmap's Permission keys
 * section and the step-1d implementation note for what that means for a Flue
 * run.
 *
 * FAIL CLOSED, as the matrix does: stored sources that do not re-validate make
 * the scan INCOMPLETE; stored observations or tools that do not re-validate
 * read as `null` — "could not be read" — never as an empty list, because no
 * observations would read as an agent nobody could fault.
 */
import type { RequestContext } from '../types';
import { runInTenantContext } from '@/lib/db-context';
import { forbidden, notFound } from '@/lib/errors/types';
import {
    parseStoredHarnessSources,
    parseStoredHarnessTools,
    parseStoredHarnessVerdicts,
    type StoredHarnessTool,
} from '@/lib/agentic/harness-contract';
import {
    harnessScanCompleteness,
    type HarnessScanCompleteness,
    type HarnessStoredReach,
    type StoredSource,
} from '@/lib/agentic/harness-read-model';
import type { CriterionVerdict } from '@/lib/agentic/harness-ladder';

export interface DiscoveredAgentFacts {
    readonly discoveredAgentId: string;
    /** The id the source gave it, e.g. `entra:sp:<objectId>`. */
    readonly discoveredId: string;
    readonly discoveredVia: readonly string[];
    /** `null` is SHADOW — including a register row deleted after a scan linked it. */
    readonly registeredAgentId: string | null;
    /** The owner as the SOURCE records it, or `null` when it records none. */
    readonly sourceOwner: { readonly kind: string; readonly ref: string } | null;
    readonly firstSeenAt: string;
    readonly lastSeenAt: string;
    /** The newest scan (by the moment it describes) that saw this agent, or `null` when none did. */
    readonly scan: {
        readonly scanRef: string;
        readonly asOf: string;
        readonly completeness: HarnessScanCompleteness;
        /** `null` = the stored sources failed re-validation, and the scan reads INCOMPLETE. */
        readonly sources: readonly StoredSource[] | null;
    } | null;
    readonly reach: HarnessStoredReach | null;
    /** Per-criterion observations, AS REPORTED — not judged. `null` = unreadable. */
    readonly observations: readonly CriterionVerdict[] | null;
    /** `null` = unreadable, never "no tools". */
    readonly tools: readonly StoredHarnessTool[] | null;
}

function assertMayRead(ctx: RequestContext): void {
    if (!ctx.appPermissions.admin.agent_registry) {
        throw forbidden('Reading a discovered agent requires admin.agent_registry');
    }
}

export async function getDiscoveredAgentFacts(
    ctx: RequestContext,
    discoveredAgentId: string,
): Promise<DiscoveredAgentFacts> {
    assertMayRead(ctx);
    return runInTenantContext(ctx, async (db) => {
        const agent = await db.discoveredAgent.findFirst({
            where: { id: discoveredAgentId, tenantId: ctx.tenantId },
            select: {
                id: true,
                discoveredId: true,
                discoveredVia: true,
                ownerKind: true,
                ownerRef: true,
                firstSeenAt: true,
                lastSeenAt: true,
                registeredAgent: { select: { id: true, deletedAt: true } },
            },
        });
        if (!agent) throw notFound('Discovered agent not found');

        // "Latest" as the matrix means it: the scan describing the newest
        // moment, then the one received later, then id — so a backfilled older
        // report does not pose as the current one.
        const item = await db.agentHarnessScanItem.findFirst({
            where: { tenantId: ctx.tenantId, discoveredAgentId: agent.id },
            orderBy: [{ scan: { asOf: 'desc' } }, { scan: { createdAt: 'desc' } }, { scanId: 'desc' }],
            select: {
                reach: true,
                verdictsJson: true,
                toolsJson: true,
                scan: { select: { scanRef: true, asOf: true, complete: true, agentCount: true, sourcesJson: true } },
            },
        });

        const sources = item ? parseStoredHarnessSources(item.scan.sourcesJson) : null;
        const register = agent.registeredAgent && agent.registeredAgent.deletedAt === null ? agent.registeredAgent : null;
        return {
            discoveredAgentId: agent.id,
            discoveredId: agent.discoveredId,
            discoveredVia: agent.discoveredVia,
            registeredAgentId: register ? register.id : null,
            sourceOwner: agent.ownerKind && agent.ownerRef ? { kind: agent.ownerKind, ref: agent.ownerRef } : null,
            firstSeenAt: agent.firstSeenAt.toISOString(),
            lastSeenAt: agent.lastSeenAt.toISOString(),
            scan: item
                ? {
                    scanRef: item.scan.scanRef,
                    asOf: item.scan.asOf.toISOString(),
                    completeness: harnessScanCompleteness({
                        complete: item.scan.complete,
                        agentCount: item.scan.agentCount,
                        sourcesReadable: sources !== null,
                    }),
                    sources,
                }
                : null,
            reach: item ? item.reach : null,
            observations: item ? parseStoredHarnessVerdicts(item.verdictsJson) : null,
            tools: item ? parseStoredHarnessTools(item.toolsJson) : null,
        };
    });
}
