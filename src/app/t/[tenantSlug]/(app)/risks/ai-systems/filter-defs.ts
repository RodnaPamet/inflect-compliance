/**
 * Filter configuration for the EU AI Act AI-System Registry. A static
 * risk-tier enum filter, applied client-side to the SSR rows — mirrors the
 * sibling Business Continuity / Vulnerabilities pages.
 *
 * i18n: labels resolve at render via `buildAiSystemFilterDefs(t, tGroup)`
 * (`t = useTranslations('risks')`, `tGroup =
 * useTranslations('common.filterGroups')`). Enum VALUES + KEYS unchanged.
 */
import { createTypedFilterDefs, optionsFromEnum } from '@/components/ui/filter/filter-definitions';
// FilterDefInput.icon is typed `LucideIcon`; a new filter-defs file has no
// Nucleo option until the filter platform migrates. Allowlisted in
// tests/guards/no-lucide.test.ts (same precedent as every other *filter-defs.ts).
import { ShieldAlert } from 'lucide-react';

/** Surface-namespace resolver (`useTranslations('risks')`). */
type T = (key: string, values?: Record<string, unknown>) => string;
/** Shared filter-group resolver (`useTranslations('common.filterGroups')`). */
type TGroup = (key: string) => string;

// UNCLASSIFIED first, as the enum orders it: a provisional entry nobody has
// classified (#3691) is filtered for on its own and never folded into MINIMAL.
const AI_RISK_TIER_KEYS = ['UNCLASSIFIED', 'PROHIBITED', 'HIGH', 'LIMITED', 'MINIMAL'] as const;

function aiRiskTierLabels(t: T): Record<string, string> {
    return Object.fromEntries(AI_RISK_TIER_KEYS.map((k) => [k, t(`aiSystems.filterEnums.riskTier.${k}`)]));
}

function aiSystemFilterDefsInput(t: T, tGroup: TGroup) {
    return {
        riskTier: {
            label: t('aiSystems.filters.riskTier'),
            description: t('aiSystems.filters.riskTierDesc'),
            group: tGroup('attributes'),
            icon: ShieldAlert,
            options: optionsFromEnum(aiRiskTierLabels(t)),
            multiple: true,
            resetBehavior: 'clearable',
        },
    } as const;
}

export const AI_SYSTEM_FILTER_KEYS = ['riskTier'] as const;

/** Build the localized AI-system filter defs. Memoize per render. */
export function buildAiSystemFilterDefs(t: T, tGroup: TGroup) {
    return createTypedFilterDefs()(aiSystemFilterDefsInput(t, tGroup));
}

export function buildAiSystemFilters(t: T, tGroup: TGroup) {
    return buildAiSystemFilterDefs(t, tGroup).filters;
}
