import { RequestContext } from '../types';
import { EvidenceRepository, EvidenceListFilters } from '../repositories/EvidenceRepository';
import { assertCanRead, assertCanWrite, assertCanAdmin } from '../policies/common';
import { assertCanReadEvidence, assertCanEditEvidence, assertCanUploadEvidence } from '../policies/evidence.policies';
import { logEvent } from '../events/audit';
import { notFound, badRequest, forbidden } from '@/lib/errors/types';
import { runInTenantContext } from '@/lib/db-context';
import { cachedListRead, bumpEntityCacheVersion } from '@/lib/cache/list-cache';
import type { EvidenceType, ReviewCadence } from '@prisma/client';
import { z } from 'zod';
import { CreateEvidenceSchema, UpdateEvidenceSchema } from '@/lib/schemas';
import { isEvidenceContentEditable } from '@/lib/evidence-content';

/**
 * EP-3 — collapse the many-to-many `controlIds` input + the legacy singular
 * `controlId` into a single deduped list. Empty/nullish entries are dropped.
 */
function normalizeControlIds(
    controlIds: string[] | undefined | null,
    controlId?: string | null,
): string[] {
    const set = new Set<string>();
    for (const id of controlIds ?? []) {
        if (id) set.add(id);
    }
    if (controlId) set.add(controlId);
    return [...set];
}

export async function listEvidence(
    ctx: RequestContext,
    filters?: EvidenceListFilters,
    options: { take?: number } = {},
) {
    assertCanRead(ctx);
    return cachedListRead({
        ctx,
        entity: 'evidence',
        operation: 'list',
        // `take` participates in the cache key so a bounded SSR
        // result can't poison the unbounded API GET cache.
        params: options.take
            ? { ...(filters ?? {}), _take: options.take }
            : (filters ?? {}),
        loader: () =>
            runInTenantContext(ctx, (db) =>
                EvidenceRepository.list(db, ctx, filters, options),
            ),
    });
}

export async function listEvidencePaginated(ctx: RequestContext, params: {
    limit?: number; cursor?: string;
    filters?: { type?: string; controlId?: string; q?: string; archived?: boolean; expiring?: boolean };
}) {
    assertCanRead(ctx);
    return cachedListRead({
        ctx,
        entity: 'evidence',
        operation: 'listPaginated',
        params,
        loader: () =>
            runInTenantContext(ctx, (db) =>
                EvidenceRepository.listPaginated(db, ctx, params),
            ),
    });
}

export async function getEvidence(ctx: RequestContext, id: string) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, async (db) => {
        const evidence = await EvidenceRepository.getById(db, ctx, id);
        if (!evidence) throw notFound('Evidence not found');
        // SP-3/audit — surface a SharePoint source link + last-sync time when
        // this evidence was imported from SharePoint (one mapping per evidence).
        const spMapping = await db.integrationSyncMapping.findFirst({
            where: {
                tenantId: ctx.tenantId,
                provider: 'sharepoint',
                localEntityType: 'Evidence',
                localEntityId: id,
            },
            select: { sourceUrl: true, lastSyncedAt: true, syncStatus: true },
        });
        // Only attach `sharePoint` when the evidence is SP-sourced — keeps the
        // shape unchanged for the common (non-SharePoint) case.
        if (!spMapping?.sourceUrl) return evidence;
        return {
            ...evidence,
            sharePoint: {
                sourceUrl: spMapping.sourceUrl,
                lastSyncedAt: spMapping.lastSyncedAt ? spMapping.lastSyncedAt.toISOString() : null,
                syncStatus: spMapping.syncStatus,
            },
        };
    });
}

export async function createEvidence(
    ctx: RequestContext,
    data: z.infer<typeof CreateEvidenceSchema> & { file?: File },
) {
    assertCanEditEvidence(ctx);

    // R5-P1 #1/#2 — FILE evidence's `content` is a storage pathKey that ONLY the
    // multipart upload path (`uploadEvidenceFile`) may derive server-side. This
    // JSON endpoint used to write caller-supplied `content` verbatim for FILE
    // rows, which let an attacker point it at another tenant's object; the old
    // content-based ownership check ([[isFileOwnedByTenant]], now removed) then
    // trusted it. Reject FILE creation here. The deprecated in-band `uploadFile`
    // helper + its `data.file` branch (flat, non-tenant-prefixed, never scanned)
    // are gone.
    if (data.type === 'FILE') {
        throw badRequest(
            'FILE_VIA_UPLOAD',
            'FILE evidence must be created through the multipart upload endpoint (/evidence/uploads), not this JSON endpoint.',
        );
    }

    // TEXT (note body) / LINK (target URL) only — no file metadata, no key.
    const fileName = null;
    const fileSize = null;
    const content = data.content || null;

    // EP-3 — normalise the control association to a set. `controlIds` is
    // the many-to-many input; a legacy singular `controlId` is wrapped in.
    const requestedControlIds = normalizeControlIds(data.controlIds, data.controlId);

    const created = await runInTenantContext(ctx, async (db) => {
        // Validate every control belongs to the same tenant (foreign /
        // unknown ids are rejected — the isolation contract).
        if (requestedControlIds.length > 0) {
            const existing = await EvidenceRepository.filterExistingControlIds(db, ctx, requestedControlIds);
            const missing = requestedControlIds.filter((id) => !existing.has(id));
            if (missing.length > 0) {
                throw badRequest('INVALID_CONTROL', 'Control not found or belongs to a different tenant');
            }
        }
        await assertOwnerIsActiveMember(db, ctx, data.ownerUserId);

        const evidence = await EvidenceRepository.create(db, ctx, {
            type: data.type as EvidenceType,
            title: data.title,
            content,
            fileName,
            fileSize,
            category: data.category,
            // B8 follow-up — trim + null-coerce so empty input
            // maps to "no folder" (the UI group-by keys on null).
            folder: data.folder?.trim() || null,
            owner: data.owner,
            ownerUserId: data.ownerUserId || null,

            reviewCycle: (data.reviewCycle || null) as ReviewCadence | null,
            nextReviewDate: data.nextReviewDate ? new Date(data.nextReviewDate) : null,
            status: 'DRAFT',
        });

        // EP-3 — ONE Evidence + N join rows (no per-control clone, no
        // ControlEvidenceLink bridge). The Evidence entity is the single
        // source of truth for evidence↔control associations.
        await EvidenceRepository.createControlLinks(db, ctx, evidence.id, requestedControlIds);

        await logEvent(db, ctx, {
            action: 'CREATE',
            entityType: 'Evidence',
            entityId: evidence.id,
            details: `Created evidence: ${evidence.title}`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'Evidence',
                operation: 'created',
                after: { title: evidence.title, type: data.type },
                summary: `Created evidence: ${evidence.title}`,
            },
        });

        return evidence;
    });
    // Linking back to a control also affects the control list view
    // (evidence count); bump both entities.
    await bumpEntityCacheVersion(ctx, 'evidence');
    if (requestedControlIds.length > 0) await bumpEntityCacheVersion(ctx, 'control');
    return created;
}

