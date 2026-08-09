'use client';

/**
 * RQ2-4 — guided qualitative assessment: inherent → controls →
 * residual, in the tenant's own matrix language.
 *
 * The pre-RQ2 flow buried likelihood/impact in an edit modal and
 * left residual to a divisor formula. This panel makes assessment a
 * first-class surface:
 *
 *   Step 1 — Inherent. L/I steppers labelled with the tenant's
 *     `RiskMatrixConfig.levelLabels`; the band chip updates live so
 *     the assessor sees the consequence of each click before saving.
 *   Step 2 — Controls. The RQ2-2 contribution breakdown: which
 *     linked controls participate (MEASURED beats DECLARED), which
 *     are excluded and why — the data-quality nudge stays visible.
 *   Step 3 — Residual. Asserted vs control-suggested side by side.
 *     Accept recomputes SERVER-side (the POST body carries only a
 *     justification); manual override sends decomposed dims + a
 *     justification and the server derives the rollup (RQ2-1).
 *
 * The "Quantify this risk" bridge hands over to the FAIR tab — one
 * narrative, two depths; nothing here duplicates the quant inputs.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { useTranslations } from 'next-intl';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';
import { useToast } from '@/components/ui/hooks';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { DatePicker } from '@/components/ui/date-picker';
import { NumberStepper } from '@/components/ui/number-stepper';
import { Eyebrow, Heading } from '@/components/ui/typography';
import { SkeletonCard } from '@/components/ui/skeleton';
import { cardVariants } from '@/components/ui/card';
import { cn } from '@/lib/cn';
import { calculateRiskScore } from '@/lib/risk-scoring';
import { RiskBandChip } from '../_shared/RiskBandChip';
import { resolveBandForScore } from '@/lib/risk-matrix/scoring';
import {
    buildRiskTreatmentOptions,
    riskStatusLabel,
    type TreatmentDecisionValue,
} from '../_shared/risk-options';
import type { RiskMatrixConfigShape } from '@/lib/risk-matrix/types';
import type { ResidualSuggestionPayload } from '@/app-layer/usecases/risk-residual-suggestion';

// Epic G-7 — the structured treatment plan now lives INSIDE the guided
// assessment (Step 4), not scattered on the Overview tab. Dynamic-imported
// so its modal machinery only loads when the assessment tab is opened.
const RiskTreatmentPlanCard = dynamic(
    () =>
        import('@/components/RiskTreatmentPlanCard').then(
            (m) => m.RiskTreatmentPlanCard,
        ),
    { loading: () => <SkeletonCard lines={2} />, ssr: false },
);

export interface AssessmentRisk {
    likelihood: number;
    impact: number;
    inherentScore: number;
    residualLikelihood: number | null;
    residualImpact: number | null;
    residualScore: number | null;
    /**
     * RQ3-OB-D — drives the adaptive bridge copy. When the risk
     * already carries a FAIR-derived ALE, "Quantify this risk →"
     * reads wrong (the work is done); the bridge becomes "Review the
     * FAIR analysis →". Null/undefined → not yet quantified.
     */
    fairAle?: number | null;
    // P1 — Step 4 (treat & monitor) reads the workflow state so the
    // guided flow continues directly from residual.
    treatment: string | null;
    nextReviewAt: string | null;
    status: string;
}

interface OwnerChoice {
    userId: string;
    label: string;
}

/**
 * The five independently-savable steps of the assessment panel. Save failures
 * are keyed by step so one failing step never blanks the others.
 */
type AssessmentStep = 'inherent' | 'accept' | 'residual' | 'treatment' | 'review';

/**
 * Inline, dismissible error for a single step. Rendered next to the step's own
 * action — the panel stays mounted, so the user keeps their place and their
 * unsaved edits in the other steps.
 */
