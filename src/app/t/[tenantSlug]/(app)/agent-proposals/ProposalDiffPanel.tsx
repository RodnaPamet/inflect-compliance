'use client';

import { useTranslations } from 'next-intl';

import { StatusBadge } from '@/components/ui/status-badge';
import { cn } from '@/lib/cn';
import { isDiffReviewable, type ProposalDiff } from '@/lib/agentic/proposal-diff';

/**
 * The review surface for ONE proposal's diff - and the only place the approve
 * control is allowed to be rendered.
 *
 * ## The invariant this component exists to make structural
 *
 * `approveAction` is a slot, and it is rendered from EXACTLY ONE place in this
 * file: inside the branch that has just rendered a diff body. Every other
 * branch renders `approveBlocked` instead. That is deliberate and it is the
 * whole point of the component's shape.
 *
 * The alternative - an approve button in the card header beside a diff that may
 * or may not have rendered - is the failure restated: a reviewer reaches the
 * control without the evidence, the click still writes an audit row saying a
 * human approved it, and the queue has manufactured consent nobody gave. Under
 * volume that is not a hypothetical; it is how automation bias operates
 * (OWASP ASI09).
 *
 * So the button cannot be positioned beside an unrendered diff, because it is
 * not a sibling of the diff - it is a child of it.
 *
 * ## "Nothing changed" and "we could not work out what changed" are different
 *
 * They get different testids, different copy, different tone, and - the part
 * that matters - different answers from `isDiffReviewable`. A NO_CHANGES
 * proposal is a computed, truthful answer and stays approvable (approving it is
 * a no-op; rejecting it is usually what a reviewer wants). TARGET_MISSING and
 * PAYLOAD_UNREADABLE are not answers, so approval is withdrawn entirely.
 */
export function ProposalDiffPanel({
    proposalId,
    diff,
    approveAction,
}: {
    proposalId: string;
    diff: ProposalDiff;
    /** The approve control. Rendered ONLY where a diff body has been rendered. */
    approveAction: React.ReactNode;
}) {
    const t = useTranslations('agents');
    const reviewable = isDiffReviewable(diff);

    return (
        <div
            data-testid={`proposal-diff-${proposalId}`}
            data-diff-status={diff.status}
            className="space-y-default"
        >
            <div className="flex items-center gap-tight">
                <span className="text-sm font-medium text-content-default">
                    {diff.status === 'CREATE'
                        ? t('proposals.diff.createHeading')
                        : t('proposals.diff.updateHeading')}
                </span>
                {diff.status === 'NO_CHANGES' && (
                    <StatusBadge variant="warning">{t('proposals.diff.noChangesBadge')}</StatusBadge>
                )}
                {!reviewable && (
                    <StatusBadge variant="error">{t('proposals.diff.blockedBadge')}</StatusBadge>
                )}
            </div>

            {diff.status === 'PAYLOAD_UNREADABLE' ? (
                <UncomputableNotice
                    proposalId={proposalId}
                    reason={diff.status}
                    title={t('proposals.diff.uncomputableTitle')}
                    body={t('proposals.diff.reasonPayloadUnreadable')}
                />
            ) : diff.status === 'TARGET_MISSING' ? (
                <>
                    <UncomputableNotice
                        proposalId={proposalId}
                        reason={diff.status}
                        title={t('proposals.diff.uncomputableTitle')}
                        body={t('proposals.diff.reasonTargetMissing')}
                    />
                    {/*
                      The proposed values are still listed, under the refusal and
                      never beside a before-column: an operator triaging this
                      needs to see WHAT was proposed against the record that
                      vanished. Rendering them as a two-column diff would read as
                      "this creates all of these", which is the wrong story.
                    */}
                    <ProposedOnlyList proposalId={proposalId} diff={diff} variant="orphaned" />
                </>
            ) : diff.status === 'CREATE' ? (
                <ProposedOnlyList proposalId={proposalId} diff={diff} variant="create" />
            ) : (
                <>
                    {diff.status === 'NO_CHANGES' && (
                        <div
                            data-testid={`proposal-diff-nochanges-${proposalId}`}
                            className="rounded border border-border-subtle bg-bg-subtle p-3 text-sm"
                        >
                            <p className="font-medium text-content-warning">
                                {t('proposals.diff.noChangesTitle')}
                            </p>
                            <p className="text-content-muted">{t('proposals.diff.noChangesBody')}</p>
                        </div>
                    )}
                    <BeforeAfterList proposalId={proposalId} diff={diff} />
                </>
            )}

            <div
                data-testid={`proposal-actions-${proposalId}`}
                className="flex items-center justify-end gap-tight border-t border-border-subtle pt-default"
            >
                {reviewable ? (
                    approveAction
                ) : (
                    <span
                        data-testid={`proposal-blocked-${proposalId}`}
                        className="text-xs text-content-error"
                    >
                        {t('proposals.diff.approveBlocked')}
                    </span>
                )}
            </div>
        </div>
    );
}

