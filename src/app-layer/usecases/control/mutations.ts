import { RequestContext } from '../../types';
import { ControlRepository } from '../../repositories/ControlRepository';
import {
    assertCanCreateControl, assertCanUpdateControl,
    assertCanSetApplicability,
} from '../../policies/control.policies';
import { logEvent } from '../../events/audit';
import { notFound, forbidden, badRequest } from '@/lib/errors/types';
import { runInTenantContext } from '@/lib/db-context';
import { restoreEntity, purgeEntity } from '../soft-delete-operations';
import { assertCanAdmin } from '../../policies/common';
import { bumpEntityCacheVersion } from '@/lib/cache/list-cache';
import { emitAutomationEvent } from '../../automation';
import { assertWithinLimit } from '@/lib/billing/entitlements';
import { createAssignmentNotification } from '../../notifications/assignment';
import { logger } from '@/lib/observability/logger';
import { recordControlCreated } from '@/lib/observability/business-metrics';
import { z } from 'zod';
import { CreateControlSchema, UpdateControlSchema } from '@/lib/schemas';
import { computeNextDueAt } from '../../utils/cadence';

// ─── Create / Update ───

/**
 * `data` is typed as the SCHEMA's inferred output, not a hand-written shape.
 *
 * The two used to be maintained separately, and drifted: this function
 * declared and wrote objective / successCriteria / testingMethodology while
 * CreateControlSchema did not declare them, so `.strip()` removed them
 * before the usecase ever saw them. Deriving the parameter type from the
 * schema makes that impossible — a field this function reads must be a
 * field the schema declares, or it does not compile.
 *
 * `z.input`, not `z.infer`: `z.infer` is the OUTPUT type, in which
 * `.default()`ed fields (status, isCustom) are REQUIRED. Callers legitimately
 * omit them — the route passes parsed data where the defaults have already
 * been applied, but internal callers (nis2-gap-lifecycle, self-assessment)
 * pass a raw shape and rely on the same defaults. `z.input` describes what a
 * caller may hand in, which is the contract this parameter actually has.
 */
export async function createControl(
    ctx: RequestContext,
    data: z.input<typeof CreateControlSchema>,
) {
    assertCanCreateControl(ctx);
    // GAP-18 — plan-limit gate. SaaS FREE tenants cap at 10 controls;
    // self-hosted is always unlimited (entitlements module resolves
    // ENTERPRISE when STRIPE_SECRET_KEY is unset). Throws
    // `forbidden('plan_limit_exceeded: …')` at the cap, surfacing
    // as 403 to the client.
    await assertWithinLimit(ctx, 'control');

    const created = await runInTenantContext(ctx, async (db) => {
        // Mint a per-tenant `CTL-N` code for custom-control creates
        // that don't supply their own code. Mirrors
        // `assetKeySequence` / `riskKeySequence` — the upsert
        // compiles to a native `INSERT … ON CONFLICT DO UPDATE`,
        // race-free under concurrent imports. Framework-installed
        // controls always carry their own `code` / `annexId` from
        // the catalogue and bypass this branch.
        const isCustom = data.isCustom ?? true;
        let code = data.code || null;
        if (!code && isCustom) {
            const seq = await db.controlKeySequence.upsert({
                where: { tenantId: ctx.tenantId },
                create: { tenantId: ctx.tenantId, lastValue: 1 },
                update: { lastValue: { increment: 1 } },
            });
            code = `CTL-${seq.lastValue}`;
        }
        const control = await ControlRepository.create(db, ctx, {
            code,
            annexId: data.annexId || null,
            name: data.name,
            objective: data.objective || null,
            successCriteria: data.successCriteria || null,
            testingMethodology: data.testingMethodology || null,
            category: data.category || null,
            status: (data.status as 'NOT_STARTED') || 'NOT_STARTED',
            frequency: (data.frequency as 'MONTHLY') || null,
            ownerUserId: data.ownerUserId || null,
            createdByUserId: ctx.userId,
            evidenceSource: (data.evidenceSource as 'MANUAL') || null,
            automationKey: data.automationKey || null,
            automationType: (data.automationType as 'AUTOMATED') || null,
            mitigationType: (data.mitigationType as 'PREVENTIVE') || null,
            isCustom,
        });

        await logEvent(db, ctx, {
            action: 'CONTROL_CREATED',
            entityType: 'Control',
            entityId: control.id,
            details: `Created control: ${control.code || control.name}`,
            detailsJson: { category: 'entity_lifecycle', entityName: 'Control', operation: 'created', after: { code: control.code, name: control.name }, summary: `Created control: ${control.code || control.name}` },
        });

        return control;
    });
    await bumpEntityCacheVersion(ctx, 'control');
    recordControlCreated({ source: 'manual' });
    return created;
}

