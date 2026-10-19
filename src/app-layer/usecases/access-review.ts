/**
 * Epic G-4 — Access Review Campaign usecases.
 *
 * Two production surfaces in this prompt:
 *
 *   • createAccessReview — admin creates a campaign. Snapshot of the
 *     scope-matching memberships writes into AccessReviewDecision in
 *     the same transaction as the AccessReview row. Initial decision
 *     state is `null` (pending) per the schema; the row's
 *     `snapshotRole` / `snapshotMembershipStatus` freeze the access
 *     state at that moment for evidence purposes.
 *
 *   • submitDecision — the campaign reviewer (OR an admin acting on
 *     their behalf) records CONFIRM / REVOKE / MODIFY against a
 *     pending decision. We DELIBERATELY do not mutate the live
 *     TenantMembership here — the brief is explicit that decision
 *     capture and decision execution are separate phases. Closeout
 *     (the next prompt) is where REVOKE/MODIFY actually act on the
 *     live row.
 *
 * State transitions kept in this file:
 *   - A decision write transitions an OPEN campaign to IN_REVIEW
 *     (one-shot — IN_REVIEW stays IN_REVIEW until explicit closure).
 *   - A CLOSED campaign rejects further decision writes — closure
 *     freezes the decision graph for evidence.
 *
 * Authorization model:
 *   - createAccessReview / list / get → assertCanAdmin. Today access
 *     reviews are an admin-only surface; a future custom-permission
 *     key (`admin.access_reviews`) is a bounded follow-up.
 *   - submitDecision → only the campaign's `reviewerUserId` OR a
 *     tenant admin (admin acts as backup if the reviewer is
 *     unavailable; the audit log captures who).
 *   - closeAccessReview → assertCanAdmin, and OWNER-tier for what is
 *     OWNER-tier on the members page (#3727): a campaign never promotes
 *     to OWNER, never sets a custom role, and lowers an OWNER only when
 *     the closer holds `admin.owner_management`. Each such refusal is
 *     named and writes an audit row (`src/lib/access-review/member-decision-rules.ts`).
 */
import { RequestContext } from '../types';
import { AccessReviewRepository } from '../repositories/AccessReviewRepository';
import { assertCanAdmin, assertCanRead } from '../policies/common';
import { logEvent } from '../events/audit';
import { runInTenantContext } from '@/lib/db-context';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { AppError, badRequest, forbidden, notFound, ConflictError } from '@/lib/errors/types';
import { ZodError } from 'zod';
import {
    BUILT_IN_SCOPE_REFUSAL,
    isAssignableTenantRole,
    isCampaignModifyRole,
    mayCarryCustomRole,
    unassignableRoleMessage,
} from '@/lib/roles';
import {
    MEMBER_DECISION_REFUSAL,
    MEMBER_DECISION_REFUSAL_MESSAGE,
} from '@/lib/access-review/member-decision-rules';
import {
    CreateAccessReviewSchema,
    SubmitDecisionSchema,
    RevokeDecisionSchema,
    type CreateAccessReviewInput,
    type SubmitDecisionInput,
    type RevokeDecisionInput,
} from '../schemas/access-review.schemas';
import type { Role, MembershipStatus } from '@prisma/client';
import { generateAccessReviewPdf } from '../reports/pdf/accessReview';
import { collectPdfBuffer } from '../reports/pdf/collect-buffer';
import { getStorageProvider, buildTenantObjectKey } from '@/lib/storage';
import { Readable } from 'node:stream';
import { logger } from '@/lib/observability/logger';
import { isMemberScope, mayReadAgentSubjects } from '@/lib/access-review/scope';
import { assertNotAgentCampaign } from './access-review-scope-gate';

// ─── Read paths ───────────────────────────────────────────────────────

/**
 * An AGENT campaign's subjects, narrowed to the readers who may see them.
 *
 * Every role holds `access_reviews.view`; the agent register is read under
 * `admin.agent_registry`, which READER, EDITOR and AUDITOR do not hold. An
 * AGENT subject row is register data — the agent's name, its owner, what it is
 * granted — so a caller who is neither the campaign's reviewer nor a register
 * reader gets the rows with that data removed: the campaign, its status and its
 * progress counts stay visible, and `subjectsRestricted` says why the rest is
 * not. Every other scope passes through untouched.
 *
 * Applied in deploy 1 (#3674) although deploy 1 creates no AGENT campaign: a
 * container running this build serves reads during deploy 2's rollout, which
 * is when such rows first exist.
 */
export function narrowAgentSubjects<
    R extends {
        scope: string;
        reviewerUserId: string;
        connectedDecisions?: ReadonlyArray<{ snapshotJson: unknown; subjectRef: string; notes: string | null }>;
    },
>(ctx: RequestContext, review: R): R & { subjectsRestricted: boolean } {
    if (review.scope !== 'AGENT') return { ...review, subjectsRestricted: false };
    const allowed = mayReadAgentSubjects({
        userId: ctx.userId,
        reviewerUserId: review.reviewerUserId,
        holdsAgentRegistry: ctx.appPermissions?.admin?.agent_registry === true,
    });
    if (allowed || !review.connectedDecisions) return { ...review, subjectsRestricted: false };
    // Each row keeps its own type — every field this replaces is nullable or a
    // string on the row — so the cast restores the generic the spread erased,
    // and asserts nothing the values do not already satisfy.
    const connectedDecisions = review.connectedDecisions.map((d) => ({
        ...d,
        snapshotJson: null,
        subjectRef: 'agent',
        notes: null,
    })) as unknown as R['connectedDecisions'];
    return { ...review, connectedDecisions, subjectsRestricted: true };
}

