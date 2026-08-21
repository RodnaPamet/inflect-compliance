'use client';

/**
 * Epic G-4 — Access Review detail / reviewer page.
 *
 * The reviewer's working surface — every snapshot subject is one
 * row in a table with:
 *   • Subject identity (name + email)
 *   • Snapshot role at campaign creation (frozen evidence)
 *   • Live role today (changes if anyone updated the membership
 *     after snapshot)
 *   • Last activity date (max UserSession.lastActiveAt for the user)
 *   • Decision dropdown — CONFIRM / REVOKE / MODIFY
 *   • Decision-aware modal for MODIFY's `modifiedToRole` + notes
 *
 * Permission gating in this component:
 *   - Only the assigned reviewer (ctx.userId === review.reviewerUserId)
 *     OR an admin can submit decisions.
 *   - Only an admin can press "Close campaign".
 *   - Anyone with read can browse + download the evidence PDF when
 *     the campaign is CLOSED.
 */
import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { useSWRConfig } from 'swr';
import { CACHE_KEYS } from '@/lib/swr-keys';
import { useEntityListIds } from '@/lib/hooks/use-entity-list-ids';
import { StatusBadge } from '@/components/ui/status-badge';
import { MetaStrip } from '@/components/ui/meta-strip';
import { Button } from '@/components/ui/button';
import { ProgressBar } from '@/components/ui/progress-bar';
import { Modal } from '@/components/ui/modal';
import { FormField } from '@/components/ui/form-field';
import { DataTable, createColumns } from '@/components/ui/table';
import { formatDate, formatDateTime } from '@/lib/format-date';
import { EntityDetailLayout } from '@/components/layout/EntityDetailLayout';

const ALL_ROLES = ['OWNER', 'ADMIN', 'EDITOR', 'READER', 'AUDITOR'] as const;
type Role = (typeof ALL_ROLES)[number];
type DecisionType = 'CONFIRM' | 'REVOKE' | 'MODIFY';
type Status = 'OPEN' | 'IN_REVIEW' | 'CLOSED';

interface DecisionRow {
    id: string;
    subjectUserId: string;
    subjectUser: { id: string; email: string; name: string | null };
    snapshotRole: Role;
    snapshotMembershipStatus: string;
    decision: DecisionType | null;
    decidedAt: string | Date | null;
    decidedBy: { id: string; email: string; name: string | null } | null;
    notes: string | null;
    modifiedToRole: Role | null;
    executedAt: string | Date | null;
    membership: {
        id: string;
        role: Role;
        status: string;
    } | null;
}

interface ReviewDetail {
    id: string;
    name: string;
    description: string | null;
    scope: 'ALL_USERS' | 'ADMIN_ONLY' | 'CUSTOM' | 'CONNECTED_APP';
    status: Status;
    periodStartAt: string | Date | null;
    periodEndAt: string | Date | null;
    dueAt: string | Date | null;
    closedAt: string | Date | null;
    createdAt: string | Date;
    reviewerUserId: string;
    evidenceFileRecordId: string | null;
    reviewer: { id: string; email: string; name: string | null };
    createdBy: { id: string; email: string; name: string | null };
    closedBy: { id: string; email: string; name: string | null } | null;
    decisions: DecisionRow[];
    lastActivityByUser: Record<string, string | Date>;
}

interface Props {
    tenantSlug: string;
    initialReview: ReviewDetail;
    currentUserId: string;
    isAdmin: boolean;
}

const STATUS_VARIANT: Record<Status, 'warning' | 'info' | 'success'> = {
    OPEN: 'warning',
    IN_REVIEW: 'info',
    CLOSED: 'success',
};

const DECISION_VARIANT: Record<DecisionType, 'success' | 'error' | 'warning'> = {
    CONFIRM: 'success',
    REVOKE: 'error',
    MODIFY: 'warning',
};

