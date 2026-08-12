/**
 * Audit Readiness Hardening
 *
 * - Evidence integrity: SHA-256 hashing of file contents
 * - Immutable export artifacts: store export files, attach to packs
 * - Pack cloning for retest workflows
 * - Events: AUDIT_PACK_CLONED, RETEST_REQUESTED
 */
import { TaskStatus, Prisma } from '@prisma/client';
import { RequestContext } from '../types';
import {
    assertCanManageAuditPacks, assertCanFreezePack, assertCanViewPack,
} from '../policies/audit-readiness.policies';
import { logEvent } from '../events/audit';
import { runInTenantContext } from '@/lib/db-context';
import { notFound, badRequest, forbidden } from '@/lib/errors/types';
import { getStorageProvider, buildTenantObjectKey, assertTenantKey } from '@/lib/storage';
import crypto from 'crypto';

// ─── Evidence Integrity ───

export function computeFileHash(buffer: Buffer): string {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

export async function verifyFileIntegrity(
    ctx: RequestContext,
    fileName: string,
    expectedHash?: string,
): Promise<{ fileName: string; computedHash: string; matches: boolean | null; fileSize: number }> {
    assertCanViewPack(ctx);

    // SECURITY (cross-tenant file oracle): `fileName` is caller-supplied and
    // names a stored object. It MUST be resolved through a tenant-scoped
    // FileRecord lookup before ANY storage read — otherwise a member of any
    // tenant could pass another tenant's storage key (URL-encoded slashes) and
    // learn its existence + fileSize + sha256, or confirm a guessed digest via
    // `expectedHash`. The `assertCanViewPack` role check alone does NOT scope by
    // tenant. Accept either the FileRecord id or its pathKey, but always read
    // from the RESOLVED, tenant-owned pathKey — never the raw `fileName`.
    const record = await runInTenantContext(ctx, (tdb) =>
        tdb.fileRecord.findFirst({
            where: {
                tenantId: ctx.tenantId,
                OR: [{ id: fileName }, { pathKey: fileName }],
            },
            select: { pathKey: true },
        }),
    );
    if (!record) throw notFound('File not found');

    // Defence-in-depth: a tenant-scoped row's pathKey is already tenant-owned,
    // but re-assert the canonical `tenants/<tenantId>/` prefix before touching
    // storage so a corrupt/legacy row can never point the reader elsewhere.
    assertTenantKey(record.pathKey, ctx.tenantId);

    const storage = getStorageProvider();
    const stream = storage.readStream(record.pathKey);

    // Hash incrementally from stream
    const hash = crypto.createHash('sha256');
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        hash.update(buf);
        chunks.push(buf);
    }
    const computedHash = hash.digest('hex');
    const totalSize = chunks.reduce((s, c) => s + c.length, 0);

    return {
        fileName,
        computedHash,
        matches: expectedHash ? computedHash === expectedHash : null,
        fileSize: totalSize,
    };
}

// ─── Immutable Export Artifacts ───

export async function storeExportArtifact(
    ctx: RequestContext,
    packId: string,
    content: string,
    filename: string,
    mimeType: string,
): Promise<{ fileName: string; hash: string }> {
    assertCanFreezePack(ctx);

    // Verify pack is frozen
    const pack = await runInTenantContext(ctx, (tdb) =>
        tdb.auditPack.findFirst({ where: { id: packId, tenantId: ctx.tenantId } })
    );
    if (!pack) throw notFound('Pack not found');
    // FREEZE INTEGRITY: a frozen pack is the immutable snapshot served to the
    // (unauthenticated) external auditor via share link. Allowing arbitrary FILE
    // items into a non-DRAFT pack would let content be injected AFTER the pack
    // was frozen + shared — inverting the immutability guarantee. Exports must be
    // attached while the pack is still a DRAFT; freezing then locks them.
    if (pack.status !== 'DRAFT') throw forbidden('Cannot attach exports to a non-DRAFT pack — an audit pack is immutable once frozen');

    // Create buffer and compute hash
    const buffer = Buffer.from(content, 'utf-8');
    const hash = computeFileHash(buffer);

    // Write via storage abstraction
    const storage = getStorageProvider();
    const pathKey = buildTenantObjectKey(ctx.tenantId, 'exports', filename);
    const { Readable } = await import('stream');
    await storage.write(pathKey, Readable.from(buffer), { mimeType });

    // Add as AuditPackItem
    await runInTenantContext(ctx, (tdb) =>
        tdb.auditPackItem.create({
            data: {
                tenantId: ctx.tenantId,
                auditPackId: packId,
                entityType: 'FILE',
                entityId: pathKey,
                snapshotJson: JSON.stringify({
                    originalFilename: filename,
                    storedFilename: pathKey,
                    sha256: hash,
                    size: buffer.length,
                    mimeType,
                    generatedAt: new Date().toISOString(),
                }),
                sortOrder: 900,
            },
        })
    );

    await runInTenantContext(ctx, (tdb) =>
        logEvent(tdb, ctx, {
            action: 'AUDIT_EXPORT_GENERATED',
            entityType: 'AuditPack',
            entityId: packId,
            details: JSON.stringify({ filename, hash, size: buffer.length }),
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'AuditPack',
                operation: 'export_generated',
                after: { filename, hash, size: buffer.length },
                summary: `Audit export generated: ${filename}`,
            },
        })
    );

    return { fileName: pathKey, hash };
}

