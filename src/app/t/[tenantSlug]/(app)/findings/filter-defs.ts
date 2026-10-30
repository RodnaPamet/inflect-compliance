/**
 * Filter configuration for the Findings register (Epic 53, #4461).
 *
 * One facet: status. It is applied SERVER-side (`GET /findings?status=…`,
 * validated by `parseEnumListFilter`), not over the loaded rows, so that
 * narrowing the register also reaches findings past the 5,000-row cap the
 * truncation banner reports — which is what that banner tells the reader to
 * do.
 *
 * i18n: labels resolve at render (`t = useTranslations('findings')`,
 * `tGroup = useTranslations('common.filterGroups')`); enum values are the
 * Prisma `FindingStatus` members.
 */
import { createTypedFilterDefs, optionsFromEnum } from '@/components/ui/filter/filter-definitions';
import { CircleHalfDottedCheck } from '@inflect/ui/components/ui/icons/nucleo';

/** Surface-namespace resolver (`useTranslations('findings')`). */
type T = (key: string, values?: Record<string, unknown>) => string;
/** Shared filter-group resolver (`useTranslations('common.filterGroups')`). */
type TGroup = (key: string) => string;

/** Workflow order, which is also the order the options are offered in. */
export const FINDING_STATUSES = ['OPEN', 'IN_PROGRESS', 'READY_FOR_VERIFICATION', 'CLOSED'] as const;

export function findingStatusLabels(t: T): Record<string, string> {
    return {
        OPEN: t('open'),
        IN_PROGRESS: t('inProgress'),
        READY_FOR_VERIFICATION: t('readyForVerification'),
        CLOSED: t('closed'),
    };
}

function findingFilterDefsInput(t: T, tGroup: TGroup) {
    return {
        status: {
            label: t('status'),
            description: t('filters.statusDesc'),
            group: tGroup('workflow'),
            icon: CircleHalfDottedCheck,
            options: optionsFromEnum(findingStatusLabels(t)),
            multiple: true,
            resetBehavior: 'clearable',
        },
    } as const;
}

export const FINDING_FILTER_KEYS = ['status'] as const;

/** Build the localized findings filter defs. Memoize per render. */
export function buildFindingFilters(t: T, tGroup: TGroup) {
    return createTypedFilterDefs()(findingFilterDefsInput(t, tGroup)).filters;
}
