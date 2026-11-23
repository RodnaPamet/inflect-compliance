/**
 * Display-time translation of the DEFAULT risk-matrix vocabulary.
 *
 * A tenant that never customised its matrix is served
 * `DEFAULT_RISK_MATRIX_CONFIG`, whose names are English ("Low", "Rare",
 * "Likelihood"). Those names are the product's words, not the tenant's, so a
 * Bulgarian reader sees them in Bulgarian. A name the tenant CHOSE is the
 * tenant's data and is shown exactly as stored — in any language.
 *
 * "Chose" is decided per label, by value and position: a likelihood label is
 * the product's only while it still equals the default at its level, a band
 * name only while it still equals one of the four default band names, an axis
 * label only while it still equals the default axis label. Rename one level
 * and that level alone keeps the tenant's word.
 *
 * This never writes. It maps a config on its way to the screen; the stored
 * row, the admin editor and the API are untouched.
 */

import {
    DEFAULT_BANDS,
    DEFAULT_IMPACT_LABELS,
    DEFAULT_LIKELIHOOD_LABELS,
    DEFAULT_RISK_MATRIX_CONFIG,
} from './defaults';
import type { RiskMatrixConfigShape } from './types';

/** A translator rooted at the `riskMatrixDefaults` namespace. */
export type RiskMatrixDefaultsTranslator = (key: string) => string;

const DEFAULT_BAND_NAMES: ReadonlySet<string> = new Set(DEFAULT_BANDS.map((b) => b.name));

function levelLabels(
    stored: readonly string[],
    defaults: readonly string[],
    axis: 'likelihood' | 'impact',
    t: RiskMatrixDefaultsTranslator,
): string[] {
    return stored.map((label, i) => (label === defaults[i] ? t(`${axis}.${i + 1}`) : label));
}

export function localizeRiskMatrixConfig(
    config: RiskMatrixConfigShape,
    t: RiskMatrixDefaultsTranslator,
): RiskMatrixConfigShape {
    return {
        ...config,
        axisLikelihoodLabel:
            config.axisLikelihoodLabel === DEFAULT_RISK_MATRIX_CONFIG.axisLikelihoodLabel
                ? t('axis.likelihood')
                : config.axisLikelihoodLabel,
        axisImpactLabel:
            config.axisImpactLabel === DEFAULT_RISK_MATRIX_CONFIG.axisImpactLabel
                ? t('axis.impact')
                : config.axisImpactLabel,
        levelLabels: {
            likelihood: levelLabels(config.levelLabels.likelihood, DEFAULT_LIKELIHOOD_LABELS, 'likelihood', t),
            impact: levelLabels(config.levelLabels.impact, DEFAULT_IMPACT_LABELS, 'impact', t),
        },
        bands: config.bands.map((band) =>
            DEFAULT_BAND_NAMES.has(band.name) ? { ...band, name: t(`band.${band.name}`) } : band,
        ),
    };
}
