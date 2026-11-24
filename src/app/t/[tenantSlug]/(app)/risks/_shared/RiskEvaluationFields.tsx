'use client';

/**
 * Shared "Risk Evaluation" scoring box — likelihood + impact sliders and
 * a tone-coloured score badge. Used by both NewRiskModal (create) and
 * EditRiskModal (detail) so the evaluation UI is identical on both
 * surfaces. `idPrefix` keeps the existing element ids stable
 * (`risk-*` for create, `risk-edit-*` for edit).
 *
 * Config-aware (PR-J): the slider ranges, the severity bands, and the
 * per-level labels all come from the tenant's `RiskMatrixConfig` — the
 * same source `RiskAssessmentPanel` reads. A tenant on a 6×6 (or
 * clinical / supply-chain) matrix can enter their full range and sees
 * their OWN band names here, exactly as they do on the detail page. The
 * config is fetched via `useRiskMatrixConfig` unless a caller passes one
 * in (tests / a parent that already holds it).
 */
import { useTranslations } from 'next-intl';
import { InfoTooltip } from '@/components/ui/tooltip';
import { Slider } from '@/components/ui/slider';
import { useRiskMatrixConfig } from '@/lib/hooks/use-risk-matrix-config';
import { resolveBandTone, type RiskSeverityTone } from '@/lib/risk-matrix/scoring';
import type { RiskMatrixConfigShape } from '@/lib/risk-matrix/types';

/** One mark per level, so a 5x5 or a 6x6 matrix shows its own steps. */
function levelMarks(levels: number): number[] {
    return Array.from({ length: levels }, (_, i) => i + 1);
}

const TONE_CLASSES: Record<RiskSeverityTone, string> = {
    default: 'border-border-subtle bg-bg-subtle text-content-default',
    success: 'border-border-success bg-bg-success text-content-success',
    attention: 'border-border-warning bg-bg-warning text-content-warning',
    critical: 'border-border-error bg-bg-error text-content-error',
};

export interface RiskEvaluationFieldsProps {
    likelihood: number;
    impact: number;
    onLikelihood: (v: number) => void;
    onImpact: (v: number) => void;
    /** Element-id prefix — 'risk' (create) or 'risk-edit' (edit). */
    idPrefix?: string;
    /** Pre-resolved config — skips the fetch (tests / parent already holds it). */
    config?: RiskMatrixConfigShape;
}

export function RiskEvaluationFields({
    likelihood,
    impact,
    onLikelihood,
    onImpact,
    idPrefix = 'risk',
    config: configProp,
}: RiskEvaluationFieldsProps) {
    const t = useTranslations('risks');
    // Fetch only when a config wasn't handed in.
    const { config: fetched } = useRiskMatrixConfig(!configProp);
    const config = configProp ?? fetched;

    const likelihoodLabel = config.levelLabels?.likelihood?.[likelihood - 1];
    const impactLabel = config.levelLabels?.impact?.[impact - 1];

    const score = likelihood * impact;
    const { band, tone } = resolveBandTone(score, config.bands);

    return (
        <div className="space-y-default rounded-lg border border-border-subtle bg-bg-subtle p-4">
            <p className="text-sm font-medium text-content-emphasis">
                {t('eval.title')}
            </p>
            <div className="grid grid-cols-1 gap-default sm:grid-cols-[1fr_1fr_auto] sm:items-end">
                <div>
                    <div className="mb-1 flex items-center gap-1.5">
                        <span
                            className="text-sm text-content-default"
                            id={`${idPrefix}-likelihood-label`}
                        >
                            {config.axisLikelihoodLabel || t('eval.likelihood')} ·{' '}
                            <span className="font-semibold text-content-emphasis">
                                {likelihood}
                            </span>
                            {likelihoodLabel && (
                                <span className="text-content-muted"> — {likelihoodLabel}</span>
                            )}
                        </span>
                        <InfoTooltip
                            aria-label={t('eval.aboutLikelihood')}
                            iconClassName="h-3.5 w-3.5"
                            content={t('eval.likelihoodHelp')}
                        />
                    </div>
                    <Slider
                        id={`${idPrefix}-likelihood`}
                        ariaLabelledBy={`${idPrefix}-likelihood-label`}
                        min={1}
                        max={config.likelihoodLevels}
                        marks={levelMarks(config.likelihoodLevels)}
                        value={likelihood}
                        onChange={onLikelihood}
                    />
                </div>
                <div>
                    <div className="mb-1 flex items-center gap-1.5">
                        <span
                            className="text-sm text-content-default"
                            id={`${idPrefix}-impact-label`}
                        >
                            {config.axisImpactLabel || t('eval.impact')} ·{' '}
                            <span className="font-semibold text-content-emphasis">
                                {impact}
                            </span>
                            {impactLabel && (
                                <span className="text-content-muted"> — {impactLabel}</span>
                            )}
                        </span>
                        <InfoTooltip
                            aria-label={t('eval.aboutImpact')}
                            iconClassName="h-3.5 w-3.5"
                            content={t('eval.impactHelp')}
                        />
                    </div>
                    <Slider
                        id={`${idPrefix}-impact`}
                        ariaLabelledBy={`${idPrefix}-impact-label`}
                        min={1}
                        max={config.impactLevels}
                        marks={levelMarks(config.impactLevels)}
                        value={impact}
                        onChange={onImpact}
                    />
                </div>
                <div
                    className={`shrink-0 rounded-md border px-3 py-2 text-center ${TONE_CLASSES[tone]}`}
                    data-testid={`${idPrefix}-score-preview`}
                    data-band={band.name}
                >
                    <p className="text-xs uppercase tracking-wider opacity-75">
                        {t('score')}
                    </p>
                    <p className="text-xl font-bold">{score}</p>
                    <p className="text-xs font-medium">{band.name}</p>
                </div>
            </div>
        </div>
    );
}