export async function updateEvidence(ctx: RequestContext, id: string, data: z.infer<typeof UpdateEvidenceSchema>) {
    assertCanEditEvidence(ctx);

    const updated = await runInTenantContext(ctx, async (db) => {
        // `content` is only user-authored for TEXT (note body) and LINK
        // (target URL). For FILE evidence it holds the object-storage
        // pathKey written by the upload / `replaceEvidenceFile`, so
        // accepting a caller-supplied value would detach the row from its
        // file. The edit form already hides the field for FILE rows; this
        // is the server-side half of that gate, because the API is public.
        const existing = await db.evidence.findFirst({
            where: { id, tenantId: ctx.tenantId },
            select: { type: true, status: true, content: true },
        });
        if (!existing) throw notFound('Evidence not found');
        const content = isEvidenceContentEditable(existing.type)
            ? data.content
            : undefined;

        // R5-P2 #4 — editing the body (TEXT note / LINK url) of an APPROVED
        // item voids the prior approval the same way replacing a file does:
        // the reviewer signed off on DIFFERENT content. Reset to SUBMITTED so
        // it re-enters review, but only when the content actually changes.
        const contentReReview =
            existing.status === 'APPROVED' &&
            content !== undefined &&
            content !== existing.content;

        await assertOwnerIsActiveMember(db, ctx, data.ownerUserId);

        const evidence = await EvidenceRepository.update(db, ctx, id, {
            title: data.title,
            content,
            ...(contentReReview ? { status: 'SUBMITTED' } : {}),
            category: data.category,
            // B8 follow-up — folder is editable post-create. The
            // three-state contract is preserved (undefined = no
            // change; null = clear; string = set).
            folder:
                data.folder === undefined
                    ? undefined
                    : (data.folder?.trim() || null),
            owner: data.owner,
            ownerUserId: data.ownerUserId,

            reviewCycle: data.reviewCycle as ReviewCadence | undefined,
            nextReviewDate: data.nextReviewDate ? new Date(data.nextReviewDate) : undefined,
        });

        if (!evidence) throw notFound('Evidence not found');

        // Tags reconcile to exactly the supplied set (three-state, like
        // controlIds): omitted ⇒ untouched, [] ⇒ cleared.
        if (data.tags !== undefined) {
            await EvidenceRepository.setTags(db, ctx, id, data.tags);
        }

        // EP-3 — reconcile control links to exactly `controlIds` when the
        // multi-select is present. Adds/removes join rows (never moves the
        // record). Omitted ⇒ links untouched.
        if (data.controlIds !== undefined) {
            const desired = normalizeControlIds(data.controlIds, null);
            if (desired.length > 0) {
                const existingControls = await EvidenceRepository.filterExistingControlIds(db, ctx, desired);
                const missing = desired.filter((cid) => !existingControls.has(cid));
                if (missing.length > 0) {
                    throw badRequest('INVALID_CONTROL', 'Control not found or belongs to a different tenant');
                }
            }
            const current = await EvidenceRepository.listControlLinks(db, ctx, id);
            const currentIds = new Set(current.map((l) => l.controlId));
            const desiredSet = new Set(desired);
            const toAdd = desired.filter((cid) => !currentIds.has(cid));
            const toRemove = [...currentIds].filter((cid) => !desiredSet.has(cid));
            await EvidenceRepository.createControlLinks(db, ctx, id, toAdd);
            for (const cid of toRemove) {
                await EvidenceRepository.unlinkControl(db, ctx, id, cid);
            }
        }

        await logEvent(db, ctx, {
            action: 'UPDATE',
            entityType: 'Evidence',
            entityId: id,
            details: `Evidence updated`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'Evidence',
                operation: 'updated',
                changedFields: Object.keys(data).filter(k => data[k as keyof typeof data] !== undefined),
                after: { title: data.title, category: data.category },
                summary: 'Evidence updated',
            },
        });

        return evidence;
    });
    await bumpEntityCacheVersion(ctx, 'evidence');
    if (data.controlIds !== undefined) await bumpEntityCacheVersion(ctx, 'control');
    return updated;
}

/**
 * EP-3 Part 3 — link an existing evidence record to a control from the
 * library. Creates one EvidenceControlLink (idempotent). Returns
 * `{ linked: boolean }` — false when the pair already existed.
 */
export async function linkEvidenceToControl(ctx: RequestContext, evidenceId: string, controlId: string) {
    assertCanWrite(ctx);
    const result = await runInTenantContext(ctx, async (db) => {
        const evidence = await EvidenceRepository.getById(db, ctx, evidenceId);
        if (!evidence) throw notFound('Evidence not found');
        const existing = await EvidenceRepository.filterExistingControlIds(db, ctx, [controlId]);
        if (!existing.has(controlId)) {
            throw badRequest('INVALID_CONTROL', 'Control not found or belongs to a different tenant');
        }
        const linked = await EvidenceRepository.linkControl(db, ctx, evidenceId, controlId);
        if (linked) {
            await logEvent(db, ctx, {
                action: 'CONTROL_EVIDENCE_LINKED',
                entityType: 'Evidence',
                entityId: evidenceId,
                details: `Evidence linked to control ${controlId}`,
                detailsJson: {
                    category: 'relationship',
                    operation: 'linked',
                    sourceEntity: 'Evidence',
                    sourceId: evidenceId,
                    targetEntity: 'Control',
                    targetId: controlId,
                    relation: 'evidence_control',
                },
            });
        }
        return { linked };
    });
    await bumpEntityCacheVersion(ctx, 'evidence');
    await bumpEntityCacheVersion(ctx, 'control');
    return result;
}

/**
 * EP-3 Part 3 — remove the association between an evidence record and a
 * control (deletes the EvidenceControlLink). The Evidence row itself
 * survives — this is a detach, not a delete.
 */
export async function unlinkEvidenceFromControl(ctx: RequestContext, evidenceId: string, controlId: string) {
    assertCanWrite(ctx);
    const result = await runInTenantContext(ctx, async (db) => {
        const evidence = await EvidenceRepository.getById(db, ctx, evidenceId);
        if (!evidence) throw notFound('Evidence not found');
        const removed = await EvidenceRepository.unlinkControl(db, ctx, evidenceId, controlId);
        if (removed === 0) throw notFound('Evidence is not linked to that control');
        await logEvent(db, ctx, {
            action: 'CONTROL_EVIDENCE_UNLINKED',
            entityType: 'Evidence',
            entityId: evidenceId,
            details: `Evidence unlinked from control ${controlId}`,
            detailsJson: {
                category: 'relationship',
                operation: 'unlinked',
                sourceEntity: 'Evidence',
                sourceId: evidenceId,
                targetEntity: 'Control',
                targetId: controlId,
                relation: 'evidence_control',
            },
        });
        return { success: true };
    });
    await bumpEntityCacheVersion(ctx, 'evidence');
    await bumpEntityCacheVersion(ctx, 'control');
    return result;
}

