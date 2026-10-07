'use client';
/* TODO(swr-migration): this file has fetch-on-mount + setState
 * patterns flagged by react-hooks/set-state-in-effect. Each call site
 * carries an inline disable directive; collectively they should
 * migrate to useTenantSWR (Epic 69 shape) so the rule can lift. */

/**
 * Epic G-3 — internal reviewer page.
 *
 * Side-by-side view of every question + submitted answer + auto
 * computed points + reviewer override + per-answer reviewer note.
 * Surfaces the live engine output (mode, sums, suggested rating)
 * so the reviewer sees "what would the score be" before saving.
 *
 * Status-aware:
 *   • SUBMITTED                    — full edit UI, Save Review action
 *   • REVIEWED                     — read-only with final rating + Close action
 *   • CLOSED                       — read-only terminal
 *   • DRAFT / SENT / IN_PROGRESS   — "not yet submitted" placeholder
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiErrorMessage } from '@/lib/api-error';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import {
    useTenantApiUrl,
    useTenantContext,
    useTenantHref,
} from '@/lib/tenant-context-provider';
import { Button } from '@/components/ui/button';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { SkeletonDetailPage } from '@/components/ui/skeleton';
import { formatDate } from '@/lib/format-date';
import { StatusBadge } from '@/components/ui/status-badge';
import { Heading } from '@/components/ui/typography';
import { BackAffordance } from '@/components/nav/BackAffordance';
import { cardVariants } from '@/components/ui/card';
import { cn } from '@inflect/ui/lib/cn';
import {
    VENDOR_ASSESSMENT_VARIANT,
    vendorAssessmentStatusLabelKey,
} from '@/app-layer/domain/entity-status-mapping';
import { AssessmentPrefillPanel } from './_components/AssessmentPrefillPanel';

interface Question {
    id: string;
    sectionId: string;
    sortOrder: number;
    prompt: string;
    answerType:
        | 'YES_NO'
        | 'SINGLE_SELECT'
        | 'MULTI_SELECT'
        | 'TEXT'
        | 'NUMBER'
        | 'SCALE'
        | 'FILE_UPLOAD';
    required: boolean;
    weight: number;
    optionsJson: unknown;
    scaleConfigJson: unknown;
}
interface Section {
    id: string;
    title: string;
    description: string | null;
    questions: Question[];
}
interface Answer {
    questionId: string;
    answerJson: unknown;
    computedPoints: number;
    reviewerOverridePoints: number | null;
    reviewerNotes: string | null;
}
interface ReviewView {
    assessmentId: string;
    status: string;
    vendor: { id: string; name: string };
    template: {
        id: string;
        key: string;
        version: number;
        name: string;
        description: string | null;
    };
    sections: Section[];
    answers: Answer[];
    scoring: {
        mode: string;
        score: number;
        autoSum: number;
        effectiveSum: number;
        totalWeight: number;
        verdict?: 'PASS' | 'FAIL';
        suggestedRating: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | null;
    };
    submittedAt: string | null;
    reviewedAt: string | null;
    reviewerNotes: string | null;
    riskRating: string | null;
    closedAt: string | null;
}

const RATING_OPTIONS: ComboboxOption[] = [
    { value: 'LOW', label: 'LOW' },
    { value: 'MEDIUM', label: 'MEDIUM' },
    { value: 'HIGH', label: 'HIGH' },
    { value: 'CRITICAL', label: 'CRITICAL' },
];

export function VendorAssessmentReviewClient({
    assessmentId,
}: {
    assessmentId: string;
}) {
    const apiUrl = useTenantApiUrl();
    const tenantHref = useTenantHref();
    const { permissions } = useTenantContext();
    const t = useTranslations('admin');
    const tv = useTranslations('vendors');

    const [view, setView] = useState<ReviewView | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    // PR-S — id of the register Risk this review auto-created (HIGH/CRITICAL), so
    // we can surface a link to it after review; null when none was created.
    const [autoRiskId, setAutoRiskId] = useState<string | null>(null);

    // Local edit state, keyed off the answers from the server.
    const [overrides, setOverrides] = useState<
        Record<string, { points: number | null; notes: string | null }>
    >({});
    const [finalRating, setFinalRating] = useState<string | null>(null);
    const [reviewerNotes, setReviewerNotes] = useState('');

    const refresh = useCallback(async () => {
        setLoading(true);
        try {
            const res = await fetch(
                apiUrl(`/vendor-assessment-reviews/${assessmentId}`),
            );
            if (!res.ok) {
                setError(t('assessmentReview.loadError', { status: res.status }));
                return;
            }
            const data = (await res.json()) as ReviewView;
            setView(data);
            // Seed local state.
            const seedOverrides: Record<
                string,
                { points: number | null; notes: string | null }
            > = {};
            for (const a of data.answers) {
                seedOverrides[a.questionId] = {
                    points: a.reviewerOverridePoints,
                    notes: a.reviewerNotes,
                };
            }
            setOverrides(seedOverrides);
            setFinalRating(data.riskRating);
            setReviewerNotes(data.reviewerNotes ?? '');
        } finally {
            setLoading(false);
        }
    }, [apiUrl, assessmentId, t]);

    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        refresh();
    }, [refresh]);

    const editable = useMemo(
        () => permissions.canAdmin && view?.status === 'SUBMITTED',
        [permissions.canAdmin, view?.status],
    );

    const closable = useMemo(
        () => permissions.canAdmin && view?.status === 'REVIEWED',
        [permissions.canAdmin, view?.status],
    );

    async function saveReview() {
        if (!view || !editable) return;
        setSaving(true);
        setError(null);
        try {
            // Build the overrides[] payload — only include rows the
            // reviewer actually touched relative to the loaded state.
            const initialMap = new Map(
                view.answers.map((a) => [
                    a.questionId,
                    {
                        points: a.reviewerOverridePoints,
                        notes: a.reviewerNotes,
                    },
                ]),
            );
            const dirtyOverrides: Array<{
                questionId: string;
                overridePoints?: number | null;
                reviewerNotes?: string | null;
            }> = [];
            for (const [qid, cur] of Object.entries(overrides)) {
                const orig = initialMap.get(qid) ?? {
                    points: null,
                    notes: null,
                };
                const pointsChanged = cur.points !== orig.points;
                const notesChanged = (cur.notes ?? null) !== (orig.notes ?? null);
                if (pointsChanged || notesChanged) {
                    dirtyOverrides.push({
                        questionId: qid,
                        ...(pointsChanged
                            ? { overridePoints: cur.points }
                            : {}),
                        ...(notesChanged
                            ? { reviewerNotes: cur.notes }
                            : {}),
                    });
                }
            }

            const res = await fetch(
                apiUrl(
                    `/vendor-assessment-reviews/${assessmentId}/review`,
                ),
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        overrides: dirtyOverrides,
                        finalRiskRating:
                            finalRating === view.riskRating
                                ? undefined
                                : finalRating,
                        reviewerNotes: reviewerNotes,
                    }),
                },
            );
            if (!res.ok) {
                const b = await res.json().catch(() => ({}));
                setError(apiErrorMessage(b, t('assessmentReview.saveError', { status: res.status })));
                return;
            }
            // PR-S — surface the auto-created register Risk (HIGH/CRITICAL) to the
            // reviewer so the silent writeback becomes observable.
            const body = (await res.json().catch(() => null)) as { autoCreatedRiskId?: string | null } | null;
            setAutoRiskId(body?.autoCreatedRiskId ?? null);
            await refresh();
        } finally {
            setSaving(false);
        }
    }

    async function closeOut() {
        if (!view || !closable) return;
        setSaving(true);
        try {
            const res = await fetch(
                apiUrl(`/vendor-assessment-reviews/${assessmentId}/close`),
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({}),
                },
            );
            if (!res.ok) {
                const b = await res.json().catch(() => ({}));
                setError(apiErrorMessage(b, t('assessmentReview.closeError', { status: res.status })));
                return;
            }
            await refresh();
        } finally {
            setSaving(false);
        }
    }

    if (loading) return <SkeletonDetailPage />;
    if (!view)
        return (
            <div className="p-12 text-center text-content-error">
                {error ?? t('assessmentReview.notFound')}
            </div>
        );

    const answerByQ = new Map(view.answers.map((a) => [a.questionId, a]));

    return (
        <div className="space-y-section animate-fadeIn" data-testid="vendor-review-page">
            <BackAffordance />
            {/* Header */}
            <div>
                <div className="flex items-start justify-between mt-1">
                    <div>
                        <p className="text-xs text-content-subtle">
                            {view.vendor.name}
                        </p>
                        <Heading level={1} className="mt-0.5">
                            {view.template.name}
                        </Heading>
                        <div className="flex items-center gap-tight mt-1 text-xs text-content-subtle">
                            <span>{view.template.key}</span>
                            <span>·</span>
                            <span>v{view.template.version}</span>
                            <span>·</span>
                            <StatusBadge variant={VENDOR_ASSESSMENT_VARIANT[view.status] ?? 'neutral'} size="sm" data-testid="review-status-badge">
                                {tv(vendorAssessmentStatusLabelKey(view.status))}
                            </StatusBadge>
                            {view.submittedAt && (
                                <>
                                    <span>·</span>
                                    <span>
                                        {t('assessmentReview.submitted', { date: formatDate(view.submittedAt) })}
                                    </span>
                                </>
                            )}
                        </div>
                    </div>
                </div>
            </div>

            {error && (
                <p
                    className="text-xs text-content-error"
                    role="alert"
                    data-testid="review-error"
                >
                    {error}
                </p>
            )}

            {/* PR-S — the review auto-created a register Risk (HIGH/CRITICAL):
                make the previously-silent writeback observable + linkable. */}
            {autoRiskId && (
                <div
                    className={cn(cardVariants({ density: 'compact' }), 'flex flex-wrap items-center justify-between gap-tight')}
                    id="auto-risk-notice"
                >
                    <span className="text-sm text-content-default">{t('assessmentReview.autoRiskCreated')}</span>
                    <Link href={tenantHref(`/risks/${autoRiskId}`)} className="text-content-info hover:underline text-sm">
                        {t('assessmentReview.autoRiskView')}
                    </Link>
                </div>
            )}

            {/* Pre-submit placeholder */}
            {(view.status === 'DRAFT' ||
                view.status === 'SENT' ||
                view.status === 'IN_PROGRESS') && (
                <div
                    className={cardVariants()}
                    data-testid="not-yet-submitted-state"
                >
                    <p className="text-sm text-content-emphasis">
                        {t('assessmentReview.awaitingTitle')}
                    </p>
                    <p className="text-xs text-content-muted mt-1">
                        {t('assessmentReview.awaitingDesc')}
                    </p>
                </div>
            )}

            {/* Scoring panel */}
            {(view.status === 'SUBMITTED' ||
                view.status === 'REVIEWED' ||
                view.status === 'CLOSED') && (
                <div
                    className={cn(cardVariants({ density: 'compact' }), 'grid grid-cols-2 md:grid-cols-5 gap-default')}
                    data-testid="scoring-panel"
                >
                    <Stat
                        label={t('assessmentReview.mode')}
                        value={view.scoring.mode.replace(/_/g, ' ')}
                    />
                    <Stat label={t('assessmentReview.score')} value={fmtNum(view.scoring.score)} />
                    <Stat
                        label={t('assessmentReview.autoSum')}
                        value={fmtNum(view.scoring.autoSum)}
                    />
                    <Stat
                        label={t('assessmentReview.effectiveSum')}
                        value={fmtNum(view.scoring.effectiveSum)}
                    />
                    {view.scoring.verdict ? (
                        <Stat
                            label={t('assessmentReview.verdict')}
                            value={view.scoring.verdict}
                            tone={
                                view.scoring.verdict === 'PASS'
                                    ? 'success'
                                    : 'danger'
                            }
                        />
                    ) : (
                        <Stat
                            label={t('assessmentReview.suggestedRating')}
                            value={view.scoring.suggestedRating ?? '—'}
                        />
                    )}
                </div>
            )}

            {/* Side-by-side question rows */}
            {(view.status === 'SUBMITTED' ||
                view.status === 'REVIEWED' ||
                view.status === 'CLOSED') &&
                view.sections.map((s) => (
                    <div
                        key={s.id}
                        className={cardVariants({ density: 'compact' })}
                        data-testid={`section-${s.id}`}
                    >
                        <Heading level={2} className="mb-3">
                            {s.title}
                        </Heading>
                        <div className="space-y-compact">
                            {s.questions.map((q) => {
                                const a = answerByQ.get(q.id);
                                const ov = overrides[q.id] ?? {
                                    points: null,
                                    notes: null,
                                };
                                return (
                                    <div
                                        key={q.id}
                                        className="border-t border-border-default/30 pt-3 grid grid-cols-1 md:grid-cols-12 gap-compact"
                                        data-testid={`review-row-${q.id}`}
                                    >
                                        <div className="md:col-span-5">
                                            <p className="text-sm text-content-emphasis">
                                                {q.prompt}
                                            </p>
                                            <p className="text-xs text-content-subtle mt-1">
                                                <StatusBadge variant="info" size="sm">
                                                    {q.answerType}
                                                </StatusBadge>{' '}
                                                {q.required && (
                                                    <StatusBadge variant="warning" size="sm">
                                                        {t('assessmentReview.required')}
                                                    </StatusBadge>
                                                )}{' '}
                                                <span>w={q.weight}</span>
                                            </p>
                                        </div>
                                        <div
                                            className="md:col-span-3 text-sm"
                                            data-testid={`review-answer-${q.id}`}
                                        >
                                            <p className="text-xs text-content-muted mb-1">
                                                {t('assessmentReview.submittedAnswer')}
                                            </p>
                                            <RenderAnswer
                                                answerJson={a?.answerJson}
                                            />
                                        </div>
                                        <div className="md:col-span-2">
                                            <p className="text-xs text-content-muted">
                                                {t('assessmentReview.auto')}
                                            </p>
                                            <p className="text-sm text-content-emphasis">
                                                {fmtNum(
                                                    a?.computedPoints ?? 0,
                                                )}
                                            </p>
                                            {editable ? (
                                                <input
                                                    className="input w-full mt-1"
                                                    type="text"
                                                    inputMode="decimal"
                                                    placeholder={t('assessmentReview.overridePlaceholder')}
                                                    value={
                                                        ov.points === null
                                                            ? ''
                                                            : String(ov.points)
                                                    }
                                                    onChange={(e) => {
                                                        const v = e.target.value;
                                                        const n =
                                                            v === ''
                                                                ? null
                                                                : Number(v);
                                                        setOverrides((prev) => ({
                                                            ...prev,
                                                            [q.id]: {
                                                                ...ov,
                                                                points:
                                                                    n === null ||
                                                                    Number.isFinite(
                                                                        n,
                                                                    )
                                                                        ? n
                                                                        : ov.points,
                                                            },
                                                        }));
                                                    }}
                                                    data-testid={`override-points-${q.id}`}
                                                />
                                            ) : (
                                                ov.points !== null && (
                                                    <p className="text-xs text-content-warning mt-1">
                                                        {t('assessmentReview.overrideLabel', { points: fmtNum(ov.points) })}
                                                    </p>
                                                )
                                            )}
                                        </div>
                                        <div className="md:col-span-2">
                                            <p className="text-xs text-content-muted">
                                                {t('assessmentReview.notes')}
                                            </p>
                                            {editable ? (
                                                <textarea
                                                    className="input w-full"
                                                    rows={2}
                                                    value={ov.notes ?? ''}
                                                    onChange={(e) =>
                                                        setOverrides(
                                                            (prev) => ({
                                                                ...prev,
                                                                [q.id]: {
                                                                    ...ov,
                                                                    notes:
                                                                        e.target
                                                                            .value ||
                                                                        null,
                                                                },
                                                            }),
                                                        )
                                                    }
                                                />
                                            ) : (
                                                <p className="text-xs text-content-muted">
                                                    {ov.notes ?? '—'}
                                                </p>
                                            )}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                ))}

            {/* AI pre-fill — propose cited answers from a vendor document; a
                human approves before anything is scored (propose-not-commit).
                Gated to reviewers who can act on the assessment. */}
            {permissions.canAdmin &&
                (view.status === 'SUBMITTED' ||
                    view.status === 'REVIEWED' ||
                    view.status === 'CLOSED') && (
                    <AssessmentPrefillPanel
                        vendorId={view.vendor.id}
                        assessmentId={view.assessmentId}
                        onApplied={refresh}
                    />
                )}

            {/* Final rating + reviewer notes + actions */}
            {(view.status === 'SUBMITTED' || view.status === 'REVIEWED') && (
                <div
                    className={cn(cardVariants({ density: 'compact' }), 'space-y-compact')}
                    data-testid="final-rating-panel"
                >
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-compact">
                        <div>
                            <label className="text-xs text-content-muted block mb-1">
                                {t('assessmentReview.finalRating')}
                            </label>
                            {editable ? (
                                <Combobox
                                    hideSearch
                                    selected={
                                        RATING_OPTIONS.find(
                                            (o) => o.value === finalRating,
                                        ) ?? null
                                    }
                                    setSelected={(opt) => {
                                        setFinalRating(opt?.value ?? null);
                                    }}
                                    options={RATING_OPTIONS}
                                    matchTriggerWidth
                                    placeholder={
                                        view.scoring.suggestedRating
                                            ? t('assessmentReview.suggestedPlaceholder', { rating: view.scoring.suggestedRating })
                                            : t('assessmentReview.chooseRating')
                                    }
                                />
                            ) : (
                                <p
                                    className="text-sm text-content-emphasis"
                                    data-testid="final-rating-readonly"
                                >
                                    {finalRating ?? '—'}
                                </p>
                            )}
                        </div>
                        <div>
                            <label className="text-xs text-content-muted block mb-1">
                                {t('assessmentReview.reviewerNotes')}
                            </label>
                            {editable ? (
                                <textarea
                                    className="input w-full"
                                    rows={3}
                                    value={reviewerNotes}
                                    onChange={(e) =>
                                        setReviewerNotes(e.target.value)
                                    }
                                />
                            ) : (
                                <p className="text-sm text-content-muted whitespace-pre-wrap">
                                    {reviewerNotes || '—'}
                                </p>
                            )}
                        </div>
                    </div>

                    <div className="flex justify-end gap-tight pt-2 border-t border-border-default/30">
                        {editable && (
                            <Button
                                variant="primary"
                                size="sm"
                                onClick={saveReview}
                                disabled={saving}
                                loading={saving}
                                id="save-review-btn"
                            >
                                {saving ? t('assessmentReview.saving') : t('assessmentReview.saveReview')}
                            </Button>
                        )}
                        {closable && (
                            <Button
                                variant="secondary"
                                size="sm"
                                onClick={closeOut}
                                disabled={saving}
                                loading={saving}
                                id="close-assessment-btn"
                            >
                                {saving ? t('assessmentReview.closing') : t('assessmentReview.closeAssessment')}
                            </Button>
                        )}
                    </div>
                </div>
            )}

            {view.status === 'CLOSED' && (
                <div
                    className={cn(cardVariants({ density: 'compact' }), 'text-sm text-content-muted')}
                    data-testid="closed-banner"
                >
                    {view.closedAt
                        ? t('assessmentReview.closedOn', { date: formatDate(view.closedAt) })
                        : t('assessmentReview.closedNoDate')}
                    . {t('assessmentReview.finalRatingColon')}{' '}
                    <strong className="text-content-emphasis">
                        {view.riskRating ?? '—'}
                    </strong>
                </div>
            )}
        </div>
    );
}

// ─── Subcomponents ─────────────────────────────────────────────────

function Stat({
    label,
    value,
    tone,
}: {
    label: string;
    value: string;
    tone?: 'success' | 'danger';
}) {
    return (
        <div>
            <p className="text-xs text-content-muted">{label}</p>
            <p
                className={`text-sm font-semibold ${
                    tone === 'success'
                        ? 'text-content-success'
                        : tone === 'danger'
                            ? 'text-content-error'
                            : 'text-content-emphasis'
                }`}
            >
                {value}
            </p>
        </div>
    );
}

function RenderAnswer({ answerJson }: { answerJson: unknown }) {
    const t = useTranslations('admin');
    if (answerJson === null || answerJson === undefined) {
        return <span className="text-content-subtle italic">{t('assessmentReview.noAnswer')}</span>;
    }
    if (
        typeof answerJson === 'object' &&
        !Array.isArray(answerJson) &&
        'value' in (answerJson as object)
    ) {
        const v = (answerJson as { value: unknown }).value;
        return <RenderValue v={v} />;
    }
    return <RenderValue v={answerJson} />;
}

function RenderValue({ v }: { v: unknown }) {
    const t = useTranslations('admin');
    if (Array.isArray(v)) {
        return <span>{v.join(', ')}</span>;
    }
    if (v === null || v === undefined) {
        return <span className="text-content-subtle italic">{t('assessmentReview.noAnswer')}</span>;
    }
    return <span>{String(v)}</span>;
}

function fmtNum(n: number): string {
    if (!Number.isFinite(n)) return '—';
    if (Number.isInteger(n)) return String(n);
    return n.toFixed(2);
}
