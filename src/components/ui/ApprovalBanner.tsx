'use client';

/**
 * `<ApprovalBanner>` — Epic 45.3 review-state surface.
 *
 * Renders above the policy detail body whenever a `PolicyApproval`
 * row exists in `PENDING` state. Shows the status, who requested
 * the review, and (when the current user has reviewer permission)
 * Approve / Reject actions.
 *
 * Authorization model:
 *   - The banner ALWAYS shows informational content (status, who
 *     requested, when, optional version reference) so the requester
 *     and other readers see the review state without acting on it.
 *   - `canDecide` (passed by the consumer) gates the action buttons.
 *     The current page wires this off `tenant.permissions.canAdmin`
 *     — same gate the legacy in-version approval buttons used.
 *   - When `canDecide=true` AND the current user IS the requester,
 *     the actions are shown disabled with a "you can't approve your
 *     own request" tooltip. Reviewers cannot self-approve.
 *
 * Decision flow is purely presentational: `onDecide(approvalId,
 * decision, comment)` is the consumer's hook. The current page
 * wires it to `decideApproval`, which POSTs to
 * `/policies/:id/approval/:approvalId/decide`.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { CheckCircle2, XCircle, Clock, AlertTriangle, MessageSquare } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Heading } from '@/components/ui/typography';

export interface ApprovalBannerUserRef {
    id: string;
    name?: string | null;
    email?: string | null;
}

export interface ApprovalBannerApproval {
    id: string;
    status: 'PENDING' | 'APPROVED' | 'REJECTED' | string;
    requestedBy?: ApprovalBannerUserRef | null;
    approvedBy?: ApprovalBannerUserRef | null;
    decidedAt?: string | null;
    comment?: string | null;
    /**
     * Author of the version under review. Segregation of duties blocks BOTH the
     * requester and the author from approving — the server and the per-version
     * approval card already enforce the author half, so without it here the
     * banner rendered an enabled Approve button that 403'd on click.
     */
    versionAuthor?: ApprovalBannerUserRef | null;
    /** Optional — when the version reference is known, it surfaces
     *  in the banner so the reviewer knows which version they're
     *  approving (avoids accidental approval of an outdated draft). */
    versionNumber?: number | null;
}

export interface ApprovalBannerProps {
    approval: ApprovalBannerApproval;
    /** True when the current user has reviewer permission. */
    canDecide: boolean;
    /** Current user id — used to gate self-approval (a reviewer who is also the requester). */
    currentUserId?: string | null;
    /** Decide handler — see Authorization model in the file docstring. */
    onDecide?: (
        approvalId: string,
        decision: 'APPROVED' | 'REJECTED',
        comment: string,
    ) => void | Promise<void>;
    /** Disabled spinner-style state — caller indicates an in-flight decide call. */
    busy?: boolean;
    className?: string;
    'data-testid'?: string;
}

// ─── Helpers ────────────────────────────────────────────────────────

function userLabel(u: ApprovalBannerUserRef | null | undefined, unknownLabel: string): string {
    if (!u) return unknownLabel;
    return u.name ?? u.email ?? u.id;
}

// ─── Component ──────────────────────────────────────────────────────

