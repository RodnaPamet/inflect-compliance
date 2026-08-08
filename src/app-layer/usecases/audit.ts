import { RequestContext } from '../types';
import { AuditRepository } from '../repositories/AuditRepository';
import { assertCanRead, assertCanWrite } from '../policies/common';
import { logEvent } from '../events/audit';
import { notFound, badRequest } from '@/lib/errors/types';
import { runInTenantContext, type PrismaTx } from '@/lib/db-context';
import { sanitizePlainText } from '@/lib/security/sanitize';
import type { AuditStatus } from '@prisma/client';
import { z } from 'zod';
import { UpdateAuditSchema } from '@/lib/schemas';
import { createFinding } from './finding';
import { createTask } from './task';

// Epic D.2 — preserve the three-state contract on update paths.
function sanitizeOptional(v: string | null | undefined): string | null | undefined {
    if (v === undefined) return undefined;
    if (v === null) return null;
    return sanitizePlainText(v);
}

// feat/audit-cycle-unify — provenance tag so a FAIL-raised finding is
// idempotent: the (sourceKind, sourceRef=checklistItemId) pair lets a
// FAIL → PASS → FAIL toggle reconcile to a single finding instead of
// spawning a duplicate on every re-transition.
const CHECKLIST_FINDING_SOURCE = 'AUDIT_CHECKLIST';

/**
 * feat/audit-cycle-unify — cascade a checklist item transitioning to
 * FAIL into a real connected lifecycle: a `Finding` (via the canonical
 * `createFinding` usecase) plus a remediation `Task` (via `createTask`).
 *
 * Idempotency is critical: a FAIL → PASS → FAIL toggle must NOT spawn a
 * second finding. We guard on the existing
 * (sourceKind='AUDIT_CHECKLIST', sourceRef=itemId) finding before
 * creating. `createFinding` / `createTask` open their own nested tenant
 * transactions (same pattern as control/test-plans.ts's FAIL → task cascade);
 * `db` here is only used for the pre-flight idempotency read.
 */
async function cascadeChecklistFailure(
    db: PrismaTx,
    ctx: RequestContext,
    params: { auditId: string; checklistItemId: string; prompt: string; notes: string | null | undefined },
): Promise<void> {
    const existing = await db.finding.findFirst({
        where: {
            tenantId: ctx.tenantId,
            sourceKind: CHECKLIST_FINDING_SOURCE,
            sourceRef: params.checklistItemId,
            deletedAt: null,
        },
        select: { id: true },
    });
    // Already materialised for this checklist item — a re-FAIL is a no-op.
    if (existing) return;

    // Truncate the prompt sensibly for the finding/task title.
    const shortPrompt = params.prompt.length > 120 ? `${params.prompt.slice(0, 117)}…` : params.prompt;
    const description = (params.notes && params.notes.trim())
        ? params.notes
        : `Audit checklist item failed: ${params.prompt}`;

    const finding = await createFinding(ctx, {
        auditId: params.auditId,
        severity: 'MEDIUM',
        type: 'NONCONFORMITY',
        title: shortPrompt,
        description,
        sourceKind: CHECKLIST_FINDING_SOURCE,
        sourceRef: params.checklistItemId,
    });

    // Remediation task — mirrors the vulnerability / control-test FAIL →
    // task pattern. The finding id rides metadataJson (there is no
    // FINDING TaskLinkEntityType). type=AUDIT_FINDING per the lifecycle;
    // validateTypeRelevance defers the control-link requirement to a
    // later status transition, so creation is unblocked here.
    await createTask(ctx, {
        title: `Remediate finding: ${shortPrompt}`,
        type: 'AUDIT_FINDING',
        description,
        severity: 'MEDIUM',
        source: 'AUDIT',
        // TP-3 — first-class FK to the Finding (reconciliation closes
        // it when this task terminates). metadataJson.findingId is kept
        // for back-compat with any reader that still consumes it.
        findingId: finding.id,
        metadataJson: {
            findingId: finding.id,
            auditId: params.auditId,
            checklistItemId: params.checklistItemId,
        },
    });
}

