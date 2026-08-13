import { z } from 'zod';
import { RequestContext } from '../types';
import { VendorRepository, VendorDocumentRepository, VendorLinkRepository, VendorFilters, VendorListParams } from '../repositories/VendorRepository';
import { QuestionnaireRepository, VendorAssessmentRepository } from '../repositories/AssessmentRepository';
import { assertCanReadVendors, assertCanManageVendors, assertCanManageVendorDocs } from '../policies/vendor.policies';
import { assertCanAdmin } from '../policies/common';
import {
    assertTargetInTenant,
    assertOwnerInTenant,
    assertFileInTenant,
} from './vendor-link-targets';
import { logEvent } from '../events/audit';
import { runInTenantContext, runInTenantReadContext, type PrismaTx } from '@/lib/db-context';
import { notFound, badRequest } from '@/lib/errors/types';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { CreateVendorSchema } from '@/lib/schemas';
import { bumpEntityCacheVersion } from '@/lib/cache/list-cache';

// Epic D.2 — preserve the three-state contract on update paths.
function sanitizeOptional(v: string | null | undefined): string | null | undefined {
    if (v === undefined) return undefined;
    if (v === null) return null;
    return sanitizePlainText(v);
}

// Epic D.2 — list of free-text Vendor columns the loose-typed
// `updateVendor` patch may carry. Anything not in this list is left
// untouched (enums, foreign keys, dates, JSON, arrays of non-strings).
const FREE_TEXT_VENDOR_FIELDS = [
    'name',
    'legalName',
    'country',
    'domain',
    'websiteUrl',
    'description',
] as const;

// ─── Vendor CRUD ───

export async function listVendors(
    ctx: RequestContext,
    filters: VendorFilters = {},
    options: { take?: number } = {},
) {
    assertCanReadVendors(ctx);
    return runInTenantContext(ctx, (db) => VendorRepository.list(db, ctx, filters, options));
}

/**
 * DORA Register of Information (Art. 28(3)) — the tenant's ICT
 * third-party arrangements, projected from the vendor inventory.
 *
 * Gated by the same vendor-read permission every other vendor read
 * uses: the register is a VIEW of vendors, not a separate asset class,
 * so it must not become a side door to vendor data for a role that
 * cannot read `/vendors`.
 */
export async function listInformationRegister(ctx: RequestContext) {
    assertCanReadVendors(ctx);
    return runInTenantContext(ctx, (db) => VendorRepository.listInformationRegister(db, ctx));
}

export async function listVendorsPaginated(ctx: RequestContext, params: VendorListParams) {
    assertCanReadVendors(ctx);
    return runInTenantContext(ctx, (db) => VendorRepository.listPaginated(db, ctx, params));
}

export async function getVendor(ctx: RequestContext, vendorId: string) {
    assertCanReadVendors(ctx);
    return runInTenantContext(ctx, async (db) => {
        const vendor = await VendorRepository.getById(db, ctx, vendorId);
        if (!vendor) throw notFound('Vendor not found');
        return vendor;
    });
}

export async function createVendor(ctx: RequestContext, input: z.infer<typeof CreateVendorSchema>) {
    assertCanManageVendors(ctx);
    // Epic D.2 — sanitise every free-text column. Enums + booleans +
    // FK ids pass through untouched.
    const sanitisedInput = {
        ...input,
        name: sanitizePlainText(input.name),
        legalName: input.legalName ? sanitizePlainText(input.legalName) : input.legalName,
        country: input.country ? sanitizePlainText(input.country) : input.country,
        domain: input.domain ? sanitizePlainText(input.domain) : input.domain,
        websiteUrl: input.websiteUrl ? sanitizePlainText(input.websiteUrl) : input.websiteUrl,
        description: input.description ? sanitizePlainText(input.description) : input.description,
        tags: input.tags?.map((t) => sanitizePlainText(t)),
    };
    const result = await runInTenantContext(ctx, async (db) => {
        // ownerUserId is a caller-supplied id written verbatim — verify it
        // belongs to an ACTIVE member of THIS tenant before it lands.
        if (sanitisedInput.ownerUserId) {
            await assertOwnerInTenant(db, ctx, sanitisedInput.ownerUserId);
        }
        const vendor = await VendorRepository.create(db, ctx, sanitisedInput);
        await logEvent(db, ctx, {
            action: 'VENDOR_CREATED',
            entityType: 'Vendor',
            entityId: vendor.id,
            details: `Vendor "${vendor.name}" created`,
            detailsJson: { category: 'entity_lifecycle', entityName: 'Vendor', operation: 'created', after: { name: vendor.name, status: vendor.status, criticality: vendor.criticality }, summary: `Vendor "${vendor.name}" created` },
            metadata: { name: vendor.name, status: vendor.status, criticality: vendor.criticality },
        });
        return vendor;
    });
    await bumpEntityCacheVersion(ctx, 'vendor');
    return result;
}

