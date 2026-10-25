/**
 * Control ⇄ evidence links.
 *
 * `evidence.ts` used to also hold asset linking and contributor management —
 * three unrelated relationship graphs behind one filename, so "where do I add
 * a link type?" had no answer you could read off the directory. Split
 * 2026-08-08 (roadmap P3.3) into this file, `asset-links.ts` and
 * `contributors.ts`. The barrel re-exports all three, so no call site moved.
 */
import { RequestContext } from '../../types';
import { ControlRepository } from '../../repositories/ControlRepository';
import {
    assertCanReadControls, assertCanUpdateControl, assertCanLinkEvidence,
} from '../../policies/control.policies';
import { EvidenceRepository } from '../../repositories/EvidenceRepository';
import { FileRepository } from '../../repositories/FileRepository';
import { logEvent } from '../../events/audit';
import { badRequest, notFound } from '@/lib/errors/types';
import { runInTenantContext } from '@/lib/db-context';
import { bumpEntityCacheVersion } from '@/lib/cache/list-cache';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { isAllowedMime, isAllowedSize, FILE_MAX_SIZE_BYTES } from '@/lib/storage';

// ─── Evidence Links ───

export async function listEvidenceLinks(ctx: RequestContext, controlId: string) {
    assertCanReadControls(ctx);
    return runInTenantContext(ctx, (db) =>
        ControlRepository.listEvidenceLinks(db, ctx, controlId)
    );
}

/**
 * Combined Evidence-tab payload (#102 item 1 — tab-lazy).
 *
 * The Evidence tab renders two collections: `controlEvidenceLink`
 * rows (manual URL / file links) AND the `Evidence` entities
 * directly attached to the control. Both used to ride on the eager
 * `getById` payload; the tab now fetches them together on demand —
 * one round-trip, one SWR key.
 *
 * Each evidence row carries `addedBy` — the person who attached it to
 * THIS control, read off its `EvidenceControlLink.createdBy`. `Evidence`
 * has no creator column, and for a record uploaded or linked from the
 * control's own tab the join row is written by the same request, so it
 * names the creator. The join is read as a nested include (one batched
 * query for the whole page, not one per row) scoped to this control, so
 * a record linked to several controls reports who added it HERE (#4126:
 * the column read a dash for every library record).
 */
export async function getControlEvidenceTab(ctx: RequestContext, controlId: string) {
    assertCanReadControls(ctx);
    return runInTenantContext(ctx, async (db) => {
        const control = await db.control.findFirst({
            where: { id: controlId, tenantId: ctx.tenantId },
        });
        if (!control) throw notFound('Control not found');
        const [links, evidenceRows] = await Promise.all([
            ControlRepository.listEvidenceLinks(db, ctx, controlId),
            // EP-3 — Evidence entities are attached to a control through the
            // many-to-many join now (not a singular controlId). Explicit
            // `deletedAt: null` mirrors the task evidence tab — soft-deleted
            // rows never surface in the control evidence list.
            db.evidence.findMany({
                where: {
                    tenantId: ctx.tenantId,
                    deletedAt: null,
                    evidenceControlLinks: { some: { controlId } },
                },
                orderBy: { createdAt: 'desc' },
                include: {
                    evidenceControlLinks: {
                        where: { controlId, tenantId: ctx.tenantId },
                        select: { createdBy: { select: { id: true, name: true } } },
                        take: 1,
                    },
                },
            }),
        ]);
        const evidence = evidenceRows.map(({ evidenceControlLinks, ...row }) => ({
            ...row,
            addedBy: evidenceControlLinks?.[0]?.createdBy ?? null,
        }));
        return { links, evidence };
    });
}

/**
 * Attaches evidence to a control from `POST /controls/:id/evidence` — the
 * API, and the URL box in the controls list's edit panel.
 *
 * A web link (`kind: LINK`) becomes a library record: a DRAFT `Evidence` of
 * type LINK joined to the control by an `EvidenceControlLink`, exactly what the
 * control's Evidence tab and the library's own link dialog create, so it can
 * be submitted, approved and rejected (#4126). It used to be a plain
 * `ControlEvidenceLink` row, which nothing in the library reads. The response
 * is the new record.
 *
 * The record is written here, under the control's gate, rather than through
 * `createEvidence`, whose `evidence.edit` gate would have refused an API key
 * scoped `controls:write` that could add a link before (owner decision). Tasks,
 * risks and assets attach their link records the same way. A link arrives
 * with no title, so it is titled by its note, or by its address when there is
 * none — the rule those paths already use.
 *
 * An uploaded file (`kind: FILE`, naming a `FileRecord` by `fileId`) becomes a
 * library record the same way — see `linkFileRecord`.
 *
 * INTEGRATION_RESULT kinds still write a plain `ControlEvidenceLink`.
 */
