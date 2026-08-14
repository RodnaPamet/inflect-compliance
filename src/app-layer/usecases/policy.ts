import { Prisma } from '@prisma/client';
import { RequestContext } from '../types';
import { PolicyRepository, PolicyFilters, PolicyListParams } from '../repositories/PolicyRepository';
import { PolicyVersionRepository } from '../repositories/PolicyVersionRepository';
import { PolicyApprovalRepository } from '../repositories/PolicyApprovalRepository';
import { PolicyTemplateRepository } from '../repositories/PolicyTemplateRepository';
import {
    assertCanReadPolicies,
    assertCanCreatePolicy,
    assertCanWritePolicies,
    assertCanApprovePolicies,
    assertCanAdminPolicies,
} from '../policies/policy.policies';
import { logEvent } from '../events/audit';
import { enqueueEmail } from '../notifications/enqueue';
import { notFound, badRequest, forbidden, conflict } from '@/lib/errors/types';
import { runInTenantContext, type PrismaTx } from '@/lib/db-context';
import { hasOutstandingAcknowledgement } from '@/lib/policy/coverage-predicate';
import { sanitizePolicyContent, sanitizePlainText } from '@/lib/security/sanitize';
import { parseReviewCadenceDays, parseEvidenceToRetain } from '@/lib/policy/template-skeleton';
import { logger } from '@/lib/observability/logger';
import { recordPolicyPublished } from '@/lib/observability/business-metrics';

// ─── Slug helper ───

function slugify(text: string): string {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .substring(0, 80);
}

// ─── Queries ───

/** Per-policy acknowledgement rollup surfaced on the library list. */
export interface PolicyAcknowledgementSummary {
    assignedCount: number;
    acknowledgedCount: number;
    outstanding: boolean;
}

const EMPTY_ACK_SUMMARY: PolicyAcknowledgementSummary = {
    assignedCount: 0,
    acknowledgedCount: 0,
    outstanding: false,
};

/**
 * Batch-annotate list rows with their CURRENT-version acknowledgement rollup so
 * the library can show its "outstanding acknowledgements" KPI / column / filter
 * without an N+1.
 *
 * Backed by ONE JOIN'd aggregate (`PolicyRepository.ackCountsByVersion`) — it
 * replaced a pair of `take: 20000` row fetches that were reduced in memory, so
 * the rollup no longer silently truncates on a large campaign and costs two
 * full table reads per list load.
 *
 * `acknowledgedCount` is the intersection of assigned ∧ acked (voluntary acks by
 * non-assigned users don't reduce the outstanding count, and stale acks of a
 * superseded version are excluded because we key on the current version id).
 * Only PUBLISHED policies with a current version can have a live campaign;
 * everything else annotates to zero / not-outstanding.
 */
async function annotatePolicyAcknowledgements<
    T extends { status: string; currentVersion: { id: string } | null },
>(
    db: PrismaTx,
    ctx: RequestContext,
    policies: T[],
): Promise<(T & { acknowledgement: PolicyAcknowledgementSummary })[]> {
    const versionIds = policies
        .filter((p) => p.status === 'PUBLISHED' && p.currentVersion?.id)
        .map((p) => p.currentVersion!.id);
    if (versionIds.length === 0) {
        return policies.map((p) => ({ ...p, acknowledgement: EMPTY_ACK_SUMMARY }));
    }
    const counts = await PolicyRepository.ackCountsByVersion(db, ctx, versionIds);
    const byVersion = new Map(counts.map((c) => [c.policyVersionId, c]));
    return policies.map((p) => {
        const vid = p.status === 'PUBLISHED' ? p.currentVersion?.id ?? null : null;
        const row = vid ? byVersion.get(vid) : undefined;
        if (!row) return { ...p, acknowledgement: EMPTY_ACK_SUMMARY };
        const summary: PolicyAcknowledgementSummary = {
            assignedCount: row.assigned,
            acknowledgedCount: row.acked,
            outstanding: hasOutstandingAcknowledgement({
                assignedCount: row.assigned,
                acknowledgedCount: row.acked,
            }),
        };
        return { ...p, acknowledgement: summary };
    });
}

export async function listPolicies(
    ctx: RequestContext,
    filters?: PolicyFilters,
    options: { take?: number } = {},
) {
    assertCanReadPolicies(ctx);
    return runInTenantContext(ctx, async (db) => {
        const rows = await PolicyRepository.list(db, ctx, filters, options);
        return annotatePolicyAcknowledgements(db, ctx, rows);
    });
}

/**
 * Counts for the KPI filter cards, resolved server-side.
 *
 * Deliberately NOT folded into `listPolicies`: the list is capped
 * (LIST_BACKFILL_CAP) and SSR-windowed, and deriving counts from a windowed
 * array is the exact defect this replaces. Counting in the database is the
 * only way the number can describe the tenant rather than the page.
 */
export async function listPolicyKpiCounts(ctx: RequestContext, filters?: PolicyFilters) {
    assertCanReadPolicies(ctx);
    return runInTenantContext(ctx, (db) => PolicyRepository.kpiCounts(db, ctx, filters));
}

export async function listPoliciesPaginated(ctx: RequestContext, params: PolicyListParams) {
    assertCanReadPolicies(ctx);
    return runInTenantContext(ctx, async (db) => {
        const page = await PolicyRepository.listPaginated(db, ctx, params);
        const items = await annotatePolicyAcknowledgements(
            db,
            ctx,
            page.items as Array<{ status: string; currentVersion: { id: string } | null }>,
        );
        return { ...page, items };
    });
}

export async function getPolicy(ctx: RequestContext, policyId: string) {
    assertCanReadPolicies(ctx);
    return runInTenantContext(ctx, async (db) => {
        const policy = await PolicyRepository.getById(db, ctx, policyId);
        if (!policy) throw notFound('Policy not found');
        return policy;
    });
}

export async function listPolicyTemplates(ctx: RequestContext) {
    assertCanReadPolicies(ctx);
    return runInTenantContext(ctx, (db) =>
        PolicyTemplateRepository.list(db)
    );
}

export async function getPolicyActivity(ctx: RequestContext, policyId: string) {
    assertCanReadPolicies(ctx);
    return runInTenantContext(ctx, (db) =>
        db.auditLog.findMany({
            where: {
                tenantId: ctx.tenantId,
                entity: 'Policy',
                entityId: policyId,
            },
            orderBy: { createdAt: 'desc' },
            take: 50,
            include: {
                user: { select: { id: true, name: true } },
            },
        })
    );
}


/**
 * Assert a body-supplied `ownerUserId` is an ACTIVE member of this tenant.
 *
 * `User` is a GLOBAL table, so the FK on `Policy.ownerUserId` is satisfied by
 * ANY user id in the system — including one belonging to another tenant. The
 * row is then stamped with `ctx.tenantId` and looks entirely legitimate: the
 * policy has an owner who is not a member, cannot see it, and will never act
 * on it, while the surface reports it as owned. Ownership also feeds review
 * reminders, so the reminder is addressed to someone outside the tenant.
 *
 * The correct pattern already exists in this surface — acknowledgement
 * audiences are intersected with `status: 'ACTIVE'` membership before use
 * (`policy-attestation.ts`). This is the same intersection for a single id.
 *
 * A null/undefined owner is a no-op: clearing ownership is legitimate.
 */
async function assertOwnerIsActiveMember(
    db: PrismaTx,
    ctx: RequestContext,
    ownerUserId: string | null | undefined,
) {
    if (!ownerUserId) return;
    const membership = await db.tenantMembership.findFirst({
        where: { tenantId: ctx.tenantId, userId: ownerUserId, status: 'ACTIVE' },
        select: { userId: true },
    });
    if (!membership) {
        throw badRequest(
            'INVALID_OWNER',
            'The selected owner is not an active member of this tenant.',
        );
    }
}