function UncomputableNotice({
    proposalId,
    reason,
    title,
    body,
}: {
    proposalId: string;
    reason: string;
    title: string;
    body: string;
}) {
    return (
        <div
            data-testid={`proposal-diff-uncomputable-${proposalId}`}
            data-reason={reason}
            className="rounded border border-border-emphasis bg-bg-subtle p-3 text-sm"
        >
            <p className="font-medium text-content-error">{title}</p>
            <p className="text-content-muted">{body}</p>
        </div>
    );
}

/**
 * A one-column rendering: field -> proposed value, with no before-column at
 * all. Used for a CREATE (there is no prior state) and for an orphaned UPDATE
 * (there is prior state, but we could not read it). The absent column is the
 * honest signal in both cases.
 */
function ProposedOnlyList({
    proposalId,
    diff,
    variant,
}: {
    proposalId: string;
    diff: ProposalDiff;
    variant: 'create' | 'orphaned';
}) {
    const t = useTranslations('agents');
    return (
        <ul
            data-testid={`proposal-diff-content-${proposalId}`}
            data-variant={variant}
            className="space-y-tight"
        >
            {diff.fields.map((f) => (
                <li
                    key={f.field}
                    data-testid={`proposal-diff-field-${proposalId}-${f.field}`}
                    className="rounded border border-border-subtle bg-bg-subtle p-2"
                >
                    <span className="block text-xs font-medium text-content-subtle">{f.field}</span>
                    <span
                        data-testid={`proposal-diff-after-${proposalId}-${f.field}`}
                        className="block whitespace-pre-wrap break-words text-sm text-content-default"
                    >
                        {f.after ?? t('proposals.diff.emptyValue')}
                    </span>
                </li>
            ))}
        </ul>
    );
}

/** The two-column rendering: what the record says now, next to what it would say. */
function BeforeAfterList({ proposalId, diff }: { proposalId: string; diff: ProposalDiff }) {
    const t = useTranslations('agents');
    return (
        <ul
            data-testid={`proposal-diff-fields-${proposalId}`}
            className="space-y-tight"
        >
            {diff.fields.map((f) => (
                <li
                    key={f.field}
                    data-testid={`proposal-diff-field-${proposalId}-${f.field}`}
                    data-changed={f.changed ? 'true' : 'false'}
                    className={cn(
                        'rounded border p-2',
                        f.changed
                            ? 'border-border-emphasis bg-bg-subtle'
                            : 'border-border-subtle opacity-70',
                    )}
                >
                    <span className="block text-xs font-medium text-content-subtle">
                        {f.field}
                        {!f.changed && ` · ${t('proposals.diff.unchanged')}`}
                    </span>
                    <div className="grid gap-tight sm:grid-cols-2">
                        <div>
                            <span className="block text-xs uppercase tracking-wide text-content-subtle">
                                {t('proposals.diff.beforeColumn')}
                            </span>
                            <span
                                data-testid={`proposal-diff-before-${proposalId}-${f.field}`}
                                className="block whitespace-pre-wrap break-words text-sm text-content-muted"
                            >
                                {f.before ?? t('proposals.diff.emptyValue')}
                            </span>
                        </div>
                        <div>
                            <span className="block text-xs uppercase tracking-wide text-content-subtle">
                                {t('proposals.diff.afterColumn')}
                            </span>
                            <span
                                data-testid={`proposal-diff-after-${proposalId}-${f.field}`}
                                className="block whitespace-pre-wrap break-words text-sm text-content-default"
                            >
                                {f.after ?? t('proposals.diff.emptyValue')}
                            </span>
                        </div>
                    </div>
                </li>
            ))}
        </ul>
    );
}
