/**
 * Delete the stored bytes when evidence is purged.
 *
 * `docs/data-retention.md` singles Evidence out as the only entity with an
 * end-to-end lifecycle — retentionUntil, reminders, archive, 365-day hard
 * purge. The first legs are real. The purge deleted the DATABASE ROW and left
 * the object in storage forever:
 *
 *   - `purgeEntity` (the admin purge) issues one raw SQL row delete.
 *     (Spelled out that way on purpose: `tests/unit/soft-delete-guardrails`
 *     greps for the literal SQL and does not strip comments, so quoting the
 *     statement here would flag this file as an unapproved raw-delete site.)
 *   - the 90-day soft-delete sweep and the 365-day archived purge in
 *     `data-lifecycle.ts` do the same.
 *   - none of the three imports a storage provider, so none of them COULD
 *     have deleted a blob.
 *
 * So the product wrote a DATA_PURGED audit row attesting a destruction that
 * did not happen. For a GDPR erasure or a contractual destruction commitment
 * that is the wrong way round — the attestation is the part a customer relies
 * on.
 *
 * ## The dedup constraint, which is why this is not a one-liner
 *
 * `pathKey` lives on FileRecord, not Evidence — Evidence holds
 * `fileRecordId`. And `uploadEvidenceFile` de-duplicates by SHA-256: a second
 * upload of identical bytes REUSES the existing FileRecord instead of creating
 * one. So a single FileRecord can back several Evidence rows, and deleting its
 * blob because ONE of them was purged would silently break every other row
 * pointing at it — turning a retention fix into data loss.
 *
 * Every candidate is therefore checked for surviving siblings first, counting
 * soft-deleted rows too: a soft-deleted sibling is restorable, so its bytes
 * are still needed.
 *
 * ## Outcomes are returned, not swallowed
 *
 * A failed blob delete means data the product claims to have destroyed is
 * still present. That has to be visible, so callers get a per-outcome tally to
 * log rather than a silent best-effort. Order matters too: blob first, then
 * the row, mirroring `jobs/evidence-import.ts` — dropping the row first would
 * strand the object with nothing left pointing at it.
 */
import type { PrismaTx } from '@/lib/db-context';
import { withDeleted } from '@/lib/soft-delete';
import { getProviderByName } from '@/lib/storage/index';
import type { StorageProviderType } from '@/lib/storage/types';
import { logger } from '@/lib/observability/logger';

export interface BlobPurgeOutcome {
    /** Blob deleted from storage and its FileRecord row removed. */
    deleted: number;
    /** Left alone — another Evidence row still references the same FileRecord. */
    retainedForSibling: number;
    /** No FileRecord to delete (TEXT/LINK evidence, or already reclaimed). */
    nothingToDelete: number;
    /** Provider reported the object already absent — reconciled, not an error. */
    alreadyGone: number;
    /** Provider threw. Bytes may still exist; this MUST be surfaced. */
    failed: number;
}

const EMPTY: BlobPurgeOutcome = {
    deleted: 0,
    retainedForSibling: 0,
    nothingToDelete: 0,
    alreadyGone: 0,
    failed: 0,
};

/**
 * Reclaim storage for evidence rows about to be hard-deleted.
 *
 * Call this BEFORE deleting the Evidence rows — it needs them present to
 * resolve `fileRecordId` and to count siblings correctly.
 */
export async function purgeEvidenceBlobs(
    db: PrismaTx,
    evidenceIds: string[],
): Promise<BlobPurgeOutcome> {
    if (evidenceIds.length === 0) return { ...EMPTY };
    const out: BlobPurgeOutcome = { ...EMPTY };

    // `withDeleted` throughout: these rows are soft-deleted or archived by
    // definition, so the default filter would hide the very rows being purged.
    const rows = await db.evidence.findMany(
        withDeleted({
            where: { id: { in: evidenceIds } },
            select: { id: true, fileRecordId: true },
        }),
    );

    const fileIds = [
        ...new Set(rows.map((r) => r.fileRecordId).filter((id): id is string => !!id)),
    ];

    // Both lookups are hoisted out of the loop. Per-row they were a textbook
    // N+1 — two round trips per candidate on a sweep that runs over every
    // expired row in the tenant — and the query-shape guardrail is right to
    // refuse it.
    //
    // Any OTHER Evidence still pointing at one of these FileRecords, INCLUDING
    // soft-deleted ones: a soft-deleted sibling is restorable, so its bytes are
    // still needed. Excluding the whole `evidenceIds` batch (not just the
    // current row) is load-bearing — two deduped rows purged in the same pass
    // would otherwise each see the other as a survivor, both retain, and the
    // blob would never be freed by any purge.
    const survivors = await db.evidence.findMany(
        withDeleted({
            where: {
                fileRecordId: { in: fileIds },
                id: { notIn: evidenceIds },
            },
            select: { fileRecordId: true },
        }),
    );
    const hasSibling = new Set(survivors.map((s) => s.fileRecordId));

    const files = await db.fileRecord.findMany({
        where: { id: { in: fileIds } },
        select: { id: true, pathKey: true, storageProvider: true },
    });
    const fileById = new Map(files.map((f) => [f.id, f]));

    /** FileRecord rows whose object is gone — deleted in one statement below. */
    const reclaimed: string[] = [];

    for (const row of rows) {
        if (!row.fileRecordId) {
            out.nothingToDelete += 1;
            continue;
        }

        if (hasSibling.has(row.fileRecordId)) {
            out.retainedForSibling += 1;
            continue;
        }

        const file = fileById.get(row.fileRecordId);
        if (!file) {
            out.nothingToDelete += 1;
            continue;
        }

        // Dispatch by the record's OWN provider — a row written under `local`
        // must not be deleted through the S3 client after a migration.
        const provider = getProviderByName(
            (file.storageProvider || 'local') as StorageProviderType,
        );

        try {
            await provider.delete(file.pathKey);
            out.deleted += 1;
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            // "Already absent" is reconciliation, not failure — the goal state
            // is reached. Anything else leaves bytes the product will attest
            // were destroyed, so it is counted separately and logged loudly.
            if (/not\s*found|NoSuchKey|ENOENT/i.test(message)) {
                out.alreadyGone += 1;
            } else {
                out.failed += 1;
                logger.error('evidence blob purge failed — bytes may remain', {
                    component: 'evidence-blob-purge',
                    fileRecordId: file.id,
                    provider: provider.name,
                    err: err instanceof Error ? err : new Error(message),
                });
                // Leave the FileRecord row in place: it is the only remaining
                // pointer to the object, and dropping it makes the orphan
                // unfindable.
                continue;
            }
        }

        reclaimed.push(file.id);
    }

    // One statement rather than one per row. Only ids whose object is actually
    // gone reach here — a failed provider delete `continue`s above, keeping its
    // FileRecord row as the last pointer to the orphan.
    if (reclaimed.length > 0) {
        await db.fileRecord.deleteMany({ where: { id: { in: reclaimed } } });
    }

    return out;
}
