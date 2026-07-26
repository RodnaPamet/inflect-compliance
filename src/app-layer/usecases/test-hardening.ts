/**
 * Test Hardening — Evidence integrity, audit pack snapshots, secure exports
 *
 * verifyRunEvidence()          — re-computes hashes and checks against stored values
 * snapshotTestRun()            — creates immutable AuditPackItem for a test run
 * exportTestEvidenceBundle()   — generates CSV/JSON export of runs + evidence
 *
 * PR-R — evidence linking + hashing now lives on the live path in
 * `control-test.ts::linkEvidenceToRun` (which freezes FileRecord.sha256 on the
 * link). The previously-dead `linkEvidenceWithHash` here was removed — it
 * duplicated the linker and had a broken hash source (it passed a FileRecord id
 * where verifyFileIntegrity wants a storage pathKey).
 */
import { RequestContext } from '../types';
import { assertCanReadTests, assertCanExportTests } from '../policies/test.policies';
import { assertCanManageAuditPacks } from '../policies/audit-readiness.policies';
import { logEvent } from '../events/audit';
import { runInTenantContext, type PrismaTx } from '@/lib/db-context';
import { notFound, badRequest } from '@/lib/errors/types';
import { verifyFileIntegrity } from './audit-hardening';

// ─── Evidence Integrity ───

/**
 * Verify all FILE-kind evidence on a test run by re-computing SHA-256.
 */
export async function verifyRunEvidence(ctx: RequestContext, runId: string) {
    assertCanReadTests(ctx);

    return runInTenantContext(ctx, async (db: PrismaTx) => {
        const run = await db.controlTestRun.findFirst({
            where: { id: runId, tenantId: ctx.tenantId },
            include: {
                evidence: true,
                testPlan: { select: { name: true } },
            },
        });
        if (!run) throw notFound('Test run not found');

        interface VerificationResult {
            linkId: string;
            kind: string;
            fileId: string | null;
            storedHash: string | null;
            computedHash: string | null;
            matches: boolean | null;
            error: string | null;
        }

        const results: VerificationResult[] = [];

        // PR-R — verifyFileIntegrity reads storage by pathKey, so resolve the
        // FileRecords up front in ONE query (the old code passed the FileRecord
        // id as a storage key → the read always threw → integrity was trivially
        // "ok"). Batched to avoid an N+1 read inside the loop below.
        const fileIds = run.evidence
            .filter((ev) => ev.kind === 'FILE' && ev.fileId)
            .map((ev) => ev.fileId as string);
        const pathKeyById = new Map<string, string>();
        if (fileIds.length > 0) {
            const files = await db.fileRecord.findMany({
                where: { tenantId: ctx.tenantId, id: { in: fileIds } },
                select: { id: true, pathKey: true },
            });
            for (const f of files) pathKeyById.set(f.id, f.pathKey);
        }

        for (const ev of run.evidence) {
            if (ev.kind === 'FILE' && ev.fileId) {
                const pathKey = pathKeyById.get(ev.fileId);
                try {
                    if (!pathKey) throw notFound('File record not found');
                    // Recompute the bytes from storage and compare to the hash
                    // frozen on the link at link time.
                    const integrity = await verifyFileIntegrity(ctx, pathKey, ev.sha256Hash ?? undefined);
                    results.push({
                        linkId: ev.id,
                        kind: ev.kind,
                        fileId: ev.fileId,
                        storedHash: ev.sha256Hash,
                        computedHash: integrity.computedHash,
                        matches: ev.sha256Hash ? integrity.computedHash === ev.sha256Hash : null,
                        error: null,
                    });
                } catch (e: unknown) {
                    results.push({
                        linkId: ev.id,
                        kind: ev.kind,
                        fileId: ev.fileId,
                        storedHash: ev.sha256Hash,
                        computedHash: null,
                        // A FILE link with a frozen hash we can no longer verify
                        // (file gone / unreadable) is an integrity FAILURE, not a
                        // pass — only a link that never had a hash stays null.
                        matches: ev.sha256Hash ? false : null,
                        error: e instanceof Error ? e.message : 'Unknown error',
                    });
                }
            } else {
                results.push({
                    linkId: ev.id,
                    kind: ev.kind,
                    fileId: ev.fileId,
                    storedHash: ev.sha256Hash,
                    computedHash: null,
                    matches: null,
                    error: null,
                });
            }
        }

        // A FILE link is only integrity-verified when its recomputed hash
        // MATCHES the frozen hash. `null` (no hash / unverifiable) and `false`
        // (mismatch) both fail — folding `null` into the pass was the fail-open
        // path where a hashless FILE link scored VERIFIED. With link-time
        // rejection of unresolvable files, a live `null` now means a file that
        // existed but carried no upload checksum: still unverifiable, not a pass.
        const allFileLinksVerified = results
            .filter(r => r.kind === 'FILE')
            .every(r => r.matches === true);

        return {
            runId,
            planName: run.testPlan?.name,
            totalLinks: results.length,
            fileLinks: results.filter(r => r.kind === 'FILE').length,
            verified: results.filter(r => r.matches === true).length,
            mismatches: results.filter(r => r.matches === false).length,
            unverifiable: results.filter(r => r.kind === 'FILE' && r.matches === null).length,
            integrityOk: allFileLinksVerified,
            details: results,
        };
    });
}