function StepError({
    message,
    onDismiss,
    onRetry,
    retryLabel,
    dismissLabel,
    testId,
}: {
    message: string;
    onDismiss: () => void;
    onRetry?: () => void;
    retryLabel: string;
    dismissLabel: string;
    testId: string;
}) {
    return (
        <div
            role="alert"
            data-testid={testId}
            className="flex flex-wrap items-center gap-tight rounded-md border border-border-error bg-bg-error/10 px-default py-tight text-sm text-content-error"
        >
            <span className="min-w-0 flex-1 break-words">{message}</span>
            {onRetry ? (
                <Button size="xs" variant="secondary" onClick={onRetry}>
                    {retryLabel}
                </Button>
            ) : null}
            <Button size="xs" variant="ghost" onClick={onDismiss}>
                {dismissLabel}
            </Button>
        </div>
    );
}

function BandChip({ score, config }: { score: number; config: RiskMatrixConfigShape }) {
    // Thin wrapper: this surface resolves the band from the tenant config
    // and spells the name out beside the number. The chip markup itself is
    // shared — see _shared/RiskBandChip for the axe-AA colour-role split.
    return (
        <RiskBandChip
            value={score}
            band={resolveBandForScore(score, config.bands)}
            showBandName
            size="md"
        />
    );
}

function levelLabel(config: RiskMatrixConfigShape, axis: 'likelihood' | 'impact', level: number): string {
    const label = config.levelLabels?.[axis]?.[level - 1];
    return label ? `${level} — ${label}` : String(level);
}