/**
 * Audit Coherence S3 (2026-05-22) — explicit state-machine table.
 *
 * Pre-this-PR `reviewEvidence` accepted any `action` string against
 * any current status; a `DRAFT → APPROVED` jump bypassed SUBMITTED.
 *
 * Author / submitter flow (EDITOR):
 *   DRAFT        → SUBMITTED   (ready for review)
 *   REJECTED     → SUBMITTED   (author revised; re-submit)
 *   NEEDS_REVIEW → SUBMITTED   (owner re-submits stale evidence)
 *
 * Reviewer flow (ADMIN):
 *   SUBMITTED → APPROVED
 *   SUBMITTED → REJECTED
 *
 * Out-of-band:
 *   APPROVED → NEEDS_REVIEW    (evidence-expiry cron, NOT this endpoint)
 */
const EVIDENCE_TRANSITIONS: Record<string, ReadonlySet<string>> = {
    DRAFT: new Set(['SUBMITTED']),
    REJECTED: new Set(['SUBMITTED']),
    NEEDS_REVIEW: new Set(['SUBMITTED']),
    SUBMITTED: new Set(['APPROVED', 'REJECTED']),
};

/**
 * Segregation of duties — resolve the person who authored/submitted a
 * piece of evidence so a reviewer can be blocked from approving their
 * own work. The submitter is the reviewer of the latest `SUBMITTED`
 * `EvidenceReview`; when no such review exists we fall back to the
 * evidence's `ownerUserId`. Enforced UNCONDITIONALLY — there is no
 * per-tenant "allow self-review" setting today.
 */
async function resolveEvidenceSubmitter(
    db: import('@/lib/db-context').PrismaTx,
    ctx: RequestContext,
    evidenceId: string,
    ownerUserId: string | null,
): Promise<string | null> {
    const submitters = await EvidenceRepository.getLatestSubmitters(db, ctx, [evidenceId]);
    return submitters.get(evidenceId) ?? ownerUserId ?? null;
}

/**
 * Fire the owner notification for an APPROVED / REJECTED decision.
 * Shared by the single-item and bulk review paths so both notify
 * identically. Notification routes via `ownerUserId` only — rows
 * missing an owner FK simply don't notify (graceful degrade).
 *
 * `knownOwnerIds` is the bulk-path optimisation: the caller pre-resolves
 * which owner ids exist in one batched `findMany`, so this helper skips
 * the per-row `findUnique` (avoids an N+1 in the approve loop). The
 * single path omits it and does the canonical FK lookup here.
 */
/**
 * R5-P2 #7 — a body-supplied `ownerUserId` is stamped with `ctx.tenantId`. If it
 * isn't an ACTIVE member of this tenant we both mis-assign the row AND, via
 * notifyEvidenceOwner's unscoped `db.user.findUnique`, mint a notification for a
 * foreign user — the cross-tenant email-disclosure shape. Validate it the same
 * way control-link targets are validated. `null`/`undefined` clears the owner
 * (always allowed).
 */
async function assertOwnerIsActiveMember(
    db: import('@/lib/db-context').PrismaTx,
    ctx: RequestContext,
    ownerUserId: string | null | undefined,
): Promise<void> {
    if (!ownerUserId) return;
    const membership = await db.tenantMembership.findFirst({
        where: { tenantId: ctx.tenantId, userId: ownerUserId, status: 'ACTIVE' },
        select: { id: true },
    });
    if (!membership) {
        throw badRequest('INVALID_OWNER', 'The evidence owner must be an active member of this tenant.');
    }
}

async function notifyEvidenceOwner(
    db: import('@/lib/db-context').PrismaTx,
    ctx: RequestContext,
    evidence: { ownerUserId: string | null; title: string },
    newStatus: 'APPROVED' | 'REJECTED',
    comment?: string | null,
    knownOwnerIds?: Set<string>,
): Promise<void> {
    if (!evidence.ownerUserId) return;
    if (knownOwnerIds) {
        if (!knownOwnerIds.has(evidence.ownerUserId)) return;
    } else {
        // R5-P2 #7 — resolve strictly via an ACTIVE membership in THIS tenant,
        // not an unscoped `db.user.findUnique` (which would notify a foreign
        // user whose id was stamped onto the row). Owners are validated at write
        // time now; this is the read-side backstop.
        const member = await db.tenantMembership.findFirst({
            where: { tenantId: ctx.tenantId, userId: evidence.ownerUserId, status: 'ACTIVE' },
            select: { id: true },
        });
        if (!member) return;
    }
    await db.notification.create({
        data: {
            tenantId: ctx.tenantId,
            // Non-null here: we returned early when ownerUserId is null,
            // and both branches above confirm the owner exists.
            userId: evidence.ownerUserId,
            type: newStatus === 'APPROVED' ? 'EVIDENCE_APPROVED' : 'EVIDENCE_REJECTED',
            title: `Evidence ${newStatus.toLowerCase()}: ${evidence.title}`,
            message: comment || `Your evidence "${evidence.title}" has been ${newStatus.toLowerCase()}.`,
            linkUrl: `/evidence`,
        },
    });
}

export async function reviewEvidence(ctx: RequestContext, id: string, data: { action: string; comment?: string | null }) {
    const { action, comment } = data;

    if (action === 'SUBMITTED') {
        assertCanEditEvidence(ctx); // EDITOR-tier evidence.edit grant
    } else if (action === 'APPROVED' || action === 'REJECTED') {
        assertCanAdmin(ctx); // ADMIN
    } else {
        throw badRequest('Invalid review action');
    }

    const result = await runInTenantContext(ctx, async (db) => {
        const evidence = await EvidenceRepository.getById(db, ctx, id);
        if (!evidence) throw notFound('Evidence not found');

        // Audit S3 — enforce the state machine BEFORE any write.
        const allowed = EVIDENCE_TRANSITIONS[evidence.status as string];
        if (!allowed || !allowed.has(action)) {
            throw badRequest(
                `Illegal evidence transition ${evidence.status} → ${action}. ` +
                    `From ${evidence.status} the only legal next states are: ` +
                    `${[...(allowed ?? [])].join(', ') || 'none'}.`,
            );
        }

        const newStatus = action as 'SUBMITTED' | 'APPROVED' | 'REJECTED';

        // R5-P2 #5 — a rejection MUST carry a reason (checked AFTER the state
        // machine so an illegal transition still reports the transition error).
        // `comment` is optional in the schema and only the client RejectReasonModal
        // enforced it, so a direct API REJECTED slipped through blank.
        if (newStatus === 'REJECTED' && !comment?.trim()) {
            throw badRequest('A rejection reason is required.');
        }

        // Segregation of duties — a reviewer may not approve/reject
        // evidence they submitted or own. Enforced unconditionally.
        if (newStatus === 'APPROVED' || newStatus === 'REJECTED') {
            const submitterId = await resolveEvidenceSubmitter(db, ctx, id, evidence.ownerUserId ?? null);
            if (submitterId && submitterId === ctx.userId) {
                throw forbidden(
                    'You cannot review evidence you submitted. Segregation of duties requires a different reviewer.',
                );
            }
        }

        await EvidenceRepository.update(db, ctx, id, { status: newStatus });
        await EvidenceRepository.addReview(db, ctx, id, newStatus, comment);

        if (newStatus === 'APPROVED' || newStatus === 'REJECTED') {
            await notifyEvidenceOwner(db, ctx, evidence, newStatus, comment);
        }

        await logEvent(db, ctx, {
            action: 'STATUS_CHANGE',
            entityType: 'Evidence',
            entityId: id,
            details: `Evidence ${action}: ${comment || ''}`,
            detailsJson: {
                category: 'status_change',
                entityName: 'Evidence',
                fromStatus: evidence.status,
                toStatus: action,
                reason: comment || undefined,
            },
        });

        return { success: true, status: newStatus };
    });
    await bumpEntityCacheVersion(ctx, 'evidence');
    return result;
}