// ─── Pack Cloning (Retest) ───

export async function clonePackForRetest(
    ctx: RequestContext,
    sourcePackId: string,
    name?: string,
): Promise<{ id: string; name: string; status: string; tenantId: string; auditCycleId: string }> {
    assertCanManageAuditPacks(ctx);

    const sourcePack = await runInTenantContext(ctx, (tdb) =>
        tdb.auditPack.findFirst({
            where: { id: sourcePackId, tenantId: ctx.tenantId },
            include: {
                items: { select: { entityType: true, entityId: true, sortOrder: true } },
                cycle: true,
            },
        })
    );
    if (!sourcePack) throw notFound('Source pack not found');
    if (sourcePack.status === 'DRAFT') throw badRequest('Cannot clone a DRAFT pack — freeze first');

    // Create new draft pack
    const clonedPack = await runInTenantContext(ctx, (tdb) =>
        tdb.auditPack.create({
            data: {
                tenantId: ctx.tenantId,
                auditCycleId: sourcePack.auditCycleId,
                name: name || `Retest: ${sourcePack.name}`,
                status: 'DRAFT',
            },
        })
    );

    // Copy item selections (NOT snapshots — new snapshots will be created on freeze)
    const itemsToClone: Prisma.AuditPackItemCreateManyInput[] = sourcePack.items
        .filter((i) => i.entityType !== 'FILE' && i.entityType !== 'READINESS_REPORT')
        .map((item) => ({
            tenantId: ctx.tenantId,
            auditPackId: clonedPack.id,
            entityType: item.entityType,
            entityId: item.entityId,
            sortOrder: item.sortOrder,
            snapshotJson: '',
        }));

    // Auto-include IN_PROGRESS issues (legacy "READY_FOR_RETEST" status migrated
    // to IN_PROGRESS in the unified task model; see migration 20260310191803).
    const retestIssues = await runInTenantContext(ctx, (tdb) =>
        tdb.task.findMany({
            where: {
                tenantId: ctx.tenantId,
                status: TaskStatus.IN_PROGRESS,
            },
            select: { id: true },
            take: 50,
        })
    );

    const existingIssueIds = new Set(itemsToClone.filter((i) => i.entityType === 'ISSUE').map((i) => i.entityId));
    let sortOrder = Math.max(...itemsToClone.map((i) => (i.sortOrder as number) || 0), 0) + 1;

    for (const issue of retestIssues) {
        if (!existingIssueIds.has(issue.id)) {
            itemsToClone.push({
                tenantId: ctx.tenantId,
                auditPackId: clonedPack.id,
                entityType: 'ISSUE',
                entityId: issue.id,
                sortOrder: sortOrder++,
                snapshotJson: '',
            });
        }
    }

    if (itemsToClone.length > 0) {
        await runInTenantContext(ctx, (tdb) =>
            tdb.auditPackItem.createMany({ data: itemsToClone })
        );
    }

    // Log events
    await runInTenantContext(ctx, (tdb) =>
        logEvent(tdb, ctx, {
            action: 'AUDIT_PACK_CLONED',
            entityType: 'AuditPack',
            entityId: clonedPack.id,
            details: JSON.stringify({
                sourcePackId,
                itemsCopied: itemsToClone.length,
                retestIssuesAdded: retestIssues.filter(i => !existingIssueIds.has(i.id)).length,
            }),
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'AuditPack',
                operation: 'cloned',
                after: {
                    sourcePackId,
                    itemsCopied: itemsToClone.length,
                    retestIssuesAdded: retestIssues.filter(i => !existingIssueIds.has(i.id)).length,
                },
                summary: `Pack cloned from ${sourcePackId}`,
            },
        })
    );

    if (retestIssues.length > 0) {
        await runInTenantContext(ctx, (tdb) =>
            logEvent(tdb, ctx, {
                action: 'RETEST_REQUESTED',
                entityType: 'AuditPack',
                entityId: clonedPack.id,
                details: JSON.stringify({ issueCount: retestIssues.length }),
                detailsJson: {
                    category: 'custom',
                    event: 'retest_requested',
                    issueCount: retestIssues.length,
                },
            })
        );
    }

    return clonedPack;
}

// ─── Auditor Pack Access ───
//
// PR-O — `getAuditorAssignedPacks` (the internal /audits/auditor portal's
// data source) was removed. The portal required an AUDITOR-role platform
// User whose email matched an ACTIVE AuditorAccount, but `inviteAuditor`
// only ever creates an AuditorAccount (never a User), so for a normally-
// invited auditor the portal always returned []. Real external review runs
// through the login-less /audit/shared/[token] page; internal reviewers use
// the pack pages. The dead portal + its route + this usecase were retired.