export async function updateVendor(ctx: RequestContext, vendorId: string, patch: Record<string, unknown>) {
    assertCanManageVendors(ctx);
    // Epic D.2 — sanitise the loose-typed patch one key at a time.
    // Enums, ids, dates, and structured JSON pass through unchanged
    // because they don't satisfy `typeof === 'string'`.
    const sanitisedPatch: Record<string, unknown> = { ...patch };
    for (const key of FREE_TEXT_VENDOR_FIELDS) {
        if (typeof sanitisedPatch[key] === 'string') {
            sanitisedPatch[key] = sanitizePlainText(sanitisedPatch[key] as string);
        }
    }
    if (Array.isArray(sanitisedPatch.tags)) {
        sanitisedPatch.tags = (sanitisedPatch.tags as unknown[]).map((t) =>
            typeof t === 'string' ? sanitizePlainText(t) : t,
        );
    }
    const result = await runInTenantContext(ctx, async (db) => {
        if (typeof sanitisedPatch.ownerUserId === 'string' && sanitisedPatch.ownerUserId) {
            await assertOwnerInTenant(db, ctx, sanitisedPatch.ownerUserId);
        }
        let previousStatus: string | null = null;
        if (patch.status) {
            // Activation gate applies on the edit path too — a vendor must not
            // be flipped to ACTIVE via the edit form without a completed
            // assessment review. Routes through the single gate implementation
            // (assertVendorActivationAllowed).
            const current = await db.vendor.findFirst({
                where: { id: vendorId, tenantId: ctx.tenantId },
                include: { assessments: { orderBy: { createdAt: 'desc' }, take: 1 } },
            });
            if (!current) throw notFound('Vendor not found');
            previousStatus = current.status;
            assertVendorActivationAllowed(patch.status as string, current.status, current.assessments[0]);
        }
        const vendor = await VendorRepository.update(db, ctx, vendorId, sanitisedPatch);
        if (!vendor) throw notFound('Vendor not found');

        const action = patch.status && patch.status !== previousStatus ? 'VENDOR_STATUS_CHANGED' : 'VENDOR_UPDATED';
        await logEvent(db, ctx, {
            action,
            entityType: 'Vendor',
            entityId: vendor.id,
            details: `Vendor "${vendor.name}" updated`,
            detailsJson: action === 'VENDOR_STATUS_CHANGED' ? { category: 'status_change', entityName: 'Vendor', fromStatus: previousStatus, toStatus: patch.status as string } : { category: 'entity_lifecycle', entityName: 'Vendor', operation: 'updated', changedFields: Object.keys(patch), summary: `Vendor "${vendor.name}" updated` },
            metadata: { fields: Object.keys(patch) },
        });
        return vendor;
    });
    await bumpEntityCacheVersion(ctx, 'vendor');
    return result;
}

// ─── Vendor Documents ───

export async function listVendorDocuments(ctx: RequestContext, vendorId: string) {
    assertCanReadVendors(ctx);
    return runInTenantContext(ctx, (db) => VendorDocumentRepository.listByVendor(db, ctx, vendorId));
}