// ─── Soft Delete / Restore / Purge ───

import { restoreEntity, purgeEntity } from './soft-delete-operations';
import { withDeleted } from '@/lib/soft-delete';

/** Bulk soft-delete evidence selected in the table action bar. */
export async function bulkDeleteEvidence(ctx: RequestContext, evidenceIds: string[]) {
    assertCanAdmin(ctx);
    const result = await runInTenantContext(ctx, async (db) => {
        const rows = await EvidenceRepository.listByIds(db, ctx, evidenceIds);
        if (rows.length === 0) return { deleted: 0 };
        await db.evidence.deleteMany({ where: { id: { in: rows.map((r) => r.id) }, tenantId: ctx.tenantId } });
        for (const r of rows) {
            await logEvent(db, ctx, {
                action: 'SOFT_DELETE',
                entityType: 'Evidence',
                entityId: r.id,
                details: 'Evidence soft-deleted (bulk)',
                detailsJson: { category: 'entity_lifecycle', entityName: 'Evidence', operation: 'deleted', summary: 'Evidence soft-deleted' },
            });
        }
        return { deleted: rows.length };
    });
    // R5-P3 #7 — invalidate the list cache so the deleted rows disappear
    // immediately instead of lingering for up to the 60s TTL.
    await bumpEntityCacheVersion(ctx, 'evidence');
    return result;
}

export async function deleteEvidence(ctx: RequestContext, id: string) {
    assertCanAdmin(ctx);
    const result = await runInTenantContext(ctx, async (db) => {
        const evidence = await EvidenceRepository.getById(db, ctx, id);
        if (!evidence) throw notFound('Evidence not found');

        await db.evidence.delete({ where: { id } });

        await logEvent(db, ctx, {
            action: 'SOFT_DELETE',
            entityType: 'Evidence',
            entityId: id,
            details: `Evidence soft-deleted: ${evidence.title}`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'Evidence',
                operation: 'deleted',
                before: { title: evidence.title },
                summary: `Evidence soft-deleted: ${evidence.title}`,
            },
        });
        return { success: true };
    });
    await bumpEntityCacheVersion(ctx, 'evidence');
    return result;
}

export async function restoreEvidence(ctx: RequestContext, id: string) {
    const result = await restoreEntity(ctx, 'Evidence', id);
    await bumpEntityCacheVersion(ctx, 'evidence');
    return result;
}

export async function purgeEvidence(ctx: RequestContext, id: string) {
    const result = await purgeEntity(ctx, 'Evidence', id);
    await bumpEntityCacheVersion(ctx, 'evidence');
    return result;
}

export async function listEvidenceWithDeleted(ctx: RequestContext) {
    assertCanAdmin(ctx);
    return runInTenantContext(ctx, (db) =>
        db.evidence.findMany(withDeleted({ where: { tenantId: ctx.tenantId }, orderBy: { createdAt: 'desc' as const } }))
    );
}

/**
 * GET evidence metrics — ADMIN only.
 */
export async function getEvidenceMetrics(ctx: RequestContext) {
    assertCanAdmin(ctx);
    const tenantId = ctx.tenantId;

    return runInTenantContext(ctx, async (db) => {
        const [totalEvidence, fileEvidence, linkedFileEvidence, fileRecordAgg, topControls] = await Promise.all([
            db.evidence.count({ where: { tenantId, deletedAt: null } }),
            db.evidence.count({ where: { tenantId, type: 'FILE', deletedAt: null } }),
            // EP-3 — FILE evidence linked to at least one control (via join).
            db.evidence.count({ where: { tenantId, type: 'FILE', deletedAt: null, evidenceControlLinks: { some: {} } } }),

            db.fileRecord.aggregate({
                where: { tenantId, status: 'STORED' },
                _sum: { sizeBytes: true },
                _count: { id: true },
            }),
            // EP-3 — top controls by evidence count, grouped over the join.
            db.evidenceControlLink.groupBy({
                by: ['controlId'],
                where: { tenantId, evidence: { deletedAt: null } },
                _count: { id: true },
                orderBy: { _count: { id: 'desc' } },
                take: 10,
            }),
        ]);

        const controlIds = topControls
            .map((g: { controlId: string | null }) => g.controlId)
            .filter(Boolean) as string[];
        const controlNames = controlIds.length > 0
            ? await db.control.findMany({
                where: { id: { in: controlIds } },
                select: { id: true, name: true, annexId: true, code: true },
            })
            : [];

        const controlLookup = new Map(controlNames.map(c => [c.id, c]));
        const totalBytesStored = fileRecordAgg._sum?.sizeBytes ?? 0;
        const storedFileCount = fileRecordAgg._count?.id ?? 0;
        const linkedRate = fileEvidence > 0 ? Math.round((linkedFileEvidence / fileEvidence) * 100) : 0;

        return {
            totalEvidence,
            fileEvidence,
            linkedFileEvidence,
            linkedRate,
            storedFileCount,
            totalBytesStored,
            totalBytesFormatted: totalBytesStored < 1048576
                ? `${(totalBytesStored / 1024).toFixed(1)} KB`
                : `${(totalBytesStored / 1048576).toFixed(1)} MB`,
            topControlsByEvidence: topControls.map((g: { controlId: string | null; _count: { id: number } }) => {
                const ctrl = g.controlId ? controlLookup.get(g.controlId) : null;
                return {
                    controlId: g.controlId,
                    controlName: ctrl ? `${ctrl.annexId || ctrl.code || ''} ${ctrl.name}`.trim() : '—',
                    evidenceCount: g._count.id,
                };
            }),
        };
    });
}