/** `data` derives from the schema — see createControl. */
export async function updateControl(
    ctx: RequestContext,
    id: string,
    data: z.input<typeof UpdateControlSchema>,
) {
    assertCanUpdateControl(ctx);

    const updated = await runInTenantContext(ctx, async (db) => {
        // The BEFORE image. Needed for two things the request body cannot
        // tell us: which fields actually changed, and whether `frequency`
        // moved (which invalidates the stored nextDueAt).
        const before = await ControlRepository.getById(db, ctx, id);

        const control = await ControlRepository.update(db, ctx, id, {
            ...(data.name !== undefined && { name: data.name }),
            ...(data.category !== undefined && { category: data.category }),
            ...(data.code !== undefined && { code: data.code }),
            ...(data.frequency !== undefined && { frequency: data.frequency as 'MONTHLY' | null }),
            ...(data.evidenceSource !== undefined && { evidenceSource: data.evidenceSource as 'MANUAL' | null }),
            ...(data.automationKey !== undefined && { automationKey: data.automationKey }),
            ...(data.automationType !== undefined && { automationType: data.automationType as 'AUTOMATED' | null }),
            ...(data.mitigationType !== undefined && { mitigationType: data.mitigationType as 'PREVENTIVE' | null }),
            ...(data.objective !== undefined && { objective: data.objective }),
            ...(data.successCriteria !== undefined && { successCriteria: data.successCriteria }),
            ...(data.testingMethodology !== undefined && { testingMethodology: data.testingMethodology }),
            ...(data.annualCost !== undefined && { annualCost: data.annualCost }),
            ...(data.effectiveness !== undefined && { effectiveness: data.effectiveness }),
        });

        if (!control) {
            // Reuses the BEFORE read above rather than issuing a second
            // getById: the update's where-filter excludes global rows, so a
            // null result with a row that WAS readable means it belongs to
            // the shared library. One read serves both the diff and this
            // guard.
            if (before) throw forbidden('Cannot modify global library controls');
            throw notFound('Control not found');
        }

        // `frequency` drives nextDueAt, which is otherwise only computed at
        // attest time (control-test.ts, task-source-reconcile.ts). Editing
        // the cadence without recomputing left [nextDueAt]-driven scheduling
        // and the controlsDueSoon dashboard count running on a value derived
        // from a SUPERSEDED frequency until the next test completed.
        if (
            data.frequency !== undefined &&
            before &&
            data.frequency !== before.frequency
        ) {
            await ControlRepository.update(db, ctx, id, {
                nextDueAt: computeNextDueAt(data.frequency, new Date()),
            });
        }

        // changedFields is DIFFED, not read off the request body.
        //
        // `Object.keys(data)` made the audit trail a function of which UI the
        // user opened: the detail page PATCHes 10 fields, ControlEditPanel
        // PATCHes 3, so editing one field through the detail page recorded
        // nine unchanged fields as "changed" — and the same edit through the
        // panel recorded a different set. Comparing before/after records
        // what actually moved, whatever the caller sent.
        const changedFields = before
            ? (Object.keys(data) as Array<keyof typeof data>).filter((k) => {
                  if (data[k] === undefined) return false;
                  return data[k] !== (before as Record<string, unknown>)[k as string];
              })
            : (Object.keys(data) as Array<keyof typeof data>).filter(
                  (k) => data[k] !== undefined,
              );

        await logEvent(db, ctx, {
            action: 'CONTROL_UPDATED',
            entityType: 'Control',
            entityId: id,
            details: JSON.stringify(data),
            detailsJson: { category: 'entity_lifecycle', entityName: 'Control', operation: 'updated', changedFields, summary: 'Control updated' },
        });

        return control;
    });
    await bumpEntityCacheVersion(ctx, 'control');
    return updated;
}