export async function listAudits(
    ctx: RequestContext,
    options: { take?: number; auditCycleId?: string } = {},
) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, (db) =>
        AuditRepository.list(db, ctx, options)
    );
}

export async function getAudit(ctx: RequestContext, id: string) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, async (db) => {
        const audit = await AuditRepository.getById(db, ctx, id);
        if (!audit) throw notFound('Audit not found');
        return audit;
    });
}

export async function createAudit(ctx: RequestContext, data: {
    title: string;
    scope?: string | null;
    criteria?: string | null;
    schedule?: string | null;
    auditors?: string | null;
    auditees?: string | null;
    departments?: string | null;
    /** B8 — optional `Framework.key` the audit assesses. Nullable for
     *  ad-hoc audits that span multiple frameworks. */
    frameworkKey?: string | null;
    /** feat/audit-cycle-unify — optional AuditCycle this fieldwork audit
     *  belongs to. Validated against the tenant. NULL = standalone audit. */
    auditCycleId?: string | null;
    generateChecklist?: boolean;
}) {
    assertCanWrite(ctx);

    return runInTenantContext(ctx, async (db) => {
        // feat/audit-cycle-unify — validate the cycle ref belongs to the
        // tenant (mirrors the finding/task ref-validation pattern). RLS
        // already blocks cross-tenant writes; this turns a silent no-op
        // into a clear 400 and stops an audit pointing at a foreign cycle.
        if (data.auditCycleId) {
            const cycle = await db.auditCycle.findFirst({
                where: { id: data.auditCycleId, tenantId: ctx.tenantId },
                select: { id: true },
            });
            if (!cycle) {
                throw badRequest('INVALID_AUDIT_CYCLE', 'Audit cycle not found or belongs to a different tenant');
            }
        }

        const audit = await AuditRepository.create(db, ctx, {
            auditCycleId: data.auditCycleId || null,
            // Epic D.2 — sanitise free-text before persistence.
            // `auditScope`, `criteria`, `auditors`, `auditees`,
            // `departments` are all encrypted in the manifest and
            // also surface in audit-log details + PDF exports.
            title: sanitizePlainText(data.title),
            auditScope: sanitizeOptional(data.scope),
            criteria: sanitizeOptional(data.criteria),
            schedule: data.schedule ? new Date(data.schedule) : null,
            auditors: sanitizeOptional(data.auditors),
            auditees: sanitizeOptional(data.auditees),
            departments: sanitizeOptional(data.departments),
            // B8 — frameworkKey is plain-text (the Framework.key
            // column itself is plain ASCII) — sanitise to strip any
            // injected HTML / control chars before persistence.
            frameworkKey: data.frameworkKey ? sanitizePlainText(data.frameworkKey) : null,
            status: 'PLANNED',
        });

        if (data.generateChecklist) {
            // The checklist must reflect the audit's SELECTED framework — an
            // OWASP audit gets OWASP clauses, an ISO 27001 audit gets ISO
            // clauses, etc. Derive the items from that framework's requirement
            // set (global catalogue, keyed by `Framework.key`). Only when the
            // audit has no framework (ad-hoc / multi-framework) do we fall
            // back to the tenant's controls so the checklist is never empty.
            let order = 0;

            if (audit.frameworkKey) {
                const framework = await db.framework.findFirst({
                    where: { key: audit.frameworkKey },
                    select: { id: true },
                });
                if (framework) {
                    const requirements = await db.frameworkRequirement.findMany({
                        where: { frameworkId: framework.id, deprecatedAt: null },
                        orderBy: { sortOrder: 'asc' },
                        take: 100,
                        select: { code: true, title: true },
                    });
                    for (const req of requirements) {
                        const label = req.title
                            ? `Verify ${req.code} — ${req.title}: confirm implementation and evidence`
                            : `Verify ${req.code}: confirm implementation and evidence`;
                        await AuditRepository.createChecklistItem(db, ctx, audit.id, label, order++);
                    }
                }
            }

            // Fallback: no framework selected, or the framework had no
            // requirements — seed from the tenant's controls instead.
            if (order === 0) {
                const controls = await db.control.findMany({
                    where: { OR: [{ tenantId: ctx.tenantId }, { tenantId: null }] },
                    take: 20,
                });
                for (const ctrl of controls.slice(0, 15)) {
                    const prompt = `Verify control "${ctrl.name}" (${ctrl.annexId || 'Custom'}): check implementation status and evidence`;
                    await AuditRepository.createChecklistItem(db, ctx, audit.id, prompt, order++);
                }
            }
        }

        await logEvent(db, ctx, {
            action: 'CREATE',
            entityType: 'Audit',
            entityId: audit.id,
            details: `Created audit: ${audit.title}`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'Audit',
                operation: 'created',
                after: { title: audit.title, status: 'PLANNED', generateChecklist: !!data.generateChecklist },
                summary: `Created audit: ${audit.title}`,
            },
        });

        return audit;
    });
}