/**
 * EP-4 — tenant-wide retention/KPI aggregate (READER-gated).
 *
 * Thin usecase over `EvidenceRepository.retentionMetrics`. Returns the
 * authoritative status + expiry bucket counts computed by DB aggregate over
 * the FULL dataset, so the Evidence list KPI strips + the "all current"
 * celebration reflect the whole tenant rather than the ≤100-row SSR page.
 * Distinct from `getEvidenceMetrics` (ADMIN-only storage/top-controls
 * metrics) and `getRetentionMetrics` (retention dashboard buckets + top
 * controls with expiring evidence).
 */
export async function getEvidenceRetentionMetrics(ctx: RequestContext) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, (db) =>
        EvidenceRepository.retentionMetrics(db, ctx),
    );
}

// ─── File Upload / Download ───

import { FileRepository } from '../repositories/FileRepository';
import {
    getStorageProvider,
    buildTenantObjectKey,
    assertTenantKey,
    isAllowedMime,
    isAllowedSize,
    FILE_MAX_SIZE_BYTES,
} from '@/lib/storage';
import type { StorageDomain } from '@/lib/storage';
import { isDownloadAllowed, getBlockedReason } from '@/lib/storage/av-scan';
import { Readable } from 'stream';
import { env } from '@/env';

/**
 * Upload a file and create an Evidence record of type FILE in one flow.
 * Streams to disk + computes SHA-256 + creates FileRecord + Evidence.
 * Supports SHA-256 dedup: reuses existing FileRecord if same hash+tenant.
 */
export async function uploadEvidenceFile(
    ctx: RequestContext,
    file: File,
    metadata: {
        title?: string;
        controlId?: string | null;
        /** EP-3 — many-to-many control association (one Evidence + N links). */
        controlIds?: string[] | null;
        /** Source task — set when uploaded from a task's Evidence tab. */
        taskId?: string | null;
        /** Source risk / asset — set when uploaded from that entity's Evidence tab. */
        riskId?: string | null;
        assetId?: string | null;
        category?: string | null;
        /** B8 follow-up — folder applied to the newly-created
         *  evidence row. Trimmed + null-coerced inside `create`. */
        folder?: string | null;
        owner?: string | null;         // Legacy free-text
        ownerUserId?: string | null;   // Real user FK (preferred)
        reviewCycle?: string | null;
        nextReviewDate?: string | null;
        domain?: StorageDomain;
    },
) {
    assertCanUploadEvidence(ctx);

    // Validate before writing
    const mimeType = file.type || 'application/octet-stream';
    if (!isAllowedMime(mimeType)) {
        throw badRequest('FILE_TYPE_NOT_ALLOWED', `MIME type "${mimeType}" is not allowed`);
    }
    if (!isAllowedSize(file.size)) {
        throw badRequest('FILE_TOO_LARGE', `File exceeds maximum size of ${FILE_MAX_SIZE_BYTES} bytes`);
    }

    const storage = getStorageProvider();
    const originalName = file.name || 'unnamed';
    const domain = metadata.domain || 'evidence';
    const pathKey = buildTenantObjectKey(ctx.tenantId, domain, originalName);

    // Write through the storage abstraction (local or S3)
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const readable = Readable.from(buffer);

    const writeResult = await storage.write(pathKey, readable, { mimeType });

    // EP-3 — normalise the control association (many-to-many + legacy single).
    const requestedControlIds = normalizeControlIds(metadata.controlIds, metadata.controlId);

    // Create FileRecord + Evidence in a transaction
    const result = await runInTenantContext(ctx, async (db) => {
        const taskId = metadata.taskId || null;
        const riskId = metadata.riskId || null;
        const assetId = metadata.assetId || null;

        // Validate every control belongs to the same tenant
        if (requestedControlIds.length > 0) {
            const existing = await EvidenceRepository.filterExistingControlIds(db, ctx, requestedControlIds);
            const missing = requestedControlIds.filter((id) => !existing.has(id));
            if (missing.length > 0) {
                throw badRequest('INVALID_CONTROL', 'Control not found or belongs to a different tenant');
            }
        }

        // Validate task belongs to the same tenant
        if (taskId) {
            const task = await db.task.findFirst({
                where: { id: taskId, tenantId: ctx.tenantId },
                select: { id: true },
            });
            if (!task) throw badRequest('INVALID_TASK', 'Task not found or belongs to a different tenant');
        }

        // Validate risk belongs to the same tenant
        if (riskId) {
            const risk = await db.risk.findFirst({
                where: { id: riskId, tenantId: ctx.tenantId },
                select: { id: true },
            });
            if (!risk) throw badRequest('INVALID_RISK', 'Risk not found or belongs to a different tenant');
        }

        // Validate asset belongs to the same tenant
        if (assetId) {
            const asset = await db.asset.findFirst({
                where: { id: assetId, tenantId: ctx.tenantId },
                select: { id: true },
            });
            if (!asset) throw badRequest('INVALID_ASSET', 'Asset not found or belongs to a different tenant');
        }

        // ─── SHA-256 Dedup ───
        const existingFile = await FileRepository.findBySha256(db, ctx.tenantId, writeResult.sha256);
        let fileRecordId: string;
        let deduplicated = false;

        if (existingFile && existingFile.status === 'STORED') {
            // Reuse existing FileRecord — delete the new file
            fileRecordId = existingFile.id;
            deduplicated = true;
            // Best-effort cleanup: on a SHA-256 dedup hit the just-written
            // temp object is redundant (the canonical FileRecord already
            // holds identical bytes). A failed delete only leaks one orphan
            // object — it must NOT fail the dedup path, and there is no
            // user-visible failure to surface. The retention/GC sweep
            // reclaims orphans, so swallowing here is intentional.
            try { await storage.delete(pathKey); } catch { /* best-effort orphan cleanup — see reason above */ }
        } else {
            // Create new FileRecord with cloud storage metadata
            const fileRecord = await FileRepository.createPending(db, ctx, {
                pathKey,
                originalName,
                mimeType,
                sizeBytes: writeResult.sizeBytes,
                sha256: writeResult.sha256,
                storageProvider: storage.name,
                bucket: env.S3_BUCKET || null,
                domain,
            });
            await FileRepository.markStored(db, ctx, fileRecord.id);
            fileRecordId = fileRecord.id;
        }

        await assertOwnerIsActiveMember(db, ctx, metadata.ownerUserId);

        // Create Evidence linked to FileRecord
        const evidence = await EvidenceRepository.create(db, ctx, {
            type: 'FILE' as EvidenceType,
            title: metadata.title || originalName,
            content: pathKey,
            fileName: originalName,
            fileSize: writeResult.sizeBytes,
            fileRecordId,
            taskId,
            riskId,
            assetId,
            category: metadata.category || undefined,
            // B8 follow-up — same null-coercion as the TEXT path.
            folder: metadata.folder?.trim() || null,
            owner: metadata.owner || undefined,
            ownerUserId: metadata.ownerUserId || null,
            reviewCycle: (metadata.reviewCycle || null) as ReviewCadence | null,
            nextReviewDate: metadata.nextReviewDate ? new Date(metadata.nextReviewDate) : null,
            status: 'DRAFT',
        });

        // EP-3 — ONE Evidence + N join rows (no per-control clone, no
        // ControlEvidenceLink bridge for Evidence entities).
        await EvidenceRepository.createControlLinks(db, ctx, evidence.id, requestedControlIds);

        // An upload started from a risk / asset creates the join row too —
        // the singular FK above is provenance ("uploaded from"), the join
        // is the association the tab reads. Without this an uploaded file
        // would not appear on the very risk it was uploaded from.
        if (riskId) {
            await db.evidenceRiskLink.create({
                data: { tenantId: ctx.tenantId, evidenceId: evidence.id, riskId, createdByUserId: ctx.userId },
            });
        }
        if (assetId) {
            await db.evidenceAssetLink.create({
                data: { tenantId: ctx.tenantId, evidenceId: evidence.id, assetId, createdByUserId: ctx.userId },
            });
        }

        const eventAction = deduplicated ? 'FILE_DEDUP_REUSED' : 'EVIDENCE_FILE_UPLOADED';
        await logEvent(db, ctx, {
            action: eventAction,
            entityType: 'Evidence',
            entityId: evidence.id,
            details: `File uploaded: ${originalName}`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'Evidence',
                operation: 'created',
                after: {
                    fileRecordId,
                    originalName,
                    mimeType,
                    sizeBytes: writeResult.sizeBytes,
                    sha256: writeResult.sha256,
                    deduplicated,
                    storageProvider: storage.name,
                },
                summary: `File uploaded: ${originalName}`,
            },
        });

        return {
            ...evidence,
            controlIds: requestedControlIds,
            fileRecord: {
                id: fileRecordId,
                originalName,
                mimeType,
                sizeBytes: writeResult.sizeBytes,
                sha256: writeResult.sha256,
                status: 'STORED',
                deduplicated,
                storageProvider: storage.name,
            },
        };
    });
    // List-cache invalidation — same pair as createEvidence(): a new
    // Evidence row should appear in the evidence list immediately,
    // and if linked to a control the control's evidence-count is now
    // stale too. Without these bumps the list cache returns the
    // pre-upload view for up to 60s (TTL), and the e2e
    // upload-then-verify flow times out waiting for the new row.
    await bumpEntityCacheVersion(ctx, 'evidence');
    if (requestedControlIds.length > 0) await bumpEntityCacheVersion(ctx, 'control');
    return result;
}

