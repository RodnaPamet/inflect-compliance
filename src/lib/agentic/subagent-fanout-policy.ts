/**
 * Reading the fan-out cap for a run (#3473).
 *
 * The server half of `subagent-fanout.ts`, split from it for the reason
 * `run-concurrency-policy` is split from `run-concurrency`: the arithmetic is
 * pure and has to load inside the Flue ESM graph, and this half reaches Prisma
 * and cannot.
 *
 * ## A FAILED READ RESOLVES TO THE DEFAULT, NOT TO "NO CAP"
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
 * Delegation has no such claim on us. Nothing can delegate today, so there is
 * no running work to protect and no outage to cause: a failed read that
 * resolved to "unlimited" would hand an unbounded fan-out to the one caller
 * whose settings row could not be read, which is precisely the caller about
 * whom we know least. The default is the safe answer AND the ordinary one —
 * the column is `NOT NULL DEFAULT 3`, so the default is what almost every
 * tenant has anyway.
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
        logger.warn('subagent-fanout: settings read failed, using the product default', {
            component: 'agentic',
            tenantId,
            requestId,
            cap: DEFAULT_MAX_SUBAGENTS_PER_TURN,
            error: err instanceof Error ? err.message : String(err),
        });
        return DEFAULT_MAX_SUBAGENTS_PER_TURN;
    }
}