export async function addVendorDocument(ctx: RequestContext, vendorId: string, docInput: {
    type: string;
    title?: string | null;
    fileId?: string | null;
    externalUrl?: string | null;
    validFrom?: string | null;
    validTo?: string | null;
    notes?: string | null;
    folder?: string | null;
}) {
    assertCanManageVendorDocs(ctx);
    // Epic D.2 — sanitise the free-text columns before persistence.
    // `notes` is encrypted at rest (manifest); sanitisation closes the
    // downstream-renderer integrity gap. `folder` is plain-text and
    // user-supplied so sanitised the same way.
    const sanitisedDoc = {
        ...docInput,
        title: sanitizeOptional(docInput.title) as string | null | undefined,
        externalUrl: sanitizeOptional(docInput.externalUrl) as string | null | undefined,
        notes: sanitizeOptional(docInput.notes) as string | null | undefined,
        folder: sanitizeOptional(docInput.folder) as string | null | undefined,
    };
    const result = await runInTenantContext(ctx, async (db) => {
        // fileId feeds the document text-extraction path, which reads the
        // object out of storage — an unchecked id here is the front half of
        // a cross-tenant file read.
        if (sanitisedDoc.fileId) {
            await assertFileInTenant(db, ctx, sanitisedDoc.fileId);
        }
        const doc = await VendorDocumentRepository.create(db, ctx, vendorId, sanitisedDoc);
        await logEvent(db, ctx, {
            action: 'VENDOR_DOCUMENT_ADDED',
            entityType: 'Vendor',
            entityId: vendorId,
            details: `Document "${doc.title || doc.type}" added to vendor`,
            detailsJson: { category: 'relationship', operation: 'linked', sourceEntity: 'Vendor', sourceId: vendorId, targetEntity: 'VendorDocument', targetId: doc.id, relation: doc.type },
            metadata: { docId: doc.id, type: doc.type },
        });
        return doc;
    });
    await bumpEntityCacheVersion(ctx, 'vendor');
    return result;
}

export async function removeVendorDocument(
    ctx: RequestContext,
    docId: string,
    /**
     * The vendor the URL claims this document belongs to.
     *
     * Optional for the moment so existing non-route callers keep working,
     * but the route passes it. Without it the child was resolved by
     * (id, tenantId) alone, so a document belonging to vendor A was
     * reachable — and deletable — at /vendors/B/documents/{id}. Tenant
     * scoping held, so this was never a cross-tenant breach; it was the URL
     * naming one parent while the operation acted on another, which is how
     * an audit trail ends up attributing a deletion to the wrong vendor.
     */
    vendorId?: string,
) {
    assertCanManageVendorDocs(ctx);
    const result = await runInTenantContext(ctx, async (db) => {
        if (vendorId) {
            const owned = await db.vendorDocument.findFirst({
                where: { id: docId, vendorId, tenantId: ctx.tenantId },
                select: { id: true },
            });
            if (!owned) throw notFound('Document not found');
        }
        const doc = await VendorDocumentRepository.deleteById(db, ctx, docId);
        if (!doc) throw notFound('Document not found');
        await logEvent(db, ctx, {
            action: 'VENDOR_DOCUMENT_REMOVED',
            entityType: 'Vendor',
            entityId: doc.vendorId,
            details: `Document "${doc.title || doc.type}" removed`,
            detailsJson: { category: 'relationship', operation: 'unlinked', sourceEntity: 'Vendor', sourceId: doc.vendorId, targetEntity: 'VendorDocument', targetId: doc.id },
            metadata: { docId: doc.id },
        });
        return doc;
    });
    await bumpEntityCacheVersion(ctx, 'vendor');
    return result;
}

// ─── Vendor Assessments ───

export async function getVendorAssessment(ctx: RequestContext, assessmentId: string) {
    assertCanReadVendors(ctx);
    return runInTenantContext(ctx, async (db) => {
        const assessment = await VendorAssessmentRepository.getById(db, ctx, assessmentId);
        if (!assessment) throw notFound('Assessment not found');
        return assessment;
    });
}

// ─── Questionnaire Templates ───

export async function listQuestionnaireTemplates(ctx: RequestContext) {
    assertCanReadVendors(ctx);
    return runInTenantContext(ctx, (db) => QuestionnaireRepository.listTemplates(db));
}

export async function getQuestionnaireTemplate(ctx: RequestContext, templateKey: string) {
    assertCanReadVendors(ctx);
    return runInTenantContext(ctx, async (db) => {
        const template = await QuestionnaireRepository.getByKey(db, templateKey);
        if (!template) throw notFound('Template not found');
        return template;
    });
}

// ─── Vendor Review Dates ───