// ─── Status ───

export async function setControlStatus(ctx: RequestContext, id: string, status: string) {
    assertCanUpdateControl(ctx);
    const result = await runInTenantContext(ctx, async (db) => {
        const existing = await ControlRepository.getById(db, ctx, id);
        if (!existing) throw notFound('Control not found');
        if (!existing.tenantId) throw forbidden('Cannot change status of global library controls');

        const oldStatus = existing.status;
        const control = await ControlRepository.update(db, ctx, id, { status: status as 'NOT_STARTED' });
        if (!control) throw notFound('Control not found');

        await logEvent(db, ctx, {
            action: 'CONTROL_STATUS_CHANGED',
            entityType: 'Control',
            entityId: id,
            details: `Status changed: ${oldStatus} → ${status}`,
            detailsJson: { category: 'status_change', entityName: 'Control', fromStatus: oldStatus, toStatus: status },
        });
        // Domain-emit (cycle-2 follow-up) — let automation rules react to control
        // lifecycle moves. Best-effort: a bus hiccup must not fail the write.
        await emitAutomationEvent(ctx, {
            event: 'CONTROL_STATUS_CHANGED',
            entityType: 'Control',
            entityId: id,
            actorUserId: ctx.userId,
            data: { fromStatus: oldStatus, toStatus: status },
        }).catch(() => {});
        return control;
    });
    await bumpEntityCacheVersion(ctx, 'control');
    return result;
}

// ─── Applicability ───

export async function setControlApplicability(
    ctx: RequestContext,
    controlId: string,
    applicability: 'APPLICABLE' | 'NOT_APPLICABLE',
    justification: string | null
) {
    assertCanSetApplicability(ctx);

    if (applicability === 'NOT_APPLICABLE' && !justification) {
        throw badRequest('Justification is required when marking a control as NOT_APPLICABLE');
    }

    const result = await runInTenantContext(ctx, async (db) => {
        const existing = await ControlRepository.getById(db, ctx, controlId);
        if (!existing) throw notFound('Control not found');
        if (!existing.tenantId) throw forbidden('Cannot change applicability of global library controls');

        const oldApplicability = existing.applicability;
        const updated = await ControlRepository.setApplicability(db, ctx, controlId, applicability, justification);
        if (!updated) throw notFound('Control not found');

        await logEvent(db, ctx, {
            action: 'CONTROL_APPLICABILITY_CHANGED',
            entityType: 'Control',
            entityId: controlId,
            details: `Applicability changed: ${oldApplicability} → ${applicability}`,
            detailsJson: { category: 'status_change', entityName: 'Control', fromStatus: oldApplicability || 'APPLICABLE', toStatus: applicability, reason: justification || undefined },
            metadata: { oldApplicability, newApplicability: applicability, justification },
        });

        return updated;
    });
    await bumpEntityCacheVersion(ctx, 'control');
    return result;
}

/**
 * Set a PER-FRAMEWORK applicability override on one control↔requirement link.
 * NULL clears the override (the link reverts to inheriting the control's global
 * Control.applicability). SoA/coverage read the effective value (link ?? control).
 */