// ─── Create ───

export async function createPolicy(ctx: RequestContext, data: {
    title: string;
    description?: string | null;
    category?: string | null;
    ownerUserId?: string | null;
    reviewFrequencyDays?: number | null;
    language?: string | null;
    content?: string | null;
    /** Initial-version editor mode (Prompt-3.3). Defaults to MARKDOWN. */
    contentType?: 'MARKDOWN' | 'HTML';
}) {
    assertCanCreatePolicy(ctx);

    return runInTenantContext(ctx, async (db) => {
        await assertOwnerIsActiveMember(db, ctx, data.ownerUserId);

        // Generate unique slug
        let baseSlug = slugify(data.title);
        if (!baseSlug) baseSlug = 'policy';
        let slug = baseSlug;
        let counter = 0;
        while (await PolicyRepository.getBySlug(db, ctx, slug)) {
            counter++;
            slug = `${baseSlug}-${counter}`;
        }

        const policy = await PolicyRepository.create(db, ctx, {
            slug,
            title: data.title,
            description: data.description,
            category: data.category,
            ownerUserId: data.ownerUserId,
            reviewFrequencyDays: data.reviewFrequencyDays,
            language: data.language,
        });

        // Create initial version if content provided. Sanitised
        // before persistence — same contract as createPolicyVersion.
        if (data.content) {
            const initialContentType = data.contentType ?? 'MARKDOWN';
            const version = await PolicyVersionRepository.create(db, ctx, policy.id, {
                contentType: initialContentType,
                contentText: sanitizePolicyContent(initialContentType, data.content),
                changeSummary: 'Initial version',
            });
            await PolicyRepository.setCurrentVersion(db, ctx, policy.id, version.id);
        }

        await logEvent(db, ctx, {
            action: 'POLICY_CREATED',
            entityType: 'Policy',
            entityId: policy.id,
            details: `Created policy: ${policy.title}`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'Policy',
                operation: 'created',
                after: { title: policy.title, slug: policy.slug, category: data.category || null },
                summary: `Created policy: ${policy.title}`,
            },
        });

        return policy;
    });
}

export async function createPolicyFromTemplate(ctx: RequestContext, templateId: string, overrides?: {
    title?: string;
    description?: string | null;
    category?: string | null;
    ownerUserId?: string | null;
    language?: string | null;
}) {
    assertCanCreatePolicy(ctx);

    return runInTenantContext(ctx, async (db) => {
        await assertOwnerIsActiveMember(db, ctx, overrides?.ownerUserId);
        const template = await PolicyTemplateRepository.getById(db, templateId);
        if (!template) throw notFound('Policy template not found');

        const title = overrides?.title || template.title;
        let baseSlug = slugify(title);
        if (!baseSlug) baseSlug = 'policy';
        let slug = baseSlug;
        let counter = 0;
        while (await PolicyRepository.getBySlug(db, ctx, slug)) {
            counter++;
            slug = `${baseSlug}-${counter}`;
        }

        // Adopt the template's canonical structure into operational data:
        //   - "Document Control" review cadence → reviewFrequencyDays +
        //     a first nextReviewAt (the tenant adjusts).
        //   - owner defaults to the creating user.
        // Best-effort: a template without a parseable cadence leaves the
        // fields null (no schedule) rather than guessing.
        const cadenceDays = parseReviewCadenceDays(template.contentText);
        const nextReviewAt = cadenceDays ? new Date(Date.now() + cadenceDays * 86_400_000) : null;

        const policy = await PolicyRepository.create(db, ctx, {
            slug,
            title,
            description: overrides?.description ?? null,
            category: overrides?.category || template.category,
            ownerUserId: overrides?.ownerUserId ?? ctx.userId,
            reviewFrequencyDays: cadenceDays,
            nextReviewAt,
            language: overrides?.language || template.language,
        });

        // Create version from template content.
        //
        // Sanitised like every other content write path. This was the ONLY
        // one that skipped `sanitizePolicyContent` (see `createPolicy` and
        // `createPolicyVersion`), and it is the one carrying THIRD-PARTY
        // content: templates ship from the ciso-toolkit, and `contentType`
        // comes from the template too, so an HTML template's markup went
        // into the encrypted column verbatim. Encryption protects it at
        // rest; it does nothing for the renderers that decrypt and display
        // it (the editor, the PDF export, the public trust-centre
        // projection). That the very next block sanitises the template's
        // evidence labels shows this was an omission, not a decision.
        const version = await PolicyVersionRepository.create(db, ctx, policy.id, {
            contentType: template.contentType,
            contentText: sanitizePolicyContent(template.contentType, template.contentText),
            changeSummary: `Created from template: ${template.title}`,
        });
        await PolicyRepository.setCurrentVersion(db, ctx, policy.id, version.id);

        // "Evidence to Retain" → checklist items (label only; the tenant
        // links real Evidence on the detail page). Sanitised free text.
        const evidenceLabels = parseEvidenceToRetain(template.contentText);
        if (evidenceLabels.length) {
            await db.policyEvidenceItem.createMany({
                data: evidenceLabels.map((label, i) => ({
                    tenantId: ctx.tenantId,
                    policyId: policy.id,
                    label: sanitizePlainText(label).slice(0, 500),
                    sortOrder: i,
                })),
            });
        }

        await logEvent(db, ctx, {
            action: 'POLICY_CREATED',
            entityType: 'Policy',
            entityId: policy.id,
            details: `Created from template: ${template.title}`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'Policy',
                operation: 'created',
                after: {
                    title,
                    templateId: template.id,
                    templateTitle: template.title,
                    reviewFrequencyDays: cadenceDays,
                    evidenceItemCount: evidenceLabels.length,
                },
                summary: `Created from template: ${template.title}`,
            },
            metadata: { templateId: template.id },
        });

        return policy;
    });
}

/**
 * The single implementation of "this policy was reviewed". Stamps
 * `lastReviewedAt = now` and recomputes `nextReviewAt = now +
 * reviewFrequencyDays`. A policy with NO cadence keeps whatever
 * `nextReviewAt` it already has — a manually-set review date must survive
 * a review, not be wiped. Clearing it would drop the policy out of
 * `processOverdueReminders`' `nextReviewAt: { not: null }` predicate
 * (`jobs/policyReviewReminder.ts`) permanently: never reminded again.
 *
 * Transaction-bound so callers that are ALREADY inside a tenant
 * transaction (the task→source reconciler) can share it without nesting a
 * second `runInTenantContext`. `trigger` is the ONLY sanctioned point of
 * variation between call sites — it selects the audit wording. Any future
 * caller that needs different *behaviour* adds a parameter here; it does
 * NOT fork a second copy of the cadence rule.
 *
 * Authorization + policy loading are the caller's job.
 */
export async function applyPolicyReviewed(
    db: PrismaTx,
    ctx: RequestContext,
    policy: { id: string; reviewFrequencyDays: number | null; nextReviewAt: Date | null },
    opts: { trigger: 'manual' | 'reminder_task_close'; taskId?: string },
): Promise<{ lastReviewedAt: Date; nextReviewAt: Date | null }> {
    const now = new Date();
    // With a cadence, recompute the next review date. Without one,
    // PRESERVE any explicitly-set nextReviewAt rather than clearing it.
    const nextReviewAt = policy.reviewFrequencyDays
        ? new Date(now.getTime() + policy.reviewFrequencyDays * 86_400_000)
        : policy.nextReviewAt;

    await PolicyRepository.updateMetadata(db, ctx, policy.id, {
        lastReviewedAt: now,
        nextReviewAt,
    });

    const fromTask = opts.trigger === 'reminder_task_close';
    await logEvent(db, ctx, {
        action: 'POLICY_REVIEWED',
        entityType: 'Policy',
        entityId: policy.id,
        details: `${fromTask ? 'Policy review cycle advanced on reminder-task close' : 'Policy reviewed'}${nextReviewAt ? `; next review ${nextReviewAt.toISOString().slice(0, 10)}` : ''}`,
        detailsJson: {
            category: 'status_change',
            entityName: 'Policy',
            operation: 'reviewed',
            after: {
                lastReviewedAt: now.toISOString(),
                nextReviewAt: nextReviewAt?.toISOString() ?? null,
            },
            summary: fromTask ? 'Policy marked reviewed on reminder-task close' : 'Policy marked reviewed',
        },
        ...(opts.taskId ? { metadata: { taskId: opts.taskId, policyId: policy.id } } : {}),
    });

    return { lastReviewedAt: now, nextReviewAt };
}

