'use client';

/**
 * EditFiltersButton — the "Edit filter cards" gear (2026-06-07).
 *
 * Thin wrapper over the shared `<ChecklistGearButton>`: binds the filter
 * domain's icon (`Settings`), title, and test-id; all checklist / ordering
 * / ring / reset behaviour lives in the shared primitive. The companion
 * `useFilterCardVisibility` hook owns the state and renders this.
 *
 * Sits FIRST (leftmost) in the toolbar's actions slot — it controls the
 * primary toolbar content. The columns gear (`Columns3`) sits second.
 */
import { useTranslations } from 'next-intl';
import { Settings } from 'lucide-react';
import { ChecklistGearButton } from '@/components/ui/checklist-gear-button';
import type { ChecklistGearItem } from '@/components/ui/checklist-order';

export interface EditFiltersButtonProps {
    items: ChecklistGearItem[];
    onToggle: (id: string) => void;
    onReset?: () => void;
    onReorder?: (fromId: string, toId: string) => void;
    someModified: boolean;
    className?: string;
    id?: string;
}

export function EditFiltersButton(props: EditFiltersButtonProps) {
    const t = useTranslations('common');
    return (
        <ChecklistGearButton
            {...props}
            icon={<Settings className="h-3.5 w-3.5 shrink-0" />}
            // "Edit KPI cards", not "Edit filter cards". The label was written
            // when the gear listed FILTER categories; it now edits the KPI
            // strip on all eight list pages, so the old wording named the wrong
            // thing on every one of them.
            //
            // Localised via the same catalogue path the sibling gear already
            // uses (`common.table.toggleColumns`), so the two toolbar gears
            // resolve their names the same way.
            title={t('table.editKpiCards')}
            data-testid="edit-filters-button"
        />
    );
}
