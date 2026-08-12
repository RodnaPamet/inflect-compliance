/**
 * Behavioural contract for `runRetentionSweep`'s model set.
 *
 * The invariant: the sweep queries a model ONLY if something in `src/` can
 * write that model's `retentionUntil`. Eight Prisma models carry the column;
 * only `Asset` (create/update/bulk-import schema → `usecases/asset.ts` → the
 * asset forms + CSV importer + public OpenAPI) and `Evidence`
 * (`usecases/evidence-retention.ts` + the evidence importer) have a writer.
 * `Evidence` is handled by the specialised `runEvidenceRetentionSweep`, so
 * the cross-model loop skips it — leaving `Asset` as the one model it acts on.
 *
 * These tests EXECUTE the sweep against an in-memory client (no DB) and
 * assert on what it did, not on how the source is spelled. They fail if:
 *   - a writer-less model is put back into `RETENTION_MODELS` (the sweep
 *     starts querying a model it can never act on — the exact defect), or
 *   - `Asset` is dropped and a written `retentionUntil` stops being honoured.
 */
import {
    RETENTION_COLUMN_MODELS,
    runProbedSweep,
    type ProbeRow,
    type RetentionColumnModel,
} from '../../helpers/retention-sweep-probe';

const NOW = new Date('2026-06-01T00:00:00.000Z');
const EXPIRED = new Date(NOW.getTime() - 30 * 86_400_000);
const FUTURE = new Date(NOW.getTime() + 30 * 86_400_000);
const TENANT = 't-probe';

/** Models with a `retentionUntil` column but no writer anywhere in `src/`. */
const WRITERLESS: RetentionColumnModel[] = [
    'Risk', 'Control', 'Policy', 'Vendor', 'FileRecord', 'Task',
];

function row(id: string, retentionUntil: Date | null, deletedAt: Date | null = null): ProbeRow {
    return { id, tenantId: TENANT, retentionUntil, deletedAt };
}

/** One already-expired row on every retention-column model. */
function seedAllExpired(): Record<RetentionColumnModel, ProbeRow[]> {
    return Object.fromEntries(
        RETENTION_COLUMN_MODELS.map((m) => [m, [row(`${m}-1`, EXPIRED)]]),
    ) as Record<RetentionColumnModel, ProbeRow[]>;
}

describe('runRetentionSweep — only sweeps models it can act on', () => {
    it('queries Asset and no other retention-column model', async () => {
        const { probe } = await runProbedSweep(seedAllExpired(), { tenantId: TENANT, now: NOW });

        expect(probe.queried).toEqual(['Asset']);
        for (const model of WRITERLESS) {
            expect(probe.queried).not.toContain(model);
        }
        // Evidence is deliberately delegated to runEvidenceRetentionSweep.
        expect(probe.queried).not.toContain('Evidence');
    });

    it('never soft-deletes or audits a writer-less model, even with an expired date on the row', async () => {
        const { probe, results } = await runProbedSweep(seedAllExpired(), {
            tenantId: TENANT, now: NOW,
        });

        for (const model of WRITERLESS) {
            expect(probe.updated.filter((u) => u.model === model)).toEqual([]);
            expect(probe.audits.filter((a) => a.entity === model)).toEqual([]);
            expect(results.find((r) => r.model === model)).toBeUndefined();
            // The row is untouched — no deletedAt stamped.
            expect(probe.rows[model][0].deletedAt).toBeNull();
        }
        expect(results.map((r) => r.model)).toEqual(['Asset']);
    });

    it('honours a written Asset.retentionUntil: soft-delete + DATA_EXPIRED audit', async () => {
        const { probe, results } = await runProbedSweep(
            { Asset: [row('a-expired', EXPIRED)] },
            { tenantId: TENANT, now: NOW },
        );

        expect(results).toEqual([{ model: 'Asset', scanned: 1, expired: 1 }]);
        expect(probe.updated).toEqual([
            { model: 'Asset', id: 'a-expired', data: { deletedAt: NOW, deletedByUserId: null } },
        ]);
        expect(probe.rows.Asset[0].deletedAt).toEqual(NOW);

        expect(probe.audits).toHaveLength(1);
        const audit = probe.audits[0];
        expect(audit).toMatchObject({
            tenantId: TENANT, action: 'DATA_EXPIRED', entity: 'Asset', entityId: 'a-expired',
        });
        expect(JSON.parse(audit.details)).toMatchObject({ reason: 'retention_period_elapsed' });
    });

    it('leaves a future retentionUntil and an already-soft-deleted row alone', async () => {
        const { probe, results } = await runProbedSweep(
            {
                Asset: [
                    row('a-future', FUTURE),
                    row('a-gone', EXPIRED, new Date('2026-05-01T00:00:00.000Z')),
                    row('a-none', null),
                ],
            },
            { tenantId: TENANT, now: NOW },
        );

        expect(results).toEqual([{ model: 'Asset', scanned: 0, expired: 0 }]);
        expect(probe.updated).toEqual([]);
        expect(probe.audits).toEqual([]);
    });

    it('dryRun reports scanned without writing', async () => {
        const { probe, results } = await runProbedSweep(
            { Asset: [row('a-dry', EXPIRED)] },
            { tenantId: TENANT, now: NOW, dryRun: true },
        );

        expect(results).toEqual([{ model: 'Asset', scanned: 1, expired: 1 }]);
        expect(probe.updated).toEqual([]);
        expect(probe.audits).toEqual([]);
        expect(probe.rows.Asset[0].deletedAt).toBeNull();
    });
});