/**
 * Mark a policy as reviewed (periodic re-validation — distinct from
 * PolicyApproval's initial sign-off). Thin authorization + loading wrapper
 * over {@link applyPolicyReviewed}, which owns the cadence rule. Audited.
 */
export async function markPolicyReviewed(ctx: RequestContext, policyId: string) {
    assertCanWritePolicies(ctx);

    return runInTenantContext(ctx, async (db) => {
        const policy = await PolicyRepository.getById(db, ctx, policyId);
        if (!policy) throw notFound('Policy not found');

        await applyPolicyReviewed(db, ctx, policy, { trigger: 'manual' });

        return PolicyRepository.getById(db, ctx, policyId);
    });
}

// ─── Version ───

export async function createPolicyVersion(ctx: RequestContext, policyId: string, data: {
    contentType: string;
    contentText?: string | null;
    externalUrl?: string | null;
    changeSummary?: string | null;
}, opts: {
    /**
     * Prompt-3.2 — when true, a new version on a PUBLISHED/APPROVED policy is a
     * *proposed* draft: the live published version and status are NOT demoted.
     * The proposal must go through request-approval → publish to replace the
     * live version. Used by the SharePoint pull so an external edit never
     * silently un-publishes a live policy (stranding its acknowledgements).
     */
    proposeOnly?: boolean;
} = {}) {
    assertCanWritePolicies(ctx);

    return runInTenantContext(ctx, async (db) => {
        const policy = await PolicyRepository.getById(db, ctx, policyId);
        if (!policy) throw notFound('Policy not found');

        if (policy.status === 'ARCHIVED') {
            throw badRequest('Cannot create version for an archived policy');
        }

        // Validate content based on type
        if (data.contentType === 'EXTERNAL_LINK' && !data.externalUrl) {
            throw badRequest('externalUrl is required for EXTERNAL_LINK content type');
        }
        if ((data.contentType === 'MARKDOWN' || data.contentType === 'HTML') && !data.contentText) {
            throw badRequest('contentText is required for MARKDOWN/HTML content type');
        }

        // Epic C.5 — sanitise BEFORE the repository write so the
        // stored row never carries dangerous HTML. HTML content gets
        // the rich-text allowlist; MARKDOWN/EXTERNAL_LINK get
        // plain-text stripping (markdown's renderer escapes; embedded
        // raw HTML inside a markdown blob would bypass it).
        const safeData =
            data.contentText && (
                data.contentType === 'HTML'
                || data.contentType === 'MARKDOWN'
                || data.contentType === 'EXTERNAL_LINK'
            )
                ? {
                      ...data,
                      contentText: sanitizePolicyContent(
                          data.contentType as 'HTML' | 'MARKDOWN' | 'EXTERNAL_LINK',
                          data.contentText,
                      ),
                  }
                : data;

        const version = await PolicyVersionRepository.create(db, ctx, policyId, safeData);

        const wasLive = policy.status === 'PUBLISHED' || policy.status === 'APPROVED';
        // Move policy back to DRAFT if it was published/approved — UNLESS this is
        // a *proposed* external change (Prompt-3.2), which must not demote the
        // live published version; the proposal awaits its own approval instead.
        if (wasLive && !opts.proposeOnly) {
            await PolicyRepository.updateStatus(db, ctx, policyId, 'DRAFT');
        }
        if (wasLive && opts.proposeOnly) {
            await logEvent(db, ctx, {
                action: 'POLICY_EXTERNAL_CHANGE_PROPOSED',
                entityType: 'Policy',
                entityId: policyId,
                details: `External change proposed as version ${version.versionNumber} (live ${policy.status} version unchanged)`,
                detailsJson: {
                    category: 'entity_lifecycle',
                    entityName: 'Policy',
                    summary: `External change proposed as v${version.versionNumber}; live ${policy.status} version retained pending re-approval`,
                    after: { versionId: version.id, versionNumber: version.versionNumber, retainedStatus: policy.status },
                },
                metadata: { versionId: version.id, versionNumber: version.versionNumber },
            });
        }

        await logEvent(db, ctx, {
            action: 'POLICY_VERSION_CREATED',
            entityType: 'Policy',
            entityId: policyId,
            details: `Version ${version.versionNumber} created`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'PolicyVersion',
                operation: 'created',
                after: { versionId: version.id, versionNumber: version.versionNumber, contentType: data.contentType },
                summary: `Version ${version.versionNumber} created`,
            },
            metadata: { versionId: version.id, versionNumber: version.versionNumber },
        });

        return version;
    });
}

// ─── Metadata ───

export async function updatePolicyMetadata(ctx: RequestContext, policyId: string, data: {
    title?: string;
    description?: string | null;
    category?: string | null;
    ownerUserId?: string | null;
    reviewFrequencyDays?: number | null;
    nextReviewAt?: string | null;
    language?: string | null;
}) {
    assertCanWritePolicies(ctx);

    return runInTenantContext(ctx, async (db) => {
        const policy = await PolicyRepository.getById(db, ctx, policyId);
        if (!policy) throw notFound('Policy not found');

        // Only when the patch actually carries the field — an unrelated
        // metadata edit should not pay for a membership lookup.
        if (data.ownerUserId !== undefined) {
            await assertOwnerIsActiveMember(db, ctx, data.ownerUserId);
        }

        const updateData: Record<string, unknown> = { ...data };
        if (data.nextReviewAt !== undefined) {
            updateData.nextReviewAt = data.nextReviewAt ? new Date(data.nextReviewAt) : null;
        }

        await PolicyRepository.updateMetadata(db, ctx, policyId, updateData);

        await logEvent(db, ctx, {
            action: 'POLICY_UPDATED',
            entityType: 'Policy',
            entityId: policyId,
            details: `Metadata updated`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'Policy',
                operation: 'updated',
                changedFields: Object.keys(data).filter(k => data[k as keyof typeof data] !== undefined),
                after: data,
                summary: 'Policy metadata updated',
            },
            metadata: data,
        });

        return PolicyRepository.getById(db, ctx, policyId);
    });
}

// ─── Approval Workflow ───

