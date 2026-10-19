'use client';

/**
 * One sampled workpaper, re-performed and answered (#3677, step 3d).
 *
 * The sheet shows what the auditor agent recorded — the population, the
 * sample, each sampled unit's outcome, the exceptions and the conclusion — so
 * the reviewer can re-perform it, and then takes their answer inline: a radio
 * group (CONCURRED / DISSENTED / INDETERMINATE) and, for a dissent, the stable
 * dissent codes. A Sheet with an inline form rather than a Modal: the reviewer
 * reads the workpaper and answers in the same place, and the form's one action
 * is a SECONDARY button — the product's primary-button budget is spent, and a
 * dialog's last button would have to be primary.
 *
 * The answer is set once. The server refuses a second one, refuses anybody but
 * the assigned reviewer, and refuses the auditor agent's owner; each refusal
 * arrives as the server's sentence, shown inline. Nothing here decides.
 *
 * Internal audit opens anybody's row from its overview, READ-ONLY: the form
 * renders only when the server says this viewer may answer (`viewer`), which
 * is only ever on the viewer's own row.
 */
import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { ErrorState } from '@/components/ui/error-state';
import { FormField } from '@/components/ui/form-field';
import { useToast } from '@/components/ui/hooks';
import { InlineNotice } from '@/components/ui/inline-notice';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Sheet } from '@/components/ui/sheet';
import { SkeletonCard } from '@/components/ui/skeleton';
import { Heading } from '@/components/ui/typography';
import { apiErrorMessage } from '@/lib/api-error';
import {
    WORKPAPER_REVIEW_ANSWERS,
    WORKPAPER_REVIEW_DISSENT_CODES,
    type WorkpaperReviewAnswer,
    type WorkpaperReviewDissentCode,
} from '@/lib/agentic/workpaper-review-codes';
import { formatDateTime } from '@inflect/ui/lib/format-date';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';

import { WORKPAPER_REVIEWS_ENDPOINT, type ReviewOutcome } from './WorkpaperReviewsClient';

interface ItemOutcome {
    unitId: string;
    outcome: string;
    code: string | null;
}

interface ExceptionRow {
    unitId: string | null;
    code: string;
    proposalId?: string;
}

/** `GET /api/t/:slug/audits/workpaper-reviews/:reviewId`. */
export interface WorkpaperReviewDetailPayload {
    review: {
        id: string;
        workpaperId: string;
        samplingEpoch: string;
        samplePercent: number;
        sampledAt: string;
        assignedToUserId: string | null;
        unassignedReason: string | null;
        outcome: ReviewOutcome;
        dissentCodes: string[];
        reviewedAt: string | null;
        findingProposalId: string | null;
    };
    /** Whether THIS viewer may answer — only ever on their own row. */
    viewer: { mine: boolean; answerable: boolean; refusal: string | null };
    workpaper: {
        id: string;
        procedureId: string;
        catalogueVersion: number;
        periodLabel: string;
        populationDefinition: string;
        populationCount: number;
        populationDigest: string;
        sampleEpoch: string | null;
        seedFingerprint: string | null;
        sampleSize: number | null;
        sampledUnitIds: string[];
        parametersJson: Record<string, unknown> | null;
        attributesTested: string[];
        itemOutcomesJson: ItemOutcome[];
        exceptionsJson: ExceptionRow[];
        conclusion: string;
        conclusionBasis: string;
        evidenceRefs: string[];
        proposalIds: string[];
        auditorAgentId: string;
        controlTestRunId: string;
        createdAt: string;
    };
}

/** Narrows a Combobox value back to the vocabulary it was built from. */
function isDissentCode(value: string): value is WorkpaperReviewDissentCode {
    return (WORKPAPER_REVIEW_DISSENT_CODES as readonly string[]).includes(value);
}

/** Shown in the sheet, and capped: a population can hold 5,000 units. */
const UNIT_ROW_CAP = 200;