export function AccessReviewDetailClient({
    tenantSlug,
    initialReview,
    currentUserId,
    isAdmin,
}: Props) {
    const t = useTranslations('accessReviews');
    const { mutate: swrMutate } = useSWRConfig();
    const router = useRouter();
    const apiBase = `/api/t/${tenantSlug}/access-reviews/${initialReview.id}`;

    const reviewQuery = useTenantSWR<ReviewDetail>(
        CACHE_KEYS.accessReviews.detail(initialReview.id),
        { fallbackData: initialReview },
    );
    const review = reviewQuery.data!;

    const isReviewer = currentUserId === review.reviewerUserId;
    const canDecide = (isReviewer || isAdmin) && review.status !== 'CLOSED';
    const canClose = isAdmin && review.status !== 'CLOSED';

    // #107 READ side. The register publishes what it rendered; the fallback
    // to the list cache is left ENABLED here (a real `listKey`, not the
    // null-key shape) because this list endpoint is a genuine SWR resource in
    // the `CappedList` shape the hook already unwraps — so a campaign opened
    // by deep link or from a notification still gets server order, which for
    // an unfiltered, unsorted register is the same order the page shows.
    //
    // `accessReview` IS in the `ui.recordStepper` catalog (en + bg), so the
    // tooltips read the real phrase rather than the generic record one.
    const reviewIds = useEntityListIds(CACHE_KEYS.accessReviews.list());

    const [activeDecision, setActiveDecision] = useState<{
        row: DecisionRow;
        type: DecisionType;
    } | null>(null);
    const [closing, setClosing] = useState(false);

    const decisionsTotal = review.decisions.length;
    const decided = review.decisions.filter((d) => d.decision !== null).length;
    const pct = decisionsTotal === 0 ? 0 : Math.round((decided / decisionsTotal) * 100);

    const decisionColumns = useMemo(
        () => createColumns<DecisionRow>([
            {
                id: 'subject',
                header: t('colSubject'),
                cell: ({ row }) => (
                    <div data-testid={`decision-row-${row.original.id}`}>
                        <div className="font-medium text-content-default">
                            {row.original.subjectUser.name || '—'}
                        </div>
                        <div className="text-xs text-content-muted">
                            {row.original.subjectUser.email}
                        </div>
                    </div>
                ),
            },
            {
                id: 'snapshotRole',
                header: t('colSnapshotRole'),
                cell: ({ row }) => (
                    <span className="text-sm">{row.original.snapshotRole}</span>
                ),
            },
            {
                id: 'liveRole',
                header: t('colLiveRole'),
                cell: ({ row }) =>
                    row.original.membership ? (
                        <span className="text-sm">{row.original.membership.role}</span>
                    ) : (
                        <span className="text-sm text-content-muted italic">{t('deleted')}</span>
                    ),
            },
            {
                id: 'lastActive',
                header: t('colLastActive'),
                cell: ({ row }) => {
                    const lastActiveAt =
                        review.lastActivityByUser[row.original.subjectUserId] ?? null;
                    return (
                        <span className="text-sm text-content-muted">
                            {lastActiveAt ? formatDate(lastActiveAt) : t('never')}
                        </span>
                    );
                },
            },
            {
                id: 'decision',
                header: t('colDecision'),
                cell: ({ row }) => {
                    const d = row.original;
                    if (d.decision) {
                        return (
                            <StatusBadge variant={DECISION_VARIANT[d.decision]}>
                                {d.decision}
                                {d.decision === 'MODIFY' && d.modifiedToRole
                                    ? ` → ${d.modifiedToRole}`
                                    : ''}
                            </StatusBadge>
                        );
                    }
                    if (canDecide) {
                        return (
                            <select
                                className="input"
                                defaultValue=""
                                data-testid={`decision-select-${d.id}`}
                                onChange={(e) => {
                                    const v = e.target.value as DecisionType | '';
                                    if (v) setActiveDecision({ row: d, type: v });
                                    e.target.value = '';
                                }}
                            >
                                <option value="" disabled>{t('decidePrompt')}</option>
                                <option value="CONFIRM">{t('confirmAccess')}</option>
                                <option value="REVOKE">{t('revokeAccess')}</option>
                                <option value="MODIFY">{t('modifyRole')}</option>
                            </select>
                        );
                    }
                    return (
                        <span className="text-xs text-content-muted">{t('pending')}</span>
                    );
                },
            },
        ]),
        [canDecide, review.lastActivityByUser, t],
    );

    return (
        <EntityDetailLayout
            id="access-review-detail-page"
            back={{ smart: true }}
            prevNext={{
                ids: reviewIds,
                currentId: review.id,
                hrefFor: (id) => `/t/${tenantSlug}/access-reviews/${id}`,
                labelSingular: 'accessReview',
            }}
            breadcrumbs={[
                { label: t('crumbDashboard'), href: `/t/${tenantSlug}/dashboard` },
                { label: t('crumbList'), href: `/t/${tenantSlug}/access-reviews` },
                { label: review.name },
            ]}
            title={<span data-testid="access-review-detail-title">{review.name}</span>}
            meta={
                <MetaStrip
                    items={[
                        {
                            kind: 'status',
                            label: t('metaStatus'),
                            value: review.status,
                            variant:
                                STATUS_VARIANT[review.status] ?? 'neutral',
                        },
                    ]}
                />
            }
            actions={
                <div className="flex flex-col items-end gap-tight">
                    <div className="flex items-center gap-tight">
                        <ProgressBar
                            value={pct}
                            variant={pct >= 100 ? 'success' : pct >= 50 ? 'info' : 'brand'}
                            aria-label={t('decisionsAria', { decided, total: decisionsTotal })}
                            className="w-full sm:w-48"
                        />
                        <span className="text-xs text-content-muted whitespace-nowrap">
                            {decided}/{decisionsTotal}
                        </span>
                    </div>
                    <div className="flex gap-tight">
                        {review.evidenceFileRecordId ? (
                            <Button
                                variant="secondary"
                                onClick={() =>
                                    window.open(`${apiBase}/evidence`, '_blank')
                                }
                                data-testid="access-review-download-evidence"
                            >{t('downloadEvidence')}</Button>
                        ) : null}
                        {canClose ? (
                            <Button
                                onClick={() => setClosing(true)}
                                disabled={decided !== decisionsTotal}
                                data-testid="access-review-close-button"
                            >{t('closeCampaign')}</Button>
                        ) : null}
                    </div>
                </div>
            }
        >
            {/* Description + meta data list — preserved as the first body
                element since EntityDetailLayout's `meta` prop is sized
                for inline badges, not multi-row metadata. */}
            <div className="space-y-tight">
                {review.description ? (
                    <p className="text-sm text-content-muted max-w-prose">
                        {review.description}
                    </p>
                ) : null}
                <dl className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-content-muted">
                    <div>
                        <dt className="font-semibold uppercase">{t('dlReviewer')}</dt>
                        <dd>{review.reviewer.email}</dd>
                    </div>
                    <div>
                        <dt className="font-semibold uppercase">{t('dlScope')}</dt>
                        <dd>{review.scope.replace('_', ' ').toLowerCase()}</dd>
                    </div>
                    <div>
                        <dt className="font-semibold uppercase">{t('dlDue')}</dt>
                        <dd>{review.dueAt ? formatDate(review.dueAt) : '—'}</dd>
                    </div>
                    {review.closedAt ? (
                        <div>
                            <dt className="font-semibold uppercase">{t('dlClosed')}</dt>
                            <dd>{formatDateTime(review.closedAt)}</dd>
                        </div>
                    ) : null}
                </dl>
            </div>

            {/* Roster — DataTable */}
            <DataTable
                data={review.decisions}
                columns={decisionColumns}
                getRowId={(d) => d.id}
                emptyState={t('rosterEmpty')}
                resourceName={(p) => (p ? 'subjects' : 'subject')}
                data-testid="access-review-roster-table"
            />

            {activeDecision ? (
                <DecisionDialog
                    apiBase={apiBase}
                    decision={activeDecision}
                    onClose={() => setActiveDecision(null)}
                    onSuccess={() => {
                        setActiveDecision(null);
                        reviewQuery.mutate();
                    }}
                />
            ) : null}

            {closing ? (
                <CloseDialog
                    apiBase={apiBase}
                    onClose={() => setClosing(false)}
                    onSuccess={() => {
                        setClosing(false);
                        reviewQuery.mutate();
                        // List page sees the new CLOSED state too.
                        swrMutate(
                            `/api/t/${tenantSlug}${CACHE_KEYS.accessReviews.list()}`,
                        );
                        router.refresh();
                    }}
                />
            ) : null}
        </EntityDetailLayout>
    );
}