export async function requestPolicyApproval(ctx: RequestContext, policyId: string, versionId: string) {
    assertCanWritePolicies(ctx);

    return runInTenantContext(ctx, async (db) => {
        const policy = await PolicyRepository.getById(db, ctx, policyId);
        if (!policy) throw notFound('Policy not found');

        // Verify the version belongs to this policy
        const version = await PolicyVersionRepository.getById(db, versionId);
        if (!version || version.policyId !== policyId) {
            throw badRequest('Version does not belong to this policy');
        }

        // Requesting approval MOVES the policy to IN_REVIEW, so it is a
        // lifecycle transition, not a neutral annotation — and it had no
        // status guard at all. On a PUBLISHED policy that silently withdrew
        // the live document: attestPolicy requires PUBLISHED, so every
        // acknowledgement stopped being possible, and the policy dropped out
        // of coverage — with no version change, no content change and no
        // administrator involved. `createPolicyVersion` already guards
        // ARCHIVED for the same reason; this path simply never did.
        //
        // PUBLISHED is refused rather than silently allowed: the way to
        // revise a live policy is to draft a new version (which carries its
        // own explicit demotion), not to withdraw the current one as a
        // side effect of asking for review.
        if (policy.status === 'PUBLISHED') {
            throw conflict(
                'This policy is published. Create a new version to propose changes — requesting approval on the live policy would withdraw it from acknowledgement.',
            );
        }
        if (policy.status === 'ARCHIVED') {
            throw conflict('This policy is archived. Restore it before requesting approval.');
        }

        // Dedupe: one open request per policy at a time.
        //
        // Multiple concurrent PENDING rows are what make a stale approval
        // dangerous — each one is independently decidable later, and a single
        // Reject rewrites the policy's status regardless of what has happened
        // since. Refusing the second request keeps "the policy's review
        // state" and "the approval rows" in agreement.
        const openApprovals = await PolicyApprovalRepository.findPending(db, ctx, policyId);
        if (openApprovals.length > 0) {
            const sameVersion = openApprovals.some((a) => a.policyVersionId === versionId);
            throw conflict(
                sameVersion
                    ? 'This version already has an approval request awaiting a decision.'
                    : 'This policy already has an approval request awaiting a decision. Decide or withdraw it before requesting another.',
            );
        }

        // Move policy to IN_REVIEW
        await PolicyRepository.updateStatus(db, ctx, policyId, 'IN_REVIEW');

        const approval = await PolicyApprovalRepository.request(db, ctx, policyId, versionId);

        await logEvent(db, ctx, {
            action: 'POLICY_APPROVAL_REQUESTED',
            entityType: 'Policy',
            entityId: policyId,
            details: `Approval requested for version ${version.versionNumber}`,
            detailsJson: {
                category: 'status_change',
                entityName: 'Policy',
                fromStatus: policy.status,
                toStatus: 'IN_REVIEW',
                reason: `Approval requested for version ${version.versionNumber}`,
            },
            metadata: { versionId, approvalId: approval.id },
        });

        // Notify admin users with POLICY_APPROVAL_REQUESTED email
        try {
            const requester = await db.user.findUnique({
                where: { id: ctx.userId },
                select: { name: true },
            });
            const admins = await db.tenantMembership.findMany({
                where: { tenantId: ctx.tenantId, role: 'ADMIN' },
                include: { user: { select: { email: true, name: true } } },
            });
            for (const m of admins) {
                if (!m.user.email) continue;
                await enqueueEmail(db, {
                    tenantId: ctx.tenantId,
                    type: 'POLICY_APPROVAL_REQUESTED',
                    toEmail: m.user.email,
                    entityId: policyId,
                    requestId: ctx.requestId,
                    payload: {
                        policyTitle: policy.title,
                        requesterName: requester?.name || 'A team member',
                        approverName: m.user.name || m.user.email,
                        versionNumber: version.versionNumber,
                        tenantSlug: ctx.tenantSlug || '',
                    },
                });
            }
        } catch (err) {
            logger.warn('failed to enqueue policy approval email', { component: 'notifications' });
        }

        return approval;
    });
}

/**
 * @param policyId the policy the approval must belong to.
 *
 * Required, and deliberately positioned before `approvalId`, so the pair
 * cannot be left unrelated. The decide route receives both — a policy id in
 * the URL path and an approval id in the same path — but only ever forwarded
 * the approval id, so ANY approval in the tenant could be decided through ANY
 * policy's URL. The tenant filter made that tenant-safe but not coherent: it
 * still let an approval be decided from a page describing a different policy,
 * and the audit row was written against `approval.policyId`, so the trail
 * pointed somewhere the actor never visited.
 */
export async function decidePolicyApproval(ctx: RequestContext, policyId: string, approvalId: string, decision: {
    decision: 'APPROVED' | 'REJECTED';
    comment?: string | null;
}) {
    assertCanApprovePolicies(ctx);

    return runInTenantContext(ctx, async (db) => {
        const approval = await PolicyApprovalRepository.getById(db, ctx, approvalId, policyId);
        if (!approval) throw notFound('Approval request not found');

        // Verify tenant ownership
        if (approval.policy.tenantId !== ctx.tenantId) {
            throw forbidden('Access denied');
        }

        if (approval.status !== 'PENDING') {
            throw conflict('This approval request has already been decided');
        }

        // STALE-APPROVAL GUARD.
        //
        // Deciding used to rewrite the policy's status unconditionally
        // (APPROVED → 'APPROVED', anything else → 'DRAFT') with no regard for
        // where the policy actually was. Combined with the publish-bypass
        // path — which publishes while leaving its approval PENDING forever —
        // that meant one later Reject on a long-forgotten row dropped a LIVE,
        // PUBLISHED policy to DRAFT: attestations stranded, coverage lost, no
        // confirmation, no version change.
        //
        // A decision is only meaningful while the policy is still asking the
        // question. `publishPolicy` now supersedes outstanding requests, so
        // reaching this branch means the policy moved on some other way.
        //
        // (The audit entry below also hardcoded `fromStatus: 'IN_REVIEW'`,
        // which was false in exactly this case — it now reports the real
        // prior status.)
        if (approval.policy.status !== 'IN_REVIEW') {
            throw conflict(
                `This approval is no longer current — the policy has since moved to ${approval.policy.status}. ` +
                    `Deciding it now would overwrite that state.`,
            );
        }

        // Segregation of duties — the requester of a policy change may not
        // APPROVE their own request. No per-tenant toggle exists today, so this
        // is enforced unconditionally. A self-REJECTION is still allowed so a
        // requester can withdraw a change without stranding it in IN_REVIEW.
        if (decision.decision === 'APPROVED' && approval.requestedByUserId === ctx.userId) {
            throw forbidden(
                'Separation of duties: you cannot approve a policy change you requested. Another administrator must approve it.',
            );
        }

        // SoD also covers AUTHORSHIP: when the version author differs from the
        // requester, an admin who WROTE the version must not approve it either.
        // (Previously only the requester was blocked, so a self-authored version
        // requested by someone else could be self-approved.)
        if (decision.decision === 'APPROVED') {
            const version = await db.policyVersion.findFirst({
                where: { id: approval.policyVersionId, tenantId: ctx.tenantId },
                select: { createdById: true },
            });
            if (version?.createdById === ctx.userId) {
                throw forbidden(
                    'Separation of duties: you cannot approve a policy version you authored. Another administrator must approve it.',
                );
            }
        }

        const result = await PolicyApprovalRepository.decide(
            db, ctx, approvalId, decision.decision, decision.comment || undefined
        );
        // `decide` claims the row with a `status: 'PENDING'` predicate and
        // returns null when the claim was LOST — i.e. a concurrent request
        // decided it between our read above and this write. Reporting that as
        // "already decided" is the truth; the old unconditional updateMany
        // would have silently overwritten the winner's decision and approver.
        if (!result) {
            throw conflict('This approval request was decided by someone else just now.');
        }

        // Update policy status based on decision
        if (decision.decision === 'APPROVED') {
            await PolicyRepository.updateStatus(db, ctx, approval.policyId, 'APPROVED');
        } else {
            await PolicyRepository.updateStatus(db, ctx, approval.policyId, 'DRAFT');
        }

        const action = decision.decision === 'APPROVED' ? 'POLICY_APPROVED' : 'POLICY_REJECTED';
        await logEvent(db, ctx, {
            action,
            entityType: 'Policy',
            entityId: approval.policyId,
            details: `Policy ${decision.decision.toLowerCase()}`,
            detailsJson: {
                category: 'status_change',
                entityName: 'Policy',
                // The real prior status, not a hardcoded 'IN_REVIEW'. The
                // guard above means it IS IN_REVIEW today, but reading it
                // from the row keeps the audit honest if that ever widens.
                fromStatus: approval.policy.status,
                toStatus: decision.decision === 'APPROVED' ? 'APPROVED' : 'DRAFT',
                reason: decision.comment || undefined,
            },
            metadata: { approvalId, decision: decision.decision, comment: decision.comment },
        });

        // Notify the requester about the decision
        try {
            const requester = await db.user.findUnique({
                where: { id: approval.requestedByUserId },
                select: { email: true, name: true },
            });
            const decider = await db.user.findUnique({
                where: { id: ctx.userId },
                select: { name: true },
            });
            if (requester?.email) {
                const emailType = decision.decision === 'APPROVED' ? 'POLICY_APPROVED' as const : 'POLICY_REJECTED' as const;
                await enqueueEmail(db, {
                    tenantId: ctx.tenantId,
                    type: emailType,
                    toEmail: requester.email,
                    entityId: approval.policyId,
                    requestId: ctx.requestId,
                    payload: {
                        policyTitle: approval.policy.title,
                        decision: decision.decision,
                        deciderName: decider?.name || 'An administrator',
                        requesterName: requester.name || requester.email,
                        comment: decision.comment,
                        tenantSlug: ctx.tenantSlug || '',
                    },
                });
            }
        } catch (err) {
            logger.warn('failed to enqueue policy decision email', { component: 'notifications' });
        }

        return result;
    });
}