export async function listAccessReviews(
    ctx: RequestContext,
    options: { take?: number; status?: 'OPEN' | 'IN_REVIEW' | 'CLOSED' } = {},
) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, (db) =>
        AccessReviewRepository.list(db, ctx, options),
    );
}

export async function getAccessReview(ctx: RequestContext, id: string) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, async (db) => {
        const review = await AccessReviewRepository.getById(db, ctx, id);
        if (!review) throw notFound('Access review not found');
        return narrowAgentSubjects(ctx, review);
    });
}

/**
 * Detail-with-activity — the review page wants the full decision
 * graph PLUS the per-subject "last activity" signal. Single round
 * trip from the route's perspective, two queries inside.
 */
export async function getAccessReviewWithActivity(
    ctx: RequestContext,
    id: string,
) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, async (db) => {
        const review = await AccessReviewRepository.getById(db, ctx, id);
        if (!review) throw notFound('Access review not found');
        const userIds = review.decisions.map((d) => d.subjectUserId);
        const lastActivityByUser = await AccessReviewRepository.getLastActivityByUser(
            db,
            ctx,
            userIds,
        );
        return { ...narrowAgentSubjects(ctx, review), lastActivityByUser };
    });
}

// ─── createAccessReview ───────────────────────────────────────────────

export interface CreateAccessReviewResult {
    accessReviewId: string;
    snapshotCount: number;
}

/**
 * Snapshot the scope-matching memberships into AccessReviewDecision
 * rows the moment the campaign is created. Two-step inside one
 * tenant context:
 *
 *   1. Resolve the snapshot population (ALL_USERS / ADMIN_ONLY /
 *      CUSTOM). Empty population is a 400 — a campaign with zero
 *      subjects is meaningless.
 *   2. Insert the AccessReview + the per-subject snapshot rows.
 *
 * Both steps run inside the same `runInTenantContext` block so RLS
 * is in effect and a partial failure rolls back. We do NOT use a
 * Prisma `$transaction` block because `runInTenantContext` already
 * pins the per-statement tenant context — wrapping it in a nested
 * tx would lose that binding.
 */
export async function createAccessReview(
    ctx: RequestContext,
    input: unknown,
): Promise<CreateAccessReviewResult> {
    assertCanAdmin(ctx);

    const parsed: CreateAccessReviewInput = CreateAccessReviewSchema.parse(input);

    return runInTenantContext(ctx, async (db) => {
        const memberships = await AccessReviewRepository.resolveMembershipsForScope(
            db,
            ctx,
            parsed.scope,
            parsed.customMembershipIds,
        );

        if (memberships.length === 0) {
            throw badRequest(
                parsed.scope === 'CUSTOM'
                    ? 'None of the supplied membership ids are eligible (active/invited within this tenant). Refresh the list and try again.'
                    : 'No memberships matched the requested scope — the campaign would have zero subjects.',
            );
        }

        // CUSTOM scope: detect IDs the caller passed that didn't
        // match an eligible membership. Keep the campaign creation
        // path strict — silently dropping IDs would let a stale UI
        // produce a campaign that doesn't review who the operator
        // thought it would.
        if (parsed.scope === 'CUSTOM' && parsed.customMembershipIds) {
            const found = new Set(memberships.map((m) => m.id));
            const missing = parsed.customMembershipIds.filter((id) => !found.has(id));
            if (missing.length > 0) {
                throw badRequest(
                    `Some membership ids are not eligible (deactivated, removed, or not in this tenant): ${missing.join(', ')}`,
                );
            }
        }

        const review = await AccessReviewRepository.create(db, ctx, {
            name: sanitizePlainText(parsed.name),
            description: parsed.description ? sanitizePlainText(parsed.description) : null,
            scope: parsed.scope,
            periodStartAt: parsed.periodStartAt ?? null,
            periodEndAt: parsed.periodEndAt ?? null,
            reviewerUserId: parsed.reviewerUserId,
            dueAt: parsed.dueAt ?? null,
        });

        const snapshotCount = await AccessReviewRepository.bulkCreateDecisions(
            db,
            ctx,
            review.id,
            memberships.map((m) => ({
                membershipId: m.id,
                subjectUserId: m.userId,
                snapshotRole: m.role as Role,
                snapshotCustomRoleId: m.customRoleId,
                snapshotMembershipStatus: m.status as MembershipStatus,
            })),
        );

        // Audit OUTSIDE the runInTenantContext closure isn't strictly
        // necessary — appendAuditEntry uses the global Prisma client
        // and writes its own per-tenant chain — but emitting from
        // inside keeps the success-trail tight and avoids the
        // "audit row exists for a transaction that rolled back"
        // anti-pattern.
        await logEvent(db, ctx, {
            action: 'ACCESS_REVIEW_CREATED',
            entityType: 'AccessReview',
            entityId: review.id,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'AccessReview',
                operation: 'create',
                summary: `Access review "${review.name}" created with ${snapshotCount} subject(s)`,
                after: {
                    name: review.name,
                    scope: parsed.scope,
                    snapshotCount,
                    reviewerUserId: parsed.reviewerUserId,
                    periodStartAt: parsed.periodStartAt?.toISOString() ?? null,
                    periodEndAt: parsed.periodEndAt?.toISOString() ?? null,
                    dueAt: parsed.dueAt?.toISOString() ?? null,
                },
            },
        });

        return { accessReviewId: review.id, snapshotCount };
    });
}

// ─── Named refusals and their audit rows (#3727) ──────────────────────

/**
 * The reasons a member campaign refuses a decision or a close BY NAME. Each
 * refusal writes an audit row as well as the error, because each is an attempt
 * at something OWNER-tier (a promotion to OWNER, a custom-role grant, an
 * OWNER's demotion) that the product refused.
 */
