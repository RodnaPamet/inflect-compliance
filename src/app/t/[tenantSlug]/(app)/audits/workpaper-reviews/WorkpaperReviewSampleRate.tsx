'use client';

/**
 * Internal audit's sampling rate, set inline (#3677, owner decision
 * 2026-10-19).
 *
 * Rendered only for internal audit — the list response's
 * `sampleRate.canChange`, which is the server's own rule (a person, an ACTIVE
 * third-line member who owns no auditor agent). Hiding it is a courtesy, not
 * the gate: `PUT …/workpaper-reviews/sample-rate` refuses everybody else with
 * a named reason, and its refusal is shown here as the server's sentence.
 *
 * A stepper bounded by the CHECK's own numbers and ONE secondary button, inline
 * on the page rather than in a dialog: the product's primary-button budget is
 * spent, and a dialog's last button would have to be primary.
 */
import { useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { useToast } from '@/components/ui/hooks';
import { InlineNotice } from '@/components/ui/inline-notice';
import { NumberStepper } from '@/components/ui/number-stepper';
import { apiErrorMessage } from '@/lib/api-error';
import {
    WORKPAPER_REVIEW_MAX_SAMPLE_PERCENT,
    WORKPAPER_REVIEW_MIN_SAMPLE_PERCENT,
} from '@/lib/agentic/workpaper-review-codes';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';

/** The rate route, relative to the tenant. */
export const WORKPAPER_REVIEW_SAMPLE_RATE_ENDPOINT = '/audits/workpaper-reviews/sample-rate';

export function WorkpaperReviewSampleRate({ percent, onSaved }: { percent: number; onSaved: () => void }) {
    const t = useTranslations('audits');
    const apiUrl = useTenantApiUrl();
    const toast = useToast();
    const [value, setValue] = useState(percent);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const dirty = value !== percent;

    const save = async () => {
        setBusy(true);
        setError(null);
        try {
            const res = await fetch(apiUrl(WORKPAPER_REVIEW_SAMPLE_RATE_ENDPOINT), {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ samplePercent: value }),
            });
            if (!res.ok) {
                const payload = await res.json().catch(() => null);
                const message = apiErrorMessage(payload, t('workpaperReviews.rateFailed'));
                setError(message);
                toast.error(message);
                return;
            }
            toast.success(t('workpaperReviews.rateSaved', { percent: value }));
            onSaved();
        } catch {
            setError(t('workpaperReviews.rateFailed'));
            toast.error(t('workpaperReviews.rateFailed'));
        } finally {
            setBusy(false);
        }
    };

    return (
        <section className="space-y-default" data-testid="workpaper-review-sample-rate">
            <FormField
                label={t('workpaperReviews.rateLabel')}
                description={t('workpaperReviews.rateHint', {
                    min: WORKPAPER_REVIEW_MIN_SAMPLE_PERCENT,
                    max: WORKPAPER_REVIEW_MAX_SAMPLE_PERCENT,
                })}
            >
                <div className="flex flex-wrap items-center gap-compact">
                    <NumberStepper
                        id="workpaper-review-sample-rate"
                        value={value}
                        onChange={(v) => {
                            setValue(v);
                            setError(null);
                        }}
                        min={WORKPAPER_REVIEW_MIN_SAMPLE_PERCENT}
                        max={WORKPAPER_REVIEW_MAX_SAMPLE_PERCENT}
                        size="sm"
                        formatValue={(v) => `${v}%`}
                        ariaLabel={t('workpaperReviews.rateLabel')}
                        decrementAriaLabel={t('workpaperReviews.rateDecrease')}
                        incrementAriaLabel={t('workpaperReviews.rateIncrease')}
                        className="max-w-[12rem]"
                    />
                    <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => {
                            void save();
                        }}
                        disabled={!dirty || busy}
                        loading={busy}
                        id="workpaper-review-sample-rate-save"
                        text={t('workpaperReviews.rateSave')}
                    />
                </div>
            </FormField>
            {error ? (
                <InlineNotice variant="error" icon={null} data-testid="workpaper-review-sample-rate-error">
                    {error}
                </InlineNotice>
            ) : null}
        </section>
    );
}