export function RiskAssessmentPanel({
    tenantSlug,
    riskId,
    risk,
    matrixConfig,
    canWrite,
    canAdmin,
    ownerChoices,
    onRiskUpdated,
    onQuantify,
    onLinkControls,
    onStatusChange,
}: {
    tenantSlug: string;
    riskId: string;
    risk: AssessmentRisk;
    /** The tenant's risk-matrix config, resolved once by the parent —
     *  passed down so the panel does not independently re-fetch it. */
    matrixConfig: RiskMatrixConfigShape;
    canWrite: boolean;
    canAdmin: boolean;
    /** Tenant roster for the treatment-plan owner picker (Step 4). */
    ownerChoices: readonly OwnerChoice[];
    /** Parent refetches the risk after any save here. */
    onRiskUpdated: () => void;
    /** Bridge to the Quantification (FAIR) tab. */
    onQuantify: () => void;
    /** Bridge to the Traceability tab (where controls are linked). */
    onLinkControls: () => void;
    /** Advance the workflow status (PATCH /status), shared with the header. */
    onStatusChange: (status: string) => void | Promise<void>;
}) {
    const t = useTranslations('risks');
    const apiUrl = useTenantApiUrl();
    const toast = useToast();

    // Matrix config is supplied by the parent (already fetched there) —
    // no independent re-fetch. Local alias keeps the existing call sites.
    const config = matrixConfig;
    const [suggestion, setSuggestion] = useState<ResidualSuggestionPayload | null>(null);
    // The panel used to keep ONE `error` state shared by the initial load AND
    // all five save handlers, and returned early on it — so a failed Save on
    // Step 4 unmounted Steps 1–3 and the user lost their place. Load failures
    // (nothing to render without the suggestion) still replace the panel; SAVE
    // failures are scoped to the step that raised them and render inline.
    const [loadError, setLoadError] = useState<string | null>(null);
    const [stepErrors, setStepErrors] = useState<Partial<Record<AssessmentStep, string>>>({});
    const setStepError = useCallback((step: AssessmentStep, message: string) => {
        setStepErrors((prev) => ({ ...prev, [step]: message }));
    }, []);
    const clearStepError = useCallback((step: AssessmentStep) => {
        setStepErrors((prev) => {
            if (!(step in prev)) return prev;
            const next = { ...prev };
            delete next[step];
            return next;
        });
    }, []);
    // RQ3-7 — currently-breached KRIs for this risk. Drives the
    // re-assess nudge: a sensor fired, the conclusion should catch
    // up. Failure-soft — a failed load just hides the nudge.
    const [kriBreaches, setKriBreaches] = useState<Array<{ kriId: string; name: string; value: number }>>([]);

    // Step 1 draft state.
    const [likelihood, setLikelihood] = useState(risk.likelihood);
    const [impact, setImpact] = useState(risk.impact);
    const [savingInherent, setSavingInherent] = useState(false);

    // Step 3 draft state.
    const [residualLikelihood, setResidualLikelihood] = useState(risk.residualLikelihood ?? risk.likelihood);
    const [residualImpact, setResidualImpact] = useState(risk.residualImpact ?? risk.impact);
    const [justification, setJustification] = useState('');
    const [overriding, setOverriding] = useState(false);
    const [savingResidual, setSavingResidual] = useState(false);
    const [accepting, setAccepting] = useState(false);
    // polish #15 — when inherent saves while a manual residual draft
    // is open, the draft now applies to a DIFFERENT inherent
    // baseline. The user gets an in-line warning until they save or
    // cancel the draft; silently rebasing would corrupt the
    // conclusion. State lives above the early-returns to keep the
    // hook order stable across loading/loaded transitions.
    const [residualBaselineDirty, setResidualBaselineDirty] = useState(false);

    // Step 4 — treat & monitor draft state.
    const treatmentOptions: ComboboxOption[] = useMemo(
        () => buildRiskTreatmentOptions((k) => t(k as Parameters<typeof t>[0])),
        [t],
    );
    const [savingTreatment, setSavingTreatment] = useState(false);
    const [reviewDate, setReviewDate] = useState<Date | null>(
        risk.nextReviewAt ? new Date(risk.nextReviewAt) : null,
    );
    const [savingReview, setSavingReview] = useState(false);

    const loadSuggestion = useCallback(async () => {
        const res = await fetch(apiUrl(`/risks/${riskId}/residual-suggestion`));
        if (!res.ok) throw new Error(t('assessment.failedLoadStatus', { status: res.status }));
        setSuggestion(await res.json());
    }, [apiUrl, riskId, t]);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                await loadSuggestion();
            } catch (err) {
                if (!cancelled) setLoadError(err instanceof Error ? err.message : t('assessment.failedLoad'));
            }
        })();
        return () => { cancelled = true; };
    }, [loadSuggestion, t]);

    // RQ3-7 — load the KRI breach signal independently (failure-soft:
    // never blocks the panel, just hides the nudge on error).
    useEffect(() => {
        let cancelled = false;
        fetch(apiUrl(`/risks/${riskId}/kri-breaches`))
            .then((r) => (r.ok ? r.json() : null))
            .then((d) => { if (!cancelled) setKriBreaches(d?.breaches ?? []); })
            .catch(() => { if (!cancelled) setKriBreaches([]); });
        return () => { cancelled = true; };
    }, [apiUrl, riskId]);

    if (loadError) {
        return (
            <div className={cn(cardVariants({ density: 'compact' }), 'space-y-tight border-border-error text-sm')}>
                <p className="text-content-error">{loadError}</p>
                <Button
                    size="sm"
                    variant="secondary"
                    data-testid="assessment-load-retry"
                    onClick={() => {
                        setLoadError(null);
                        void loadSuggestion().catch((err) =>
                            setLoadError(err instanceof Error ? err.message : t('assessment.failedLoad')),
                        );
                    }}
                >
                    {t('assessment.retry')}
                </Button>
            </div>
        );
    }
    if (!suggestion) {
        return <SkeletonCard lines={4} />;
    }

    const maxScale = Math.max(config.likelihoodLevels, config.impactLevels);
    const draftInherentScore = calculateRiskScore(likelihood, impact, maxScale);
    const inherentDirty = likelihood !== risk.likelihood || impact !== risk.impact;
    const draftResidualScore = calculateRiskScore(residualLikelihood, residualImpact, maxScale);

    const saveInherent = async () => {
        setSavingInherent(true);
        clearStepError('inherent');
        try {
            const res = await fetch(apiUrl(`/risks/${riskId}`), {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ likelihood, impact }),
            });
            if (!res.ok) throw new Error(t('assessment.failedSaveStatus', { status: res.status }));
            if (overriding) setResidualBaselineDirty(true);
            onRiskUpdated();
            await loadSuggestion();
        } catch (err) {
            setStepError('inherent', err instanceof Error ? err.message : t('assessment.failedSave'));
        } finally {
            setSavingInherent(false);
        }
    };

    const acceptSuggestion = async () => {
        setAccepting(true);
        clearStepError('accept');
        try {
            // Body carries ONLY the justification — values are
            // recomputed server-side (RQ2-2 contract).
            const res = await fetch(apiUrl(`/risks/${riskId}/residual-suggestion`), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ justification: justification || null }),
            });
            if (!res.ok) throw new Error(t('assessment.failedAcceptStatus', { status: res.status }));
            // RQ3-OB-D — "accepting deserves an answer". The success
            // toast carries the SERVER-derived one-liner (composed in
            // acceptResidualSuggestion from the recomputed values), so
            // the message reflects exactly what was persisted — never
            // client draft state, which could disagree.
            const body = await res.json().catch(() => null);
            const summary: string | undefined = body?.accepted?.summary;
            toast.success(summary ?? t('assessment.residualAccepted'));
            onRiskUpdated();
            await loadSuggestion();
        } catch (err) {
            setStepError('accept', err instanceof Error ? err.message : t('assessment.failedAccept'));
        } finally {
            setAccepting(false);
        }
    };

    const saveResidualOverride = async () => {
        setSavingResidual(true);
        clearStepError('residual');
        try {
            const res = await fetch(apiUrl(`/risks/${riskId}`), {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    residualLikelihood,
                    residualImpact,
                    scoreJustification: justification || null,
                }),
            });
            if (!res.ok) throw new Error(t('assessment.failedResidualStatus', { status: res.status }));
            setOverriding(false);
            setResidualBaselineDirty(false);
            onRiskUpdated();
            await loadSuggestion();
        } catch (err) {
            setStepError('residual', err instanceof Error ? err.message : t('assessment.failedSave'));
        } finally {
            setSavingResidual(false);
        }
    };

    // Step 4 — persist the treatment decision (writes the enum-valid
    // TreatmentDecision value; the canonical vocabulary is a label-only
    // concern). A PUT that carries just `treatment` leaves the score alone.
    const saveTreatment = async (decision: string) => {
        setSavingTreatment(true);
        clearStepError('treatment');
        try {
            const res = await fetch(apiUrl(`/risks/${riskId}`), {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ treatment: decision || null }),
            });
            if (!res.ok) throw new Error(t('assessment.failedTreatmentStatus', { status: res.status }));
            onRiskUpdated();
        } catch (err) {
            setStepError('treatment', err instanceof Error ? err.message : t('assessment.failedSave'));
        } finally {
            setSavingTreatment(false);
        }
    };

    const saveReviewDate = async () => {
        setSavingReview(true);
        clearStepError('review');
        try {
            const res = await fetch(apiUrl(`/risks/${riskId}`), {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    nextReviewAt: reviewDate ? reviewDate.toISOString() : null,
                }),
            });
            if (!res.ok) throw new Error(t('assessment.failedReviewStatus', { status: res.status }));
            toast.success(t('assessment.saveReviewDate'));
            onRiskUpdated();
        } catch (err) {
            setStepError('review', err instanceof Error ? err.message : t('assessment.failedSave'));
        } finally {
            setSavingReview(false);
        }
    };

    // Guided status (item 4) — recommend the next workflow status from the
    // assessment + treatment state, rather than letting the header combobox
    // float free. Plan COMPLETION still finalizes status server-side
    // (MITIGATE→MITIGATED, ACCEPT→ACCEPTED, TRANSFER/AVOID→CLOSED); this
    // covers the in-flight transitions the backend can't infer.
    const recommendedStatus: { status: string; messageKey: string } | null = (() => {
        if (risk.residualScore === null) return { status: '', messageKey: 'assessment.recommendAssessFirst' };
        if (!risk.treatment) return { status: '', messageKey: 'assessment.recommendDecideFirst' };
        const decision = risk.treatment as TreatmentDecisionValue;
        if (decision === 'TOLERATE') {
            return risk.status === 'ACCEPTED' ? null : { status: 'ACCEPTED', messageKey: 'assessment.recommendAccepted' };
        }
        // TRANSFER / AVOID resolve to CLOSED when their plan completes —
        // recommending MITIGATING would contradict the decision. Nudge
        // toward CLOSED (the status their completed plan maps to); once
        // there (or already terminal) there's nothing to nudge.
        if (decision === 'TRANSFER' || decision === 'AVOID') {
            const settled = risk.status === 'CLOSED' || risk.status === 'MITIGATED';
            return settled ? null : { status: 'CLOSED', messageKey: 'assessment.recommendClosed' };
        }
        // TREAT is in-flight (MITIGATING) until its plan completes.
        const inFlight = risk.status === 'MITIGATING' || risk.status === 'MITIGATED' || risk.status === 'CLOSED';
        return inFlight ? null : { status: 'MITIGATING', messageKey: 'assessment.recommendMitigating' };
    })();

    const participating = suggestion.combined.contributions.filter((c) => c.affects !== null);
    const excluded = suggestion.combined.contributions.filter((c) => c.affects === null);

    return (
        <div className="space-y-section" id="risk-assessment-panel">
            {/* RQ3-7 — re-assess nudge. A linked KRI's latest reading
                sits in RED: the sensor moved, the conclusion should
                catch up. Closes the KRI ⇄ assessment loop — sensors
                that change no conclusion are decoration. Disappears
                automatically once the KRI recovers (latest reading no
                longer RED). */}
            {kriBreaches.length > 0 && (
                <div
                    className="rounded-md border border-border-warning bg-bg-warning/15 p-3 text-sm text-content-warning"
                    data-testid="kri-reassess-nudge"
                >
                    <p className="font-medium">
                        {kriBreaches.length === 1
                            ? t('assessment.kriBreachedOne', { name: kriBreaches[0].name })
                            : t('assessment.kriBreachedMany', { count: kriBreaches.length })}
                    </p>
                    <p className="mt-0.5 text-content-muted">
                        {t('assessment.kriNudge')}
                    </p>
                </div>
            )}

            {/* ── Step 1 — Inherent ─────────────────────────────── */}
            <div className={cn(cardVariants(), 'space-y-default')}>
                <div className="flex items-center justify-between">
                    <Heading level={3}>{t('assessment.step1')}</Heading>
                    <BandChip score={draftInherentScore} config={config} />
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-default">
                    <div>
                        <Eyebrow>{config.axisLikelihoodLabel || t('assessment.likelihood')}</Eyebrow>
                        <NumberStepper
                            id="assessment-likelihood"
                            value={likelihood}
                            onChange={setLikelihood}
                            min={1}
                            max={config.likelihoodLevels}
                            disabled={!canWrite}
                            ariaLabel={t('assessment.likelihoodLevel')}
                            formatValue={(v) => levelLabel(config, 'likelihood', v)}
                        />
                    </div>
                    <div>
                        <Eyebrow>{config.axisImpactLabel || t('assessment.impact')}</Eyebrow>
                        <NumberStepper
                            id="assessment-impact"
                            value={impact}
                            onChange={setImpact}
                            min={1}
                            max={config.impactLevels}
                            disabled={!canWrite}
                            ariaLabel={t('assessment.impactLevel')}
                            formatValue={(v) => levelLabel(config, 'impact', v)}
                        />
                    </div>
                </div>
                {stepErrors.inherent ? (
                    <StepError
                        testId="assessment-error-inherent"
                        message={stepErrors.inherent}
                        onRetry={() => { void saveInherent(); }}
                        onDismiss={() => clearStepError('inherent')}
                        retryLabel={t('assessment.retry')}
                        dismissLabel={t('assessment.dismiss')}
                    />
                ) : null}
                {canWrite && inherentDirty && (
                    <div className="flex justify-end">
                        <Button
                            variant="secondary"
                            id="save-inherent-btn"
                            onClick={saveInherent}
                            disabled={savingInherent}
                        >
                            {savingInherent ? t('saving') : t('assessment.saveAssessment')}
                        </Button>
                    </div>
                )}
            </div>

            {/* ── Step 2 — Controls ─────────────────────────────── */}
            <div className={cn(cardVariants(), 'space-y-default')} id="assessment-controls">
                <Heading level={3}>{t('assessment.step2')}</Heading>
                <p className="text-sm text-content-muted">{suggestion.summary}</p>
                {participating.length > 0 && (
                    <ul className="space-y-tight">
                        {participating.map((c) => (
                            <li key={c.controlId} className="flex items-center gap-tight text-sm">
                                <span className="text-content-default">
                                    {c.code ? `${c.code} — ` : ''}{c.name}
                                </span>
                                <span className="text-content-muted">
                                    {t('assessment.effective', {
                                        pct: c.effectiveness ?? '',
                                        source: c.source === 'MEASURED' ? t('assessment.measuredFromTests') : t('assessment.declared'),
                                    })}
                                    {' → '}{c.affects === 'LIKELIHOOD' ? t('assessment.reducesLikelihood') : t('assessment.reducesImpact')}
                                </span>
                            </li>
                        ))}
                    </ul>
                )}
                {excluded.length > 0 && (
                    <div className="text-xs text-content-muted">
                        <Eyebrow>{t('assessment.notParticipating')}</Eyebrow>
                        <ul className="space-y-tight">
                            {excluded.map((c) => (
                                <li key={c.controlId}>
                                    {c.code ? `${c.code} — ` : ''}{c.name}:{' '}
                                    {c.excludedReason === 'NO_EFFECTIVENESS'
                                        ? t('assessment.noEffectivenessSignal')
                                        : t('assessment.noMitigationType')}
                                </li>
                            ))}
                        </ul>
                    </div>
                )}
                {suggestion.combined.contributions.length === 0 && (
                    <p className="text-sm text-content-muted">
                        {t('assessment.controlsUnlinked')}{' '}
                        <button
                            type="button"
                            className="underline text-content-default"
                            onClick={onLinkControls}
                            id="assessment-link-controls"
                        >
                            {t('assessment.linkControlsInTraceability')}
                        </button>
                        {' '}{t('assessment.deriveResidualSuffix')}
                    </p>
                )}
            </div>

            {/* ── Step 3 — Residual ─────────────────────────────── */}
            <div className={cn(cardVariants(), 'space-y-default')} id="assessment-residual">
                <Heading level={3}>{t('assessment.step3')}</Heading>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-default">
                    <div className={cn(cardVariants({ density: 'compact' }), 'space-y-tight')}>
                        <Eyebrow>{t('assessment.currentAsserted')}</Eyebrow>
                        {risk.residualScore !== null ? (
                            <>
                                <BandChip score={risk.residualScore} config={config} />
                                <p className="text-xs text-content-muted">
                                    {risk.residualLikelihood !== null && risk.residualImpact !== null
                                        ? `${levelLabel(config, 'likelihood', risk.residualLikelihood)} × ${levelLabel(config, 'impact', risk.residualImpact)}`
                                        : t('assessment.legacyDimsUnknown')}
                                </p>
                            </>
                        ) : (
                            <p className="text-sm text-content-muted">{t('assessment.notAssessedYet')}</p>
                        )}
                    </div>
                    <div className={cn(cardVariants({ density: 'compact' }), 'space-y-tight')}>
                        <Eyebrow>{t('assessment.suggestedFromControls')}</Eyebrow>
                        {suggestion.suggestion ? (
                            <>
                                <BandChip score={suggestion.suggestion.residualScore} config={config} />
                                <p className="text-xs text-content-muted">
                                    {levelLabel(config, 'likelihood', suggestion.suggestion.residualLikelihood)} ×{' '}
                                    {levelLabel(config, 'impact', suggestion.suggestion.residualImpact)}
                                </p>
                                {canWrite && (
                                    <Button
                                        variant="secondary"
                                        id="accept-suggestion-btn"
                                        onClick={acceptSuggestion}
                                        disabled={accepting}
                                    >
                                        {accepting ? t('assessment.accepting') : t('assessment.acceptSuggestion')}
                                    </Button>
                                )}
                            </>
                        ) : (
                            <p className="text-sm text-content-muted">
                                {t('assessment.residualNotDerivable')}
                            </p>
                        )}
                    </div>
                </div>

                {stepErrors.accept ? (
                    <StepError
                        testId="assessment-error-accept"
                        message={stepErrors.accept}
                        onRetry={() => { void acceptSuggestion(); }}
                        onDismiss={() => clearStepError('accept')}
                        retryLabel={t('assessment.retry')}
                        dismissLabel={t('assessment.dismiss')}
                    />
                ) : null}
                {canWrite && !overriding && (
                    <Button variant="secondary" id="override-residual-btn" onClick={() => setOverriding(true)}>
                        {t('assessment.assessResidualManually')}
                    </Button>
                )}
                {canWrite && overriding && (
                    <div className="space-y-default border-t border-border-subtle pt-4">
                        {residualBaselineDirty && (
                            <div
                                // RQ3-OB-E — the conflict warning appears
                                // when inherent shifts mid-draft. role=status
                                // + aria-live=polite announces it to screen
                                // readers when it mounts, not just visually.
                                role="status"
                                aria-live="polite"
                                className="rounded-md border border-border-warning bg-bg-warning/20 p-2 text-xs text-content-warning"
                                data-testid="residual-baseline-warning"
                            >
                                {t('assessment.baselineWarning', { l: risk.likelihood, i: risk.impact })}
                            </div>
                        )}
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-default">
                            <div>
                                <Eyebrow>{t('assessment.residualPrefix')} {config.axisLikelihoodLabel || t('assessment.dimLikelihood')}</Eyebrow>
                                <NumberStepper
                                    id="residual-likelihood"
                                    value={residualLikelihood}
                                    onChange={setResidualLikelihood}
                                    min={1}
                                    max={config.likelihoodLevels}
                                    ariaLabel={t('assessment.residualLikelihoodLevel')}
                                    formatValue={(v) => levelLabel(config, 'likelihood', v)}
                                />
                            </div>
                            <div>
                                <Eyebrow>{t('assessment.residualPrefix')} {config.axisImpactLabel || t('assessment.dimImpact')}</Eyebrow>
                                <NumberStepper
                                    id="residual-impact"
                                    value={residualImpact}
                                    onChange={setResidualImpact}
                                    min={1}
                                    max={config.impactLevels}
                                    ariaLabel={t('assessment.residualImpactLevel')}
                                    formatValue={(v) => levelLabel(config, 'impact', v)}
                                />
                            </div>
                        </div>
                        <div className="flex items-center gap-tight text-sm">
                            <span className="text-content-muted">{t('assessment.resultingScore')}</span>
                            <BandChip score={draftResidualScore} config={config} />
                        </div>
                        <FormField label={t('assessment.justification')}>
                            <Input
                                id="residual-justification"
                                value={justification}
                                onChange={(e) => setJustification(e.target.value)}
                                placeholder={t('assessment.justificationPlaceholder')}
                                maxLength={2000}
                            />
                        </FormField>
                        <div className="flex gap-tight justify-end">
                            <Button
                                variant="secondary"
                                onClick={() => {
                                    setOverriding(false);
                                    setResidualBaselineDirty(false);
                                }}
                            >
                                {t('assessment.cancel')}
                            </Button>
                            <Button
                                variant="secondary"
                                id="save-residual-btn"
                                onClick={saveResidualOverride}
                                disabled={savingResidual}
                            >
                                {savingResidual ? t('saving') : t('assessment.saveResidual')}
                            </Button>
                        </div>
                        {stepErrors.residual ? (
                            <StepError
                                testId="assessment-error-residual"
                                message={stepErrors.residual}
                                onRetry={() => { void saveResidualOverride(); }}
                                onDismiss={() => clearStepError('residual')}
                                retryLabel={t('assessment.retry')}
                                dismissLabel={t('assessment.dismiss')}
                            />
                        ) : null}
                    </div>
                )}
            </div>

            {/* ── Step 4 — Treat & monitor ──────────────────────── */}
            {/* P1 — the lifecycle used to scatter across tabs (treatment
                decision in the Edit modal, plan on Overview, review date
                buried). Step 4 continues the narrated path directly from
                residual: decide → plan → cadence → status, all here. */}
            <div className={cn(cardVariants(), 'space-y-default')} id="assessment-treat-monitor">
                <Heading level={3}>{t('assessment.step4')}</Heading>
                <p className="text-sm text-content-muted">{t('assessment.treatMonitorIntro')}</p>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-default">
                    <FormField
                        label={t('assessment.treatDecisionLabel')}
                        hint={t('assessment.treatDecisionHelp')}
                    >
                        <Combobox
                            id="treatment-decision-select"
                            options={treatmentOptions}
                            selected={treatmentOptions.find((o) => o.value === risk.treatment) ?? null}
                            setSelected={(opt) => { if (opt) void saveTreatment(opt.value); }}
                            placeholder={t('assessment.treatDecisionLabel')}
                            disabled={!canWrite || savingTreatment}
                        />
                    </FormField>
                    {stepErrors.treatment ? (
                        <StepError
                            testId="assessment-error-treatment"
                            message={stepErrors.treatment}
                            onDismiss={() => clearStepError('treatment')}
                            retryLabel={t('assessment.retry')}
                            dismissLabel={t('assessment.dismiss')}
                        />
                    ) : null}
                    <FormField
                        label={t('assessment.reviewCadenceLabel')}
                        hint={t('assessment.reviewCadenceHelp')}
                    >
                        <div className="flex items-center gap-tight">
                            <DatePicker value={reviewDate} onChange={setReviewDate} disabled={!canWrite} />
                            {canWrite && (
                                <Button
                                    variant="secondary"
                                    id="save-review-date-btn"
                                    onClick={saveReviewDate}
                                    disabled={savingReview}
                                >
                                    {savingReview ? t('saving') : t('assessment.saveReviewDate')}
                                </Button>
                            )}
                        </div>
                    </FormField>
                    {stepErrors.review ? (
                        <StepError
                            testId="assessment-error-review"
                            message={stepErrors.review}
                            onRetry={() => { void saveReviewDate(); }}
                            onDismiss={() => clearStepError('review')}
                            retryLabel={t('assessment.retry')}
                            dismissLabel={t('assessment.dismiss')}
                        />
                    ) : null}
                </div>

                {/* Guided workflow status */}
                <div className="space-y-tight border-t border-border-subtle pt-default" data-testid="guided-status">
                    <div className="flex items-center justify-between gap-tight">
                        <Eyebrow>{t('assessment.guidedStatusTitle')}</Eyebrow>
                        <span className="text-xs text-content-muted">
                            {t('assessment.currentStatus', { status: riskStatusLabel(t, risk.status) })}
                        </span>
                    </div>
                    {recommendedStatus && (
                        <div className="flex items-center justify-between gap-tight text-sm">
                            <p className="text-content-muted">
                                {t(recommendedStatus.messageKey as Parameters<typeof t>[0])}
                            </p>
                            {canWrite && recommendedStatus.status && (
                                <Button
                                    variant="secondary"
                                    id="apply-status-btn"
                                    onClick={() => onStatusChange(recommendedStatus.status)}
                                >
                                    {t('assessment.applyStatus', { status: riskStatusLabel(t, recommendedStatus.status) })}
                                </Button>
                            )}
                        </div>
                    )}
                    <p className="text-xs text-content-muted">{t('assessment.statusAutoNote')}</p>
                </div>

                {/* Structured treatment plan — relocated from Overview so the
                    entire treatment lifecycle lives in one narrated path. */}
                <div className="border-t border-border-subtle pt-default">
                    <RiskTreatmentPlanCard
                        tenantSlug={tenantSlug}
                        riskId={riskId}
                        ownerChoices={ownerChoices}
                        canWrite={canWrite}
                        canAdmin={canAdmin}
                        treatment={risk.treatment}
                    />
                </div>
            </div>

            {/* ── Quantify bridge ───────────────────────────────── */}
            {/* RQ3-OB-D — the bridge knows where you've been. When a
                FAIR ALE already exists, "Quantify this risk →" is the
                wrong invitation (the work is done) — the copy adapts
                to "Review the FAIR analysis →" and the helper text
                follows. The callback is the same; only the framing
                changes. */}
            <div
                className={cn(cardVariants({ density: 'compact' }), 'flex items-center justify-between')}
                data-testid="quantify-bridge"
                data-quantified={risk.fairAle != null ? 'true' : 'false'}
            >
                <p className="text-sm text-content-muted">
                    {risk.fairAle != null
                        ? t('assessment.quantifiedHelp')
                        : t('assessment.notQuantifiedHelp')}
                </p>
                <Button variant="secondary" id="quantify-bridge-btn" onClick={onQuantify}>
                    {risk.fairAle != null ? t('assessment.reviewFair') : t('assessment.quantify')}
                </Button>
            </div>
        </div>
    );
}
