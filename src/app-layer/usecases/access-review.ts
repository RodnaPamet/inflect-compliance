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
 *   - submitDecision / revokeDecision → only the campaign's
 *     `reviewerUserId` OR a tenant admin (admin acts as backup if the
 *     reviewer is unavailable; the audit log captures who) — and never on
 *     the row whose subject is the caller (#4130): nobody, OWNER
 *     included, records, changes or discards the verdict on their own
 *     access.
 *   - closeAccessReview → assertCanAdmin, and OWNER-tier for what is
 *     OWNER-tier on the members page (#3727, #4130): a campaign never
 *     promotes to OWNER, never sets a custom role, lowers an OWNER or
 *     changes an AI admin's role only when the closer holds
 *     `admin.owner_management`, and never executes a verdict its subject
 *     recorded on themselves. Each such refusal is named and writes an
 *     audit row (`src/lib/access-review/member-decision-rules.ts`).
 *   - updateAccessReviewSettings → assertCanAdmin: the reviewer and the
 *     due date of an open campaign, and nothing else (#4130).
 *   - regenerateAccessReviewEvidence → assertCanAdmin: the evidence PDF of
 *     a CLOSED member campaign whose PDF failed at close, rebuilt from the
 *     stored decisions with the close's own builder (#4130).
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
    isOwnerManagedRole,
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
    UpdateAccessReviewSettingsSchema,
    type CreateAccessReviewInput,
    type SubmitDecisionInput,
    type RevokeDecisionInput,
} from '../schemas/access-review.schemas';
import type { Role, MembershipStatus } from '@prisma/client';
import { generateAccessReviewPdf, type AccessReviewPdfInput } from '../reports/pdf/accessReview';
import { collectPdfBuffer } from '../reports/pdf/collect-buffer';
import { getStorageProvider, buildTenantObjectKey } from '@/lib/storage';
import { Readable } from 'node:stream';
import { logger } from '@/lib/observability/logger';
import { campaignSettingsEditable, isMemberScope, mayReadAgentSubjects } from '@/lib/access-review/scope';
import { assertNotAgentCampaign } from './access-review-scope-gate';
import { assertReviewerIsActiveMember } from './access-review-reviewer';

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
    return runInTenantContext(ctx, async (db) => {
        const rows = await AccessReviewRepository.list(db, ctx, options);
        // The register's Progress column reads `decidedCount` (#4130). It was
        // declared on the client and sent by nothing, so every campaign —
        // closed ones included — read 0 of N.
        const decided = await AccessReviewRepository.countDecidedByReview(
            db,
            ctx,
            rows.map((r) => r.id),
        );
        return rows.map((r) => ({ ...r, decidedCount: decided.get(r.id) ?? 0 }));
    });
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
        // Before the population: a campaign whose reviewer cannot open it is
        // refused whatever it would have covered, and nothing is written.
        await assertReviewerIsActiveMember(db, ctx, parsed.reviewerUserId);

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
 * OWNER's demotion, an AI admin's role change) or at deciding one's own access
 * (#4130) that the product refused.
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

/** The discard path's refusal: audit a named one, then rethrow `err` unchanged. */
async function recordDecisionRevokeRefusal(
    ctx: RequestContext,
    decisionId: string,
    err: unknown,
): Promise<never> {
    const reason = namedCampaignRefusalOf(err);
    if (reason) {
        await auditCampaignRefusal(ctx, {
            action: 'ACCESS_REVIEW_DECISION_REVOKE_REFUSED',
            entityType: 'AccessReviewDecision',
            entityId: decisionId,
            reason,
        });
    }
    throw err;
}

/**
 * Nobody decides the row whose subject is themselves (#4130).
 *
 * Checked AFTER the reviewer gate, so a caller who may not decide this
 * campaign at all is told that, and before anything is read or written. The
 * assigned reviewer, an ADMIN and an OWNER are all refused: the admin backup
 * exists so a campaign is not blocked by an absent reviewer, not so a reviewer
 * — or an admin — can certify their own access. The row is decided by
 * somebody else: the reviewer when the subject is an admin, another OWNER or
 * ADMIN when the subject is the reviewer.
 */
function assertNotDecidingOwnAccess(ctx: RequestContext, subjectUserId: string): void {
    if (subjectUserId !== ctx.userId) return;
    const reason = MEMBER_DECISION_REFUSAL.DECIDER_IS_SUBJECT;
    throw forbidden(`${reason}: ${MEMBER_DECISION_REFUSAL_MESSAGE[reason]}`, { reason });
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
        assertNotDecidingOwnAccess(ctx, decision.subjectUserId);

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
        // A named refusal thrown inside the transaction (#4130's own-row rule)
        // is audited after it rolls back, in a transaction of its own.
    }).catch((err: unknown) => recordDecisionSubmissionRefusal(ctx, decisionId, err));
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
 *   - Caller is not the row's subject (#4130): discarding a verdict on
 *     one's own access is deciding it, and is refused by name and audited.
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
        assertNotDecidingOwnAccess(ctx, decision.subjectUserId);

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
    }).catch((err: unknown) => recordDecisionRevokeRefusal(ctx, decisionId, err));
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
    /// a linked artifact (`regenerateAccessReviewEvidence` produces it
    /// again from the stored decisions).
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
 * memberships, log every action, and produce the evidence PDF (carrying a
 * SHA-256 hash of its contents; it is not cryptographically signed).
 *
 * Closure contract (the brief is explicit: not a cosmetic flip):
 *   • Admin-only operation.
 *   • Campaign must be OPEN or IN_REVIEW (not CLOSED, not deleted).
 *   • Every decision row must have a verdict — pending rows reject
 *     the close so the auditor never sees an under-reviewed campaign.
 *   • #3727: a MODIFY to OWNER, a MODIFY carrying a custom role, and —
 *     for a closer without `admin.owner_management` — a REVOKE or MODIFY
 *     of a live OWNER each reject the WHOLE close by name, with an
 *     `ACCESS_REVIEW_CLOSE_REFUSED` audit row. #4130 adds two the same
 *     way: a MODIFY of a live AI admin (that closer again), and a verdict
 *     recorded by its own subject (every closer).
 *   • Last-OWNER guard runs at the campaign level: if the planned
 *     execution would leave zero ACTIVE OWNERs, the WHOLE close is
 *     rejected. (DB trigger is the per-row backstop.)
 *   • Decisions execute in one tenant context with per-row error
 *     handling — a stale subject doesn't poison the rest of the
 *     campaign. CONFIRM is recorded as a deliberate no-op.
 *   • Campaign status flips to CLOSED in the SAME context after
 *     all per-row mutations land.
 *   • PDF generation + storage runs after close. Failure here keeps
 *     the campaign CLOSED with `evidenceFileRecordId = null`;
 *     `regenerateAccessReviewEvidence` produces it again.
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

        // 3b. Changing or revoking an AI admin is OWNER-tier too: on the
        //     members page only a holder of `admin.owner_management` moves a
        //     member out of an owner-managed role (`isOwnerManagedRole`, #4130)
        //     or deactivates one (#4118), so a campaign closed by an ADMIN must
        //     do neither. Judged on the LIVE role, as rule 3 is. An OWNER
        //     subject has already refused above, so what reaches this filter
        //     is the AI-admin half.
        const endsAnOwnerManagedRole = decisions.filter(
            (d) =>
                (d.decision === 'REVOKE' || d.decision === 'MODIFY') &&
                d.membership !== null &&
                isOwnerManagedRole(d.membership.role),
        );
        if (endsAnOwnerManagedRole.length > 0 && !ctx.appPermissions.admin.owner_management) {
            throw closeRefusal(
                'forbidden',
                MEMBER_DECISION_REFUSAL.AI_ADMIN_SUBJECT_NEEDS_OWNER_CLOSER,
                MEMBER_DECISION_REFUSAL_MESSAGE.AI_ADMIN_SUBJECT_NEEDS_OWNER_CLOSER,
                endsAnOwnerManagedRole.map((d) => d.id),
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

        // 5. A verdict its own subject recorded is never executed (#4130).
        //    `submitDecision` refuses one now; this is the read-side half, for
        //    a verdict stored before that rule — refused, never applied and
        //    never dropped, like every rule above. Any closer: an OWNER closing
        //    would still be executing a reviewer's judgement of themselves.
        const selfDecided = decisions.filter(
            (d) => d.decision !== null && d.decidedByUserId != null && d.decidedByUserId === d.subjectUserId,
        );
        if (selfDecided.length > 0) {
            throw closeRefusal(
                'conflict',
                MEMBER_DECISION_REFUSAL.DECIDER_IS_SUBJECT,
                MEMBER_DECISION_REFUSAL_MESSAGE.CAMPAIGN_SUBJECT_MAY_NOT_DECIDE_OWN_ACCESS,
                selfDecided.map((d) => d.id),
                'Somebody other than the subject revokes those decisions and records them again.',
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
        evidenceFileRecordId = await storeMemberEvidencePdf(
            ctx,
            accessReviewId,
            {
                tenantName: phase1.tenantName,
                review: phase1.review,
                decisions: phase1.decisions,
                outcomeByDecision: new Map<string, string>(
                    phase1.executions.map((e) => [e.decisionId, e.outcome] as const),
                ),
                closerEmail: phase1.closerEmail,
                closedAt: phase1.closedAt,
            },
            {
                action: 'ACCESS_REVIEW_EVIDENCE_GENERATED',
                summary: 'Generated access-review evidence PDF',
            },
        );
    } catch (err) {
        // Closeout has already committed. The campaign is CLOSED but
        // its evidence link is null — `regenerateAccessReviewEvidence`
        // (the campaign page's regenerate action) produces it again.
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


// ─── The member evidence PDF (close, and regeneration — #4130) ────────

type ExecutionDecisionRow = Awaited<
    ReturnType<typeof AccessReviewRepository.getDecisionsForExecution>
>[number];

/** Everything the member evidence PDF is built from, all of it stored rows. */
interface MemberEvidenceSource {
    tenantName: string;
    review: {
        name: string;
        description: string | null;
        scope: string;
        periodStartAt: Date | null;
        periodEndAt: Date | null;
        reviewer: { email: string };
        createdBy: { email: string };
    };
    decisions: readonly ExecutionDecisionRow[];
    /** The outcome the close executor recorded per decision id. */
    outcomeByDecision: ReadonlyMap<string, string>;
    closerEmail: string;
    closedAt: Date;
}

/**
 * The PDF builder's input for a member campaign. ONE mapping, used by the
 * close and by regeneration, so a regenerated artefact is the artefact the
 * close would have produced: same rows, same closer, same close time — and so
 * the same content hash, which covers neither the generation time nor the
 * notes.
 *
 * The notes are the reviewers' justifications (#4130). They used to be left
 * out ("notes is encrypted; closeout PDF stays metadata-only"), so an auditor
 * reading the evidence could not see why any access was kept or removed. The
 * column is encrypted AT REST; the extension decrypts it on read, and the
 * evidence is the artefact that exists to be read. Sanitised again here, as
 * the connected flow does, for a row written before submission sanitised it.
 */
function memberEvidencePdfInput(src: MemberEvidenceSource): AccessReviewPdfInput {
    return {
        tenantName: src.tenantName,
        campaignName: src.review.name,
        campaignDescription: src.review.description ?? null,
        scope: src.review.scope,
        periodStartIso: src.review.periodStartAt?.toISOString() ?? null,
        periodEndIso: src.review.periodEndAt?.toISOString() ?? null,
        reviewerEmail: src.review.reviewer.email,
        createdByEmail: src.review.createdBy.email,
        closedByEmail: src.closerEmail,
        closedAtIso: src.closedAt.toISOString(),
        decisions: src.decisions.map((d) => ({
            subjectUserEmail: d.subjectUser.email,
            subjectUserName: d.subjectUser.name,
            snapshotRole: d.snapshotRole as Role,
            snapshotMembershipStatus: d.snapshotMembershipStatus as MembershipStatus,
            decision: d.decision,
            decidedAtIso: d.decidedAt?.toISOString() ?? null,
            notes: d.notes ? sanitizePlainText(d.notes) : null,
            modifiedToRole: d.modifiedToRole as Role | null,
            executionOutcome: src.outcomeByDecision.get(d.id) ?? 'SKIPPED_PENDING',
        })),
        watermark: 'FINAL',
    };
}

/**
 * Render, store and attach the member evidence PDF; returns the FileRecord id.
 *
 * Outside any transaction until the last step: rendering and the storage write
 * must not hold a tenant-scoped transaction open. The FileRecord, the link and
 * the audit row are then written together, and the link is CONDITIONAL
 * (`attachEvidence` — CLOSED, and no evidence yet), so a second producer that
 * lost a race rolls its FileRecord back rather than replacing the first.
 */
async function storeMemberEvidencePdf(
    ctx: RequestContext,
    accessReviewId: string,
    src: MemberEvidenceSource,
    audit: {
        action: 'ACCESS_REVIEW_EVIDENCE_GENERATED' | 'ACCESS_REVIEW_EVIDENCE_REGENERATED';
        summary: string;
    },
): Promise<string> {
    const pdfDoc = generateAccessReviewPdf(memberEvidencePdfInput(src));
    const pdfBuffer = await collectPdfBuffer(pdfDoc);
    const fileName = `access_review_${src.review.name.replace(/[^a-z0-9]+/gi, '_')}_${src.closedAt.toISOString().slice(0, 10)}.pdf`;
    const storage = getStorageProvider();
    const pathKey = buildTenantObjectKey(ctx.tenantId, 'evidence', fileName);
    const writeResult = await storage.write(pathKey, Readable.from(pdfBuffer), {
        mimeType: 'application/pdf',
    });

    return runInTenantContext(ctx, async (db) => {
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
        const attached = await AccessReviewRepository.attachEvidence(db, ctx, accessReviewId, record.id);
        if (attached === 0) {
            // Thrown inside the transaction, so the FileRecord goes with it.
            throw new ConflictError(
                'The campaign already has an evidence PDF, or is no longer closed; nothing was attached.',
            );
        }
        await logEvent(db, ctx, {
            action: audit.action,
            entityType: 'AccessReview',
            entityId: accessReviewId,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'FileRecord',
                operation: 'create',
                summary: `${audit.summary} (sha256=${writeResult.sha256})`,
                after: {
                    fileRecordId: record.id,
                    pathKey,
                    sizeBytes: writeResult.sizeBytes,
                    sha256: writeResult.sha256,
                },
            },
        });
        return record.id;
    });
}

// ─── regenerateAccessReviewEvidence (#4130) ───────────────────────────

/**
 * The label a regenerated row carries when the close recorded no outcome for
 * it. Never expected — the close writes the outcome's audit row in the same
 * transaction as the row's `executedAt` — and printed rather than guessed if it
 * happens: deriving EXECUTED from `executedAt` would hide a SKIPPED_STALE or a
 * SKIPPED_LAST_OWNER behind the most reassuring word in the column.
 */
export const UNRECORDED_OUTCOME = 'UNRECORDED';

export interface RegenerateAccessReviewEvidenceResult {
    accessReviewId: string;
    evidenceFileRecordId: string;
}

/**
 * Produce a CLOSED member campaign's evidence PDF again, when the close
 * committed and the PDF did not (#4130).
 *
 * The close flips the campaign CLOSED before it renders the PDF, deliberately —
 * a storage outage must not undo executed decisions — and a second close is
 * refused. So a failed PDF used to be permanent: the decisions were carried out
 * and the artefact an auditor asks for could never exist.
 *
 * Rebuilt from STORED rows with the close's own mapping
 * (`memberEvidencePdfInput`): the decisions as stored, the outcome each one's
 * `ACCESS_REVIEW_DECISION_EXECUTED` audit row recorded, the closer and the
 * close time on the campaign. Nothing is re-executed and no membership is
 * read, so the artefact describes what the close did, not today's state.
 *
 * Refused unless the campaign is a CLOSED member campaign WITH NO evidence: a
 * second PDF beside a good one would be two artefacts for one campaign. The
 * evidence link is conditional at the write too, so two concurrent
 * regenerations attach one PDF.
 */
export async function regenerateAccessReviewEvidence(
    ctx: RequestContext,
    accessReviewId: string,
): Promise<RegenerateAccessReviewEvidenceResult> {
    assertCanAdmin(ctx);

    const src = await runInTenantContext(ctx, async (db) => {
        const review = await db.accessReview.findFirst({
            where: { id: accessReviewId, tenantId: ctx.tenantId },
            include: {
                reviewer: { select: { email: true } },
                createdBy: { select: { email: true } },
                closedBy: { select: { email: true } },
            },
        });
        if (!review || review.deletedAt !== null) {
            throw notFound('Access review not found');
        }
        if (!isMemberScope(review.scope)) {
            throw badRequest(
                `A ${review.scope} campaign's evidence is not produced by the member flow; its subjects are not tenant memberships.`,
            );
        }
        if (review.status !== 'CLOSED' || review.closedAt === null) {
            throw badRequest('Only a closed campaign has evidence to produce. Close the campaign first.');
        }
        if (review.evidenceFileRecordId !== null) {
            throw new ConflictError(
                'This campaign already has its evidence PDF. Download it from the campaign page.',
            );
        }

        const decisions = await AccessReviewRepository.getDecisionsForExecution(db, ctx, accessReviewId);
        // ZERO IS NOT COMPLETE: a PDF over no subjects would evidence nothing.
        if (decisions.length === 0) {
            throw badRequest(
                'Cannot produce evidence: this campaign has no subjects, and a review over nobody evidences nothing.',
            );
        }

        // What the close SAID it did to each row — the hash-chained record,
        // written in the close's own transaction.
        const executed = await db.auditLog.findMany({
            where: {
                tenantId: ctx.tenantId,
                action: 'ACCESS_REVIEW_DECISION_EXECUTED',
                entity: 'AccessReviewDecision',
                entityId: { in: decisions.map((d) => d.id) },
            },
            select: { entityId: true, detailsJson: true },
            orderBy: { createdAt: 'asc' },
            take: decisions.length * 2,
        });
        const outcomeByDecision = new Map<string, string>(
            decisions.map((d) => [d.id, UNRECORDED_OUTCOME] as const),
        );
        for (const row of executed) {
            const after = (row.detailsJson as { after?: { outcome?: unknown } } | null)?.after;
            if (typeof after?.outcome === 'string') outcomeByDecision.set(row.entityId, after.outcome);
        }

        const tenantRow = await db.tenant.findUnique({
            where: { id: ctx.tenantId },
            select: { name: true },
        });

        return {
            tenantName: tenantRow?.name ?? 'Tenant',
            review,
            decisions,
            outcomeByDecision,
            closerEmail: review.closedBy?.email ?? '(unknown)',
            closedAt: review.closedAt,
        } satisfies MemberEvidenceSource;
    });

    // Not caught: unlike the close, nothing here has committed that a failure
    // could misreport, and the person who asked needs to know it failed again.
    const evidenceFileRecordId = await storeMemberEvidencePdf(ctx, accessReviewId, src, {
        action: 'ACCESS_REVIEW_EVIDENCE_REGENERATED',
        summary: 'Regenerated access-review evidence PDF from the stored decisions',
    });
    return { accessReviewId, evidenceFileRecordId };
}

// ─── updateAccessReviewSettings (#4130) ───────────────────────────────

export interface UpdateAccessReviewSettingsResult {
    accessReviewId: string;
    reviewerUserId: string;
    dueAt: Date | null;
    /** The fields that actually changed; empty when the request matched the campaign. */
    changed: Array<'reviewerUserId' | 'dueAt'>;
}

/**
 * Change who reviews an open campaign, and by when (#4130, owner decision).
 *
 * The overdue escalation email told admins they could reassign a campaign, and
 * nothing could; a reviewer who left, or a deadline that was wrong, meant a
 * campaign that could only be abandoned. This is that verb and no other: the
 * scope, the name and the period are not editable (the schema is strict), and
 * a campaign is not deleted.
 *
 *   - OWNER + ADMIN (`assertCanAdmin`, the creator's gate; the route takes
 *     `access_reviews.create`).
 *   - OPEN or IN_REVIEW only — a CLOSED campaign is immutable evidence — and
 *     the write is conditional on that, so a close landing mid-request wins.
 *   - Not an AGENT campaign (`campaignSettingsEditable`): its reviewer reads
 *     register data, and moving that is the agent flow's decision.
 *   - The new reviewer must be an ACTIVE member of this tenant, as every
 *     campaign's creation requires (`assertReviewerIsActiveMember`).
 *
 * Every change writes `ACCESS_REVIEW_UPDATED` with the before and after values.
 * Decisions already recorded keep their decider; the own-row rule applies to
 * the new reviewer as to anybody.
 */
export async function updateAccessReviewSettings(
    ctx: RequestContext,
    accessReviewId: string,
    input: unknown,
): Promise<UpdateAccessReviewSettingsResult> {
    assertCanAdmin(ctx);
    const parsed = UpdateAccessReviewSettingsSchema.parse(input);

    return runInTenantContext(ctx, async (db) => {
        const review = await db.accessReview.findFirst({
            where: { id: accessReviewId, tenantId: ctx.tenantId, deletedAt: null },
            select: { id: true, name: true, scope: true, status: true, reviewerUserId: true, dueAt: true },
        });
        if (!review) throw notFound('Access review not found');
        if (review.status === 'CLOSED') {
            throw badRequest('This campaign is closed; its reviewer and due date can no longer change.');
        }
        if (!campaignSettingsEditable(review.scope)) {
            throw new ConflictError(
                `CAMPAIGN_SETTINGS_FIXED_FOR_SCOPE: a ${review.scope} campaign keeps the reviewer and due date it was created with.`,
                { reason: 'CAMPAIGN_SETTINGS_FIXED_FOR_SCOPE' },
            );
        }

        const data: { reviewerUserId?: string; dueAt?: Date | null } = {};
        if (parsed.reviewerUserId !== undefined && parsed.reviewerUserId !== review.reviewerUserId) {
            await assertReviewerIsActiveMember(db, ctx, parsed.reviewerUserId);
            data.reviewerUserId = parsed.reviewerUserId;
        }
        if (
            parsed.dueAt !== undefined &&
            (parsed.dueAt?.getTime() ?? null) !== (review.dueAt?.getTime() ?? null)
        ) {
            data.dueAt = parsed.dueAt;
        }

        const changed = (Object.keys(data) as Array<'reviewerUserId' | 'dueAt'>).sort();
        if (changed.length === 0) {
            return {
                accessReviewId,
                reviewerUserId: review.reviewerUserId,
                dueAt: review.dueAt,
                changed,
            };
        }

        const count = await AccessReviewRepository.updateSettings(db, ctx, accessReviewId, data);
        if (count === 0) {
            throw new ConflictError('The campaign was closed while this change was being made; nothing was changed.');
        }

        const after = {
            reviewerUserId: data.reviewerUserId ?? review.reviewerUserId,
            dueAt: data.dueAt !== undefined ? data.dueAt : review.dueAt,
        };
        await logEvent(db, ctx, {
            action: 'ACCESS_REVIEW_UPDATED',
            entityType: 'AccessReview',
            entityId: accessReviewId,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'AccessReview',
                operation: 'update',
                summary: `Access review "${review.name}" — changed ${changed.join(' and ')}`,
                changedFields: changed,
                before: {
                    reviewerUserId: review.reviewerUserId,
                    dueAt: review.dueAt?.toISOString() ?? null,
                },
                after: {
                    reviewerUserId: after.reviewerUserId,
                    dueAt: after.dueAt?.toISOString() ?? null,
                },
            },
        });

        return { accessReviewId, reviewerUserId: after.reviewerUserId, dueAt: after.dueAt, changed };
    });
}