// ─── Audit Pack Snapshot ───

/**
 * Create immutable snapshot of a test run in an audit pack.
 * Pack must not be FROZEN (snapshots are added to DRAFT packs, then frozen).
 */
export async function snapshotTestRun(ctx: RequestContext, runId: string, packId: string) {
    assertCanManageAuditPacks(ctx);

    return runInTenantContext(ctx, async (db: PrismaTx) => {
        // Verify pack exists and is not frozen
        const pack = await db.auditPack.findFirst({
            where: { id: packId, tenantId: ctx.tenantId },
        });
        if (!pack) throw notFound('Audit pack not found');
        if (pack.status === 'FROZEN' || pack.status === 'EXPORTED') {
            throw badRequest('Cannot add items to a frozen/exported pack');
        }

        // Get run with full details for snapshot
        const run = await db.controlTestRun.findFirst({
            where: { id: runId, tenantId: ctx.tenantId },
            include: {
                testPlan: {
                    select: { id: true, name: true, method: true, frequency: true },
                },
                control: {
                    select: { id: true, name: true, code: true },
                },
                executedBy: { select: { name: true, email: true } },
                evidence: {
                    select: {
                        id: true, kind: true, fileId: true, url: true,
                        sha256Hash: true, note: true,
                    },
                },
            },
        });
        if (!run) throw notFound('Test run not found');
        if (run.status !== 'COMPLETED') throw badRequest('Can only snapshot completed test runs');

        // Build immutable snapshot JSON
        const snapshotJson = JSON.stringify({
            snapshotVersion: 1,
            capturedAt: new Date().toISOString(),
            testRun: {
                id: run.id,
                status: run.status,
                result: run.result,
                executedAt: run.executedAt?.toISOString?.() ?? run.executedAt,
                notes: run.notes,
                findingSummary: run.findingSummary,
                executedBy: run.executedBy
                    ? { name: run.executedBy.name, email: run.executedBy.email }
                    : null,
            },
            testPlan: run.testPlan
                ? { id: run.testPlan.id, name: run.testPlan.name, method: run.testPlan.method, frequency: run.testPlan.frequency }
                : null,
            control: run.control
                ? { id: run.control.id, name: run.control.name, code: run.control.code }
                : null,
            evidence: run.evidence.map((ev: Record<string, unknown>) => ({
                id: ev.id,
                kind: ev.kind,
                fileId: ev.fileId,
                url: ev.url,
                sha256Hash: ev.sha256Hash,
                note: ev.note,
            })),
            evidenceHashes: run.evidence
                .filter((ev: Record<string, unknown>) => ev.sha256Hash)
                .map((ev: Record<string, unknown>) => ({
                    fileId: ev.fileId,
                    sha256: ev.sha256Hash,
                })),
        });

        // Check for duplicate
        const existing = await db.auditPackItem.findFirst({
            where: {
                auditPackId: packId,
                entityType: 'TEST_RUN',
                entityId: runId,
            },
        });
        if (existing) throw badRequest('This test run is already in the audit pack');

        // Get max sort order
        const lastItem = await db.auditPackItem.findFirst({
            where: { auditPackId: packId },
            orderBy: { sortOrder: 'desc' },
            select: { sortOrder: true },
        });
        const sortOrder = (lastItem?.sortOrder ?? 0) + 1;

        const item = await db.auditPackItem.create({
            data: {
                tenantId: ctx.tenantId,
                auditPackId: packId,
                entityType: 'TEST_RUN',
                entityId: runId,
                snapshotJson,
                sortOrder,
            },
        });

        await logEvent(db, ctx, {
            action: 'TEST_RUN_SNAPSHOT_ADDED_TO_PACK',
            entityType: 'AuditPackItem',
            entityId: item.id,
            details: JSON.stringify({ runId, packId, result: run.result }),
            detailsJson: { category: 'custom', event: 'test_run_snapshot_added_to_pack' },
        });

        return item;
    });
}

