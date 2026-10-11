/**
 * DB-free probe for `runRetentionSweep` (`src/app-layer/jobs/data-lifecycle.ts`).
 *
 * The sweep takes an injectable `db`, so we hand it an in-memory fake whose
 * delegates RECORD every `findMany` / `update` and evaluate the real `where`
 * clause. That makes two things observable without a database:
 *
 *   1. WHICH models the sweep actually queries (membership in
 *      `RETENTION_MODELS`, which is module-private), and
 *   2. WHETHER a written `retentionUntil` is honoured end-to-end
 *      (soft-delete + `DATA_EXPIRED` audit row).
 *
 * Used by `tests/unit/jobs/retention-sweep-writer-parity.test.ts` (behaviour)
 * and `tests/guardrails/retention-policy-coverage.test.ts` (doc↔behaviour
 * cross-walk). Both must stay DB-free — do not reach for prismaTestClient here.
 */
import { runRetentionSweep } from '@/app-layer/jobs/data-lifecycle';

/** Every Prisma model that carries a `retentionUntil` column. */
export const RETENTION_COLUMN_MODELS = [
    'Asset', 'Risk', 'Control', 'Evidence',
    'Policy', 'Vendor', 'FileRecord', 'Task',
] as const;

export type RetentionColumnModel = (typeof RETENTION_COLUMN_MODELS)[number];

export interface ProbeRow {
    id: string;
    tenantId: string;
    retentionUntil: Date | null;
    deletedAt: Date | null;
}

export interface SweepProbe {
    /** Model names the sweep called `findMany` on, in order. */
    queried: RetentionColumnModel[];
    /** Every `update` the sweep issued. */
    updated: Array<{ model: RetentionColumnModel; id: string; data: Record<string, unknown> }>;
    /** Every audit row the sweep wrote. */
    audits: Array<{ tenantId: string; action: string; entity: string; entityId: string; details: string }>;
    /** Live row store, mutated in place by `update`. */
    rows: Record<RetentionColumnModel, ProbeRow[]>;
}

function delegateKey(model: RetentionColumnModel): string {
    return model.charAt(0).toLowerCase() + model.slice(1);
}

/** Evaluates the subset of Prisma `where` the sweep actually builds. */
function matches(row: ProbeRow, where: Record<string, unknown>): boolean {
    for (const [field, cond] of Object.entries(where)) {
        const value = (row as unknown as Record<string, unknown>)[field];
        if (cond === null) {
            if (value !== null && value !== undefined) return false;
            continue;
        }
        if (cond instanceof Date || typeof cond === 'string') {
            if (value instanceof Date && cond instanceof Date) {
                if (value.getTime() !== cond.getTime()) return false;
            } else if (value !== cond) return false;
            continue;
        }
        if (typeof cond === 'object') {
            const c = cond as { not?: unknown; lt?: Date };
            if ('not' in c && c.not === null && (value === null || value === undefined)) return false;
            if (c.lt !== undefined) {
                if (!(value instanceof Date)) return false;
                if (value.getTime() >= c.lt.getTime()) return false;
            }
            continue;
        }
    }
    return true;
}

/**
 * Builds a fake Prisma client exposing a delegate for EVERY model that has a
 * `retentionUntil` column — so a model the sweep should not touch is present
 * and populated, and its absence from `probe.queried` is a real signal rather
 * than a missing-delegate accident.
 */
export function makeSweepProbe(
    seed: Partial<Record<RetentionColumnModel, ProbeRow[]>> = {},
): { probe: SweepProbe; db: unknown } {
    const rows = Object.fromEntries(
        RETENTION_COLUMN_MODELS.map((m) => [m, [...(seed[m] ?? [])]]),
    ) as Record<RetentionColumnModel, ProbeRow[]>;

    const probe: SweepProbe = { queried: [], updated: [], audits: [], rows };

    const db: Record<string, unknown> = {
        auditLog: {
            create: async (args: { data: Record<string, unknown> }) => {
                probe.audits.push(args.data as unknown as SweepProbe['audits'][number]);
                return args.data;
            },
        },
    };

    for (const model of RETENTION_COLUMN_MODELS) {
        db[delegateKey(model)] = {
            findMany: async (args: { where: Record<string, unknown> }) => {
                probe.queried.push(model);
                return rows[model]
                    .filter((r) => matches(r, args.where ?? {}))
                    .map((r) => ({ id: r.id, tenantId: r.tenantId }));
            },
            update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
                probe.updated.push({ model, id: args.where.id, data: args.data });
                const row = rows[model].find((r) => r.id === args.where.id);
                if (row && args.data.deletedAt instanceof Date) row.deletedAt = args.data.deletedAt;
                return row;
            },
        };
    }

    return { probe, db };
}

