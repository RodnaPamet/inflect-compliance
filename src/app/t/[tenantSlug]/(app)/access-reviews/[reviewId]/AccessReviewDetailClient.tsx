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
import { formatDate, formatDateTime } from '@inflect/ui/lib/format-date';
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

/**
 * Step 5a — a CONNECTED_APP subject.
 *
 * These rows were already in the database and already decidable through
 * `/connected-decisions`, and this page rendered none of them: it reads
 * `review.decisions`, which holds MEMBER rows only. So a connected campaign
 * showed an empty subject table — and, because the Close button's gate was
 * `decided !== decisionsTotal`, an empty table meant `0 !== 0`, which is
 * false, which ENABLED Close. A connected campaign could be closed with every
 * one of its subjects undecided, from a page that showed no subjects.
 */
interface ConnectedSnapshot {
    provider?: string;
    email?: string;
    displayName?: string | null;
    isAdmin?: boolean;
    mfaEnrolled?: boolean;
    groups?: unknown;
    connectionId?: string;
    externalUserId?: string;
    /** Read-only HR context, or null when the account is linked to no worker. */
    hr?: {
        employeeId: string;
        fullName: string;
        workEmail: string;
        employmentStatus: string;
        department: string | null;
        jobTitle: string | null;
        managerName: string | null;
        managerEmail: string | null;
        matchMethod: string;
        contradicted: boolean;
    } | null;
}

interface ConnectedDecisionRow {
    id: string;
    subjectRef: string;
    decision: DecisionType | null;
    decidedAt: string | Date | null;
    decidedBy: { id: string; email: string; name: string | null } | null;
    notes: string | null;
    executedAt: string | Date | null;
    /**
     * Prisma types this `JsonValue`, which genuinely admits a string, a number
     * and an array — the column has no schema. Declaring the narrow object
     * shape here and asserting it at the boundary would be a lie the compiler
     * believes; `readSnapshot` narrows instead.
     */
    snapshotJson: unknown;
}

/**
 * Narrow a `snapshotJson` to the shape the table reads, degrading to `{}`.
 *
 * A snapshot that is not a JSON object cannot describe an account, and the
 * columns already have a fallback for every field — the account cell falls back
 * to `subjectRef`, HR renders "no linked worker". So degrading renders a row
 * that is honest about knowing nothing, rather than throwing and taking the
 * whole campaign page down over one malformed row.
 */
function readSnapshot(value: unknown): ConnectedSnapshot {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        return value as ConnectedSnapshot;
    }
    return {};
}

interface ReviewDetail {
    id: string;
    name: string;
    description: string | null;
    scope: 'ALL_USERS' | 'ADMIN_ONLY' | 'CUSTOM' | 'CONNECTED_APP' | 'LEGACY_APP';
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
    connectedDecisions: ConnectedDecisionRow[];
    /** The subject snapshot was cut off at the cap; the campaign covers a prefix. */
    snapshotTruncated: boolean;
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

    // ─── Progress over the subjects this campaign ACTUALLY has ──────────
    //
    // A campaign is one scope or the other, so exactly one of these two lists
    // is populated. Counting over both means the progress figure, the progress
    // bar and the Close gate all describe the same population, whichever scope
    // the campaign is — rather than describing member rows and silently
    // reporting 0/0 for a connected one.
    const isConnected = review.scope === 'CONNECTED_APP';
    const connectedRows = review.connectedDecisions ?? [];
    const subjectCount = review.decisions.length + connectedRows.length;
    const decided =
        review.decisions.filter((d) => d.decision !== null).length +
        connectedRows.filter((d) => d.decision !== null).length;
    const decisionsTotal = subjectCount;
    const pct = subjectCount === 0 ? 0 : Math.round((decided / subjectCount) * 100);
    // ZERO IS NOT COMPLETE. `decided !== subjectCount` is false when both are
    // zero, so the old gate enabled Close on a campaign with no subjects at
    // all. A review over zero subjects evidences nothing, and the usecase now
    // refuses it too — this is the same rule stated where the operator sees it,
    // so the button is disabled rather than failing on press.
    const everySubjectDecided = subjectCount > 0 && decided === subjectCount;

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

    const [connectedError, setConnectedError] = useState<string | null>(null);

