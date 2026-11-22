/**
 * Filter configuration for the Training page (PR-6). A static training-status
 * enum filter. The filter bar writes it to the URL, and the server applies it
 * in SQL over every assignment (#5764 item 6).
 */
import { createTypedFilterDefs, optionsFromEnum } from '@/components/ui/filter/filter-definitions';
// FilterDefInput.icon is typed LucideIcon; allowlisted like every *filter-defs.ts.
import { GraduationCap } from 'lucide-react';

type T = (key: string, values?: Record<string, unknown>) => string;
type TGroup = (key: string) => string;

const STATUS_KEYS = ['ASSIGNED', 'IN_PROGRESS', 'COMPLETED', 'OVERDUE'] as const;

function statusLabels(t: T): Record<string, string> {
    return Object.fromEntries(STATUS_KEYS.map((k) => [k, t(`filterEnums.status.${k}`)]));
}

function trainingFilterDefsInput(t: T, tGroup: TGroup) {
    return {
        status: {
            label: t('filters.status'),
            description: t('filters.statusDesc'),
            group: tGroup('attributes'),
            icon: GraduationCap,
            options: optionsFromEnum(statusLabels(t)),
            multiple: true,
            resetBehavior: 'clearable',
        },
    } as const;
}

export const TRAINING_FILTER_KEYS = ['status'] as const;

export function buildTrainingFilterDefs(t: T, tGroup: TGroup) {
    return createTypedFilterDefs()(trainingFilterDefsInput(t, tGroup));
}

export function buildTrainingFilters(t: T, tGroup: TGroup) {
    return buildTrainingFilterDefs(t, tGroup).filters;
}
