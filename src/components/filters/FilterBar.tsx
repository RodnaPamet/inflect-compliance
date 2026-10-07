'use client';

import { useTranslations } from 'next-intl';
import { useUrlFilters } from '@/lib/hooks/useUrlFilters';
import { Combobox } from '@/components/ui/combobox';
import { Button } from '@/components/ui/button';
import { cardVariants } from '@/components/ui/card';
import { cn } from '@inflect/ui/lib/cn';

export interface FilterSelectConfig {
    key: string;
    label: string;
    options: { value: string; label: string }[];
    /** CSS width class, e.g. 'w-40' */
    width?: string;
}

export interface FilterToggleConfig {
    key: string;
    label: string;
    /** Value sent when toggled on (default: 'true') */
    activeValue?: string;
}

interface FilterBarProps {
    /** Which URL param keys this bar manages */
    filterKeys: string[];
    /** Search placeholder text */
    searchPlaceholder?: string;
    /** Select dropdown configs */
    selects?: FilterSelectConfig[];
    /** Toggle button configs */
    toggles?: FilterToggleConfig[];
    /** Extra class names */
    className?: string;
}

/**
 * Reusable URL-driven filter bar.
 *
 * Renders a search input + configurable selects/toggles.
 * All state lives in the URL via useUrlFilters.
 */
export function FilterBar({
    filterKeys,
    searchPlaceholder: searchPlaceholderProp,
    selects = [],
    toggles = [],
    className = '',
}: FilterBarProps) {
    const t = useTranslations('common');
    const searchPlaceholder = searchPlaceholderProp ?? t('search');
    const { filters, setFilter, clearFilters, hasActiveFilters } = useUrlFilters(filterKeys);

    return (
        <div className={cn(cardVariants({ density: 'compact' }), className)}>
            <div className="flex flex-wrap gap-compact items-center">
                {/* Search input */}
                <div className="flex-1 min-w-[200px]">
                    <input
                        type="text"
                        className="input w-full"
                        placeholder={searchPlaceholder}
                        value={filters.q || ''}
                        onChange={(e) => setFilter('q', e.target.value)}
                        id="filter-search"
                    />
                </div>

                {/* Select dropdowns */}
                {selects.map((s) => (
                    <Combobox
                        key={s.key}
                        hideSearch
                        id={`filter-${s.key}`}
                        selected={s.options.find(o => o.value === (filters[s.key] || '')) ? { value: filters[s.key] || '', label: s.options.find(o => o.value === filters[s.key])?.label || '' } : null}
                        setSelected={(opt) => setFilter(s.key, opt?.value ?? '')}
                        options={s.options.map(o => ({ value: o.value, label: o.label }))}
                        placeholder={s.label}
                        matchTriggerWidth
                        buttonProps={{ className: s.width || 'w-40' }}
                    />
                ))}

                {/* Toggle buttons */}
                {toggles.map((t) => {
                    const activeVal = t.activeValue || 'true';
                    const isActive = filters[t.key] === activeVal;
                    return (
                        <Button
                            key={t.key}
                            variant={isActive ? 'primary' : 'secondary'}
                            size="sm"
                            onClick={() => setFilter(t.key, isActive ? '' : activeVal)}
                            id={`filter-toggle-${t.key}`}
                        >
                            {t.label}
                        </Button>
                    );
                })}

                {/* Clear filters */}
                {hasActiveFilters && (
                    <Button
                        variant="secondary"
                        size="sm"
                        onClick={clearFilters}
                        className="text-xs"
                        id="filter-clear"
                    >
                        {`× ${t('ui.clearFilters')}`}
                    </Button>
                )}
            </div>
        </div>
    );
}