export async function setVendorReviewDates(ctx: RequestContext, vendorId: string, dates: { nextReviewAt?: string | null; contractRenewalAt?: string | null }) {
    assertCanManageVendors(ctx);
    const result = await runInTenantContext(ctx, async (db) => {
        const vendor = await VendorRepository.update(db, ctx, vendorId, dates);
        if (!vendor) throw notFound('Vendor not found');
        await logEvent(db, ctx, {
            action: 'VENDOR_UPDATED',
            entityType: 'Vendor',
            entityId: vendor.id,
            details: 'Vendor review dates updated',
            detailsJson: { category: 'entity_lifecycle', entityName: 'Vendor', operation: 'updated', changedFields: Object.keys(dates), after: dates, summary: 'Vendor review dates updated' },
            metadata: { nextReviewAt: dates.nextReviewAt, contractRenewalAt: dates.contractRenewalAt },
        });
        return vendor;
    });
    await bumpEntityCacheVersion(ctx, 'vendor');
    return result;
}

// ─── Vendor Links ───

export async function listVendorLinks(ctx: RequestContext, vendorId: string) {
    assertCanReadVendors(ctx);
    return runInTenantContext(ctx, async (db) => {
        const links = await VendorLinkRepository.listByVendor(db, ctx, vendorId);
        // Hydrate each link with its target entity's display name so the UI
        // renders a named hyperlink instead of a raw cuid. Batched per type
        // (one query per entityType present) — no N+1.
        const names = await resolveLinkedEntityNames(db, ctx, links);
        return links.map((l) => ({
            ...l,
            entityName: names.get(`${l.entityType}:${l.entityId}`) ?? null,
        }));
    });
}

/**
 * Resolve the display name of each (entityType, entityId) pair referenced by
 * a set of vendor links. RISK/ISSUE carry `title`, CONTROL/ASSET carry
 * `name`; ISSUE ids are Task ids (issues redirect to tasks). One query per
 * distinct entityType.
 */
async function resolveLinkedEntityNames(
    db: PrismaTx,
    ctx: RequestContext,
    links: { entityType: string; entityId: string }[],
): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const byType = new Map<string, string[]>();
    for (const l of links) {
        const arr = byType.get(l.entityType) ?? [];
        arr.push(l.entityId);
        byType.set(l.entityType, arr);
    }
    const where = (ids: string[]) => ({ tenantId: ctx.tenantId, id: { in: ids } });
    // Bounded to ≤4 entityType iterations (RISK/CONTROL/ASSET/ISSUE), each a
    // SINGLE batched findMany({ id: { in: ids } }); round-trips are capped at
    // the number of distinct entity types, not the number of links.
    for (const [type, ids] of byType) { // guardrail-allow: n+1 — batched per-type, ≤4 iterations
        if (type === 'RISK') {
            for (const r of await db.risk.findMany({ where: where(ids), select: { id: true, title: true } }))
                out.set(`RISK:${r.id}`, r.title);
        } else if (type === 'CONTROL') {
            for (const c of await db.control.findMany({ where: where(ids), select: { id: true, name: true } }))
                out.set(`CONTROL:${c.id}`, c.name);
        } else if (type === 'ASSET') {
            for (const a of await db.asset.findMany({ where: where(ids), select: { id: true, name: true } }))
                out.set(`ASSET:${a.id}`, a.name);
        } else if (type === 'ISSUE') {
            for (const t of await db.task.findMany({ where: where(ids), select: { id: true, title: true } }))
                out.set(`ISSUE:${t.id}`, t.title);
        }
    }
    return out;
}

/**
 * Reverse "where-used": the vendors linked to a given entity. Powers the
 * LinkedVendorsPanel on the Risk / Control / Asset / Task detail pages.
 */
export async function listVendorsLinkedToEntity(
    ctx: RequestContext,
    entityType: string,
    entityId: string,
): Promise<{ vendorId: string; vendorName: string; relation: string; linkId: string }[]> {
    assertCanReadVendors(ctx);
    return runInTenantContext(ctx, async (db) => {
        const links = await VendorLinkRepository.listByEntity(db, ctx, entityType, entityId);
        return links.map((l) => ({
            linkId: l.id,
            vendorId: l.vendorId,
            vendorName: l.vendor?.name ?? l.vendorId,
            relation: l.relation,
        }));
    });
}