    /**
     * Record a verdict on a connected subject.
     *
     * Posted straight from the row rather than through a modal: unlike the
     * member MODIFY path there is no target role to collect — a directory
     * account has no tenant role, and MODIFY here means "adjust this account
     * in the identity provider", which `closeConnectedAccessReview` turns into
     * a remediation task. Nothing to ask, so nothing to ask it with.
     */
    const submitConnected = async (decisionId: string, decision: DecisionType) => {
        setConnectedError(null);
        try {
            const res = await fetch(`${apiBase}/connected-decisions/${decisionId}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ decision }),
            });
            if (!res.ok) {
                throw new Error((await res.text()) || t('submitFailed'));
            }
            await reviewQuery.mutate();
            void swrMutate(CACHE_KEYS.accessReviews.list());
        } catch (err) {
            setConnectedError(err instanceof Error ? err.message : t('unknownError'));
        }
    };

    // ─── Step 5a — the CONNECTED_APP subject table ──────────────────────
    //
    // Deliberately a SEPARATE column set rather than a widened `DecisionRow`:
    // a directory account and a tenant membership share almost no columns. The
    // member table shows snapshot role vs LIVE role and last activity in the
    // product; a directory account has no membership to compare against and no
    // product activity. What a reviewer needs instead is who the account
    // belongs to according to HR, whether MFA is on, and whether the HR link
    // is still believed.
    const connectedColumns = useMemo(
        () => createColumns<ConnectedDecisionRow>([
            {
                id: 'account',
                header: t('colAccount'),
                cell: ({ row }) => {
                    const snap = readSnapshot(row.original.snapshotJson);
                    return (
                        <div data-testid={`connected-row-${row.original.id}`}>
                            <div className="font-medium text-content-default">
                                {snap.displayName || snap.email || row.original.subjectRef}
                            </div>
                            <div className="text-xs text-content-muted">
                                {snap.email ?? row.original.subjectRef}
                                {snap.provider ? ` · ${snap.provider}` : ''}
                            </div>
                        </div>
                    );
                },
            },
            {
                id: 'directoryPosture',
                header: t('colSnapshotRole'),
                cell: ({ row }) => {
                    const snap = readSnapshot(row.original.snapshotJson);
                    return (
                        <div className="text-sm">
                            <div>{snap.isAdmin ? t('directoryAdmin') : t('directoryUser')}</div>
                            <div className="text-xs text-content-muted">
                                {snap.mfaEnrolled ? t('mfaEnrolled') : t('mfaMissing')}
                            </div>
                        </div>
                    );
                },
            },
            {
                id: 'hr',
                header: t('colHrContext'),
                cell: ({ row }) => {
                    const hr = readSnapshot(row.original.snapshotJson).hr ?? null;
                    if (!hr) {
                        // An unlinked account is a REVIEWABLE fact, not missing
                        // data: it is a service account, a contractor the HR
                        // feed does not carry, or an unreconciled one. Saying
                        // "—" would read as "we did not look".
                        return (
                            <span className="text-xs text-content-muted italic">
                                {t('hrUnlinked')}
                            </span>
                        );
                    }
                    return (
                        <div className="text-sm">
                            <div>{hr.fullName}</div>
                            <div className="text-xs text-content-muted">
                                {hr.employmentStatus}
                                {hr.department ? ` · ${hr.department}` : ''}
                            </div>
                            {hr.managerName ? (
                                <div className="text-xs text-content-muted">
                                    {t('hrManager', { name: hr.managerName })}
                                </div>
                            ) : null}
                            {hr.contradicted ? (
                                <div className="text-xs font-medium text-content-warning">
                                    {t('hrContradicted')}
                                </div>
                            ) : null}
                        </div>
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
                            </StatusBadge>
                        );
                    }
                    if (canDecide) {
                        return (
                            <select
                                className="input"
                                defaultValue=""
                                data-testid={`connected-decision-select-${d.id}`}
                                onChange={(e) => {
                                    const v = e.target.value as DecisionType | '';
                                    if (v) void submitConnected(d.id, v);
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
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [canDecide, t],
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
                                disabled={!everySubjectDecided}
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

            {/* Step 5a — a campaign that covers a PREFIX of the directory must
                say so on the page an operator closes it from, not only in the
                audit log they read afterwards. */}
            {review.snapshotTruncated ? (
                <div
                    role="alert"
                    data-testid="access-review-snapshot-truncated"
                    className="rounded-md border border-border-warning bg-bg-warning p-3 text-sm text-content-warning"
                >
                    <strong className="font-semibold">{t('truncatedTitle')}</strong>{' '}
                    {t('truncatedBody', { count: subjectCount })}
                </div>
            ) : null}

            {/* Roster — DataTable. Connected campaigns render their OWN
                subjects: `review.decisions` is empty for them, and showing an
                empty roster beside a live Close button was the whole defect. */}
            {connectedError ? (
                <div
                    role="alert"
                    data-testid="connected-decision-error"
                    className="rounded-md border border-border-error bg-bg-error p-3 text-sm text-content-error"
                >
                    {connectedError}
                </div>
            ) : null}

            {isConnected ? (
                <DataTable
                    data={connectedRows}
                    columns={connectedColumns}
                    getRowId={(d) => d.id}
                    emptyState={t('rosterEmpty')}
                    resourceName={(p) => (p ? 'accounts' : 'account')}
                    data-testid="access-review-connected-table"
                />
            ) : (
                <DataTable
                    data={review.decisions}
                    columns={decisionColumns}
                    getRowId={(d) => d.id}
                    emptyState={t('rosterEmpty')}
                    resourceName={(p) => (p ? 'subjects' : 'subject')}
                    data-testid="access-review-roster-table"
                />
            )}

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