// ─── Export ───

interface ExportOptions {
    controlId?: string;
    format?: 'csv' | 'json';
    periodDays?: number;
}

/**
 * Export test evidence bundle as CSV or JSON.
 */
const EXPORT_RUN_LIMIT = 500;

export async function exportTestEvidenceBundle(ctx: RequestContext, options: ExportOptions) {
    // Exporting the bundle carries run notes / hashes / control codes out of the
    // app — an EXPORT action (reports.export), not the vacuous read a READER
    // always passes.
    assertCanExportTests(ctx);

    return runInTenantContext(ctx, async (db: PrismaTx) => {
        const where: Record<string, unknown> = { tenantId: ctx.tenantId };
        if (options.controlId) where.controlId = options.controlId;
        if (options.periodDays) {
            const since = new Date();
            since.setDate(since.getDate() - options.periodDays);
            where.createdAt = { gte: since };
        }

        // Fetch one past the cap so we can honestly report truncation — an
        // "evidence bundle" that silently drops runs is an integrity problem.
        const fetched = await db.controlTestRun.findMany({
            where,
            include: {
                testPlan: { select: { name: true, method: true, frequency: true } },
                control: { select: { id: true, name: true, code: true } },
                executedBy: { select: { name: true, email: true } },
                evidence: {
                    select: {
                        id: true, kind: true, fileId: true, url: true,
                        sha256Hash: true, note: true,
                    },
                },
            },
            orderBy: { createdAt: 'desc' },
            take: EXPORT_RUN_LIMIT + 1,
        });
        const truncated = fetched.length > EXPORT_RUN_LIMIT;
        const runs = fetched.slice(0, EXPORT_RUN_LIMIT);

        const rows = runs.map((run) => ({
            runId: run.id,
            controlCode: run.control?.code || '',
            controlName: run.control?.name || '',
            planName: run.testPlan?.name || '',
            method: run.testPlan?.method || '',
            frequency: run.testPlan?.frequency || '',
            status: run.status,
            result: run.result || '',
            executedAt: run.executedAt?.toISOString?.() ?? run.executedAt ?? '',
            executedBy: run.executedBy?.email || '',
            notes: run.notes || '',
            findingSummary: run.findingSummary || '',
            evidenceCount: run.evidence?.length || 0,
            evidenceHashes: run.evidence
                ?.filter((e) => e.sha256Hash)
                .map((e) => `${e.fileId}:${e.sha256Hash}`)
                .join('; ') || '',
        }));

        if (options.format === 'csv') {
            if (rows.length === 0) return 'No test runs found.\n';
            const headers = Object.keys(rows[0]);
            const csvLines = [
                headers.join(','),
                ...rows.map(row =>
                    headers.map(h => {
                        const val = String((row as Record<string, unknown>)[h] ?? '');
                        return val.includes(',') || val.includes('"') || val.includes('\n')
                            ? `"${val.replace(/"/g, '""')}"`
                            : val;
                    }).join(',')
                ),
            ];
            // Never let a CSV imply completeness it doesn't have.
            if (truncated) {
                csvLines.push(
                    `# NOTE: results truncated at ${EXPORT_RUN_LIMIT} runs — narrow by controlId or period to export the rest.`,
                );
            }
            return csvLines.join('\n') + '\n';
        }

        return { rows, truncated, limit: EXPORT_RUN_LIMIT };
    });
}