export async function addVendorLink(ctx: RequestContext, vendorId: string, data: {
    entityType: string;
    entityId: string;
    relation?: string;
}) {
    assertCanManageVendors(ctx);
    const result = await runInTenantContext(ctx, async (db) => {
        // The link row is written with ctx.tenantId, so RLS is satisfied
        // either way — but nothing checked the id it POINTS AT. A foreign
        // entityId persisted happily and then rendered as a dangling
        // reference, because RLS hides the target from every later read.
        await assertTargetInTenant(db, ctx, data.entityType, data.entityId);
        const link = await VendorLinkRepository.create(db, ctx, vendorId, data);
        await logEvent(db, ctx, {
            action: 'VENDOR_LINK_ADDED',
            entityType: 'Vendor',
            entityId: vendorId,
            details: `Linked ${data.entityType} ${data.entityId} as ${data.relation || 'RELATED'}`,
            detailsJson: { category: 'relationship', operation: 'linked', sourceEntity: 'Vendor', sourceId: vendorId, targetEntity: data.entityType, targetId: data.entityId, relation: data.relation || 'RELATED' },
            metadata: { linkId: link.id, entityType: data.entityType, entityId: data.entityId },
        });
        return link;
    });
    await bumpEntityCacheVersion(ctx, 'vendor');
    return result;
}

export async function removeVendorLink(
    ctx: RequestContext,
    linkId: string,
    /** The vendor the URL claims this link belongs to — see removeVendorDocument. */
    vendorId?: string,
) {
    assertCanManageVendors(ctx);
    const result = await runInTenantContext(ctx, async (db) => {
        if (vendorId) {
            const owned = await db.vendorLink.findFirst({
                where: { id: linkId, vendorId, tenantId: ctx.tenantId },
                select: { id: true },
            });
            if (!owned) throw notFound('Link not found');
        }
        const link = await VendorLinkRepository.deleteById(db, ctx, linkId);
        if (!link) throw notFound('Link not found');
        return link;
    });
    await bumpEntityCacheVersion(ctx, 'vendor');
    return result;
}

// ─── Vendor Enrichment ───

import { getEnrichmentProvider } from '../services/vendor-enrichment';

export async function enrichVendor(ctx: RequestContext, vendorId: string) {
    assertCanManageVendors(ctx);
    // Records that the attempt failed, so the stamp can be written AFTER the
    // transaction has rolled back rather than inside it. See the note on the
    // catch block below.
    let attemptFailed = false;
    const result = await runInTenantContext(ctx, async (db) => {
        const vendor = await db.vendor.findFirst({ where: { id: vendorId, tenantId: ctx.tenantId } });
        if (!vendor) throw notFound('Vendor not found');

        const domain = vendor.domain || (vendor.websiteUrl ? new URL(vendor.websiteUrl).hostname : null);
        if (!domain) throw badRequest('Vendor has no domain or website URL for enrichment');

        // Mark as pending
        await db.vendor.update({ where: { id: vendorId }, data: { enrichmentStatus: 'PENDING' } });

        try {
            const provider = getEnrichmentProvider();
            const result = await provider.enrich(domain);

            const updated = await db.vendor.update({
                where: { id: vendorId },
                data: {
                    ...(result.companyName && !vendor.legalName && { legalName: result.companyName }),
                    ...(result.country && !vendor.country && { country: result.country }),
                    ...(result.privacyPolicyUrl && { privacyPolicyUrl: result.privacyPolicyUrl }),
                    ...(result.securityPageUrl && { securityPageUrl: result.securityPageUrl }),
                    ...(result.certifications && { certificationsJson: result.certifications }),
                    ...(result.description && !vendor.description && { description: result.description }),
                    enrichmentLastRunAt: new Date(),
                    enrichmentStatus: 'SUCCESS',
                },
            });

            await logEvent(db, ctx, {
                action: 'VENDOR_ENRICHED',
                entityType: 'Vendor',
                entityId: vendorId,
                details: `Vendor enriched via ${provider.name}`,
                detailsJson: { category: 'custom', event: 'vendor_enriched', provider: provider.name, enrichedFields: Object.keys(result).filter(k => (result as Record<string, unknown>)[k]) },
                metadata: { provider: provider.name, fields: Object.keys(result).filter(k => (result as Record<string, unknown>)[k]) },
            });

            return updated;
        } catch (err: unknown) {
            // The FAILED stamp CANNOT be written here. runInTenantContext
            // opens a transaction, and rethrowing rolls the whole thing back
            // — so this write, and the PENDING write above it, were both
            // discarded. A failed enrichment left no trace at all: the status
            // reverted to whatever it was before and enrichmentLastRunAt was
            // never advanced, so an operator could not tell an attempt had
            // been made, let alone that it failed. Stamp it after the
            // rollback instead.
            attemptFailed = true;
            throw err;
        }
    }).catch(async (err: unknown) => {
        if (attemptFailed) {
            // Best-effort and deliberately swallowed: the caller is about to
            // receive the original enrichment error, and losing the status
            // stamp must not replace it with a less useful one.
            await runInTenantContext(ctx, (db) =>
                db.vendor.update({
                    where: { id: vendorId, tenantId: ctx.tenantId },
                    data: {
                        enrichmentStatus: 'FAILED',
                        enrichmentLastRunAt: new Date(),
                    },
                }),
            ).catch(() => undefined);
        }
        throw err;
    });
    await bumpEntityCacheVersion(ctx, 'vendor');
    return result;
}