// ─── Publish / Archive ───

/**
 * Audit Coherence S4 (2026-05-22) — `publishPolicy` previously
 * accepted any policy regardless of status (an admin could publish a
 * DRAFT, bypassing the approval workflow entirely). The audit
 * recommended either blocking non-APPROVED publishes outright OR
 * audit-logging the bypass. This implementation does BOTH:
 *
 *   - DEFAULT: refuses to publish unless `policy.status === 'APPROVED'`.
 *   - BYPASS: passing `bypassApprovalReason` allows publishing from
 *     any pre-PUBLISHED status, but the bypass + the reason are
 *     captured in a dedicated audit row (`POLICY_PUBLISH_BYPASS`).
 *
 * The bypass exists because real-world emergencies (hot-fix to a
 * security policy mid-incident) shouldn't be entirely blocked, but
 * they MUST be auditable + justified.
 */
/**
 * A prior published snapshot recorded in `Policy.lifecycleHistoryJson` (Prompt-3.1).
 * `versionId` is the still-existing PolicyVersion that rollback re-publishes.
 */
export interface PolicyLifecycleSnapshot {
    /** lifecycleVersion at the time this snapshot was the live published version. */
    version: number;
    versionId: string;
    versionNumber: number;
    changeSummary: string | null;
    /** ISO timestamp — when this published version was superseded. */
    supersededAt: string;
    supersededByUserId: string;
}

const MAX_LIFECYCLE_HISTORY = 20;

export interface PublishPolicyOptions {
    /**
     * If set, allows publishing a policy that isn't APPROVED. The
     * reason is captured verbatim in the bypass audit row and
     * surfaces in the policy's audit history for review. Empty /
     * whitespace-only reasons are rejected.
     */
    bypassApprovalReason?: string;
}

/**
 * Carry a required-acknowledgement campaign forward onto a newly-live version.
 *
 * A campaign is bound to a specific `policyVersionId`. Any operation that
 * changes which version is LIVE — publishing a revision, or rolling back to a
 * prior one — would otherwise leave the roster pointed at a version nobody was
 * assigned to ("none required", assignedCount 0) while the previous campaign's
 * assignments orphan against a version that is no longer live, and nobody is
 * re-notified that the text they must follow has changed.
 *
 * Acks are deliberately NOT copied: the live content changed, so carried-forward
 * users read as OUTSTANDING until they acknowledge the now-live version. That is
 * the point of the campaign.
 *
 * Shared by `publishPolicy` and `rollbackPolicy` so the two can't drift — a
 * rollback silently changing live content under an active campaign was the gap
 * this helper closes.
 *
 * Returns the user ids to re-notify AFTER commit (empty when there is nothing
 * to carry).
 */
async function carryForwardAckCampaign(
    db: PrismaTx,
    ctx: RequestContext,
    args: {
        fromVersionId: string | null | undefined;
        toVersionId: string;
        policyId: string;
        policyTitle: string;
        versionNumber: number;
    },
): Promise<string[]> {
    const { fromVersionId, toVersionId, policyId, policyTitle, versionNumber } = args;
    if (!fromVersionId || fromVersionId === toVersionId) return [];

    // PAGINATED, not `take: 5000`.
    //
    // A flat cap here loses people silently: anyone past the cap is never
    // assigned against the new version, so they are never asked to
    // re-acknowledge it, and the roster reports the campaign as more complete
    // than it is. That is a compliance number being quietly wrong — the exact
    // failure the `ackCountsByVersion` header describes, which is why its own
    // truncating row-fetches were replaced with an aggregate. This one and the
    // roster were missed.
    //
    // Cursor-paginated on the composite unique `(policyVersionId, userId)`, so
    // the walk is index-backed and stable under concurrent inserts.
    const priorAssignments: { userId: string; assignedById: string | null }[] = [];
    const CARRY_PAGE = 1000;
    let cursorUserId: string | null = null;
    // This is cursor PAGINATION, not a per-entity read. Each iteration fetches
    // the next PAGE (1000 rows), so the iteration count is total/1000 rather
    // than one query per user — and the fix the guardrail normally recommends
    // (one findMany with an `in:` filter) is exactly what we are moving away
    // from here: it needs a `take`, and any `take` silently drops assignees
    // from a compliance campaign. The roster in policy-attestation.ts walks
    // the same way via `readAllByUser` (its read sits in a callback, so the
    // scanner does not flag it — same pattern, not a different one).
    for (;;) { // guardrail-allow: n+1 — cursor pagination; see note above
        const page: { userId: string; assignedById: string | null }[] =
            await db.policyAcknowledgementAssignment.findMany({
                where: {
                    policyVersionId: fromVersionId,
                    ...(cursorUserId ? { userId: { gt: cursorUserId } } : {}),
                },
                // `assignedById` rides along so the ORIGINAL assigner is preserved —
                // stamping the publisher would silently rewrite "requested by" on the
                // roster at every revision, destroying audit attribution.
                select: { userId: true, assignedById: true },
                orderBy: { userId: 'asc' },
                take: CARRY_PAGE,
            });
        priorAssignments.push(...page);
        if (page.length < CARRY_PAGE) break;
        cursorUserId = page[page.length - 1].userId;
    }
    if (priorAssignments.length === 0) return [];

    // `@@unique([policyVersionId, userId])` guarantees one row per user, so a
    // plain Map is a faithful userId → original-assigner index.
    const assignerByUser = new Map(priorAssignments.map((a) => [a.userId, a.assignedById]));
    const carriedAckUserIds = [...assignerByUser.keys()];

    await db.policyAcknowledgementAssignment.createMany({
        data: carriedAckUserIds.map((userId) => ({
            policyVersionId: toVersionId,
            userId,
            assignedById: assignerByUser.get(userId) ?? ctx.userId,
        })),
        skipDuplicates: true,
    });
    await logEvent(db, ctx, {
        action: 'POLICY_ACK_CARRIED_FORWARD',
        entityType: 'Policy',
        entityId: policyId,
        details: `Carried acknowledgement requirement forward to version ${versionNumber} for ${carriedAckUserIds.length} user(s)`,
        detailsJson: {
            category: 'access',
            entityName: 'Policy',
            summary: `Re-requested acknowledgement of "${policyTitle}" from ${carriedAckUserIds.length} user(s)`,
            after: { fromVersionId, toVersionId, assignedCount: carriedAckUserIds.length },
        },
    });
    return carriedAckUserIds;
}