export async function linkEvidence(ctx: RequestContext, controlId: string, data: { kind: string; fileId?: string | null; url?: string | null; note?: string | null }) {
    assertCanLinkEvidence(ctx);
    if (data.kind === 'LINK') return linkEvidenceRecord(ctx, controlId, data);
    if (data.kind === 'FILE') return linkFileRecord(ctx, controlId, data);
    return runInTenantContext(ctx, async (db) => {
        const link = await ControlRepository.linkEvidence(db, ctx, controlId, data);
        if (!link) throw notFound('Control not found');

        await logEvent(db, ctx, {
            action: 'CONTROL_EVIDENCE_LINKED',
            entityType: 'Control',
            entityId: controlId,
            details: `Evidence linked: ${data.kind}${data.url ? ` (${data.url})` : ''}`,
            detailsJson: { category: 'relationship', operation: 'linked', sourceEntity: 'Control', sourceId: controlId, targetEntity: 'Evidence', targetId: data.fileId || 'url', relation: data.kind },
        });
        return link;
    });
}

async function linkEvidenceRecord(ctx: RequestContext, controlId: string, data: { url?: string | null; note?: string | null }) {
    // Sanitised like every other Evidence writer. `sanitizePlainText` returns
    // decoded text, so a query string's `&` survives as `&`, not `&amp;`.
    const url = data.url ? sanitizePlainText(data.url).trim() : '';
    if (!url) throw badRequest('A link needs a url.');
    const note = data.note ? sanitizePlainText(data.note).trim() : '';
    const evidence = await runInTenantContext(ctx, async (db) => {
        const control = await db.control.findFirst({
            where: { id: controlId, tenantId: ctx.tenantId },
            select: { id: true },
        });
        if (!control) throw notFound('Control not found');

        const created = await EvidenceRepository.create(db, ctx, {
            type: 'LINK',
            title: note || url,
            content: url,
            status: 'DRAFT',
        });
        await EvidenceRepository.createControlLinks(db, ctx, created.id, [controlId]);

        await logEvent(db, ctx, {
            action: 'CREATE',
            entityType: 'Evidence',
            entityId: created.id,
            details: `Created evidence: ${created.title}`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'Evidence',
                operation: 'created',
                after: { title: created.title, type: 'LINK' },
                summary: `Created evidence: ${created.title}`,
            },
        });
        await logEvent(db, ctx, {
            action: 'CONTROL_EVIDENCE_LINKED',
            entityType: 'Control',
            entityId: controlId,
            details: `Evidence linked: LINK (${url})`,
            detailsJson: { category: 'relationship', operation: 'linked', sourceEntity: 'Control', sourceId: controlId, targetEntity: 'Evidence', targetId: created.id, relation: 'LINK' },
        });
        return created;
    });
    await bumpEntityCacheVersion(ctx, 'evidence');
    await bumpEntityCacheVersion(ctx, 'control');
    return evidence;
}

/**
 * A FILE sent to the control's evidence route: the `FileRecord` it names
 * becomes a library record joined to the control, under the control's gate,
 * for the same reasons as a link. It used to be a plain `ControlEvidenceLink`.
 *
 * One record per file. When a live `Evidence` already holds this
 * `FileRecord`, that record is joined to the control and returned — preferring
 * one already on the control, so a repeated call changes nothing — instead of
 * a second record for the same bytes. (`fileRecordId` carries no unique key:
 * the upload path's SHA-256 dedup can leave several records on one file, so
 * the oldest is taken.) Otherwise a DRAFT `Evidence` of type FILE is created
 * with the columns `uploadEvidenceFile` writes for its row; `content` is the
 * record's own storage key, never anything from the request.
 *
 * The file is refused in the states the upload path refuses it in, with the
 * same errors: a type it would not accept, a size over the cap, and bytes
 * the scanner condemned — this record, or any record with the same hash. It
 * must also be STORED, the only state in which the upload path reuses an
 * existing `FileRecord`.
 */