// ─── Vendor Metrics (Dashboard) ───

export async function getVendorMetrics(ctx: RequestContext) {
    assertCanReadVendors(ctx);
    return runInTenantReadContext(ctx, async (db) => {
        const now = new Date();
        const in30 = new Date(now.getTime() + 30 * 86400000);
        // Reassessment cadence: an ACTIVE vendor should be re-assessed at
        // least yearly. "Overdue reassessment" is genuinely distinct from
        // "overdue review" (nextReviewAt, the manual review-cadence date) —
        // it's driven by lastAssessmentReviewedAt (stamped by the G-3 review
        // flow), so the two dashboard tiles no longer show the same number.
        const reassessCutoff = new Date(now.getTime() - 365 * 86400000);

        // Bounded. This pulls the tenant's vendors with their latest
        // assessment and then loops the whole set in memory to derive the
        // dashboard tiles, so an unbounded read is both the query cost and
        // the heap cost. 5000 is far above any realistic vendor register
        // while keeping the worst case finite.
        const vendors = await db.vendor.findMany({
            take: 5000,
            where: { tenantId: ctx.tenantId },
            include: { assessments: { orderBy: { createdAt: 'desc' }, take: 1 } },
        });

        const byCriticality: Record<string, number> = {};
        const byStatus: Record<string, number> = {};
        const byRiskRating: Record<string, number> = {};
        let overdueReview = 0;
        let upcomingReview = 0;
        let overdueRenewal = 0;
        let upcomingRenewal = 0;
        let highRiskNoAssessment = 0;
        let overdueReassessment = 0;

        for (const v of vendors) {
            byCriticality[v.criticality] = (byCriticality[v.criticality] || 0) + 1;
            byStatus[v.status] = (byStatus[v.status] || 0) + 1;

            const latestAssessment = v.assessments[0];
            if (latestAssessment?.riskRating) {
                byRiskRating[latestAssessment.riskRating] = (byRiskRating[latestAssessment.riskRating] || 0) + 1;
            }

            if (v.nextReviewAt && v.nextReviewAt < now) overdueReview++;
            else if (v.nextReviewAt && v.nextReviewAt <= in30) upcomingReview++;

            if (v.contractRenewalAt && v.contractRenewalAt < now) overdueRenewal++;
            else if (v.contractRenewalAt && v.contractRenewalAt <= in30) upcomingRenewal++;

            // High-criticality vendor whose latest assessment is NOT a
            // completed review (no assessment, or still SENT/IN_PROGRESS/
            // SUBMITTED). Previously keyed on the legacy APPROVED status, so
            // G-3 REVIEWED/CLOSED vendors were mis-counted here forever.
            if (['HIGH', 'CRITICAL'].includes(v.criticality)
                && (!latestAssessment || !COMPLETED_ASSESSMENT_STATUSES.has(latestAssessment.status))) {
                highRiskNoAssessment++;
            }

            // Active vendor never assessment-reviewed, or reviewed > 1y ago.
            if (v.status === 'ACTIVE'
                && (!v.lastAssessmentReviewedAt || v.lastAssessmentReviewedAt < reassessCutoff)) {
                overdueReassessment++;
            }
        }

        // Expiring docs in 30 days
        const expiringDocs = await db.vendorDocument.count({
            where: { tenantId: ctx.tenantId, validTo: { gte: now, lte: in30 } },
        });

        // ── Continuous-monitoring signals ──
        // Vendors whose parsed SOC 2 / cert attestation has already expired
        // (distinct vendors with a dated report period in the past).
        const expiredAttestationRows = await db.vendorDocExtraction.findMany({
            where: { tenantId: ctx.tenantId, auditPeriodEnd: { lt: now } },
            select: { vendorId: true },
            distinct: ['vendorId'],
            take: 5000,
        });
        // Vendors with a breach detected by the monitor in the last 90 days.
        const in90ago = new Date(now.getTime() - 90 * 86400000);
        const recentBreachRows = await db.vendorPostureEvent.findMany({
            where: { tenantId: ctx.tenantId, eventType: 'BREACH_DETECTED', occurredAt: { gte: in90ago } },
            select: { vendorId: true },
            distinct: ['vendorId'],
            take: 5000,
        });

        return {
            totalVendors: vendors.length,
            byCriticality,
            byStatus,
            byRiskRating,
            overdueReview,
            upcomingReview,
            overdueRenewal,
            upcomingRenewal,
            highRiskNoAssessment,
            expiringDocuments: expiringDocs,
            // Continuous-monitoring dashboard signals.
            expiredAttestations: expiredAttestationRows.length,
            recentBreachActivity: recentBreachRows.length,
            overdueReassessment,
        };
    });
}

