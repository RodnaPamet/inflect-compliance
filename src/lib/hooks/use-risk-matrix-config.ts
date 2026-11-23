'use client';

/**
 * Shared client hook for the tenant's effective `RiskMatrixConfig`.
 *
 * `RiskAssessmentPanel` fetched `/risk-matrix-config` inline; the
 * create/edit scoring box, the import scale-clamp, and the AI-draft
 * badge all need the same config so the whole product scores in the
 * tenant's own matrix. This hook centralises that read (SWR-cached, so
 * the several consumers share one request) and always resolves to a
 * fully-populated shape — it falls back to `DEFAULT_RISK_MATRIX_CONFIG`
 * while loading or on error, so callers never branch on `undefined`.
 *
 * The config it returns is for DISPLAY: the default vocabulary reads in the
 * viewer's language (`localizeRiskMatrixConfig`), and a name the tenant chose
 * reads as stored. The admin editor reads the stored config server-side and
 * does not go through here.
 */

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';

import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { DEFAULT_RISK_MATRIX_CONFIG } from '@/lib/risk-matrix/defaults';
import { localizeRiskMatrixConfig } from '@/lib/risk-matrix/localize';
import type { RiskMatrixConfigShape } from '@/lib/risk-matrix/types';

export interface UseRiskMatrixConfigResult {
    config: RiskMatrixConfigShape;
    /** True until the tenant's real config has resolved (default is served meanwhile). */
    isLoading: boolean;
}

/** A stored config, with the default vocabulary in the viewer's language. */
export function useLocalizedRiskMatrixConfig(config: RiskMatrixConfigShape): RiskMatrixConfigShape {
    const t = useTranslations('riskMatrixDefaults');
    return useMemo(() => localizeRiskMatrixConfig(config, (key) => t(key)), [config, t]);
}

/**
 * @param enabled gate the fetch (e.g. only while a modal is open). When
 *   false the hook still returns the default config so the UI renders.
 */
export function useRiskMatrixConfig(enabled: boolean = true): UseRiskMatrixConfigResult {
    const { data, isLoading } = useTenantSWR<RiskMatrixConfigShape>(
        enabled ? '/risk-matrix-config' : null,
    );
    // Guard the shape: only a well-formed config object wins; anything
    // else (loading, error, an empty test stub) falls back to the default
    // so callers never read `undefined` off `config.likelihoodLevels`.
    const resolved =
        data && typeof data === 'object' && typeof (data as RiskMatrixConfigShape).likelihoodLevels === 'number'
            ? (data as RiskMatrixConfigShape)
            : DEFAULT_RISK_MATRIX_CONFIG;
    const config = useLocalizedRiskMatrixConfig(resolved);
    return {
        config,
        isLoading: enabled && isLoading && resolved === DEFAULT_RISK_MATRIX_CONFIG,
    };
}
