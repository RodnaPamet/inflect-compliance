/**
 * Epic 53 — Tests rollup page filter configuration.
 *
 * Client-side filters (the page fetches all plans once and filters in
 * memory): Status, Last Result, Frequency, and a single-option "Due"
 * (overdue) toggle. Keys are read off the filter `state` in
 * `tests/page.tsx` to filter the in-memory plan list.
 *
 * i18n: labels resolve at render via `buildTestFilterDefs(t, tGroup)`
 * (`t = useTranslations('controlTests')`, `tGroup =
 * useTranslations('common.filterGroups')`). Enum VALUES + KEYS unchanged.
 */

import type { FilterDefInput } from '@/components/ui/filter/filter-definitions';
import {
    createTypedFilterDefs,
    optionsFromEnum,
} from '@/components/ui/filter/filter-definitions';
import { CircleDot, CheckCircle2, Repeat, Clock } from 'lucide-react';

/** Surface-namespace resolver (`useTranslations('controlTests')`). */
type T = (key: string, values?: Record<string, unknown>) => string;
/** Shared filter-group resolver (`useTranslations('common.filterGroups')`). */
type TGroup = (key: string) => string;

// TestPlanStatus (compliance schema): ACTIVE / PAUSED / ARCHIVED.
const TEST_STATUS_KEYS = ['ACTIVE', 'PAUSED', 'ARCHIVED'] as const;
// Last run result. `IN_PROGRESS` = a run exists but has no verdict yet
// (PLANNED/RUNNING); `NONE` = never run. Both are synthetic buckets (R4-P3 #5).
const TEST_RESULT_KEYS = ['PASS', 'FAIL', 'INCONCLUSIVE', 'IN_PROGRESS', 'NONE'] as const;
const TEST_FREQUENCY_KEYS = ['AD_HOC', 'DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'ANNUALLY'] as const;
// Single computed toggle. "Overdue" = an ACTIVE plan whose EARLIEST due clock
// is in the past — min(nextDueAt, nextRunAt) <= now (the reconciled signal, not
// nextDueAt alone). PAUSED/ARCHIVED plans are excluded by design.
const TEST_DUE_KEYS = ['overdue'] as const;

const fromKeys = (keys: readonly string[], t: T, group: string): Record<string, string> =>
    Object.fromEntries(keys.map((k) => [k, t(`filterEnums.${group}.${k}`)]));

function testFilterDefsInput(t: T, tGroup: TGroup) {
    return {
        status: {
            label: t('filters.status'),
            description: t('filters.statusDesc'),
            group: tGroup('attributes'),
            icon: CircleDot,
            options: optionsFromEnum(fromKeys(TEST_STATUS_KEYS, t, 'status')),
            multiple: true,
            resetBehavior: 'clearable',
        },
        result: {
            label: t('filters.result'),
            description: t('filters.resultDesc'),
            group: tGroup('attributes'),
            icon: CheckCircle2,
            options: optionsFromEnum(fromKeys(TEST_RESULT_KEYS, t, 'result')),
            multiple: true,
            resetBehavior: 'clearable',
        },
        frequency: {
            label: t('filters.frequency'),
            description: t('filters.frequencyDesc'),
            group: tGroup('attributes'),
            icon: Repeat,
            options: optionsFromEnum(fromKeys(TEST_FREQUENCY_KEYS, t, 'frequency')),
            multiple: true,
            resetBehavior: 'clearable',
        },
        due: {
            label: t('filters.due'),
            description: t('filters.dueDesc'),
            group: tGroup('attributes'),
            icon: Clock,
            options: optionsFromEnum(fromKeys(TEST_DUE_KEYS, t, 'due')),
            multiple: false,
            resetBehavior: 'clearable',
        },
    } satisfies Record<string, FilterDefInput>;
}

/** Build the localized test filter defs. Memoize per render. */
export function buildTestFilterDefs(t: T, tGroup: TGroup) {
    return createTypedFilterDefs()(testFilterDefsInput(t, tGroup));
}

// Filter KEYS are label-independent — derive once with identity resolvers.
const IDENTITY: T = (k) => k;
const IDENTITY_GROUP: TGroup = (k) => k;
export const TEST_FILTER_KEYS = buildTestFilterDefs(IDENTITY, IDENTITY_GROUP).filterKeys;

export function buildTestFilters(t: T, tGroup: TGroup) {
    return buildTestFilterDefs(t, tGroup).filters;
}
