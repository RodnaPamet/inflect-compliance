/**
 * PR-DD — ONE source of truth for test-plan / test-run enum labels + badge tones.
 *
 * The register (`/tests`) and the plan detail view (`TestPlanDetailView`) both
 * render the same four enums — plan status, run status, run result, and method.
 * The register localized them (PR-R) while the detail view rendered the RAW enum
 * (`ACTIVE`, `PLANNED`, `PASS`, `MANUAL`), and each file kept its own copy of the
 * badge-tone maps. Two copies of one vocabulary is how they drift.
 *
 * Every builder takes a `t` bound to the **`controlTests`** namespace — that's
 * where the localized values already live, so adopting this module reuses the
 * existing keys rather than minting a parallel set. (`TestPlanDetailView` is
 * otherwise bound to `controls`; it takes a second `useTranslations` for these.)
 *
 * Unknown members fall back to the raw value at every call site, so a new enum
 * member renders legibly instead of blank while its label is being added.
 */
import type { StatusBadgeVariant } from '@/components/ui/status-badge';

/** `t` bound to the `controlTests` next-intl namespace. */
type TestsT = (key: string) => string;

// ─── Labels ────────────────────────────────────────────────────────

/** TestPlanStatus → label. */
export function buildPlanStatusLabels(t: TestsT): Record<string, string> {
    return {
        ACTIVE: t('planStatus.ACTIVE'),
        PAUSED: t('planStatus.PAUSED'),
        ARCHIVED: t('planStatus.ARCHIVED'),
    };
}

/** TestRunStatus → label. */
export function buildRunStatusLabels(t: TestsT): Record<string, string> {
    return {
        PLANNED: t('runStatus.PLANNED'),
        RUNNING: t('runStatus.RUNNING'),
        COMPLETED: t('runStatus.COMPLETED'),
    };
}

/** TestResult → label. */
export function buildResultLabels(t: TestsT): Record<string, string> {
    return {
        PASS: t('result.PASS'),
        FAIL: t('result.FAIL'),
        INCONCLUSIVE: t('result.INCONCLUSIVE'),
    };
}

/**
 * Method → label. `method` is a DERIVED projection of `automationType`
 * (see `deriveMethodFromAutomationType`) — this only renders it.
 */
export function buildMethodLabels(t: TestsT): Record<string, string> {
    return {
        MANUAL: t('method.MANUAL'),
        AUTOMATED: t('method.AUTOMATED'),
    };
}

// ─── Badge tones ───────────────────────────────────────────────────

export const PLAN_STATUS_BADGE: Record<string, StatusBadgeVariant> = {
    ACTIVE: 'success',
    PAUSED: 'warning',
    ARCHIVED: 'neutral',
};

export const RUN_STATUS_BADGE: Record<string, StatusBadgeVariant> = {
    PLANNED: 'neutral',
    RUNNING: 'info',
    COMPLETED: 'success',
};

export const RESULT_BADGE: Record<string, StatusBadgeVariant> = {
    PASS: 'success',
    FAIL: 'error',
    INCONCLUSIVE: 'warning',
};