const NAMED_CAMPAIGN_REFUSALS: ReadonlySet<string> = new Set([
    ...Object.values(MEMBER_DECISION_REFUSAL),
    BUILT_IN_SCOPE_REFUSAL,
]);

/** The named reason a refusal carries, from a usecase error or a schema issue; `null` for any other error. */
function namedCampaignRefusalOf(err: unknown): string | null {
    if (err instanceof AppError) {
        const reason = (err.details as { reason?: unknown } | undefined)?.reason;
        return typeof reason === 'string' && NAMED_CAMPAIGN_REFUSALS.has(reason) ? reason : null;
    }
    if (err instanceof ZodError) {
        for (const issue of err.issues) {
            const reason = (issue as { params?: { reason?: unknown } }).params?.reason;
            if (typeof reason === 'string' && NAMED_CAMPAIGN_REFUSALS.has(reason)) return reason;
        }
    }
    return null;
}

/**
 * Write the refusal's audit row, in its OWN transaction: a close refusal is
 * thrown from inside the close's, which rolls back, and nothing the refused
 * attempt touched may be committed except this record of it.
 */
async function auditCampaignRefusal(
    ctx: RequestContext,
    row: { action: string; entityType: string; entityId: string; reason: string; decisionIds?: string[] },
): Promise<void> {
    await runInTenantContext(ctx, (db) =>
        logEvent(db, ctx, {
            action: row.action,
            entityType: row.entityType,
            entityId: row.entityId,
            detailsJson: {
                category: 'access',
                entityName: row.entityType,
                operation: 'refused',
                summary: `${row.action}: ${row.reason}`,
                after: { reason: row.reason, ...(row.decisionIds ? { decisionIds: row.decisionIds } : {}) },
            },
        }),
    );
}

/**
 * The submit path's refusal: audit a named one, then rethrow `err` unchanged.
 * The decision route calls it when `parseJsonBody` refuses the body, and
 * `submitDecision` when its own parse does, so a refusal is recorded whichever
 * caller reached the schema first — and only once.
 */
export async function recordDecisionSubmissionRefusal(
    ctx: RequestContext,
    decisionId: string,
    err: unknown,
): Promise<never> {
    const reason = namedCampaignRefusalOf(err);
    if (reason) {
        await auditCampaignRefusal(ctx, {
            action: 'ACCESS_REVIEW_DECISION_REFUSED',
            entityType: 'AccessReviewDecision',
            entityId: decisionId,
            reason,
        });
    }
    throw err;
}

/** A close refusal naming its reason and the decisions that carry it. */
function closeRefusal(
    kind: 'conflict' | 'forbidden',
    reason: string,
    explanation: string,
    decisionIds: string[],
    remedy: string,
): AppError {
    const message =
        `Cannot close: ${decisionIds.length} decision(s) refused — ${reason}. ${explanation} ` +
        `${remedy} Decision(s): ${decisionIds.join(', ')}.`;
    const details = { reason, decisionIds };
    return kind === 'forbidden' ? forbidden(message, details) : new ConflictError(message, details);
}

const RE_RECORD = 'Revoke the decision(s) and record them again.';

/** The close path's refusal: audit a named one (after the close's transaction rolled back), then rethrow. */
async function recordCloseRefusal(ctx: RequestContext, accessReviewId: string, err: unknown): Promise<never> {
    const reason = namedCampaignRefusalOf(err);
    if (reason) {
        const decisionIds = (err as AppError & { details?: { decisionIds?: string[] } }).details?.decisionIds;
        await auditCampaignRefusal(ctx, {
            action: 'ACCESS_REVIEW_CLOSE_REFUSED',
            entityType: 'AccessReview',
            entityId: accessReviewId,
            reason,
            decisionIds,
        });
    }
    throw err;
}

// ─── submitDecision ───────────────────────────────────────────────────

export interface SubmitDecisionResult {
    decisionId: string;
    accessReviewId: string;
    decision: 'CONFIRM' | 'REVOKE' | 'MODIFY';
    /// True if this submission transitioned the campaign from OPEN
    /// → IN_REVIEW (i.e. it was the first decision).
    transitionedToInReview: boolean;
}

/**
 * Reviewer (or admin acting on their behalf) records a verdict
 * against ONE pending decision. Live TenantMembership is NOT
 * touched — execution is the closeout-phase usecase.
 *
 * Idempotency contract: re-submitting the SAME verdict against an
 * already-decided row is rejected as 400 to make accidental
 * double-clicks visible. A future "change verdict before close"
 * affordance can be added as a separate `revokeDecision` usecase.
 */