/** Runs the real sweep against the fake client and returns the probe. */
export async function runProbedSweep(
    seed: Partial<Record<RetentionColumnModel, ProbeRow[]>> = {},
    options: { tenantId?: string; now?: Date; dryRun?: boolean } = {},
): Promise<{ probe: SweepProbe; results: Array<{ model: string; scanned: number; expired: number }> }> {
    const { probe, db } = makeSweepProbe(seed);
    const results = await runRetentionSweep({
        ...options,
        db: db as NonNullable<Parameters<typeof runRetentionSweep>[0]>['db'],
    });
    return { probe, results };
}

/**
 * The set of models the sweep actually acts on, observed by running it with
 * every retention-column model seeded with one already-expired row.
 */
export async function observedSweptModels(): Promise<Set<RetentionColumnModel>> {
    const now = new Date('2026-06-01T00:00:00.000Z');
    const expired = new Date(now.getTime() - 30 * 86_400_000);
    const seed = Object.fromEntries(
        RETENTION_COLUMN_MODELS.map((m) => [
            m,
            [{ id: `${m}-1`, tenantId: 't1', retentionUntil: expired, deletedAt: null }],
        ]),
    ) as Record<RetentionColumnModel, ProbeRow[]>;

    const { probe } = await runProbedSweep(seed, { tenantId: 't1', now, dryRun: true });
    return new Set(probe.queried);
}

// ═══════════════════════════════════════════════════════════════════════════
// The legacy access snapshot purge (#3317) — a SECOND probe, not an extension
// of the one above.
//
// `purgeLegacyAccessSnapshotsOlderThan` is a different shape from
// `runRetentionSweep` and the difference is why the first probe cannot be
// reused: it HARD-deletes rather than soft-deleting, it keys off a CHILD table
// (`LegacyAccountResolution`) rather than a `retentionUntil` column on the row,
// and its windows are per-tenant settings rather than one constant. None of the
// eight `RETENTION_COLUMN_MODELS` has that shape.
//
// WHAT THE CROSS-WALK ASKS, AND WHY IT IS NOT "WHICH DELEGATES WERE CALLED".
// `LegacyAccount` is deleted by CASCADE — the function never touches the
// `legacyAccount` delegate at all. A probe that recorded called delegates would
// therefore report the `LegacyAccount` doc row's claim as FALSE while it is
// true, which is worse than no check: it would push someone to delete a correct
// row from the retention policy.
//
// So the subject is what the function REPORTS destroying: its `PurgeResult[]`
// is the declaration the job's totals and the operator's attestation are both
// built from. A `LegacyAccount` result removed from that list is a real
// regression — the accounts would still be destroyed and would stop being
// counted anywhere — and this makes the doc row fail with it.
//
// The `queried` set is recorded as well, so the assertion cannot pass over a
// function that returns a result list without looking at anything.
// ═══════════════════════════════════════════════════════════════════════════

export interface LegacyPurgeProbe {
    /** Delegates the purge called, as `model.method`. */
    readonly calls: string[];
    /** Model names it reported acting on. */
    readonly reported: string[];
}

/**
 * Runs the legacy snapshot purge against an in-memory client.
 *
 * Seeded so that the purge has something to find: one tenant, one snapshot far
 * enough past both cutoffs, carrying an account count. A probe seeded with
 * nothing would observe a function that correctly did nothing, and report an
 * empty set that reads identically to a function that queries nothing.
 */
export async function probeLegacyPurge(): Promise<LegacyPurgeProbe> {
    const { purgeLegacyAccessSnapshotsOlderThan } = await import(
        '@/app-layer/jobs/data-lifecycle'
    );
    const calls: string[] = [];
    const db = {
        legacyAccessSnapshot: {
            groupBy: async () => {
                calls.push('legacyAccessSnapshot.groupBy');
                return [{ tenantId: 't1', _count: { _all: 2 } }];
            },
            findMany: async () => {
                calls.push('legacyAccessSnapshot.findMany');
                return [{ id: 'snap-1', tenantId: 't1', _count: { accounts: 1_200 } }];
            },
            deleteMany: async () => {
                calls.push('legacyAccessSnapshot.deleteMany');
                return { count: 1 };
            },
        },
        tenantSecuritySettings: {
            // `findMany`, not `findUnique`: the purge HOISTS this read out of the
            // tenant loop because `query-shape-guardrails` Layer D1 refuses a
            // Prisma read inside one. A double still shaped for the per-tenant
            // call would make this probe pass against a function that no longer
            // exists in that form.
            findMany: async () => {
                calls.push('tenantSecuritySettings.findMany');
                return []; // no settings rows — the defaults must still apply
            },
        },
        auditLog: {
            create: async () => {
                calls.push('auditLog.create');
                return {};
            },
        },
    };

    const results = await purgeLegacyAccessSnapshotsOlderThan({
        now: new Date('2026-06-01T00:00:00.000Z'),
        dryRun: true,
        db: db as unknown as NonNullable<
            Parameters<typeof purgeLegacyAccessSnapshotsOlderThan>[0]
        >['db'],
    });

    return { calls, reported: results.map((r) => r.model) };
}

/** The models the legacy purge reports acting on. */
export async function observedLegacyPurgeModels(): Promise<Set<string>> {
    return new Set((await probeLegacyPurge()).reported);
}