/**
 * EP-3 Part 4 — replace the file backing a FILE-type evidence record.
 *
 * Uploads a new file → creates a fresh FileRecord (chained to the prior one
 * via `previousFileRecordId`) → repoints `Evidence.fileRecordId` and bumps
 * `fileVersion`, PRESERVING the Evidence row's status / reviews / retention /
 * control links. The point: updating a doc keeps lineage instead of spawning
 * an unrelated Evidence row.
 */
/**
 * Safety bound on the version walk. Each `replaceEvidenceFile` adds one
 * link, so real chains are short; this stops a cycle (which the schema
 * does not forbid) from looping forever.
 */
const MAX_FILE_VERSION_CHAIN = 50;

/** The FileRecord columns the version walk reads. */
interface FileVersionRecord {
    id: string;
    originalName: string;
    mimeType: string;
    sizeBytes: number;
    sha256: string;
    createdAt: Date;
    previousFileRecordId: string | null;
}

/**
 * Walk an evidence row's file-version lineage, newest first.
 *
 * `replaceEvidenceFile` has always written the chain — each new
 * FileRecord points at the one it superseded via `previousFileRecordId`,
 * and `Evidence.fileVersion` counts up — but nothing ever read it back.
 * A user who replaced a file could see neither that v2 existed nor how to
 * retrieve v1.
 *
 * FileRecord carries no `evidenceId` (only the CURRENT head is linked,
 * from `Evidence.fileRecordId`), so the lineage can only be reached by
 * walking the linked list. Version numbers are assigned by counting down
 * from `Evidence.fileVersion`, which is the head's ordinal.
 *
 * Prior versions download through the existing
 * `/evidence/files/[fileId]/download` route — it resolves any
 * tenant-scoped FileRecord and re-checks the tenant path guard and the AV
 * scan status, so historical versions get the same protections as the head.
 */
export async function getEvidenceFileVersions(ctx: RequestContext, evidenceId: string) {
    assertCanRead(ctx);

    return runInTenantContext(ctx, async (db) => {
        const evidence = await db.evidence.findFirst({
            where: { id: evidenceId, tenantId: ctx.tenantId },
            select: { fileRecordId: true, fileVersion: true },
        });
        if (!evidence) throw notFound('Evidence not found');

        const versions: Array<{
            id: string;
            version: number;
            originalName: string;
            mimeType: string;
            sizeBytes: number;
            sha256: string;
            createdAt: Date;
            isCurrent: boolean;
        }> = [];

        let cursor = evidence.fileRecordId;
        let version = evidence.fileVersion;
        // A linked list can only be walked one hop at a time (FileRecord
        // has no evidenceId to batch on), and the walk is bounded by
        // MAX_FILE_VERSION_CHAIN. Chains are single-digit in practice:
        // one hop per file replacement.
        while (cursor && versions.length < MAX_FILE_VERSION_CHAIN) { // guardrail-allow: n+1
            const record: FileVersionRecord | null = await db.fileRecord.findFirst({
                where: { id: cursor, tenantId: ctx.tenantId, deletedAt: null },
                select: {
                    id: true,
                    originalName: true,
                    mimeType: true,
                    sizeBytes: true,
                    sha256: true,
                    createdAt: true,
                    previousFileRecordId: true,
                },
            });
            if (!record) break;

            versions.push({
                id: record.id,
                version,
                originalName: record.originalName,
                mimeType: record.mimeType,
                sizeBytes: record.sizeBytes,
                sha256: record.sha256,
                createdAt: record.createdAt,
                isCurrent: versions.length === 0,
            });

            cursor = record.previousFileRecordId;
            version -= 1;
        }

        return { fileVersion: evidence.fileVersion, versions };
    });
}

