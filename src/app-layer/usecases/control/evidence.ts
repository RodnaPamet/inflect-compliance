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
import { logEvent } from '../../events/audit';
import { notFound } from '@/lib/errors/types';
import { runInTenantContext } from '@/lib/db-context';

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
 * Writes a plain `ControlEvidenceLink` row: it never reaches the evidence
 * library and has no review status. The control's Evidence tab no longer
 * adds a web link through here — it creates a library LINK record through
 * `createEvidence` (`POST /evidence` with `controlIds`), exactly as the
 * library's own link dialog does, so the link can be reviewed (#4126).
 * This path stays for API callers and the controls list's edit panel.
 */
export async function linkEvidence(ctx: RequestContext, controlId: string, data: { kind: string; fileId?: string | null; url?: string | null; note?: string | null }) {
    assertCanLinkEvidence(ctx);
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