export async function publishPolicy(
    ctx: RequestContext,
    policyId: string,
    versionId: string,
    options: PublishPolicyOptions = {},
) {
    assertCanAdminPolicies(ctx);

    const published = await runInTenantContext(ctx, async (db) => {
        const policy = await PolicyRepository.getById(db, ctx, policyId);
        if (!policy) throw notFound('Policy not found');

        // Verify the version belongs to this policy
        const version = await PolicyVersionRepository.getById(db, versionId);
        if (!version || version.policyId !== policyId) {
            throw badRequest('Version does not belong to this policy');
        }

        // Capture the OUTGOING published version before it's replaced — used
        // below to carry forward any live acknowledgement campaign onto the
        // new version (assignments are version-scoped, so a re-publish would
        // otherwise strand the campaign at assignedCount:0).
        const outgoingVersionId = policy.currentVersionId;

        // Audit S4 — approval gate. Default refuses non-APPROVED;
        // `bypassApprovalReason` opens the door but logs the bypass.
        const isApproved = policy.status === 'APPROVED';
        const bypassReason = options.bypassApprovalReason?.trim() ?? '';
        if (!isApproved && bypassReason.length === 0) {
            throw badRequest(
                `Policy ${policyId} is ${policy.status}; cannot publish without going through APPROVED. ` +
                    `If this is an emergency override, supply bypassApprovalReason to record the bypass.`,
            );
        }

        // BIND THE PUBLISH TO THE VERSION THAT WAS ACTUALLY APPROVED.
        //
        // The checks above establish that the version belongs to the policy
        // and that the policy is APPROVED — but never that they are the SAME
        // version. The approval record has carried `policyVersionId` since it
        // was written; nothing read it back. So with v1 and v2 both drafted,
        // approval requested and granted on v1, publishing v2 shipped
        // unreviewed content under an APPROVED status — and publishPolicy
        // carries none of the separation-of-duties checks that guard
        // `decidePolicyApproval`.
        //
        // Creating a version AFTER approval demotes the policy to DRAFT, so
        // the exploit needed v2 to pre-exist. That narrowed the window; it did
        // not close it.
        //
        // Enforced whenever the policy is APPROVED, INCLUDING when a bypass
        // reason is supplied: the bypass exists to publish something that was
        // never approved, not to publish a different version than the one that
        // was. On the genuine bypass path (status DRAFT, no approval) there is
        // nothing to bind to and this is skipped.
        if (isApproved) {
            const approval = await PolicyApprovalRepository.latestApproved(db, ctx, policyId);
            if (!approval) {
                throw badRequest(
                    `Policy ${policyId} is APPROVED but carries no approval record to publish against. ` +
                        `Request and obtain approval for the version you intend to publish.`,
                );
            }
            if (approval.policyVersionId !== versionId) {
                throw badRequest(
                    'This is not the version that was approved. ' +
                        'Publish the approved version, or request approval for this one.',
                );
            }
        }

        // ── Lifecycle history + counter (Prompt-3.1) ──
        // Snapshot the OUTGOING published version (the one being replaced) into
        // lifecycleHistoryJson and bump lifecycleVersion, so the list version
        // column reflects real published lineage and rollback has a target.
        const priorHistory: PolicyLifecycleSnapshot[] = Array.isArray(policy.lifecycleHistoryJson)
            ? (policy.lifecycleHistoryJson as unknown as PolicyLifecycleSnapshot[])
            : [];
        let nextHistory = priorHistory;
        // Capture the OUTGOING version when it was previously published
        // (lifecycleVersion > 1 ⇒ at least one prior publish; currentVersionId
        // tracks the last-published version). status may already be DRAFT here
        // because creating the new version demoted it — so gate on the counter,
        // not the live status.
        if (
            policy.lifecycleVersion > 1 &&
            policy.currentVersionId &&
            policy.currentVersionId !== versionId &&
            policy.currentVersion
        ) {
            nextHistory = [
                ...priorHistory,
                {
                    version: policy.lifecycleVersion,
                    versionId: policy.currentVersionId,
                    versionNumber: policy.currentVersion.versionNumber,
                    changeSummary: policy.currentVersion.changeSummary ?? null,
                    supersededAt: new Date().toISOString(),
                    supersededByUserId: ctx.userId,
                },
            ].slice(-MAX_LIFECYCLE_HISTORY);
        }

        // Set as current version and publish
        await PolicyRepository.setCurrentVersion(db, ctx, policyId, versionId);
        await PolicyRepository.updateStatus(db, ctx, policyId, 'PUBLISHED');

        // Resolve anything still outstanding.
        //
        // Publishing settles the question the request was asking, but the
        // bypass path in particular left its approval PENDING forever. A row
        // that stays PENDING behind a live policy is a loaded gun: deciding it
        // later rewrites the policy's status out from under the publish. The
        // stale-approval guard in `decidePolicyApproval` refuses that, and
        // this closes the rows so nobody is left staring at a decidable
        // request that can no longer legitimately be decided.
        const superseded = await PolicyApprovalRepository.supersedePending(
            db,
            ctx,
            policyId,
            'Superseded — the policy was published.',
        );
        await db.policy.update({
            where: { id: policyId },
            data: {
                lifecycleVersion: policy.lifecycleVersion + 1,
                lifecycleHistoryJson: nextHistory as unknown as Prisma.InputJsonValue,
            },
        });

        // ── Acknowledgement carry-forward (re-publish survival) ──
        // A required-acknowledgement campaign is bound to a specific
        // policyVersionId. Publishing a NEW version would leave the roster
        // reading the fresh (empty) version — assignedCount:0 / "none
        // required" — while the prior campaign's assignments orphan against
        // the superseded version and nobody is re-notified. Carry the
        // requirement forward onto the new version so the campaign survives,
        // and collect the assignees to re-notify AFTER commit. Acks are NOT
        // copied — the whole point is that the revised policy needs FRESH
        // acknowledgement, so carried-forward users read as outstanding until
        // they re-ack the new version.
        const carriedAckUserIds = await carryForwardAckCampaign(db, ctx, {
            fromVersionId: outgoingVersionId,
            toVersionId: versionId,
            policyId,
            policyTitle: policy.title,
            versionNumber: version.versionNumber,
        });

        // If we got here via the bypass path, emit the dedicated
        // audit row BEFORE the POLICY_PUBLISHED event so the timeline
        // reads "bypass first, then publish".
        if (!isApproved) {
            await logEvent(db, ctx, {
                action: 'POLICY_PUBLISH_BYPASS',
                entityType: 'Policy',
                entityId: policyId,
                details: `Bypassed APPROVED gate to publish from ${policy.status}: ${bypassReason}`,
                detailsJson: {
                    category: 'status_change',
                    entityName: 'Policy',
                    fromStatus: policy.status,
                    summary: `Approval gate bypassed (was ${policy.status})`,
                    after: {
                        bypassReason,
                        versionId,
                        versionNumber: version.versionNumber,
                    },
                },
            });
        }

        // Record the supersession so the timeline explains why a request the
        // reader may remember as open is now closed.
        if (superseded.count > 0) {
            await logEvent(db, ctx, {
                action: 'POLICY_APPROVAL_SUPERSEDED',
                entityType: 'Policy',
                entityId: policyId,
                details: `Superseded ${superseded.count} outstanding approval request(s) on publish`,
                detailsJson: {
                    category: 'status_change',
                    entityName: 'Policy',
                    summary: `${superseded.count} outstanding approval request(s) superseded by publish`,
                    after: { supersededCount: superseded.count, versionId },
                },
            });
        }

        await logEvent(db, ctx, {
            action: 'POLICY_PUBLISHED',
            entityType: 'Policy',
            entityId: policyId,
            details: `Published version ${version.versionNumber}`,
            detailsJson: {
                category: 'status_change',
                entityName: 'Policy',
                fromStatus: policy.status,
                toStatus: 'PUBLISHED',
                reason: `Published version ${version.versionNumber}`,
            },
            metadata: { versionId, versionNumber: version.versionNumber },
        });

        const result = await PolicyRepository.getById(db, ctx, policyId);
        return { result, carriedAckUserIds, policyTitle: policy.title };
    });

    // Re-notify carried-forward assignees that the revised policy needs a
    // FRESH acknowledgement — OUTSIDE the publish transaction (best-effort;
    // a notification failure must never fail or roll back the publish). The
    // dedupeKey is scoped to the NEW version so it fires once per revision.
    if (published.carriedAckUserIds.length > 0) {
        try {
            await runInTenantContext(ctx, async (db) => {
                const title = `Re-acknowledgement required: "${published.policyTitle}"`;
                const message = `The policy "${published.policyTitle}" has been revised. Please read and acknowledge the new version.`;
                for (const userId of published.carriedAckUserIds) {
                    await db.notification
                        .create({
                            data: {
                                tenantId: ctx.tenantId,
                                userId,
                                type: 'GENERAL',
                                title,
                                message,
                                linkUrl: `/policies/${policyId}`,
                                dedupeKey: `POLICY_ACK_REQUIRED:${versionId}:${userId}`,
                            },
                        })
                        .catch(() => { /* dedupe/notification failure must not fail publish */ });
                }
            });
        } catch { /* re-notify is best-effort */ }
    }

    // SP-4 — push the freshly-published content to a linked SharePoint file.
    // Best-effort + OUTSIDE the publish transaction (the sync opens its own):
    // a SharePoint hiccup must never fail or roll back the publish.
    try {
        const { pushPolicyToSharePoint } = await import('./policy-sharepoint-sync');
        await pushPolicyToSharePoint(ctx, policyId);
    } catch (err) {
        const { edgeLogger } = await import('@/lib/observability/edge-logger');
        edgeLogger.error('Policy publish: SharePoint push failed', {
            component: 'sharepoint',
            policyId,
            error: err instanceof Error ? err.message : String(err),
        });
    }

    recordPolicyPublished();
    return published.result;
}

