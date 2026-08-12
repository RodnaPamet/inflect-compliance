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
