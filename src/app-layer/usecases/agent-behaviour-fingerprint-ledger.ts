/**
 * The behaviour fingerprint's ONLY read of the agent ledger.
 *
 * Three grouped counts over one UTC day, one per source table, and nothing
 * else. Every column this file names is in `FINGERPRINT_SOURCE_COLUMNS`
 * (`src/lib/agentic/behaviour-fingerprint.ts`), and
 * `tests/guards/agent-behaviour-fingerprint-content-free.test.ts` reads this
 * file and refuses any other column of those tables — so a content column
 * cannot reach a feature without a reviewed change to the allowlist, which the
 * same guard checks against the Prisma datamodel.
 *
 * Kept apart from the usecase on purpose: a short file is one the guard can
 * hold to "names no other column" without the usecase's own vocabulary (a
 * finding's `status`, a row's `id`) tripping it.
 *
 * Bounded: every read is anchored on the tenant AND the register's own agent
 * ids (at most `FINGERPRINT_MAX_AGENTS`), ranged on one UTC day, and returns at
 * most one group per agent. On `AgentBehaviourWindow` that is a prefix of its
 * only index, `@@unique([tenantId, agentId, windowStart])`, so rows examined are
 * one day of hours per agent however long the unswept table grows
 * (`tests/guards/agent-behaviour-window-reads-are-bounded.test.ts`).
 *
 * @module usecases/agent-behaviour-fingerprint-ledger
 */
import type { PrismaTx } from '@/lib/db-context';
import { buildFeatures, GUARD_FLAG_VERDICTS, type FingerprintFeatures } from '@/lib/agentic/behaviour-fingerprint';

/**
 * The most registered agents one pass scores. A tenant above it is scored for
 * its first `FINGERPRINT_MAX_AGENTS` by id and the pass records the truncation.
 */
export const FINGERPRINT_MAX_AGENTS = 2000;

/** One day's features per agent of `agentIds` that was active in it. */
export async function readLedgerDay(
    db: Pick<PrismaTx, 'agentBehaviourWindow' | 'agentProposal' | 'aiDecisionLog'>,
    tenantId: string,
    agentIds: readonly string[],
    start: Date,
    end: Date,
): Promise<Map<string, FingerprintFeatures>> {
    if (agentIds.length === 0) return new Map();
    const ids = [...agentIds].slice(0, FINGERPRINT_MAX_AGENTS);
    const [windows, proposals, decisions] = await Promise.all([
        db.agentBehaviourWindow.groupBy({
            by: ['agentId'],
            where: { tenantId, agentId: { in: ids }, windowStart: { gte: start, lt: end } },
            _sum: { readCalls: true, proposeCalls: true, orchestrateCalls: true },
            _count: { _all: true },
            orderBy: { agentId: 'asc' },
            take: FINGERPRINT_MAX_AGENTS,
        }),
        db.agentProposal.groupBy({
            by: ['agentId', 'guardVerdict'],
            where: { tenantId, agentId: { in: ids }, createdAt: { gte: start, lt: end } },
            _count: { _all: true },
            orderBy: { agentId: 'asc' },
            // One group per agent per guard verdict (three verdicts).
            take: FINGERPRINT_MAX_AGENTS * 3,
        }),
        db.aiDecisionLog.groupBy({
            by: ['agentId'],
            where: { tenantId, agentId: { in: ids }, createdAt: { gte: start, lt: end } },
            _sum: { tokensIn: true, tokensOut: true },
            _count: { _all: true },
            orderBy: { agentId: 'asc' },
            take: FINGERPRINT_MAX_AGENTS,
        }),
    ]);

    type Acc = {
        readCalls: number; proposeCalls: number; orchestrateCalls: number; activeHours: number;
        proposals: number; guardFlags: number; modelCalls: number; tokensIn: number; tokensOut: number;
    };
    const acc = new Map<string, Acc>();
    const of = (agentId: string): Acc => {
        let a = acc.get(agentId);
        if (!a) {
            a = { readCalls: 0, proposeCalls: 0, orchestrateCalls: 0, activeHours: 0, proposals: 0, guardFlags: 0, modelCalls: 0, tokensIn: 0, tokensOut: 0 };
            acc.set(agentId, a);
        }
        return a;
    };
    const flagged = new Set<string>(GUARD_FLAG_VERDICTS);

    for (const w of windows) {
        const a = of(w.agentId);
        a.readCalls += w._sum.readCalls ?? 0;
        a.proposeCalls += w._sum.proposeCalls ?? 0;
        a.orchestrateCalls += w._sum.orchestrateCalls ?? 0;
        // One row per ACTIVE hour, so the row count is the active hours.
        a.activeHours += w._count._all;
    }
    for (const p of proposals) {
        if (p.agentId === null) continue;
        const a = of(p.agentId);
        a.proposals += p._count._all;
        if (flagged.has(p.guardVerdict)) a.guardFlags += p._count._all;
    }
    for (const d of decisions) {
        if (d.agentId === null) continue;
        const a = of(d.agentId);
        a.modelCalls += d._count._all;
        a.tokensIn += d._sum.tokensIn ?? 0;
        a.tokensOut += d._sum.tokensOut ?? 0;
    }

    const out = new Map<string, FingerprintFeatures>();
    for (const [agentId, a] of acc) out.set(agentId, buildFeatures(a));
    return out;
}