export async function submitDecision(
    ctx: RequestContext,
    decisionId: string,
    input: unknown,
): Promise<SubmitDecisionResult> {
    assertCanRead(ctx);
    const result = SubmitDecisionSchema.safeParse(input);
    if (!result.success) return recordDecisionSubmissionRefusal(ctx, decisionId, result.error);
    const parsed: SubmitDecisionInput = result.data;

    return runInTenantContext(ctx, async (db) => {
        const decision = await AccessReviewRepository.getDecision(db, ctx, decisionId);
        if (!decision) throw notFound('Decision not found');

        const review = decision.accessReview;
        if (!review || review.deletedAt !== null) {
            throw notFound('Access review not found');
        }
        if (review.status === 'CLOSED') {
            throw badRequest(
                'This campaign is closed; decisions are immutable.',
            );
        }

        // Reviewer identity gate. Admin acts as backup so a vacationing
        // reviewer doesn't block compliance evidence — the audit log
        // captures the actual actor.
        const isAssignedReviewer = review.reviewerUserId === ctx.userId;
        const isAdmin = ctx.permissions.canAdmin;
        if (!isAssignedReviewer && !isAdmin) {
            throw forbidden(
                'Only the assigned reviewer (or a tenant admin) may submit decisions for this campaign.',
            );
        }

        if (decision.decision !== null) {
            throw badRequest(
                'This decision has already been recorded. Re-recording is not supported in this phase.',
            );
        }

        const now = new Date();
        const updateCount = await AccessReviewRepository.updateDecision(
            db,
            ctx,
            decisionId,
            {
                decision: parsed.decision,
                decidedAt: now,
                decidedByUserId: ctx.userId,
                notes: parsed.notes ? sanitizePlainText(parsed.notes) : null,
                modifiedToRole:
                    parsed.decision === 'MODIFY' ? parsed.modifiedToRole : null,
                // A campaign MODIFY never sets a custom role (#3727); the schema
                // refuses one, so the column only ever records "none".
                modifiedToCustomRoleId: null,
            },
        );
        if (updateCount === 0) {
            // Concurrent delete or RLS reject. Surface the same
            // shape as the initial lookup so the caller can retry
            // cleanly.
            throw notFound('Decision not found');
        }

        // Lifecycle transition. OPEN → IN_REVIEW the moment any
        // decision lands. IN_REVIEW stays IN_REVIEW (no flip-back).
        let transitionedToInReview = false;
        if (review.status === 'OPEN') {
            await AccessReviewRepository.setReviewStatus(db, ctx, review.id, 'IN_REVIEW');
            transitionedToInReview = true;
        }

        await logEvent(db, ctx, {
            action: 'ACCESS_REVIEW_DECISION_SUBMITTED',
            entityType: 'AccessReviewDecision',
            entityId: decisionId,
            detailsJson: {
                /// 'access' is the canonical category for any audit
                /// row that records a privilege-changing decision —
                /// SIEM operators already filter on it for
                /// authn/authz reviews.
                category: 'access',
                entityName: 'AccessReviewDecision',
                operation: 'submit',
                summary: `Reviewer recorded ${parsed.decision} on decision ${decisionId}`,
                targetUserId: decision.subjectUserId,
                after: {
                    accessReviewId: review.id,
                    decision: parsed.decision,
                    ...(parsed.decision === 'MODIFY'
                        ? { modifiedToRole: parsed.modifiedToRole }
                        : {}),
                    /// Don't ship the notes string to the structured
                    /// stream — auditors get it from the row, the
                    /// stream only needs the boolean signal.
                    hasNotes: Boolean(parsed.notes),
                    actorIsAssignedReviewer: isAssignedReviewer,
                    transitionedToInReview,
                },
            },
        });

        return {
            decisionId,
            accessReviewId: review.id,
            decision: parsed.decision,
            transitionedToInReview,
        };
    });
}

// ─── revokeDecision ───────────────────────────────────────────────────

export interface RevokeDecisionResult {
    decisionId: string;
    accessReviewId: string;
}

/**
 * Audit Coherence S7 (2026-05-24) — reset a submitted decision back
 * to pending.
 *
 * Before this usecase, `submitDecision` flat-out refused any second
 * write to a decision row ("Re-recording is not supported"). That
 * left reviewers no way to fix a typo'd verdict short of an admin
 * + DB intervention. The new flow:
 *
 *   1. Reviewer (or admin acting on their behalf) calls
 *      `revokeDecision(ctx, decisionId, { reason })`.
 *   2. The row's verdict + notes + modify-target fields go null;
 *      `snapshotRole` / `snapshotMembershipStatus` are preserved
 *      so the evidentiary record stays intact.
 *   3. Reviewer re-submits via `submitDecision` with the correct
 *      verdict.
 *
 * Gates (all must hold):
 *   - Decision exists in tenant.
 *   - Campaign is OPEN or IN_REVIEW (CLOSED rejects — decisions are
 *     immutable from closure forward).
 *   - Caller is the assigned reviewer OR a tenant admin.
 *   - Decision has been submitted (else there's nothing to reset).
 *   - Decision has NOT been executed (repo gates on `executedAt:
 *     null`; a closeout-executed row stays an evidentiary fact).
 *
 * Audit:
 *   - Emits `ACCESS_REVIEW_DECISION_REVOKED` with category 'access'
 *     so SIEM operators see the reset alongside the original submit.
 *   - `reason` lands in detailsJson so SOC 2 auditors can review
 *     why the decision was unwound.
 */