// ─── Workflow: Status with Approval Gate ───

// A vendor's risk is "assessed" once its latest assessment reaches a COMPLETED
// review state. G-3 assessments terminate at REVIEWED/CLOSED; APPROVED is the
// legacy World-A terminal. The old gate keyed on APPROVED only, which a G-3
// assessment can NEVER satisfy — so it was unsatisfiable (and dead: no route
// called it). These two predicates are the single source of truth for the
// activation gate + the highRiskNoAssessment metric.
const COMPLETED_ASSESSMENT_STATUSES = new Set(['REVIEWED', 'CLOSED', 'APPROVED']);

/** A completed review carrying a risk rating — the bar for activation. */
function isActivationEligible(
    latest: { status: string; riskRating: string | null } | undefined | null,
): boolean {
    return !!latest && COMPLETED_ASSESSMENT_STATUSES.has(latest.status) && latest.riskRating != null;
}

const ACTIVATION_GATE_MESSAGE =
    'Cannot activate vendor without a completed assessment review. Send an assessment and complete its review (REVIEWED/CLOSED) first.';

/**
 * PR-T — the ONE activation-gate implementation. Throws when a vendor would be
 * flipped to ACTIVE without a completed assessment review. Every throwing gate
 * site (the edit path `updateVendor`) routes through this; `bulkSetVendorStatus`
 * uses the shared `isActivationEligible` predicate directly because it collects +
 * reports blocked vendors instead of throwing. The dead standalone
 * `updateVendorStatusWithGate` (which duplicated this check) was removed.
 */
function assertVendorActivationAllowed(
    newStatus: string,
    currentStatus: string,
    latest: { status: string; riskRating: string | null } | undefined | null,
): void {
    if (newStatus === 'ACTIVE' && currentStatus !== 'ACTIVE' && !isActivationEligible(latest)) {
        throw badRequest(ACTIVATION_GATE_MESSAGE);
    }
}

// ─── Bulk actions (canonical BulkActionBar rollout) ───