export async function replaceEvidenceFile(ctx: RequestContext, evidenceId: string, file: File) {
    assertCanUploadEvidence(ctx);

    const mimeType = file.type || 'application/octet-stream';
    if (!isAllowedMime(mimeType)) {
        throw badRequest('FILE_TYPE_NOT_ALLOWED', `MIME type "${mimeType}" is not allowed`);
    }
    if (!isAllowedSize(file.size)) {
        throw badRequest('FILE_TOO_LARGE', `File exceeds maximum size of ${FILE_MAX_SIZE_BYTES} bytes`);
    }

    // Validate the evidence exists + is FILE-type BEFORE touching storage.
    const target = await runInTenantContext(ctx, async (db) => {
        const ev = await db.evidence.findFirst({
            where: { id: evidenceId, tenantId: ctx.tenantId, deletedAt: null },
            select: { id: true, type: true, fileRecordId: true, fileVersion: true, title: true, status: true },
        });
        if (!ev) throw notFound('Evidence not found');
        if (ev.type !== 'FILE') throw badRequest('NOT_FILE_EVIDENCE', 'Only FILE-type evidence can have its file replaced');
        return ev;
    });

    // R5-P2 #4 — swapping the bytes under an APPROVED artifact must void the
    // prior approval: the reviewer signed off on DIFFERENT content. Reset to
    // SUBMITTED so it re-enters the review queue instead of silently carrying
    // an APPROVED badge over unreviewed bytes.
    const requiresReReview = target.status === 'APPROVED';

    const storage = getStorageProvider();
    const originalName = file.name || 'unnamed';
    const domain: StorageDomain = 'evidence';
    const pathKey = buildTenantObjectKey(ctx.tenantId, domain, originalName);

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const readable = Readable.from(buffer);
    const writeResult = await storage.write(pathKey, readable, { mimeType });

    const result = await runInTenantContext(ctx, async (db) => {
        // New FileRecord, chained to the one it supersedes.
        const fileRecord = await FileRepository.createPending(db, ctx, {
            pathKey,
            originalName,
            mimeType,
            sizeBytes: writeResult.sizeBytes,
            sha256: writeResult.sha256,
            storageProvider: storage.name,
            bucket: env.S3_BUCKET || null,
            domain,
        });
        await FileRepository.markStored(db, ctx, fileRecord.id);
        if (target.fileRecordId) {
            await db.fileRecord.update({
                where: { id: fileRecord.id },
                data: { previousFileRecordId: target.fileRecordId },
            });
        }

        // Repoint the Evidence at the new file + bump the version. Status,
        // reviews, retention, and control links are untouched.
        const updated = await db.evidence.update({
            where: { id: evidenceId },
            data: {
                fileRecordId: fileRecord.id,
                fileName: originalName,
                fileSize: writeResult.sizeBytes,
                content: pathKey,
                fileVersion: target.fileVersion + 1,
                ...(requiresReReview ? { status: 'SUBMITTED' } : {}),
            },
        });

        await logEvent(db, ctx, {
            action: 'EVIDENCE_FILE_REPLACED',
            entityType: 'Evidence',
            entityId: evidenceId,
            details: `File replaced: ${originalName} (v${target.fileVersion + 1})`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'Evidence',
                operation: 'updated',
                changedFields: ['fileRecordId', 'fileName', 'fileSize', 'fileVersion'],
                after: {
                    fileRecordId: fileRecord.id,
                    previousFileRecordId: target.fileRecordId,
                    originalName,
                    sizeBytes: writeResult.sizeBytes,
                    sha256: writeResult.sha256,
                    fileVersion: target.fileVersion + 1,
                },
                summary: `File replaced: ${originalName}`,
            },
        });

        return {
            ...updated,
            fileRecord: {
                id: fileRecord.id,
                originalName,
                mimeType,
                sizeBytes: writeResult.sizeBytes,
                sha256: writeResult.sha256,
                status: 'STORED',
                previousFileRecordId: target.fileRecordId,
            },
        };
    });
    await bumpEntityCacheVersion(ctx, 'evidence');
    return result;
}

/**
 * Get file metadata for secure download (tenant check).
 */
export async function getEvidenceFileRecord(ctx: RequestContext, fileId: string) {
    assertCanRead(ctx);

    return runInTenantContext(ctx, async (db) => {
        const fileRecord = await FileRepository.getById(db, ctx, fileId);
        if (!fileRecord) throw notFound('File not found');
        if (fileRecord.status === 'DELETED') throw notFound('File has been deleted');
        return fileRecord;
    });
}

/**
 * STRICT DOWNLOAD POLICY (Option A):
 * - ADMIN/EDITOR: can download any tenant file evidence.
 * - READER/AUDITOR: can download ONLY if evidence is linked to a control (controlId not null).
 * - Soft-deleted evidence blocks download for all roles.
 */
export async function downloadEvidenceFile(ctx: RequestContext, fileId: string) {
    assertCanRead(ctx);

    return runInTenantContext(ctx, async (db) => {
        const fileRecord = await FileRepository.getById(db, ctx, fileId);
        if (!fileRecord) throw notFound('File not found');
        if (fileRecord.status !== 'STORED') throw notFound('File is not available for download');

        // Tenant isolation guard
        assertTenantKey(fileRecord.pathKey, ctx.tenantId);

        // ─── AV Scan Guard (single shared predicate — R5-P1 #3) ───
        // Was an inline reimplementation of isDownloadAllowed with a
        // `|| 'permissive'` fallback; two copies of one security check drift.
        if (!isDownloadAllowed(fileRecord.scanStatus)) {
            throw forbidden(getBlockedReason(fileRecord.scanStatus));
        }

        // ─── Owning-evidence gates (deleted / archived), version-aware ───
        // R5-P1 #4 — `fileRecordId: fileId` matches only the CURRENT head, so a
        // superseded version (previousFileRecordId chain) resolved to null here
        // and slipped past the deleted gate: write-tier roles could still pull
        // v1..vN of soft-deleted evidence, and isArchived was never checked at
        // all. Walk the chain FORWARD to the head, then resolve the owning
        // evidence and apply both gates to every version.
        let headFileId = fileId;
        // Bounded forward walk of the file-version chain (previousFileRecordId);
        // typically 1-5 hops, hard-capped at 100 iterations.
        for (let hops = 0; hops < 100; hops++) { // guardrail-allow: n+1
            const superseder = await db.fileRecord.findFirst({
                where: { tenantId: ctx.tenantId, previousFileRecordId: headFileId },
                select: { id: true },
            });
            if (!superseder) break;
            headFileId = superseder.id;
        }

        // EP-3 — "linked to a control" now means the Evidence has at least
        // one EvidenceControlLink (the singular controlId is gone).
        const evidence = await db.evidence.findFirst({
            where: { tenantId: ctx.tenantId, fileRecordId: headFileId },
            select: {
                id: true,
                deletedAt: true,
                isArchived: true,
                _count: { select: { evidenceControlLinks: true } },
            },
        });

        if (evidence?.deletedAt) {
            throw notFound('Evidence has been deleted');
        }
        if (evidence?.isArchived) {
            throw notFound('Evidence has been archived and is no longer available for download');
        }

        if (!ctx.permissions.canWrite) {
            if (!evidence || evidence._count.evidenceControlLinks === 0) {
                throw forbidden('You can only download evidence that is linked to a control. Contact an admin to link this evidence.');
            }
        }

        await logEvent(db, ctx, {
            action: 'EVIDENCE_DOWNLOADED',
            entityType: 'FileRecord',
            entityId: fileId,
            details: `Evidence file downloaded: ${fileRecord.originalName}`,
            detailsJson: {
                category: 'access',
                operation: 'login',
                detail: `Evidence downloaded: ${fileRecord.originalName}`,
                targetUserId: ctx.userId,
            },
        });

        // ─── Dual-read: dispatch by record's storage provider ───
        // During migration, old files may be on 'local' while app is configured for 's3'.
        // Always read from the backend that stored the file.
        const recordProvider = (fileRecord.storageProvider || 'local') as import('@/lib/storage/types').StorageProviderType;
        const { getProviderByName } = await import('@/lib/storage/index');
        const readProvider = getProviderByName(recordProvider);

        if (readProvider.name === 's3') {
            // S3: return presigned download URL (client-side redirect)
            const downloadUrl = await readProvider.createSignedDownloadUrl(fileRecord.pathKey, {
                expiresIn: 300, // 5 minutes
                downloadFilename: fileRecord.originalName,
            });
            return {
                mode: 'redirect' as const,
                downloadUrl,
                originalName: fileRecord.originalName,
                mimeType: fileRecord.mimeType,
                sizeBytes: fileRecord.sizeBytes,
                sha256: fileRecord.sha256,
            };
        }

        // Local: stream file through the server
        return {
            mode: 'stream' as const,
            stream: readProvider.readStream(fileRecord.pathKey),
            originalName: fileRecord.originalName,
            mimeType: fileRecord.mimeType,
            sizeBytes: fileRecord.sizeBytes,
            sha256: fileRecord.sha256,
        };
    });
}