export async function revokeDecision(
    ctx: RequestContext,
    decisionId: string,
    input: unknown,
): Promise<RevokeDecisionResult> {
    assertCanRead(ctx);
    const parsed: RevokeDecisionInput = RevokeDecisionSchema.parse(input);
    const reason = sanitizePlainText(parsed.reason);

    return runInTenantContext(ctx, async (db) => {
        const decision = await AccessReviewRepository.getDecision(
            db,
            ctx,
            decisionId,
        );
        if (!decision) throw notFound('Decision not found');

        const review = decision.accessReview;
        if (!review || review.deletedAt !== null) {
            throw notFound('Access review not found');
        }
        if (review.status === 'CLOSED') {
            throw badRequest(
                'This campaign is closed; decisions are immutable.',
            );
        }

        const isAssignedReviewer = review.reviewerUserId === ctx.userId;
        const isAdmin = ctx.permissions.canAdmin;
        if (!isAssignedReviewer && !isAdmin) {
            throw forbidden(
                'Only the assigned reviewer (or a tenant admin) may revoke decisions for this campaign.',
            );
        }

        if (decision.decision === null) {
            throw badRequest(
                'This decision has not been recorded; nothing to revoke.',
            );
        }
        if (decision.executedAt !== null) {
            throw badRequest(
                'This decision has been executed and cannot be revoked.',
            );
        }

        const priorDecision = decision.decision;
        const count = await AccessReviewRepository.resetDecision(
            db,
            ctx,
            decisionId,
        );
        if (count === 0) {
            // Either the row was concurrently executed (executedAt
            // flipped non-null between the gate above and the
            // update) or RLS pushed it out of view. Both surface as
            // notFound so the caller can retry cleanly.
            throw notFound('Decision not found');
        }

        await logEvent(db, ctx, {
            action: 'ACCESS_REVIEW_DECISION_REVOKED',
            entityType: 'AccessReviewDecision',
            entityId: decisionId,
            detailsJson: {
                category: 'access',
                entityName: 'AccessReviewDecision',
                operation: 'revoke',
                summary: `Reviewer revoked prior ${priorDecision} verdict on decision ${decisionId}`,
                targetUserId: decision.subjectUserId,
                before: {
                    decision: priorDecision,
                },
                after: {
                    decision: null,
                },
                accessReviewId: review.id,
                actorIsAssignedReviewer: isAssignedReviewer,
                reason,
            },
        });

        return { decisionId, accessReviewId: review.id };
    });
}

// ─── closeAccessReview ────────────────────────────────────────────────

/**
 * Per-decision execution outcome label. Surfaced on every audit
 * row + every PDF table cell.
 *
 *   EXECUTED            — REVOKE applied (membership deactivated) or
 *                          MODIFY applied (role/customRole updated).
 *   NO_CHANGE           — CONFIRM verdict; the membership row was
 *                          intentionally left untouched.
 *   SKIPPED_PENDING     — decision was null at close time.
 *                          (Today closeout rejects pending decisions
 *                          outright; this label is reserved for a
 *                          future "force-close with auto-confirm"
 *                          mode and always present in the schema for
 *                          forward compatibility.)
 *   SKIPPED_STALE       — live membership had been deleted/changed
 *                          out from under the campaign.
 *   SKIPPED_LAST_OWNER  — execution would have left zero ACTIVE
 *                          OWNERs in the tenant; the row was held
 *                          back to preserve the safety invariant.
 *                          The DB trigger is also a backstop — this
 *                          label is for the planned-skip path.
 */
export type ExecutionOutcome =
    | 'EXECUTED'
    | 'NO_CHANGE'
    | 'SKIPPED_PENDING'
    | 'SKIPPED_STALE'
    | 'SKIPPED_LAST_OWNER';

export interface DecisionExecutionResult {
    decisionId: string;
    subjectUserId: string;
    decision: 'CONFIRM' | 'REVOKE' | 'MODIFY' | null;
    outcome: ExecutionOutcome;
}

export interface CloseAccessReviewResult {
    accessReviewId: string;
    executions: DecisionExecutionResult[];
    /// FileRecord id of the generated PDF artifact, or `null` if
    /// generation/storage failed and the campaign was closed without
    /// a linked artifact (operator-triggered regenerate is the
    /// follow-up path).
    evidenceFileRecordId: string | null;
    /// Counts derived from `executions` — surfaced for callers that
    /// don't want to re-walk the array.
    counts: {
        total: number;
        executed: number;
        confirmed: number;
        skipped: number;
    };
}

/**
 * Close a campaign — execute REVOKE/MODIFY decisions against live
 * memberships, log every action, and produce a signed PDF artifact.
 *
 * Closure contract (the brief is explicit: not a cosmetic flip):
 *   • Admin-only operation.
 *   • Campaign must be OPEN or IN_REVIEW (not CLOSED, not deleted).
 *   • Every decision row must have a verdict — pending rows reject
 *     the close so the auditor never sees an under-reviewed campaign.
 *   • #3727: a MODIFY to OWNER, a MODIFY carrying a custom role, and —
 *     for a closer without `admin.owner_management` — a REVOKE or MODIFY
 *     of a live OWNER each reject the WHOLE close by name, with an
 *     `ACCESS_REVIEW_CLOSE_REFUSED` audit row.
 *   • Last-OWNER guard runs at the campaign level: if the planned
 *     execution would leave zero ACTIVE OWNERs, the WHOLE close is
 *     rejected. (DB trigger is the per-row backstop.)
 *   • Decisions execute in one tenant context with per-row error
 *     handling — a stale subject doesn't poison the rest of the
 *     campaign. CONFIRM is recorded as a deliberate no-op.
 *   • Campaign status flips to CLOSED in the SAME context after
 *     all per-row mutations land.
 *   • PDF generation + storage runs after close. Failure here keeps
 *     the campaign CLOSED with `evidenceFileRecordId = null`; the
 *     operator gets a regeneration affordance later.
 */