/**
 * Roll back to the previous published version (Prompt-3.1). Re-publishes the
 * PolicyVersion recorded in the most-recent `lifecycleHistoryJson` entry,
 * pops it off the history, and bumps `lifecycleVersion`. Admin-only.
 */
export async function rollbackPolicy(ctx: RequestContext, policyId: string) {
    assertCanAdminPolicies(ctx);
    const result = await runInTenantContext(ctx, async (db) => {
        const policy = await PolicyRepository.getById(db, ctx, policyId);
        if (!policy) throw notFound('Policy not found');

        // Status guard — an ARCHIVED policy is retired; rolling it straight to
        // PUBLISHED would resurrect it silently. Restore it first.
        if (policy.status === 'ARCHIVED') {
            throw badRequest('Cannot roll back an ARCHIVED policy. Restore it before rolling back.');
        }

        const history: PolicyLifecycleSnapshot[] = Array.isArray(policy.lifecycleHistoryJson)
            ? (policy.lifecycleHistoryJson as unknown as PolicyLifecycleSnapshot[])
            : [];
        if (history.length === 0) {
            throw badRequest('No previous published version to roll back to.');
        }
        const target = history[history.length - 1];

        const targetVersion = await PolicyVersionRepository.getById(db, target.versionId);
        if (!targetVersion || targetVersion.policyId !== policyId) {
            throw badRequest('The previous published version no longer exists.');
        }

        // Snapshot the OUTGOING version (the one being rolled away from) into
        // history — mirroring publishPolicy — so the rollback is REVERSIBLE
        // (you can roll forward again) and lifecycleHistoryJson doesn't drain to
        // empty while lifecycleVersion keeps climbing. Pop the target, push the
        // outgoing. Skip the push if the outgoing IS the target (self-rollback).
        const withoutTarget = history.slice(0, -1);
        const pushOutgoing =
            policy.currentVersionId &&
            policy.currentVersion &&
            policy.currentVersionId !== target.versionId;
        const nextHistory = (
            pushOutgoing
                ? [
                      ...withoutTarget,
                      {
                          version: policy.lifecycleVersion,
                          versionId: policy.currentVersionId!,
                          versionNumber: policy.currentVersion!.versionNumber,
                          changeSummary: policy.currentVersion!.changeSummary ?? null,
                          supersededAt: new Date().toISOString(),
                          supersededByUserId: ctx.userId,
                      },
                  ]
                : withoutTarget
        ).slice(-MAX_LIFECYCLE_HISTORY);

        const outgoingVersionId = policy.currentVersionId;

        await PolicyRepository.setCurrentVersion(db, ctx, policyId, target.versionId);
        await PolicyRepository.updateStatus(db, ctx, policyId, 'PUBLISHED');
        await db.policy.update({
            where: { id: policyId },
            data: {
                lifecycleVersion: policy.lifecycleVersion + 1,
                lifecycleHistoryJson: nextHistory as unknown as Prisma.InputJsonValue,
            },
        });

        // A rollback changes which version is LIVE just as a publish does, so it
        // carries the acknowledgement campaign with it. Without this, rolling
        // back swapped the live text underneath an active campaign: the roster
        // pointed at the restored version (assignedCount 0 — "none required")
        // while everyone who had acknowledged the withdrawn revision stayed
        // marked complete against content that is no longer in force.
        const carriedAckUserIds = await carryForwardAckCampaign(db, ctx, {
            fromVersionId: outgoingVersionId,
            toVersionId: target.versionId,
            policyId,
            policyTitle: policy.title,
            versionNumber: target.versionNumber,
        });

        await logEvent(db, ctx, {
            action: 'POLICY_ROLLED_BACK',
            entityType: 'Policy',
            entityId: policyId,
            details: `Rolled back to version ${target.versionNumber}`,
            detailsJson: {
                category: 'status_change',
                entityName: 'Policy',
                toStatus: 'PUBLISHED',
                summary: `Rolled back to previously-published version ${target.versionNumber}`,
                after: { versionId: target.versionId, versionNumber: target.versionNumber },
            },
            metadata: { versionId: target.versionId, versionNumber: target.versionNumber },
        });

        const rolledBack = await PolicyRepository.getById(db, ctx, policyId);
        return { rolledBack, carriedAckUserIds, policyTitle: policy.title, restoredVersionId: target.versionId };
    });

    // Re-notify carried-forward assignees that the LIVE content changed and
    // needs a fresh acknowledgement — outside the transaction, best-effort,
    // exactly as publishPolicy does. The dedupeKey is scoped to the restored
    // version so it fires once per rollback rather than once per policy.
    if (result.carriedAckUserIds.length > 0) {
        try {
            await runInTenantContext(ctx, async (db) => {
                const title = `Re-acknowledgement required: "${result.policyTitle}"`;
                const message = `The policy "${result.policyTitle}" was rolled back to an earlier version. Please read and acknowledge the version now in force.`;
                for (const userId of result.carriedAckUserIds) {
                    await db.notification
                        .create({
                            data: {
                                tenantId: ctx.tenantId,
                                userId,
                                type: 'GENERAL',
                                title,
                                message,
                                linkUrl: `/policies/${policyId}`,
                                dedupeKey: `POLICY_ACK_REQUIRED:${result.restoredVersionId}:${userId}`,
                            },
                        })
                        .catch(() => { /* notification failure must not fail the rollback */ });
                }
            });
        } catch { /* re-notify is best-effort */ }
    }

    // Push the restored content to a linked SharePoint file exactly as
    // publishPolicy does, so the external doc doesn't go stale. Best-effort,
    // OUTSIDE the transaction — a SharePoint hiccup must never fail the rollback.
    try {
        const { pushPolicyToSharePoint } = await import('./policy-sharepoint-sync');
        await pushPolicyToSharePoint(ctx, policyId);
    } catch (err) {
        const { edgeLogger } = await import('@/lib/observability/edge-logger');
        edgeLogger.error('Policy rollback: SharePoint push failed', {
            component: 'sharepoint',
            policyId,
            error: err instanceof Error ? err.message : String(err),
        });
    }

    // The transaction now also carries the ack-campaign bookkeeping; callers
    // still expect just the policy.
    return result.rolledBack;
}