// ─── Bulk actions (canonical BulkActionBar rollout — wave B) ───
// Assign-owner + a reviewer-gated bulk-approve (see bulkApproveEvidence
// below). The bulk-approve path enforces the SAME reviewer tier, SUBMITTED
// precondition, and segregation-of-duties rule as the single-item
// `reviewEvidence` — it is not a status bypass.

export async function bulkAssignEvidence(
    ctx: RequestContext,
    evidenceIds: string[],
    ownerUserId: string | null,
) {
    assertCanEditEvidence(ctx);
    const updated = await runInTenantContext(ctx, async (db) => {
        await assertOwnerIsActiveMember(db, ctx, ownerUserId);
        const rows = await EvidenceRepository.listByIds(db, ctx, evidenceIds);
        if (rows.length === 0) return 0;
        await EvidenceRepository.bulkUpdate(db, ctx, evidenceIds, {
            ownerUserId: ownerUserId || null,
        });
        for (const r of rows) {
            await logEvent(db, ctx, {
                action: 'UPDATE',
                entityType: 'Evidence',
                entityId: r.id,
                details: ownerUserId ? `Evidence owner reassigned` : `Evidence owner cleared`,
                detailsJson: {
                    category: 'entity_lifecycle',
                    entityName: 'Evidence',
                    operation: 'updated',
                    changedFields: ['ownerUserId'],
                    after: { ownerUserId: ownerUserId || null },
                    summary: ownerUserId ? `owner reassigned (bulk)` : `owner cleared (bulk)`,
                },
            });
        }
        return rows.length;
    });
    await bumpEntityCacheVersion(ctx, 'evidence');
    return { updated };
}

/**
 * Bulk-approve evidence — the reviewer-gated path.
 *
 * This mirrors the single-item `reviewEvidence` approval semantics
 * rather than bypassing them:
 *   - reviewer tier required (`assertCanAdmin`);
 *   - only rows currently in `SUBMITTED` are eligible — DRAFT /
 *     REJECTED / NEEDS_REVIEW / already-APPROVED are skipped, so the
 *     SUBMITTED intermediate is never bypassed;
 *   - segregation of duties: a row the acting reviewer submitted or
 *     owns is skipped (enforced unconditionally, same as the single
 *     path).
 * Each approved row records an `EvidenceReview`, a STATUS_CHANGE audit
 * entry, and an owner notification, identical to the single path.
 * `nextReviewDate` is left as-is so an approved item with a
 * future/absent review date immediately counts as "current".
 *
 * Returns `{ approved, skipped, skippedNotSubmitted, skippedSelfReview }`
 * so the UI can explain what it did and didn't touch.
 */
export async function bulkApproveEvidence(ctx: RequestContext, evidenceIds: string[]) {
    assertCanAdmin(ctx);
    const counts = await runInTenantContext(ctx, async (db) => {
        const rows = await EvidenceRepository.listByIds(db, ctx, evidenceIds);
        const submitted = rows.filter((r) => r.status === 'SUBMITTED');
        const skippedNotSubmitted = rows.length - submitted.length;

        // SoD — resolve every submitter in one batched query, then
        // partition SUBMITTED rows into self-review (skip) vs approvable.
        const submitters = await EvidenceRepository.getLatestSubmitters(
            db,
            ctx,
            submitted.map((r) => r.id),
        );
        const toApprove: typeof submitted = [];
        let skippedSelfReview = 0;
        for (const r of submitted) {
            const submitterId = submitters.get(r.id) ?? r.ownerUserId ?? null;
            if (submitterId && submitterId === ctx.userId) {
                skippedSelfReview += 1;
            } else {
                toApprove.push(r);
            }
        }

        if (toApprove.length > 0) {
            await EvidenceRepository.bulkUpdate(db, ctx, toApprove.map((r) => r.id), { status: 'APPROVED' });
            // Batch-resolve which owners exist (one findMany) so the loop's
            // notifications don't turn into an N+1 of per-row user lookups.
            const ownerIds = [
                ...new Set(toApprove.map((r) => r.ownerUserId).filter((v): v is string => !!v)),
            ];
            const owners = ownerIds.length > 0
                ? await db.user.findMany({ where: { id: { in: ownerIds } }, select: { id: true } })
                : [];
            const knownOwnerIds = new Set(owners.map((o) => o.id));
            for (const r of toApprove) {
                await EvidenceRepository.addReview(db, ctx, r.id, 'APPROVED', 'Bulk approved');
                await notifyEvidenceOwner(db, ctx, r, 'APPROVED', 'Bulk approved', knownOwnerIds);
                await logEvent(db, ctx, {
                    action: 'STATUS_CHANGE',
                    entityType: 'Evidence',
                    entityId: r.id,
                    details: 'Evidence approved (bulk)',
                    detailsJson: {
                        category: 'status_change',
                        entityName: 'Evidence',
                        fromStatus: r.status,
                        toStatus: 'APPROVED',
                        summary: 'approved (bulk)',
                    },
                });
            }
        }

        return {
            approved: toApprove.length,
            skipped: skippedNotSubmitted + skippedSelfReview,
            skippedNotSubmitted,
            skippedSelfReview,
        };
    });
    await bumpEntityCacheVersion(ctx, 'evidence');
    return counts;
}
