/**
 * Filter configuration for the data subject request register (#4818): the
 * request's status and the right it asks for, applied client-side to the SSR
 * rows. Takes its labels ready-made, so every message key is spelled in the
 * client where the i18n guard can bind it.
 */
import { createTypedFilterDefs, optionsFromEnum } from '@/components/ui/filter/filter-definitions';
import { CircleHalfDottedClock, UserFocus } from '@inflect/ui/components/ui/icons/nucleo';

export const DSAR_STATUS_KEYS = ['RECEIVED', 'VERIFIED', 'IN_PROGRESS', 'COMPLETED', 'REJECTED', 'CANCELED'] as const;
export const DSAR_TYPE_KEYS = ['EXPORT', 'ERASURE'] as const;

export interface DsarFilterLabels {
    group: string;
    status: string;
    statusDesc: string;
    statusOptions: Record<(typeof DSAR_STATUS_KEYS)[number], string>;
    type: string;
    typeDesc: string;
    typeOptions: Record<(typeof DSAR_TYPE_KEYS)[number], string>;
}

function dsarFilterDefsInput(l: DsarFilterLabels) {
    return {
        status: {
            label: l.status,
            description: l.statusDesc,
            group: l.group,
            icon: CircleHalfDottedClock,
            options: optionsFromEnum(l.statusOptions),
            multiple: true,
            resetBehavior: 'clearable',
        },
        type: {
            label: l.type,
            description: l.typeDesc,
            group: l.group,
            icon: UserFocus,
            options: optionsFromEnum(l.typeOptions),
            multiple: true,
            resetBehavior: 'clearable',
        },
    } as const;
}

export const DSAR_FILTER_KEYS = ['status', 'type'] as const;

export function buildDsarFilters(labels: DsarFilterLabels) {
    return createTypedFilterDefs()(dsarFilterDefsInput(labels)).filters;
}