export async function bulkSetVendorStatus(
    ctx: RequestContext,
    vendorIds: string[],
    status: 'ACTIVE' | 'ONBOARDING' | 'OFFBOARDING' | 'OFFBOARDED',
) {
    assertCanManageVendors(ctx);
    const outcome = await runInTenantContext(ctx, async (db) => {
        const rows = await db.vendor.findMany({
            where: { id: { in: vendorIds }, tenantId: ctx.tenantId },
            include: { assessments: { orderBy: { createdAt: 'desc' }, take: 1 } },
        });
        if (rows.length === 0) return { updated: 0, blocked: [] as { id: string; name: string }[] };

        // Activation gate applies to bulk too — only vendors with a completed
        // assessment review may be bulk-activated. Vendors that fail the gate
        // are skipped and reported (not silently ignored, not a hard failure
        // for the whole batch). Other status transitions are ungated.
        const blocked: { id: string; name: string }[] = [];
        const eligible = status !== 'ACTIVE'
            ? rows
            : rows.filter((r) => {
                if (r.status === 'ACTIVE' || isActivationEligible(r.assessments[0])) return true;
                blocked.push({ id: r.id, name: r.name });
                return false;
            });

        if (eligible.length > 0) {
            await VendorRepository.bulkUpdate(db, ctx, eligible.map((r) => r.id), { status });
            for (const r of eligible) {
                await logEvent(db, ctx, {
                    action: 'VENDOR_STATUS_CHANGED',
                    entityType: 'Vendor',
                    entityId: r.id,
                    details: `Vendor "${r.name}" status set to ${status}`,
                    detailsJson: {
                        category: 'status_change',
                        entityName: 'Vendor',
                        fromStatus: r.status,
                        toStatus: status,
                    },
                });
            }
        }
        return { updated: eligible.length, blocked };
    });
    await bumpEntityCacheVersion(ctx, 'vendor');
    return outcome;
}

/** Bulk soft-delete vendors selected in the table action bar. */
export async function bulkDeleteVendor(ctx: RequestContext, vendorIds: string[]) {
    // Deleting the vendor register in bulk is an ADMIN action, matching every
    // peer register (risk / control / asset / policy / test plan). This was
    // `assertCanManageVendors` — the same EDITOR-level gate as bulk set-status
    // and bulk assign — so an EDITOR could soft-delete 100 vendors at a time
    // here while being refused the identical action on every other surface.
    // Found by the bounded admin-gate assertion added to
    // `tests/guards/bulk-actions-rollout.test.ts`; the previous whole-file
    // regex could not see it, because the two recoverable verbs in this same
    // file satisfied the check on this one's behalf.
    assertCanAdmin(ctx);
    return runInTenantContext(ctx, async (db) => {
        const rows = await VendorRepository.listByIds(db, ctx, vendorIds);
        if (rows.length === 0) return { deleted: 0 };
        await db.vendor.deleteMany({ where: { id: { in: rows.map((r) => r.id) }, tenantId: ctx.tenantId } });
        for (const r of rows) {
            await logEvent(db, ctx, {
                action: 'SOFT_DELETE',
                entityType: 'Vendor',
                entityId: r.id,
                details: 'Vendor soft-deleted (bulk)',
                detailsJson: { category: 'entity_lifecycle', entityName: 'Vendor', operation: 'deleted', summary: 'Vendor soft-deleted' },
            });
        }
        return { deleted: rows.length };
    });
}

export async function bulkAssignVendor(
    ctx: RequestContext,
    vendorIds: string[],
    ownerUserId: string | null,
) {
    assertCanManageVendors(ctx);
    const updated = await runInTenantContext(ctx, async (db) => {
        // Clearing the owner (null) is always allowed; assigning one is not
        // — the target must be an ACTIVE member of THIS tenant.
        if (ownerUserId) await assertOwnerInTenant(db, ctx, ownerUserId);
        const rows = await VendorRepository.listByIds(db, ctx, vendorIds);
        if (rows.length === 0) return 0;
        await VendorRepository.bulkUpdate(db, ctx, vendorIds, {
            ownerUserId: ownerUserId || null,
        });
        for (const r of rows) {
            await logEvent(db, ctx, {
                action: 'VENDOR_UPDATED',
                entityType: 'Vendor',
                entityId: r.id,
                details: ownerUserId
                    ? `Vendor "${r.name}" owner reassigned`
                    : `Vendor "${r.name}" owner cleared`,
                detailsJson: {
                    category: 'entity_lifecycle',
                    entityName: 'Vendor',
                    operation: 'updated',
                    changedFields: ['ownerUserId'],
                    after: { ownerUserId: ownerUserId || null },
                    summary: ownerUserId ? `owner reassigned (bulk)` : `owner cleared (bulk)`,
                },
            });
        }
        return rows.length;
    });
    await bumpEntityCacheVersion(ctx, 'vendor');
    return { updated };
}