export async function archivePolicy(ctx: RequestContext, policyId: string) {
    assertCanAdminPolicies(ctx);

    return runInTenantContext(ctx, async (db) => {
        const policy = await PolicyRepository.getById(db, ctx, policyId);
        if (!policy) throw notFound('Policy not found');

        await PolicyRepository.updateStatus(db, ctx, policyId, 'ARCHIVED');

        await logEvent(db, ctx, {
            action: 'POLICY_ARCHIVED',
            entityType: 'Policy',
            entityId: policyId,
            details: `Policy archived: ${policy.title}`,
            detailsJson: {
                category: 'status_change',
                entityName: 'Policy',
                fromStatus: policy.status,
                toStatus: 'ARCHIVED',
            },
        });

        return { success: true };
    });
}

// ─── Soft Delete / Restore / Purge ───

import { restoreEntity, purgeEntity } from './soft-delete-operations';
import { withDeleted } from '@/lib/soft-delete';

export async function deletePolicy(ctx: RequestContext, id: string) {
    assertCanAdminPolicies(ctx);
    return runInTenantContext(ctx, async (db) => {
        const policy = await PolicyRepository.getById(db, ctx, id);
        if (!policy) throw notFound('Policy not found');

        await db.policy.delete({ where: { id } });

        await logEvent(db, ctx, {
            action: 'SOFT_DELETE',
            entityType: 'Policy',
            entityId: id,
            details: `Policy soft-deleted: ${policy.title}`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'Policy',
                operation: 'deleted',
                before: { title: policy.title, status: policy.status },
                summary: `Policy soft-deleted: ${policy.title}`,
            },
        });
        return { success: true };
    });
}

/**
 * Reverse an archive — the missing half of `archivePolicy`.
 *
 * Archiving is a STATUS transition (`status: 'ARCHIVED'`) and, until now, a
 * ONE-WAY DOOR: nothing anywhere set the status back. The two paths that write
 * DRAFT (`createPolicyVersion` and a rejected approval) both refuse archived
 * policies outright, so an archived policy could not be edited, reviewed,
 * published, or recovered by any route.
 *
 * NOT to be confused with `restorePolicy`, which reverses a SOFT DELETE
 * (`deletedAt`). Those are independent axes — a policy can be archived without
 * being deleted, and `/restore` does nothing for an archived one.
 *
 * Lands in DRAFT, deliberately, rather than the status it held before.
 * Restoring straight to PUBLISHED would put a live document back in front of
 * users — and re-open acknowledgement obligations — without passing the
 * approval gate. DRAFT means the normal review path applies, which is the
 * conservative reading of "undo the archive".
 */
export async function unarchivePolicy(ctx: RequestContext, policyId: string) {
    assertCanAdminPolicies(ctx);

    return runInTenantContext(ctx, async (db) => {
        const policy = await PolicyRepository.getById(db, ctx, policyId);
        if (!policy) throw notFound('Policy not found');
        if (policy.status !== 'ARCHIVED') {
            throw conflict('This policy is not archived.');
        }

        await PolicyRepository.updateStatus(db, ctx, policyId, 'DRAFT');

        await logEvent(db, ctx, {
            action: 'POLICY_UNARCHIVED',
            entityType: 'Policy',
            entityId: policyId,
            details: `Restored from archive: ${policy.title}`,
            detailsJson: {
                category: 'status_change',
                entityName: 'Policy',
                fromStatus: 'ARCHIVED',
                toStatus: 'DRAFT',
                reason: 'Restored from archive',
            },
        });

        return PolicyRepository.getById(db, ctx, policyId);
    });
}

export async function restorePolicy(ctx: RequestContext, id: string) {
    return restoreEntity(ctx, 'Policy', id);
}

export async function purgePolicy(ctx: RequestContext, id: string) {
    return purgeEntity(ctx, 'Policy', id);
}

export async function listPoliciesWithDeleted(ctx: RequestContext) {
    assertCanAdminPolicies(ctx);
    return runInTenantContext(ctx, (db) =>
        db.policy.findMany(withDeleted({ where: { tenantId: ctx.tenantId }, orderBy: { createdAt: 'desc' as const } }))
    );
}

// ─── Bulk actions (canonical BulkActionBar rollout — wave B) ───
// Assign owner + Archive only: Policy status is approval-gated (can't reach
// PUBLISHED without going through APPROVED), so there is no bulk status path
// that could bypass the workflow. Archive is the one safe terminal verb and
// keeps `archivePolicy`'s OWNER/ADMIN gate.

export async function bulkAssignPolicy(
    ctx: RequestContext,
    policyIds: string[],
    ownerUserId: string | null,
) {
    assertCanWritePolicies(ctx);
    const updated = await runInTenantContext(ctx, async (db) => {
        // Checked ONCE for the whole batch — the same owner is applied to
        // every id, so a per-row check would repeat one lookup N times.
        await assertOwnerIsActiveMember(db, ctx, ownerUserId);
        const rows = await PolicyRepository.listByIds(db, ctx, policyIds);
        if (rows.length === 0) return 0;
        await PolicyRepository.bulkUpdate(db, ctx, policyIds, {
            ownerUserId: ownerUserId || null,
        });
        for (const r of rows) {
            await logEvent(db, ctx, {
                action: 'POLICY_UPDATED',
                entityType: 'Policy',
                entityId: r.id,
                details: ownerUserId ? `Policy owner reassigned` : `Policy owner cleared`,
                detailsJson: {
                    category: 'entity_lifecycle',
                    entityName: 'Policy',
                    operation: 'updated',
                    changedFields: ['ownerUserId'],
                    after: { ownerUserId: ownerUserId || null },
                    summary: ownerUserId ? `owner reassigned (bulk)` : `owner cleared (bulk)`,
                },
            });
        }
        return rows.length;
    });
    return { updated };
}

/** Bulk soft-delete policies selected in the table action bar. */
export async function bulkDeletePolicy(ctx: RequestContext, policyIds: string[]) {
    assertCanAdminPolicies(ctx);
    return runInTenantContext(ctx, async (db) => {
        const rows = await PolicyRepository.listByIds(db, ctx, policyIds);
        if (rows.length === 0) return { deleted: 0 };
        await db.policy.deleteMany({ where: { id: { in: rows.map((r) => r.id) }, tenantId: ctx.tenantId } });
        for (const r of rows) {
            await logEvent(db, ctx, {
                action: 'SOFT_DELETE',
                entityType: 'Policy',
                entityId: r.id,
                details: 'Policy soft-deleted (bulk)',
                detailsJson: { category: 'entity_lifecycle', entityName: 'Policy', operation: 'deleted', summary: 'Policy soft-deleted' },
            });
        }
        return { deleted: rows.length };
    });
}

export async function bulkArchivePolicy(ctx: RequestContext, policyIds: string[]) {
    assertCanAdminPolicies(ctx);
    const updated = await runInTenantContext(ctx, async (db) => {
        const rows = await PolicyRepository.listByIds(db, ctx, policyIds);
        if (rows.length === 0) return 0;
        await PolicyRepository.bulkUpdate(db, ctx, policyIds, { status: 'ARCHIVED' });
        for (const r of rows) {
            await logEvent(db, ctx, {
                action: 'POLICY_ARCHIVED',
                entityType: 'Policy',
                entityId: r.id,
                details: `Policy archived: ${r.title}`,
                detailsJson: {
                    category: 'status_change',
                    entityName: 'Policy',
                    fromStatus: r.status,
                    toStatus: 'ARCHIVED',
                },
            });
        }
        return rows.length;
    });
    return { updated };
}