export async function closeAccessReview(
    ctx: RequestContext,
    accessReviewId: string,
): Promise<CloseAccessReviewResult> {
    assertCanAdmin(ctx);

    // Phase 1 — execute decisions + flip status. All inside one
    // tenant context so RLS is in effect for every statement.
    const phase1 = await runInTenantContext(ctx, async (db) => {
        const review = await db.accessReview.findFirst({
            where: { id: accessReviewId, tenantId: ctx.tenantId },
            include: {
                reviewer: { select: { email: true } },
                createdBy: { select: { email: true } },
            },
        });
        if (!review || review.deletedAt !== null) {
            throw notFound('Access review not found');
        }
        if (review.status === 'CLOSED') {
            throw badRequest('Campaign is already closed.');
        }
        // The MEMBER close, and only the member close. It has no zero-subject
        // guard of its own — the member creation refuses an empty scope instead
        // — so a campaign whose subjects live in the OTHER table would close
        // here over zero member rows and produce evidence that nobody was
        // reviewed. AGENT is refused by name; the connected scopes close
        // through `closeConnectedAccessReview`.
        if (!isMemberScope(review.scope)) {
            assertNotAgentCampaign(review.scope, 'close');
            throw badRequest(
                `A ${review.scope} campaign does not close through the member flow; its subjects are not tenant memberships.`,
            );
        }

        const decisions = await AccessReviewRepository.getDecisionsForExecution(
            db,
            ctx,
            accessReviewId,
        );

        // Reject pending decisions so closeout always represents a
        // complete reviewer judgment.
        const pending = decisions.filter((d) => d.decision === null);
        if (pending.length > 0) {
            throw badRequest(
                `Cannot close: ${pending.length} decision(s) are still pending. ` +
                    `Every subject must be CONFIRMed, REVOKEd, or MODIFYd before close.`,
            );
        }

        // A MODIFY whose target role no campaign may write (AI_ADMIN, #3699:
        // a review never promotes to it) refuses the whole close BEFORE any
        // row executes, like a pending decision. `SubmitDecisionSchema`
        // refuses it at submission; this is the read-side half, for a row
        // stored around the schema.
        const unassignable = decisions.find(
            (d) =>
                d.decision === 'MODIFY' &&
                d.modifiedToRole !== null &&
                !isAssignableTenantRole(d.modifiedToRole),
        );
        if (unassignable?.modifiedToRole) {
            throw badRequest(
                `Cannot close: a MODIFY decision targets a role that cannot be written. ` +
                    unassignableRoleMessage(unassignable.modifiedToRole),
            );
        }

        // ── #3727 — what a campaign may do to a membership ──────────────
        //
        // Each rule refuses the WHOLE close, before any row executes, and
        // names its reason and the decisions that carry it — like a pending
        // decision. A decision stored before the rule (an open campaign
        // decided earlier) is refused here, never applied and never dropped:
        // a CLOSED campaign is immutable, so a decision skipped at close
        // could never be carried out, and the sealed evidence would record a
        // reviewer's verdict nobody acted on. The campaign stays open; the
        // message says who may close it, or which decisions to re-record.
        const modifies = decisions.filter((d) => d.decision === 'MODIFY');

        // 1. A campaign never promotes anyone to OWNER.
        const toOwner = modifies.filter(
            (d) => d.modifiedToRole !== null && !isCampaignModifyRole(d.modifiedToRole),
        );
        if (toOwner.length > 0) {
            throw closeRefusal(
                'conflict',
                MEMBER_DECISION_REFUSAL.NEVER_PROMOTES_TO_OWNER,
                MEMBER_DECISION_REFUSAL_MESSAGE.CAMPAIGN_NEVER_PROMOTES_TO_OWNER,
                toOwner.map((d) => d.id),
                RE_RECORD,
            );
        }

        // 2. A MODIFY sets a built-in role only, never a custom role.
        const withCustomRole = modifies.filter((d) => d.modifiedToCustomRoleId !== null);
        if (withCustomRole.length > 0) {
            throw closeRefusal(
                'conflict',
                MEMBER_DECISION_REFUSAL.MODIFY_SETS_NO_CUSTOM_ROLE,
                MEMBER_DECISION_REFUSAL_MESSAGE.CAMPAIGN_MODIFY_SETS_NO_CUSTOM_ROLE,
                withCustomRole.map((d) => d.id),
                RE_RECORD,
            );
        }

        // 3. Demoting or revoking an OWNER membership is OWNER-tier. Judged on
        //    the LIVE role, because that is what the write changes: a subject
        //    promoted to OWNER since the snapshot is held, one demoted since is
        //    not. With (1) in force, every MODIFY of an OWNER lowers it.
        const lowersAnOwner = decisions.filter(
            (d) =>
                (d.decision === 'REVOKE' || d.decision === 'MODIFY') &&
                d.membership?.role === 'OWNER',
        );
        if (lowersAnOwner.length > 0 && !ctx.appPermissions.admin.owner_management) {
            throw closeRefusal(
                'forbidden',
                MEMBER_DECISION_REFUSAL.OWNER_SUBJECT_NEEDS_OWNER_CLOSER,
                MEMBER_DECISION_REFUSAL_MESSAGE.OWNER_SUBJECT_NEEDS_OWNER_CLOSER,
                lowersAnOwner.map((d) => d.id),
                'Ask an OWNER to close it, or revoke those decisions and record them again.',
            );
        }

        // 4. A REVOKE cannot execute on a legacy membership that holds a role
        //    which carries no custom role and still carries one (#3720): the
        //    CHECK refuses every UPDATE of that row except the clear. Named
        //    here rather than surfacing as a database error mid-close. (A
        //    MODIFY of such a row writes `customRoleId: null` and satisfies it.)
        const revokesLegacyRow = decisions.filter(
            (d) =>
                d.decision === 'REVOKE' &&
                d.membership !== null &&
                !mayCarryCustomRole(d.membership.role) &&
                d.membership.customRoleId !== null,
        );
        if (revokesLegacyRow.length > 0) {
            throw closeRefusal(
                'conflict',
                BUILT_IN_SCOPE_REFUSAL,
                'The membership holds a role that carries no custom role but still carries one ' +
                    '(data from before #3720), and the database refuses every change to it except ' +
                    'removing the custom role.',
                revokesLegacyRow.map((d) => d.id),
                'An OWNER removes the custom role on the members page, then the campaign closes.',
            );
        }

        // Live OWNER count. We need this BEFORE executing any row so
        // the planned post-execution count can be checked.
        const liveOwners = await db.tenantMembership.findMany({
            where: {
                tenantId: ctx.tenantId,
                role: 'OWNER',
                status: 'ACTIVE',
            },
            select: { id: true, userId: true },
        });
        const liveOwnerIds = new Set(liveOwners.map((m) => m.id));

        // Plan: which OWNER memberships would lose OWNER after exec? A REVOKE
        // deactivates one and a MODIFY lowers one; nothing GAINS OWNER, because
        // a campaign never promotes to it (rule 1 above, #3727).
        let projectedOwnerLoss = 0;
        for (const d of decisions) {
            if (!d.membership) continue; // stale — won't execute anyway
            if (!liveOwnerIds.has(d.membership.id)) continue;
            if (d.decision === 'REVOKE' || d.decision === 'MODIFY') {
                projectedOwnerLoss += 1;
            }
        }
        const projectedOwnerCount = liveOwners.length - projectedOwnerLoss;
        if (liveOwners.length > 0 && projectedOwnerCount <= 0) {
            throw forbidden(
                `Cannot close: executing the planned decisions would leave the tenant with ` +
                    `zero ACTIVE OWNERs (would go from ${liveOwners.length} to ${projectedOwnerCount}). ` +
                    `Promote another OWNER first or change the campaign's REVOKE/MODIFY decisions.`,
            );
        }

        const executions: DecisionExecutionResult[] = [];
        const now = new Date();

        for (const d of decisions) {
            // Defensive type-narrow: pending was rejected upstream.
            if (d.decision === null) continue;

            let outcome: ExecutionOutcome;
            const auditMutation: Record<string, unknown> = {};

            if (!d.membership) {
                outcome = 'SKIPPED_STALE';
            } else if (d.decision === 'CONFIRM') {
                outcome = 'NO_CHANGE';
            } else if (d.decision === 'REVOKE') {
                try {
                    await db.tenantMembership.update({
                        where: { id: d.membership.id },
                        data: {
                            status: 'DEACTIVATED',
                            deactivatedAt: now,
                        },
                    });
                    outcome = 'EXECUTED';
                    auditMutation.fromStatus = d.membership.status;
                    auditMutation.toStatus = 'DEACTIVATED';
                } catch (err) {
                    /// DB trigger `tenant_membership_last_owner_guard`
                    /// raises P0001. Surface as the planned-skip
                    /// label so the audit + PDF agree on the cause.
                    if (
                        err instanceof Error &&
                        /last.*OWNER|P0001/i.test(err.message)
                    ) {
                        outcome = 'SKIPPED_LAST_OWNER';
                    } else {
                        throw err;
                    }
                }
            } else {
                // MODIFY
                try {
                    // The built-in role and nothing else (#3727). The custom
                    // role is CLEARED, as it always was for a MODIFY naming
                    // none: a custom role replaces the role at resolution,
                    // so leaving it would make the MODIFY change nothing the
                    // member can do. Recorded, so the audit row says so.
                    await db.tenantMembership.update({
                        where: { id: d.membership.id },
                        data: {
                            role: d.modifiedToRole as Role,
                            customRoleId: null,
                        },
                    });
                    outcome = 'EXECUTED';
                    auditMutation.fromRole = d.membership.role;
                    auditMutation.toRole = d.modifiedToRole;
                    if (d.membership.customRoleId !== null) {
                        auditMutation.clearedCustomRoleId = d.membership.customRoleId;
                    }
                } catch (err) {
                    if (
                        err instanceof Error &&
                        /last.*OWNER|P0001/i.test(err.message)
                    ) {
                        outcome = 'SKIPPED_LAST_OWNER';
                    } else {
                        throw err;
                    }
                }
            }

            // Mark the decision row as executed regardless of
            // outcome — the EXECUTED column means "we ran the
            // closeout step against this row", not "the live
            // membership changed". The outcome label captures the
            // detail, and the audit log carries everything.
            await AccessReviewRepository.markDecisionExecuted(
                db,
                ctx,
                d.id,
                now,
            );

            await logEvent(db, ctx, {
                action: 'ACCESS_REVIEW_DECISION_EXECUTED',
                entityType: 'AccessReviewDecision',
                entityId: d.id,
                detailsJson: {
                    category: 'access',
                    entityName: 'TenantMembership',
                    operation: 'execute',
                    summary: `Closeout executed ${d.decision} on subject ${d.subjectUser.email} → ${outcome}`,
                    targetUserId: d.subjectUserId,
                    after: {
                        accessReviewId,
                        decision: d.decision,
                        outcome,
                        membershipId: d.membership?.id ?? null,
                        ...auditMutation,
                    },
                },
            });

            executions.push({
                decisionId: d.id,
                subjectUserId: d.subjectUserId,
                decision: d.decision,
                outcome,
            });
        }

        // Flip the campaign status. evidenceFileRecordId is set in
        // phase 2 so a PDF failure doesn't prevent the close.
        await AccessReviewRepository.closeCampaign(
            db,
            ctx,
            accessReviewId,
            now,
        );

        await logEvent(db, ctx, {
            action: 'ACCESS_REVIEW_CLOSED',
            entityType: 'AccessReview',
            entityId: accessReviewId,
            detailsJson: {
                category: 'status_change',
                entityName: 'AccessReview',
                fromStatus: review.status,
                toStatus: 'CLOSED',
                summary: `Closed campaign "${review.name}" with ${executions.length} decision execution(s)`,
                after: {
                    counts: {
                        total: executions.length,
                        executed: executions.filter(
                            (e) => e.outcome === 'EXECUTED',
                        ).length,
                        confirmed: executions.filter(
                            (e) => e.outcome === 'NO_CHANGE',
                        ).length,
                        skipped: executions.filter((e) =>
                            e.outcome.startsWith('SKIPPED_'),
                        ).length,
                    },
                },
            },
        });

        // PDF metadata fetched here so phase 2 can stay outside the
        // tenant context (PDF write hits external storage; failures
        // mustn't roll back the close). The tenant + closer rows are
        // tenant-scoped reads — pulling them through `db` keeps the
        // RLS-bound contract intact and avoids importing the global
        // prisma client (CI guardrail forbids it in tenant code).
        const tenantRow = await db.tenant.findUnique({
            where: { id: ctx.tenantId },
            select: { name: true },
        });
        const closerRow = await db.user.findUnique({
            where: { id: ctx.userId },
            select: { email: true },
        });

        return {
            review,
            decisions,
            executions,
            closedAt: now,
            tenantName: tenantRow?.name ?? 'Tenant',
            closerEmail: closerRow?.email ?? '(unknown)',
        };
    }).catch((err: unknown) => recordCloseRefusal(ctx, accessReviewId, err));

    // Phase 2 — generate + store PDF, link to campaign. Out of the
    // tenant context block because the PDF write hits external
    // storage; failures here MUST NOT roll back the closeout.
    let evidenceFileRecordId: string | null = null;
    try {
        const decisionsForPdf = phase1.decisions.map((d) => {
            const exec = phase1.executions.find((e) => e.decisionId === d.id);
            return {
                subjectUserEmail: d.subjectUser.email,
                subjectUserName: d.subjectUser.name,
                snapshotRole: d.snapshotRole as Role,
                snapshotMembershipStatus:
                    d.snapshotMembershipStatus as MembershipStatus,
                decision: d.decision,
                decidedAtIso: null, // not selected in execution shape; the audit log carries it
                notes: null, // notes is encrypted; closeout PDF stays metadata-only here
                modifiedToRole: d.modifiedToRole as Role | null,
                executionOutcome: exec?.outcome ?? 'SKIPPED_PENDING',
            };
        });

        const pdfDoc = generateAccessReviewPdf({
            tenantName: phase1.tenantName,
            campaignName: phase1.review.name,
            campaignDescription: phase1.review.description ?? null,
            scope: phase1.review.scope,
            periodStartIso:
                phase1.review.periodStartAt?.toISOString() ?? null,
            periodEndIso: phase1.review.periodEndAt?.toISOString() ?? null,
            reviewerEmail: phase1.review.reviewer.email,
            createdByEmail: phase1.review.createdBy.email,
            closedByEmail: phase1.closerEmail,
            closedAtIso: phase1.closedAt.toISOString(),
            decisions: decisionsForPdf,
            watermark: 'FINAL',
        });

        const pdfBuffer = await collectPdfBuffer(pdfDoc);
        const fileName = `access_review_${phase1.review.name.replace(/[^a-z0-9]+/gi, '_')}_${phase1.closedAt.toISOString().slice(0, 10)}.pdf`;
        const storage = getStorageProvider();
        const pathKey = buildTenantObjectKey(
            ctx.tenantId,
            'evidence',
            fileName,
        );
        // Readable already imported at the module top.
        const writeResult = await storage.write(
            pathKey,
            Readable.from(pdfBuffer),
            { mimeType: 'application/pdf' },
        );

        const fileRecord = await runInTenantContext(ctx, async (db) => {
            const record = await db.fileRecord.create({
                data: {
                    tenantId: ctx.tenantId,
                    pathKey,
                    originalName: fileName,
                    mimeType: 'application/pdf',
                    sizeBytes: writeResult.sizeBytes,
                    sha256: writeResult.sha256,
                    status: 'STORED',
                    uploadedByUserId: ctx.userId,
                    storedAt: new Date(),
                    storageProvider: storage.name,
                    domain: 'evidence',
                    /// AV scan is irrelevant for self-generated PDFs.
                    scanStatus: 'SKIPPED',
                },
            });
            await AccessReviewRepository.closeCampaign(
                db,
                ctx,
                accessReviewId,
                phase1.closedAt,
                record.id,
            );
            await logEvent(db, ctx, {
                action: 'ACCESS_REVIEW_EVIDENCE_GENERATED',
                entityType: 'AccessReview',
                entityId: accessReviewId,
                detailsJson: {
                    category: 'entity_lifecycle',
                    entityName: 'FileRecord',
                    operation: 'create',
                    summary: `Generated access-review evidence PDF (sha256=${writeResult.sha256})`,
                    after: {
                        fileRecordId: record.id,
                        pathKey,
                        sizeBytes: writeResult.sizeBytes,
                        sha256: writeResult.sha256,
                    },
                },
            });
            return record;
        });
        evidenceFileRecordId = fileRecord.id;
    } catch (err) {
        // Closeout has already committed. The campaign is CLOSED but
        // its evidence link is null — the operator can re-trigger
        // PDF regeneration in a follow-up.
        logger.error(
            'access-review.closeout.pdf_generation_failed',
            {
                component: 'access-review',
                accessReviewId,
                tenantId: ctx.tenantId,
                error: err instanceof Error ? err.message : String(err),
            },
        );
    }

    return {
        accessReviewId,
        executions: phase1.executions,
        evidenceFileRecordId,
        counts: {
            total: phase1.executions.length,
            executed: phase1.executions.filter((e) => e.outcome === 'EXECUTED')
                .length,
            confirmed: phase1.executions.filter(
                (e) => e.outcome === 'NO_CHANGE',
            ).length,
            skipped: phase1.executions.filter((e) =>
                e.outcome.startsWith('SKIPPED_'),
            ).length,
        },
    };
}