export function WorkpaperReviewSheet({
    reviewId,
    onClose,
    onAnswered,
}: {
    reviewId: string;
    onClose: () => void;
    onAnswered: () => void;
}) {
    const t = useTranslations('audits');
    const apiUrl = useTenantApiUrl();
    const toast = useToast();
    const { data, error, isLoading, mutate } = useTenantSWR<WorkpaperReviewDetailPayload>(
        `${WORKPAPER_REVIEWS_ENDPOINT}/${reviewId}`,
    );

    const [outcome, setOutcome] = useState<WorkpaperReviewAnswer | null>(null);
    const [codes, setCodes] = useState<WorkpaperReviewDissentCode[]>([]);
    const [busy, setBusy] = useState(false);
    const [answerError, setAnswerError] = useState<string | null>(null);

    const codeOptions = useMemo(
        () =>
            WORKPAPER_REVIEW_DISSENT_CODES.map((code) => ({
                value: code,
                label: t(`workpaperReviews.codes.${code}`),
            })),
        [t],
    );

    // DISSENTED needs at least one code; every other answer carries none.
    const ready = outcome !== null && (outcome !== 'DISSENTED' || codes.length > 0) && !busy;

    const submit = async () => {
        if (!outcome) return;
        setBusy(true);
        setAnswerError(null);
        try {
            const res = await fetch(apiUrl(`${WORKPAPER_REVIEWS_ENDPOINT}/${reviewId}`), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(
                    outcome === 'DISSENTED' ? { outcome, dissentCodes: codes } : { outcome },
                ),
            });
            if (!res.ok) {
                const payload = await res.json().catch(() => null);
                const message = apiErrorMessage(payload, t('workpaperReviews.answerFailed'));
                setAnswerError(message);
                toast.error(message);
                return;
            }
            toast.success(
                outcome === 'DISSENTED' ? t('workpaperReviews.answeredDissent') : t('workpaperReviews.answered'),
            );
            await mutate();
            onAnswered();
        } catch {
            setAnswerError(t('workpaperReviews.answerFailed'));
            toast.error(t('workpaperReviews.answerFailed'));
        } finally {
            setBusy(false);
        }
    };

    const wp = data?.workpaper;
    const review = data?.review;
    const viewer = data?.viewer;

    return (
        <Sheet open onOpenChange={(open) => { if (!open && !busy) onClose(); }} size="lg" title={t('workpaperReviews.sheetTitle')}>
            <Sheet.Header>
                <Sheet.Title>{t('workpaperReviews.sheetTitle')}</Sheet.Title>
                <Sheet.Description>{t('workpaperReviews.sheetDescription')}</Sheet.Description>
            </Sheet.Header>
            <Sheet.Body>
                <div className="space-y-section" data-testid="workpaper-review-sheet">
                    {isLoading || (!data && !error) ? <SkeletonCard /> : null}
                    {error ? (
                        <ErrorState
                            title={error instanceof Error ? error.message : t('workpaperReviews.loadFailed')}
                            onRetry={() => { void mutate(); }}
                        />
                    ) : null}
                    {wp && review ? (
                        <>
                            <section className="space-y-tight">
                                <Heading level={3} as="h3">{t('workpaperReviews.sectionRecord')}</Heading>
                                <dl className="space-y-tight" data-testid="workpaper-review-facts">
                                    <Field label={t('workpaperReviews.fieldProcedure')}>
                                        {t('workpaperReviews.procedureValue', {
                                            procedure: wp.procedureId,
                                            version: wp.catalogueVersion,
                                        })}
                                    </Field>
                                    <Field label={t('workpaperReviews.fieldPeriod')}>{wp.periodLabel}</Field>
                                    <Field label={t('workpaperReviews.fieldPopulation')}>
                                        {t('workpaperReviews.populationValue', { count: wp.populationCount })}
                                    </Field>
                                    <Field label={t('workpaperReviews.fieldPopulationDefinition')}>
                                        {wp.populationDefinition}
                                    </Field>
                                    <Field label={t('workpaperReviews.fieldPopulationDigest')}>
                                        <span className="font-mono text-xs break-all">{wp.populationDigest}</span>
                                    </Field>
                                    <Field label={t('workpaperReviews.fieldSample')}>
                                        {wp.sampleEpoch
                                            ? t('workpaperReviews.sampleValue', {
                                                  size: wp.sampleSize ?? 0,
                                                  epoch: wp.sampleEpoch,
                                              })
                                            : t('workpaperReviews.noSample')}
                                    </Field>
                                    {wp.seedFingerprint && (
                                        <Field label={t('workpaperReviews.fieldSeedFingerprint')}>
                                            <span className="font-mono text-xs break-all">{wp.seedFingerprint}</span>
                                        </Field>
                                    )}
                                    <Field label={t('workpaperReviews.fieldAttributes')}>
                                        {wp.attributesTested.length > 0 ? wp.attributesTested.join(', ') : '—'}
                                    </Field>
                                    <Field label={t('workpaperReviews.fieldParameters')}>
                                        {wp.parametersJson
                                            ? Object.entries(wp.parametersJson)
                                                  .map(([k, v]) => `${k}=${String(v)}`)
                                                  .join(', ')
                                            : '—'}
                                    </Field>
                                    <Field label={t('workpaperReviews.fieldConclusion')}>
                                        {t('workpaperReviews.conclusionValue', {
                                            conclusion: wp.conclusion,
                                            basis: wp.conclusionBasis,
                                        })}
                                    </Field>
                                    <Field label={t('workpaperReviews.fieldEvidence')}>
                                        {wp.evidenceRefs.length > 0 ? wp.evidenceRefs.join(', ') : '—'}
                                    </Field>
                                    <Field label={t('workpaperReviews.fieldAuditor')}>
                                        <span className="font-mono text-xs">{wp.auditorAgentId}</span>
                                    </Field>
                                    <Field label={t('workpaperReviews.fieldWritten')}>{formatDateTime(wp.createdAt)}</Field>
                                    <Field label={t('workpaperReviews.fieldDrawn')}>
                                        {t('workpaperReviews.drawnValue', {
                                            at: formatDateTime(review.sampledAt),
                                            epoch: review.samplingEpoch,
                                            percent: review.samplePercent,
                                        })}
                                    </Field>
                                </dl>
                            </section>

                            <section className="space-y-tight">
                                <Heading level={3} as="h3">
                                    {t('workpaperReviews.sectionOutcomes', { count: wp.itemOutcomesJson.length })}
                                </Heading>
                                <ul className="space-y-tight text-sm" data-testid="workpaper-review-outcomes">
                                    {wp.itemOutcomesJson.slice(0, UNIT_ROW_CAP).map((o) => (
                                        <li key={o.unitId} className="font-mono text-xs">
                                            {o.unitId} · {o.outcome}
                                            {o.code ? ` · ${o.code}` : ''}
                                        </li>
                                    ))}
                                </ul>
                                {wp.itemOutcomesJson.length > UNIT_ROW_CAP && (
                                    <p className="text-xs text-content-muted">
                                        {t('workpaperReviews.moreRows', { more: wp.itemOutcomesJson.length - UNIT_ROW_CAP })}
                                    </p>
                                )}
                            </section>

                            <section className="space-y-tight">
                                <Heading level={3} as="h3">
                                    {t('workpaperReviews.sectionExceptions', { count: wp.exceptionsJson.length })}
                                </Heading>
                                {wp.exceptionsJson.length === 0 ? (
                                    <p className="text-sm text-content-muted">{t('workpaperReviews.noExceptions')}</p>
                                ) : (
                                    <ul className="space-y-tight text-sm" data-testid="workpaper-review-exceptions">
                                        {wp.exceptionsJson.slice(0, UNIT_ROW_CAP).map((e, i) => (
                                            <li key={`${e.unitId ?? 'POPULATION'}-${e.code}-${i}`} className="font-mono text-xs">
                                                {e.unitId ?? t('workpaperReviews.populationLevel')} · {e.code}
                                                {e.proposalId ? ` · ${e.proposalId}` : ''}
                                            </li>
                                        ))}
                                    </ul>
                                )}
                            </section>

                            {review.outcome === 'PENDING' && !viewer?.answerable ? (
                                <section className="space-y-tight" data-testid="workpaper-review-read-only">
                                    <Heading level={3} as="h3">{t('workpaperReviews.sectionAnswer')}</Heading>
                                    <InlineNotice variant="info" icon={null}>
                                        {review.assignedToUserId === null
                                            ? t('workpaperReviews.readOnlyUnassigned', {
                                                  reason: review.unassignedReason ?? '—',
                                              })
                                            : t('workpaperReviews.readOnlyOther')}
                                    </InlineNotice>
                                </section>
                            ) : review.outcome === 'PENDING' ? (
                                <section className="space-y-default" data-testid="workpaper-review-answer-form">
                                    <Heading level={3} as="h3">{t('workpaperReviews.sectionAnswer')}</Heading>
                                    <InlineNotice variant="info" icon={null}>
                                        {t('workpaperReviews.answerOnce')}
                                    </InlineNotice>
                                    {answerError ? (
                                        <InlineNotice variant="error" data-testid="workpaper-review-answer-error">
                                            {answerError}
                                        </InlineNotice>
                                    ) : null}
                                    <FormField label={t('workpaperReviews.fieldYourAnswer')}>
                                        <RadioGroup
                                            value={outcome ?? ''}
                                            onValueChange={(v) => {
                                                setOutcome(v as WorkpaperReviewAnswer);
                                                if (v !== 'DISSENTED') setCodes([]);
                                            }}
                                            aria-label={t('workpaperReviews.fieldYourAnswer')}
                                        >
                                            {WORKPAPER_REVIEW_ANSWERS.map((a) => {
                                                const id = `workpaper-review-outcome-${a}`;
                                                return (
                                                    <label key={a} htmlFor={id} className="flex items-start gap-compact text-sm">
                                                        <RadioGroupItem id={id} value={a} size="sm" className="mt-0.5" data-testid={id} />
                                                        <span>
                                                            <span className="text-content-emphasis">{t(`workpaperReviews.outcome.${a}`)}</span>
                                                            <span className="block text-xs text-content-muted">
                                                                {t(`workpaperReviews.outcomeHint.${a}`)}
                                                            </span>
                                                        </span>
                                                    </label>
                                                );
                                            })}
                                        </RadioGroup>
                                    </FormField>
                                    {outcome === 'DISSENTED' && (
                                        <FormField
                                            label={t('workpaperReviews.fieldDissentCodes')}
                                            description={t('workpaperReviews.dissentCodesHint')}
                                        >
                                            <Combobox<true, (typeof codeOptions)[number]>
                                                multiple
                                                id="workpaper-review-dissent-codes"
                                                options={codeOptions}
                                                selected={codeOptions.filter((o) => codes.includes(o.value))}
                                                setSelected={(opts) => setCodes(opts.map((o) => o.value).filter(isDissentCode))}
                                                placeholder={t('workpaperReviews.dissentCodesPlaceholder')}
                                                matchTriggerWidth
                                            />
                                        </FormField>
                                    )}
                                    <div className="flex justify-end">
                                        <Button
                                            variant="secondary"
                                            onClick={() => { void submit(); }}
                                            disabled={!ready}
                                            loading={busy}
                                            id="workpaper-review-submit"
                                        >
                                            {t('workpaperReviews.recordAnswer')}
                                        </Button>
                                    </div>
                                </section>
                            ) : (
                                <section className="space-y-tight" data-testid="workpaper-review-recorded">
                                    <Heading level={3} as="h3">
                                        {viewer?.mine === false
                                            ? t('workpaperReviews.sectionRecordedOther')
                                            : t('workpaperReviews.sectionRecorded')}
                                    </Heading>
                                    <dl className="space-y-tight">
                                        <Field label={t('workpaperReviews.fieldYourAnswer')}>
                                            {t(`workpaperReviews.outcome.${review.outcome}`)}
                                        </Field>
                                        {review.dissentCodes.length > 0 && (
                                            <Field label={t('workpaperReviews.fieldDissentCodes')}>
                                                {review.dissentCodes.map((c) => t(`workpaperReviews.codes.${c}`)).join('; ')}
                                            </Field>
                                        )}
                                        {review.reviewedAt && (
                                            <Field label={t('workpaperReviews.fieldAnsweredAt')}>
                                                {formatDateTime(review.reviewedAt)}
                                            </Field>
                                        )}
                                        {review.outcome === 'DISSENTED' && (
                                            <Field label={t('workpaperReviews.fieldFindingProposal')}>
                                                {review.findingProposalId ?? t('workpaperReviews.proposalPending')}
                                            </Field>
                                        )}
                                    </dl>
                                </section>
                            )}
                        </>
                    ) : null}
                </div>
            </Sheet.Body>
        </Sheet>
    );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div className="flex flex-col gap-tight sm:flex-row sm:items-baseline sm:gap-compact">
            <dt className="min-w-[10rem] text-xs uppercase tracking-wide text-content-subtle">{label}</dt>
            <dd className="min-w-0 break-words text-sm text-content-default">{children}</dd>
        </div>
    );
}