export async function setRequirementLinkApplicability(
    ctx: RequestContext,
    controlId: string,
    requirementId: string,
    applicability: 'APPLICABLE' | 'NOT_APPLICABLE' | null,
    justification: string | null,
) {
    assertCanSetApplicability(ctx);
    if (applicability === 'NOT_APPLICABLE' && !justification) {
        throw badRequest('Justification is required when marking a requirement mapping NOT_APPLICABLE');
    }

    const result = await runInTenantContext(ctx, async (db) => {
        const link = await db.controlRequirementLink.findFirst({
            where: { controlId, requirementId, tenantId: ctx.tenantId },
            select: { id: true, applicability: true },
        });
        if (!link) throw notFound('Control–requirement mapping not found');

        const updated = await db.controlRequirementLink.update({
            where: { id: link.id },
            data: {
                applicability,
                applicabilityJustification: applicability === 'NOT_APPLICABLE' ? justification : null,
            },
        });

        await logEvent(db, ctx, {
            action: 'CONTROL_APPLICABILITY_CHANGED',
            entityType: 'Control',
            entityId: controlId,
            details: `Per-framework applicability changed: ${link.applicability ?? 'INHERIT'} → ${applicability ?? 'INHERIT'}`,
            detailsJson: { category: 'status_change', entityName: 'Control', fromStatus: link.applicability ?? 'INHERIT', toStatus: applicability ?? 'INHERIT', reason: justification || undefined },
            metadata: { requirementId, oldApplicability: link.applicability, newApplicability: applicability, justification },
        });
        return updated;
    });
    await bumpEntityCacheVersion(ctx, 'control');
    return result;
}

// ─── Owner ───