export async function updateAudit(ctx: RequestContext, id: string, data: z.infer<typeof UpdateAuditSchema>) {
    assertCanWrite(ctx);

    return runInTenantContext(ctx, async (db) => {
        const audit = await AuditRepository.update(db, ctx, id, {
            // Epic D.2 — sanitise on update only when the field is
            // actually being written.
            title: sanitizeOptional(data.title) ?? undefined,
            auditScope: sanitizeOptional(data.scope),
            criteria: sanitizeOptional(data.criteria),

            status: data.status as AuditStatus | undefined,
            auditors: sanitizeOptional(data.auditors),
            auditees: sanitizeOptional(data.auditees),
        });

        if (!audit) throw notFound('Audit not found');

        if (data.checklistUpdates) {
            // feat/audit-cycle-unify — read the PRIOR result of every
            // item being touched so we can detect a genuine transition
            // INTO FAIL (was-not-FAIL → FAIL). A row already FAIL that is
            // re-saved must not re-cascade.
            const itemIds = data.checklistUpdates.map((u) => u.id);
            const priorItems = await db.auditChecklistItem.findMany({
                where: { id: { in: itemIds }, tenantId: ctx.tenantId },
                // `auditId` is load-bearing here: it is the ONLY trustworthy
                // source of the owning audit. The request's `id` (the URL
                // audit) must never be used to stamp the write or the
                // cascaded finding — a foreign checklist id would otherwise
                // mis-attribute the item's Finding to the wrong audit.
                select: { id: true, prompt: true, result: true, auditId: true },
            });
            const priorMap = new Map(priorItems.map((p) => [p.id, p]));

            for (const item of data.checklistUpdates) {
                const prior = priorMap.get(item.id);
                // Reconcile every attacker-supplied id against the
                // tenant-filtered priorMap. An id that isn't a known item
                // for this tenant (foreign / nonexistent) is skipped — never
                // blindly written.
                if (!prior) continue;

                await AuditRepository.updateChecklistItem(db, ctx, item.id, prior.auditId, {
                    // `result` is enum-shaped; do NOT sanitise.
                    result: item.result,
                    // `notes` is encrypted on AuditChecklistItem.notes
                    // and free-text — sanitise per element.
                    notes: typeof item.notes === 'string'
                        ? sanitizePlainText(item.notes)
                        : item.notes,
                });

                // FAIL cascade: only on a real transition INTO FAIL. The
                // finding is stamped with the item's OWN auditId (from the
                // prior row), never the request's `id`.
                if (
                    item.result === 'FAIL' &&
                    prior.result !== 'FAIL'
                ) {
                    await cascadeChecklistFailure(db, ctx, {
                        auditId: prior.auditId,
                        checklistItemId: item.id,
                        prompt: prior.prompt,
                        notes: typeof item.notes === 'string' ? sanitizePlainText(item.notes) : item.notes,
                    });
                }
            }
        }

        await logEvent(db, ctx, {
            action: 'UPDATE',
            entityType: 'Audit',
            entityId: id,
            details: JSON.stringify(data),
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'Audit',
                operation: 'updated',
                changedFields: Object.keys(data).filter(k => data[k as keyof typeof data] !== undefined),
                summary: 'Audit updated',
            },
        });

        return audit;
    });
}