// ─── Decision dialog ─────────────────────────────────────────────────

function DecisionDialog({
    apiBase,
    decision,
    onClose,
    onSuccess,
}: {
    apiBase: string;
    decision: { row: DecisionRow; type: DecisionType };
    onClose: () => void;
    onSuccess: () => void;
}) {
    const t = useTranslations('accessReviews');
    const [notes, setNotes] = useState('');
    const [modifiedToRole, setModifiedToRole] = useState<Role>('READER');
    const [error, setError] = useState<string | null>(null);

    const targetRoles = useMemo(
        () => ALL_ROLES.filter((r) => r !== decision.row.snapshotRole),
        [decision.row.snapshotRole],
    );

    const [submitting, setSubmitting] = useState(false);
    const handleSubmit = async () => {
        setSubmitting(true);
        setError(null);
        try {
            const body =
                decision.type === 'MODIFY'
                    ? { decision: 'MODIFY', modifiedToRole, notes: notes || undefined }
                    : { decision: decision.type, notes: notes || undefined };
            const res = await fetch(
                `${apiBase}/decisions/${decision.row.id}`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                },
            );
            if (!res.ok) {
                const text = await res.text();
                throw new Error(text || t('submitFailed'));
            }
            onSuccess();
        } catch (err) {
            setError(err instanceof Error ? err.message : t('unknownError'));
        } finally {
            setSubmitting(false);
        }
    };

    const titleByType: Record<DecisionType, string> = {
        CONFIRM: t('confirmAccess'),
        REVOKE: t('revokeAccess'),
        MODIFY: t('modifyRole'),
    };

    return (
        <Modal showModal={true} setShowModal={(v) => !v && onClose()}>
            <Modal.Header
                title={t('dialogTitle', {
                    type: titleByType[decision.type],
                    email: decision.row.subjectUser.email,
                })}
            />
            <Modal.Body>
                <div className="space-y-default">
                    <p className="text-sm text-content-muted">
                        {t('snapshotRoleLabel')}{' '}
                        <strong>{decision.row.snapshotRole}</strong>
                        {decision.row.membership &&
                        decision.row.membership.role !== decision.row.snapshotRole ? (
                            <>
                                {' '}
                                ({t('liveNow')} <strong>{decision.row.membership.role}</strong>)
                            </>
                        ) : null}
                    </p>
                    {decision.type === 'MODIFY' ? (
                        <FormField label={t('targetRole')} required>
                            <select
                                className="input"
                                value={modifiedToRole}
                                onChange={(e) => setModifiedToRole(e.target.value as Role)}
                                data-testid="decision-modal-modified-to-role"
                            >
                                {targetRoles.map((r) => (
                                    <option key={r} value={r}>
                                        {r}
                                    </option>
                                ))}
                            </select>
                        </FormField>
                    ) : null}
                    <FormField
                        label={
                            decision.type === 'CONFIRM'
                                ? t('justOptional')
                                : t('justRecommended')
                        }
                    >
                        <textarea
                            className="input"
                            rows={3}
                            value={notes}
                            onChange={(e) => setNotes(e.target.value)}
                            placeholder={t('whyDecision')}
                            data-testid="decision-modal-notes"
                        />
                    </FormField>
                    {error ? (
                        <p
                            className="text-sm text-content-error"
                            data-testid="decision-modal-error"
                        >
                            {error}
                        </p>
                    ) : null}
                </div>
            </Modal.Body>
            <Modal.Footer>
                <Button variant="secondary" onClick={onClose}>{t('cancel')}</Button>
                <Button
                    onClick={() => void handleSubmit()}
                    disabled={submitting}
                    data-testid="decision-modal-submit"
                >
                    {submitting ? t('submitting') : t('submitDecision')}
                </Button>
            </Modal.Footer>
        </Modal>
    );
}