export async function setControlOwner(ctx: RequestContext, id: string, ownerUserId: string | null) {
    assertCanUpdateControl(ctx);
    const result = await runInTenantContext(ctx, async (db) => {
        // Validate the assignee is an ACTIVE member of THIS tenant before
        // writing the owner FK. The prior `SELECT id FROM "User"` only proved
        // platform-wide existence against an RLS-less table — any other
        // tenant's user id (or a deactivated member) would have been accepted
        // as an owner. Mirrors `asset.ts::assertActiveOwner`.
        if (ownerUserId) {
            const member = await db.tenantMembership.findFirst({
                where: { tenantId: ctx.tenantId, userId: ownerUserId, status: 'ACTIVE' },
                select: { id: true },
            });
            if (!member) throw badRequest('Owner must be an active member of this tenant');
        }
        const control = await ControlRepository.setOwner(db, ctx, id, ownerUserId);
        if (!control) throw notFound('Control not found');

        await logEvent(db, ctx, {
            action: 'CONTROL_OWNER_CHANGED',
            entityType: 'Control',
            entityId: id,
            details: `Owner set to: ${ownerUserId || 'none'}`,
            detailsJson: { category: 'entity_lifecycle', entityName: 'Control', operation: 'updated', changedFields: ['ownerUserId'], after: { ownerUserId }, summary: `Owner set to: ${ownerUserId || 'none'}` },
        });
        return control;
    });
    await bumpEntityCacheVersion(ctx, 'control');

    // PR-A 2026-05-27 — in-app CONTROL_ASSIGNED bell notification
    // for the new owner. Pre-PR-A the ownership transfer wrote
    // only an audit row; the new owner had no in-product alert.
    //
    // Runs AFTER the parent transaction commits, in its own short
    // `runInTenantContext` — a notification write must never roll
    // back the ownership change. Idempotent via the
    // `(tenantId, CONTROL_ASSIGNED, controlId, userId, date)`
    // dedupeKey so rapid re-assigns within one day collapse to a
    // single bell entry. Fire-and-forget — logged + swallowed on
    // failure, never surfaces to the caller.
    if (ownerUserId && ctx.tenantSlug) {
        const tenantSlug = ctx.tenantSlug;
        try {
            await runInTenantContext(ctx, (db) =>
                createAssignmentNotification(db, 'CONTROL_ASSIGNED', {
                    tenantId: ctx.tenantId,
                    assigneeUserId: ownerUserId,
                    entityId: id,
                    entityLabel: result.name ?? '(untitled)',
                    entityKey: result.code ?? null,
                    tenantSlug,
                }),
            );
        } catch (err) {
            logger.warn('failed to create control-assigned notification', {
                component: 'notifications',
                controlId: id,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }
    return result;
}

// ─── Cadence ───
// The manual `markControlTestCompleted` + `POST /test-completed` endpoint were
// removed — the identical control-state write (lastTested + nextDueAt) is
// performed automatically by `attestControlTested` on every completed
// test/check run (see control-test.ts), and no UI ever called the manual one.

// ─── Soft Delete / Restore / Purge ───

/** Bulk soft-delete controls selected in the table action bar. */
export async function bulkDeleteControl(ctx: RequestContext, controlIds: string[]) {
    assertCanAdmin(ctx);
    const outcome = await runInTenantContext(ctx, async (db) => {
        // Only tenant-owned, non-global rows come back — anything the tenant
        // doesn't own (foreign or global-library ids) is absent from `rows`.
        const rows = await ControlRepository.listByIds(db, ctx, controlIds);
        const ownedIds = new Set(rows.map((r) => r.id));
        // Per-id verdict so the caller can tell which ids were dropped rather
        // than silently reconciling a bare count against its selection.
        const results: Array<{ id: string; status: 'ok' | 'not_found' }> = controlIds.map((id) => ({
            id,
            status: ownedIds.has(id) ? 'ok' : 'not_found',
        }));
        if (rows.length > 0) {
            await db.control.deleteMany({ where: { id: { in: rows.map((r) => r.id) }, tenantId: ctx.tenantId } });
            for (const r of rows) {
                // Sequential by design — audit rows are hash-chained per tenant
                // (each entry hashes the previous entry's committed hash under a
                // per-tenant advisory lock; see events/audit.ts). No batch API
                // exists and parallelising would corrupt the chain ordering.
                await logEvent(db, ctx, {
                    action: 'SOFT_DELETE',
                    entityType: 'Control',
                    entityId: r.id,
                    details: 'Control soft-deleted (bulk)',
                    detailsJson: { category: 'entity_lifecycle', entityName: 'Control', operation: 'deleted', summary: 'Control soft-deleted' },
                });
            }
        }
        // `deleted` kept for backward compatibility with existing callers.
        return { results, deleted: rows.length };
    });
    // Was missing — without it the cached list served the deleted rows for the
    // full TTL. Mirrors the sibling bulk ops.
    await bumpEntityCacheVersion(ctx, 'control');
    return outcome;
}

export async function deleteControl(ctx: RequestContext, id: string) {
    assertCanAdmin(ctx);
    const result = await runInTenantContext(ctx, async (db) => {
        const control = await ControlRepository.getById(db, ctx, id);
        if (!control) throw notFound('Control not found');
        if (!control.tenantId) throw forbidden('Cannot delete global library controls');

        await db.control.delete({ where: { id } });

        await logEvent(db, ctx, {
            action: 'SOFT_DELETE',
            entityType: 'Control',
            entityId: id,
            details: `Control soft-deleted: ${control.code || control.name}`,
            detailsJson: { category: 'entity_lifecycle', entityName: 'Control', operation: 'deleted', summary: `Control soft-deleted: ${control.code || control.name}` },
        });
        return { success: true };
    });
    await bumpEntityCacheVersion(ctx, 'control');
    return result;
}

export async function restoreControl(ctx: RequestContext, id: string) {
    const result = await restoreEntity(ctx, 'Control', id);
    await bumpEntityCacheVersion(ctx, 'control');
    return result;
}

export async function purgeControl(ctx: RequestContext, id: string) {
    const result = await purgeEntity(ctx, 'Control', id);
    await bumpEntityCacheVersion(ctx, 'control');
    return result;
}

// ─── Bulk actions (canonical BulkActionBar rollout) ───

export async function bulkSetControlStatus(
    ctx: RequestContext,
    controlIds: string[],
    status:
        | 'NOT_STARTED'
        | 'PLANNED'
        | 'IN_PROGRESS'
        | 'IMPLEMENTING'
        | 'IMPLEMENTED'
        | 'NEEDS_REVIEW'
        | 'NOT_APPLICABLE',
) {
    assertCanUpdateControl(ctx);
    const outcome = await runInTenantContext(ctx, async (db) => {
        // Tenant-owned rows only — global library controls (tenantId NULL)
        // are silently excluded by the repo's tenantId filter.
        const rows = await ControlRepository.listByIds(db, ctx, controlIds);
        const ownedIds = new Set(rows.map((r) => r.id));
        const results: Array<{ id: string; status: 'ok' | 'not_found' }> = controlIds.map((id) => ({
            id,
            status: ownedIds.has(id) ? 'ok' : 'not_found',
        }));
        if (rows.length > 0) {
            await ControlRepository.bulkUpdate(db, ctx, controlIds, { status });
            for (const r of rows) {
                // Sequential — hash-chained audit trail (see events/audit.ts).
                await logEvent(db, ctx, {
                    action: 'CONTROL_STATUS_CHANGED',
                    entityType: 'Control',
                    entityId: r.id,
                    details: `Status changed: ${r.status} → ${status}`,
                    detailsJson: {
                        category: 'status_change',
                        entityName: 'Control',
                        fromStatus: r.status,
                        toStatus: status,
                    },
                });
            }
        }
        // `updated` kept for backward compatibility with existing callers.
        return { results, updated: rows.length };
    });
    await bumpEntityCacheVersion(ctx, 'control');
    return outcome;
}

export async function bulkAssignControl(
    ctx: RequestContext,
    controlIds: string[],
    ownerUserId: string | null,
) {
    assertCanUpdateControl(ctx);
    const outcome = await runInTenantContext(ctx, async (db) => {
        // Validate the assignee is an ACTIVE member of THIS tenant — the bulk
        // path previously wrote the owner FK with zero validation, so a
        // foreign or deactivated user id could be stamped onto every selected
        // control. Mirrors `setControlOwner` / `asset.ts::assertActiveOwner`.
        if (ownerUserId) {
            const member = await db.tenantMembership.findFirst({
                where: { tenantId: ctx.tenantId, userId: ownerUserId, status: 'ACTIVE' },
                select: { id: true },
            });
            if (!member) throw badRequest('Owner must be an active member of this tenant');
        }
        const rows = await ControlRepository.listByIds(db, ctx, controlIds);
        const ownedIds = new Set(rows.map((r) => r.id));
        const results: Array<{ id: string; status: 'ok' | 'not_found' }> = controlIds.map((id) => ({
            id,
            status: ownedIds.has(id) ? 'ok' : 'not_found',
        }));
        if (rows.length > 0) {
            await ControlRepository.bulkUpdate(db, ctx, controlIds, {
                ownerUserId: ownerUserId || null,
            });
            for (const r of rows) {
                // Sequential — hash-chained audit trail (see events/audit.ts).
                await logEvent(db, ctx, {
                    action: 'CONTROL_OWNER_CHANGED',
                    entityType: 'Control',
                    entityId: r.id,
                    details: `Owner set to: ${ownerUserId || 'none'}`,
                    detailsJson: {
                        category: 'entity_lifecycle',
                        entityName: 'Control',
                        operation: 'updated',
                        changedFields: ['ownerUserId'],
                        after: { ownerUserId: ownerUserId || null },
                        summary: ownerUserId ? `owner reassigned (bulk)` : `owner cleared (bulk)`,
                    },
                });
            }
        }
        // `updated` kept for backward compatibility with existing callers.
        return { results, updated: rows.length };
    });
    await bumpEntityCacheVersion(ctx, 'control');
    return outcome;
}
