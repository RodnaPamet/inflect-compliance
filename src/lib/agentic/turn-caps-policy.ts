/**
 * Reading the two per-turn caps for a run (#4594).
 *
 * The server half of `turn-caps.ts`, split from it for the reason
 * `run-concurrency-policy` is split from `run-concurrency`: the arithmetic is
 * pure and has to load inside the Flue ESM graph, and this half reaches Prisma
 * and cannot. It replaces `readFanOutCap`, so both engines read the delegation
 * cap from here and there is one reader.
 *
 * ## A FAILED READ RESOLVES TO THE NARROWEST VALUE OF BOTH
 *
 * No delegation (owner decision, 2026-11-12) and one tool call (its twin,
 * 2026-11-13). Which is the OPPOSITE of what `readCap` in
 * `run-concurrency-policy` does, and the inversion is deliberate: that reader
 * fails OPEN because the concurrent-run cap bounds something already
 * authorised, and refusing every run because a settings table hiccupped would
 * be an outage. A run that cannot delegate, or that may call one tool per turn,
 * still runs; it only does the work itself, or serially. The settings are
 * where an organization and a workspace NARROW both, so falling back to any
 * wider number would switch a narrowing off for as long as the row could not
 * be read (#5376).
 *
 * ONE QUERY reads both, so a failure of either part is a failure of the read.
 * An ABSENT settings row narrows nothing, and a workspace with no organization
 * takes the product defaults as its ceiling: neither is a failure.
 *
 * The organization's row is read by the TENANT's id, so a run never names the
 * organization whose ceiling applies to it, as `agent-switches-policy` reads
 * the switches. The global client, because `Organization` is under org RLS a
 * workspace's run context does not satisfy.
 */
import prisma from '@/lib/prisma';
import { logger } from '@/lib/observability/logger';

import {
    FAILED_READ_TURN_CAPS,
    failedReadTurnCaps,
    resolveTurnCaps,
    type TurnCapInputs,
    type TurnCaps,
} from './turn-caps';

/** What an unreadable row resolves to for delegation: none. Kept from the fan-out reader. */
export const FAILED_READ_FAN_OUT_CAP = FAILED_READ_TURN_CAPS.delegationsPerTurn;

const CAP_COLUMNS = { agentMaxSubagentsPerTurn: true, agentMaxToolCallsPerTurn: true } as const;

/**
 * The resolver's inputs for one workspace, in ONE read. THROWS on a failed
 * read: a writer validating against the ceiling must refuse, never guess.
 */
export async function readTurnCapInputs(tenantId: string): Promise<TurnCapInputs> {
    const row = await prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { organization: { select: CAP_COLUMNS }, securitySettings: { select: CAP_COLUMNS } },
    });
    const org = row?.organization ?? null;
    const ws = row?.securitySettings ?? null;
    return {
        organization: org
            ? { delegationsPerTurn: org.agentMaxSubagentsPerTurn, toolCallsPerTurn: org.agentMaxToolCallsPerTurn }
            : null,
        workspace: ws
            ? { delegationsPerTurn: ws.agentMaxSubagentsPerTurn, toolCallsPerTurn: ws.agentMaxToolCallsPerTurn }
            : null,
    };
}

/**
 * The two caps that apply to a run of this workspace.
 *
 * Never throws: a caller that got an exception here would have to decide what
 * to do about it at the one point in the dispatch where the answer is least
 * obvious. The log line is what keeps the fallback from being silent.
 */
export async function readTurnCaps(tenantId: string, requestId: string | undefined): Promise<TurnCaps> {
    try {
        return resolveTurnCaps(await readTurnCapInputs(tenantId));
    } catch (err) {
        logger.warn('turn-caps: settings read failed, allowing no delegation and one tool call per turn', {
            component: 'agentic',
            tenantId,
            requestId,
            delegationsPerTurn: FAILED_READ_TURN_CAPS.delegationsPerTurn,
            toolCallsPerTurn: FAILED_READ_TURN_CAPS.toolCallsPerTurn,
            error: err instanceof Error ? err.message : String(err),
        });
        return failedReadTurnCaps();
    }
}
