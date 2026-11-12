/**
 * Reading the fan-out cap for a run (#3473).
 *
 * The server half of `subagent-fanout.ts`, split from it for the reason
 * `run-concurrency-policy` is split from `run-concurrency`: the arithmetic is
 * pure and has to load inside the Flue ESM graph, and this half reaches Prisma
 * and cannot.
 *
 * ## A FAILED READ RESOLVES TO NO DELEGATION (owner decision, 2026-11-12)
 *
 * Which is the OPPOSITE of what `readCap` in `run-concurrency-policy` does,
 * and the inversion is deliberate rather than an inconsistency — so it is
 * written here, where somebody comparing the two files will look.
 *
 * That reader fails OPEN, on an argument its own comment makes: the
 * concurrent-run cap bounds something already authorised, so an unreadable
 * settings row must not become an outage. Refusing every agentic run because a
 * settings table hiccupped would be a control wearing an outage's costume.
 *
 * Delegation has no such claim on us. A run that cannot delegate still runs;
 * it only does the work itself. And the settings row is where a tenant
 * NARROWS delegation — a stored 0 means "no delegation", 1 means one per
 * turn. This read used to fall back to the product default (3), which is wider
 * than either: for as long as the row could not be read, a tenant that had
 * switched delegation off had it switched back on. So a failed read resolves to
 * 0, never wider than any choice a tenant can have stored (#5376). An ABSENT
 * row is different and still reads as the default: it is a tenant that never
 * chose, and the column's own default is 3.
 *
 * The log line is what keeps the fallback from being silent, exactly as it
 * does there.
 */
import prisma from '@/lib/prisma';
import { logger } from '@/lib/observability/logger';

import {
    DEFAULT_MAX_SUBAGENTS_PER_TURN,
    normaliseFanOutCap,
} from './subagent-fanout';

/** What an unreadable settings row resolves to: no delegation (see the header). */
export const FAILED_READ_FAN_OUT_CAP = 0;

/**
 * The tenant's fan-out cap, as a number the binding can carry.
 *
 * Never throws and never returns null: the binding's field is a number or
 * absent, and absent means the default. A caller that got an exception here
 * would have to decide what to do about it at the one point in the dispatch
 * where the answer is least obvious.
 */
export async function readFanOutCap(
    tenantId: string,
    requestId: string | undefined,
): Promise<number> {
    try {
        const row = await prisma.tenantSecuritySettings.findUnique({
            where: { tenantId },
            select: { agentMaxSubagentsPerTurn: true },
        });
        // `?? DEFAULT` covers the row being ABSENT, which is a real state: a
        // tenant with no `TenantSecuritySettings` row at all has never had its
        // security settings touched. The column itself is NOT NULL, so a
        // PRESENT row always carries a number.
        return normaliseFanOutCap(row?.agentMaxSubagentsPerTurn ?? DEFAULT_MAX_SUBAGENTS_PER_TURN);
    } catch (err) {
        logger.warn('subagent-fanout: settings read failed, allowing no delegation', {
            component: 'agentic',
            tenantId,
            requestId,
            cap: FAILED_READ_FAN_OUT_CAP,
            error: err instanceof Error ? err.message : String(err),
        });
        return FAILED_READ_FAN_OUT_CAP;
    }
}