// ─── Close-campaign dialog ───────────────────────────────────────────

function CloseDialog({
    apiBase,
    onClose,
    onSuccess,
}: {
    apiBase: string;
    onClose: () => void;
    onSuccess: () => void;
}) {
    const t = useTranslations('accessReviews');
    const [error, setError] = useState<string | null>(null);

    const [submitting, setSubmitting] = useState(false);
    const handleCloseCampaign = async () => {
        setSubmitting(true);
        setError(null);
        try {
            const res = await fetch(`${apiBase}/close`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
            });
            if (!res.ok) {
                const text = await res.text();
                throw new Error(text || t('closeFailed'));
            }
            onSuccess();
        } catch (err) {
            setError(err instanceof Error ? err.message : t('unknownError'));
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <Modal showModal={true} setShowModal={(v) => !v && onClose()}>
            <Modal.Header title={t('closeTitle')} />
            <Modal.Body>
                <p className="text-sm text-content-muted">
                    {t.rich('closeBody', { b: (c) => <strong>{c}</strong> })}
                </p>
                {error ? (
                    <p
                        className="mt-3 text-sm text-content-error"
                        data-testid="close-modal-error"
                    >
                        {error}
                    </p>
                ) : null}
            </Modal.Body>
            <Modal.Footer>
                <Button variant="secondary" onClick={onClose}>{t('cancel')}</Button>
                <Button
                    onClick={() => void handleCloseCampaign()}
                    disabled={submitting}
                    data-testid="close-modal-submit"
                >
                    {submitting ? t('closing') : t('closeGenerate')}
                </Button>
            </Modal.Footer>
        </Modal>
    );
}
