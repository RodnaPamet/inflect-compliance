/**
 * The shape every library-v1 procedure module implements, and the reads two
 * of them share (#3676).
 *
 * A module READS its population from raw rows and returns what the
 * orchestrator (`./index.ts`) needs to freeze it, check its preconditions and
 * judge a sample. It never decides the conclusion, never draws the sample,
 * never proposes and never records: those are the orchestrator's, written once
 * for all five, so no procedure can be the one that concludes differently.
 *
 * ── RAW ROWS, NEVER A STORED FIGURE ─────────────────────────────────────────
 *
 * Every module recomputes what it relies on from the rows that record what
 * happened. None reads a `CheckResult`, an `IntegrationExecution.resultJson`,
 * an evidence body, a control test's verdict, or a count another job stored.
 * `eslint.config.mjs` (the `audit-procedures` block) holds the
 * line structurally; each procedure's integration fixture holds it
 * behaviourally, with a stored figure that is wrong.
 *
 * ── EVERY READ IS BOUNDED AND BATCHED ───────────────────────────────────────
 *
 * One query per kind of row, keyed `in:` the ids a step needs, each with a
 * `take`; nothing reads inside a loop. A read that comes back full is a
 * truncation the module reports, never a population it pretends is whole.
 */
import type { PrismaTx } from '@/lib/db-context';
import type { UnitJudgement } from '@/lib/agentic/audit-procedure-library';

/** The catalogue's population cap: the read takes one row past it. */
export const POPULATION_CAP = 5000;

/** The identity providers whose accounts the procedures consider (catalogue procedures 1, 2 and 4). */
export const IDENTITY_PROVIDERS = ['okta', 'google-workspace', 'entra-id', 'active-directory'] as const;

/** What a run needs to read one procedure's population. */
export interface ProcedureReadContext {
    readonly db: PrismaTx;
    readonly tenantId: string;
    readonly periodLabel: string;
    readonly periodStart: Date;
    readonly periodEnd: Date;
    readonly now: Date;
    /** The second line's parameters, each set (PARAMETER_UNSET is checked before the read). */
    readonly parameters: Readonly<Record<string, number>>;
}

export interface PopulationException {
    readonly unitId: string | null;
    readonly code: string;
}

/** One procedure's population as read by this run. */
export interface PopulationReading {
    /** The frozen units, each an identifier. Sub-populations prefix theirs (`directory:<id>`). */
    readonly unitIds: readonly string[];
    /** Per sub-population, the units of each (procedure 4). */
    readonly subPopulations?: Readonly<Record<string, readonly string[]>>;
    /** The read came back past the cap: never sampled. */
    readonly truncated: boolean;
    /** Exceptions a population-level check raised, whatever the sample holds. */
    readonly populationExceptions: readonly PopulationException[];
    /** Counts and codes reported on the workpaper's evidence: scope limits, exclusions. */
    readonly facts: readonly string[];
    /**
     * The procedure's own preconditions (`SYNC_NOT_FRESH`, `ADMIN_SIGNAL_ABSENT`,
     * `AUDIT_CHAIN_BROKEN`), asked only of a population that is neither
     * truncated nor empty. The first that fails, or null.
     */
    preconditions(): Promise<string | null>;
    /** Judge the sampled units from raw rows, re-read by id. */
    evaluate(sampledUnitIds: readonly string[]): Promise<{ units: UnitJudgement[]; facts: string[] }>;
}

export interface ProcedureModule {
    read(rc: ProcedureReadContext): Promise<PopulationReading>;
}

/** `<provider>.sync`, the automation key a directory sync records its executions under. */
export function syncAutomationKey(provider: string): string {
    return `${provider}.sync`;
}

/**
 * The connections, of those named, whose newest PASSED sync completed at or
 * after `since`. One query; a connection with no such row is stale. The
 * catalogue's freshness rule (`OBSERVATION_FRESHNESS_MS`, two days): an ACTIVE
 * or non-ACTIVE reading from a stale mirror proves nothing.
 */
export async function freshConnectionIds(
    db: PrismaTx,
    tenantId: string,
    connections: readonly { id: string; provider: string }[],
    since: Date,
): Promise<Set<string>> {
    if (connections.length === 0) return new Set();
    const rows = await db.integrationExecution.findMany({
        where: {
            tenantId,
            connectionId: { in: connections.map((c) => c.id) },
            automationKey: { in: [...new Set(connections.map((c) => syncAutomationKey(c.provider)))] },
            status: 'PASSED',
            completedAt: { gte: since },
        },
        select: { connectionId: true, automationKey: true },
        distinct: ['connectionId', 'automationKey'],
        take: connections.length * IDENTITY_PROVIDERS.length,
    });
    const providerOf = new Map(connections.map((c) => [c.id, c.provider] as const));
    return new Set(
        rows
            .filter((r) => r.connectionId !== null && r.automationKey === syncAutomationKey(providerOf.get(r.connectionId) ?? ''))
            .map((r) => r.connectionId as string),
    );
}

/** Lower-case and trim an address for the case-insensitive joins the catalogue names. */
export function emailKey(email: string | null | undefined): string | null {
    const k = (email ?? '').trim().toLowerCase();
    return k.length > 0 ? k : null;
}

/** Group rows by a key, keeping insertion order. */
export function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
    const out = new Map<string, T[]>();
    for (const row of rows) {
        const k = key(row);
        const list = out.get(k);
        if (list) list.push(row);
        else out.set(k, [row]);
    }
    return out;
}