async function linkFileRecord(ctx: RequestContext, controlId: string, data: { fileId?: string | null; note?: string | null }) {
    const fileId = data.fileId?.trim();
    if (!fileId) throw badRequest('A file needs a fileId.');
    const note = data.note ? sanitizePlainText(data.note).trim() : '';
    const evidence = await runInTenantContext(ctx, async (db) => {
        const control = await db.control.findFirst({
            where: { id: controlId, tenantId: ctx.tenantId },
            select: { id: true },
        });
        if (!control) throw notFound('Control not found');

        // The FK check bypasses RLS, so a body-supplied id is checked against
        // the tenant here, as the plain path always did.
        const file = await db.fileRecord.findFirst({
            where: { id: fileId, tenantId: ctx.tenantId },
            select: {
                id: true, pathKey: true, originalName: true, mimeType: true,
                sizeBytes: true, sha256: true, status: true, scanStatus: true,
            },
        });
        if (!file) throw notFound('File not found');
        if (!isAllowedMime(file.mimeType)) {
            throw badRequest('FILE_TYPE_NOT_ALLOWED', `MIME type "${file.mimeType}" is not allowed`);
        }
        if (!isAllowedSize(file.sizeBytes)) {
            throw badRequest('FILE_TOO_LARGE', `File exceeds maximum size of ${FILE_MAX_SIZE_BYTES} bytes`);
        }
        // A hash that was ever quarantined stays poisoned — the upload path's
        // rule, through the same lookup (it returns an INFECTED row first).
        const infected = file.scanStatus === 'INFECTED'
            || (await FileRepository.findBySha256(db, ctx.tenantId, file.sha256))?.scanStatus === 'INFECTED';
        if (infected) throw badRequest('FILE_INFECTED', 'This file was rejected by the malware scanner.');
        if (file.status !== 'STORED') {
            throw badRequest('FILE_NOT_STORED', 'This file is not stored, so it cannot be evidence.');
        }

        const holders = { tenantId: ctx.tenantId, fileRecordId: file.id, deletedAt: null };
        const oldestFirst = [{ createdAt: 'asc' as const }, { id: 'asc' as const }];
        const onControl = await db.evidence.findFirst({
            where: { ...holders, evidenceControlLinks: { some: { tenantId: ctx.tenantId, controlId } } },
            orderBy: oldestFirst,
        });
        if (onControl) return onControl;

        const existing = await db.evidence.findFirst({ where: holders, orderBy: oldestFirst });
        const record = existing ?? await EvidenceRepository.create(db, ctx, {
            type: 'FILE',
            title: note || sanitizePlainText(file.originalName).trim() || 'unnamed',
            content: file.pathKey,
            fileName: file.originalName,
            fileSize: file.sizeBytes,
            fileRecordId: file.id,
            status: 'DRAFT',
        });
        // Skips a duplicate on the (tenant, evidence, control) unique, so a
        // concurrent identical call cannot fail here.
        await EvidenceRepository.createControlLinks(db, ctx, record.id, [controlId]);

        if (!existing) {
            await logEvent(db, ctx, {
                action: 'CREATE',
                entityType: 'Evidence',
                entityId: record.id,
                details: `Created evidence: ${record.title}`,
                detailsJson: {
                    category: 'entity_lifecycle',
                    entityName: 'Evidence',
                    operation: 'created',
                    after: { title: record.title, type: 'FILE', fileRecordId: file.id },
                    summary: `Created evidence: ${record.title}`,
                },
            });
        }
        await logEvent(db, ctx, {
            action: 'CONTROL_EVIDENCE_LINKED',
            entityType: 'Control',
            entityId: controlId,
            details: `Evidence linked: FILE (${file.originalName})`,
            detailsJson: { category: 'relationship', operation: 'linked', sourceEntity: 'Control', sourceId: controlId, targetEntity: 'Evidence', targetId: record.id, relation: 'FILE' },
        });
        return record;
    });
    await bumpEntityCacheVersion(ctx, 'evidence');
    await bumpEntityCacheVersion(ctx, 'control');
    return evidence;
}

export async function unlinkEvidence(ctx: RequestContext, controlId: string, linkId: string) {
    assertCanLinkEvidence(ctx);
    return runInTenantContext(ctx, async (db) => {
        const result = await ControlRepository.unlinkEvidence(db, ctx, controlId, linkId);
        if (!result) throw notFound('Evidence link not found');

        await logEvent(db, ctx, {
            action: 'CONTROL_EVIDENCE_UNLINKED',
            entityType: 'Control',
            entityId: controlId,
            details: `Evidence link removed: ${linkId}`,
            detailsJson: { category: 'relationship', operation: 'unlinked', sourceEntity: 'Control', sourceId: controlId, targetEntity: 'EvidenceLink', targetId: linkId },
        });
        return { success: true };
    });
}