export function ApprovalBanner({
    approval,
    canDecide,
    currentUserId,
    onDecide,
    busy = false,
    className = '',
    'data-testid': dataTestId = 'approval-banner',
}: ApprovalBannerProps) {
    const t = useTranslations('approval');
    const [comment, setComment] = useState('');
    const [showCommentField, setShowCommentField] = useState(false);

    const isPending = approval.status === 'PENDING';
    // SoD mirror of the server rule (and of the per-version approval card):
    // the viewer may not approve their OWN request, nor a version they authored.
    const isSelfApproval =
        canDecide &&
        currentUserId != null &&
        (approval.requestedBy?.id === currentUserId ||
            approval.versionAuthor?.id === currentUserId);
    /**
     * Approve and Reject are gated DIFFERENTLY, because the server gates them
     * differently.
     *
     * `decidePolicyApproval` refuses a self-APPROVAL only — its check is
     * literally `decision === 'APPROVED' && requestedByUserId === ctx.userId`
     * (plus the same test for the version's author). A self-REJECTION is
     * deliberately allowed so a requester can WITHDRAW their own request
     * rather than stranding the policy in IN_REVIEW.
     *
     * The banner disabled BOTH on `!isSelfApproval`, and told the user
     * "you cannot reject your own request" — a rule that does not exist. The
     * effect was a trap: the one person who most wants to withdraw the
     * request is the one person the banner refuses, and the policy sits in
     * IN_REVIEW with no route out. Meanwhile the per-version card rendered
     * Reject with no SoD gate at all, so the two surfaces disagreed about a
     * rule neither of them had right.
     */
    const canApproveNow = canDecide && isPending && !isSelfApproval && !busy;
    const canRejectNow = canDecide && isPending && !busy;

    // Visual treatment per status. Pending = brand emphasis;
    // approved = success; rejected = danger. Each surface picks
    // semantic tokens already used elsewhere in the app.
    const tone = (() => {
        switch (approval.status) {
            case 'APPROVED':
                return {
                    border: 'border-border-success',
                    bg: 'bg-bg-success',
                    fg: 'text-content-success',
                    icon: <CheckCircle2 size={16} className="text-content-success" />,
                    label: t('approved'),
                };
            case 'REJECTED':
                return {
                    border: 'border-border-error',
                    bg: 'bg-bg-error',
                    fg: 'text-content-error',
                    icon: <XCircle size={16} className="text-content-error" />,
                    label: t('rejected'),
                };
            case 'PENDING':
            default:
                return {
                    border: 'border-border-warning',
                    bg: 'bg-bg-warning',
                    fg: 'text-content-warning',
                    icon: <Clock size={16} className="text-content-warning" />,
                    label: t('pendingReview'),
                };
        }
    })();

    return (
        <section
            role="region"
            aria-label={t('regionAria')}
            data-testid={dataTestId}
            data-status={approval.status}
            className={`rounded-lg border ${tone.border} ${tone.bg} px-4 py-3 ${className}`.trim()}
        >
            <div className="flex flex-wrap items-start justify-between gap-compact">
                <div className="min-w-0 flex-1">
                    <div className="mb-1 flex items-center gap-tight">
                        {tone.icon}
                        <Heading
                            level={3}
                            className={tone.fg}
                            data-testid="approval-banner-status"
                        >
                            {tone.label}
                        </Heading>
                        {approval.versionNumber != null && (
                            <span className="text-[11px] text-content-muted">
                                · {t('version', { number: approval.versionNumber })}
                            </span>
                        )}
                    </div>
                    <p className="text-xs text-content-muted">
                        {t('requestedByLabel')}{' '}
                        <span
                            className="font-medium text-content-emphasis"
                            data-testid="approval-banner-requester"
                        >
                            {userLabel(approval.requestedBy, t('unknown'))}
                        </span>
                        {approval.approvedBy && (
                            <>
                                {' · '}
                                {t(approval.status === 'APPROVED' ? 'approvedVerb' : 'reviewedVerb')}{' '}
                                {t('byLabel')}{' '}
                                <span
                                    className="font-medium text-content-emphasis"
                                    data-testid="approval-banner-reviewer"
                                >
                                    {userLabel(approval.approvedBy, t('unknown'))}
                                </span>
                            </>
                        )}
                        {approval.status === 'PENDING' && !approval.approvedBy && (
                            <>
                                {' · '}
                                <span
                                    className="text-content-subtle"
                                    data-testid="approval-banner-reviewer"
                                >
                                    {t('awaitingReviewer')}
                                </span>
                            </>
                        )}
                    </p>
                    {approval.comment && (
                        <p className="mt-1 inline-flex items-center gap-1 text-xs text-content-muted">
                            <MessageSquare size={11} aria-hidden />
                            <span data-testid="approval-banner-comment">
                                {approval.comment}
                            </span>
                        </p>
                    )}
                    {isPending && isSelfApproval && (
                        <p className="mt-1 inline-flex items-center gap-1 text-xs text-content-subtle">
                            <AlertTriangle size={11} aria-hidden />
                            {t('cannotApproveOwn')}
                        </p>
                    )}
                </div>

                {/* Actions — gated three ways:
                    (1) only render when status is PENDING
                    (2) hidden when the viewer can't decide (RBAC)
                    (3) Approve disabled for the requester/author (SoD);
                        Reject stays enabled so they can withdraw     */}
                {isPending && canDecide && (
                    <div className="flex flex-wrap items-center gap-tight">
                        {!showCommentField && (
                            <button
                                type="button"
                                onClick={() => setShowCommentField(true)}
                                // Follows the REJECT gate: a requester who can
                                // still withdraw must be able to say why.
                                disabled={!canRejectNow}
                                className="text-[11px] text-content-muted hover:text-content-emphasis disabled:opacity-50"
                                aria-label={t('addCommentAria')}
                                data-testid="approval-banner-add-comment"
                            >
                                + {t('comment')}
                            </button>
                        )}
                        <Button
                            variant="primary"
                            size="sm"
                            onClick={() => onDecide?.(approval.id, 'APPROVED', comment)}
                            disabled={!canApproveNow}
                            id={`approval-banner-approve-${approval.id}`}
                            data-testid="approval-banner-approve"
                            title={
                                isSelfApproval
                                    ? t('cannotApproveOwnTitle')
                                    : undefined
                            }
                        >
                            {busy ? '…' : t('approve')}
                        </Button>
                        <Button
                            variant="destructive"
                            size="sm"
                            onClick={() => onDecide?.(approval.id, 'REJECTED', comment)}
                            disabled={!canRejectNow}
                            id={`approval-banner-reject-${approval.id}`}
                            data-testid="approval-banner-reject"
                        >
                            {busy ? '…' : t('reject')}
                        </Button>
                    </div>
                )}
            </div>

            {showCommentField && isPending && canDecide && (
                <div className="mt-3 border-t border-border-default/50 pt-2">
                    <label className="block text-xs text-content-muted">
                        {t('reviewerCommentLabel')}
                        <textarea
                            className="input mt-1 w-full text-xs"
                            rows={2}
                            value={comment}
                            onChange={(e) => setComment(e.target.value)}
                            placeholder={t('commentPlaceholder')}
                            data-testid="approval-banner-comment-input"
                        />
                    </label>
                </div>
            )}
        </section>
    );
}
