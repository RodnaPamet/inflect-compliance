'use client';

/**
 * Automation Rules tab (Automation Epic 1).
 *
 * The "rule inventory" overview — Archer's workflow-manager entry screen.
 * Lists every automation rule with status, trigger, action, last-fired,
 * execution count, and priority, filterable by status / trigger / action.
 *
 * Filtering is in-memory over the fetched list (rule counts are small).
 * Row click → RuleDetailSheet and the "+ Rule" builder land in Epics 2-3;
 * Epic 1 ships the read-only inventory.
 */
import { useCallback, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { RuleDetailSheet } from '@/components/processes/RuleDetailSheet';
import { RuleBuilderModal } from '@/components/processes/RuleBuilderModal';
import { TemplateLibraryModal } from '@/components/processes/TemplateLibraryModal';
import { Button } from '@/components/ui/button';
import { Plus } from '@/components/ui/icons/nucleo';
import { CACHE_KEYS } from '@/lib/swr-keys';
import { EntityListPage } from '@/components/layout/EntityListPage';
import { createColumns } from '@/components/ui/table';
import { StatusBadge, type StatusBadgeVariant } from '@/components/ui/status-badge';
import { EmptyState } from '@/components/ui/empty-state';
import { formatDate } from '@/lib/format-date';
import {
    FilterProvider,
    useFilterContext,
    useFilters,
} from '@/components/ui/filter';
import { toApiSearchParams } from '@/lib/filters/url-sync';
import {
    buildRuleFilters,
    RULE_FILTER_KEYS,
    buildRuleStatusLabels,
    buildRuleActionLabels,
    type RuleStatusKey,
    type RuleActionKey,
} from './automation-filter-defs';

export interface AutomationRuleRow {
    id: string;
    name: string;
    triggerEvent: string;
    actionType: RuleActionKey;
    status: RuleStatusKey;
    priority: number;
    executionCount: number;
    lastTriggeredAt: string | Date | null;
}

const STATUS_VARIANT: Record<string, StatusBadgeVariant> = {
    ENABLED: 'success',
    DISABLED: 'neutral',
    DRAFT: 'info',
    ARCHIVED: 'neutral',
};

function humanizeEvent(name: string): string {
    return name
        .toLowerCase()
        .split('_')
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
}

/** Comma-separated multi-select match (empty filter = match all). */
function matchesCsv(filterValue: string | null, rowValue: string): boolean {
    if (!filterValue) return true;
    return filterValue.split(',').filter(Boolean).includes(rowValue);
}

export function RulesTab({ tenantSlug }: { tenantSlug: string }) {
    const filterCtx = useFilterContext([], RULE_FILTER_KEYS, {});
    return (
        <FilterProvider value={filterCtx}>
            <RulesTabInner tenantSlug={tenantSlug} />
        </FilterProvider>
    );
}

function RulesTabInner({ tenantSlug }: { tenantSlug: string }) {
    const t = useTranslations('processes');
    const tGroup = useTranslations('common.filterGroups');
    const RULE_STATUS_LABELS = buildRuleStatusLabels((k) => t(k as Parameters<typeof t>[0]));
    const RULE_ACTION_LABELS = buildRuleActionLabels((k) => t(k as Parameters<typeof t>[0]));
    const { state, search } = useFilters();
    const { data, isLoading, error } = useTenantSWR<AutomationRuleRow[]>(
        CACHE_KEYS.automation.rules.list(),
    );
    const [selected, setSelected] = useState<AutomationRuleRow | null>(null);
    const [sheetOpen, setSheetOpen] = useState(false);
    const [builderOpen, setBuilderOpen] = useState(false);
    const [editRule, setEditRule] = useState<AutomationRuleRow | null>(null);
    const [templatesOpen, setTemplatesOpen] = useState(false);

    const rows = useMemo(() => {
        const all = data ?? [];
        const sp = toApiSearchParams(state, { search });
        const status = sp.get('status');
        const trigger = sp.get('triggerEvent');
        const action = sp.get('actionType');
        return all.filter(
            (r) =>
                matchesCsv(status, r.status) &&
                matchesCsv(trigger, r.triggerEvent) &&
                matchesCsv(action, r.actionType),
        );
    }, [data, state, search]);

    const columns = useMemo(
        () =>
            createColumns<AutomationRuleRow>([
                {
                    accessorKey: 'name',
                    header: t('rules.colName'),
                    cell: ({ row }) => (
                        <span className="font-medium text-content-emphasis">
                            {row.original.name}
                        </span>
                    ),
                },
                {
                    accessorKey: 'triggerEvent',
                    header: t('rules.colTrigger'),
                    cell: ({ row }) => (
                        <span className="text-sm text-content-default">
                            {humanizeEvent(row.original.triggerEvent)}
                        </span>
                    ),
                },
                {
                    accessorKey: 'actionType',
                    header: t('rules.colAction'),
                    cell: ({ row }) => (
                        <span className="text-sm text-content-muted">
                            {RULE_ACTION_LABELS[row.original.actionType] ??
                                row.original.actionType}
                        </span>
                    ),
                },
                {
                    accessorKey: 'status',
                    header: t('rules.colStatus'),
                    cell: ({ row }) => (
                        <StatusBadge
                            variant={STATUS_VARIANT[row.original.status] ?? 'neutral'}
                        >
                            {RULE_STATUS_LABELS[row.original.status] ?? row.original.status}
                        </StatusBadge>
                    ),
                },
                {
                    accessorKey: 'lastTriggeredAt',
                    header: t('rules.colLastTriggered'),
                    cell: ({ row }) =>
                        row.original.lastTriggeredAt ? (
                            <span className="text-sm text-content-muted tabular-nums">
                                {formatDate(row.original.lastTriggeredAt)}
                            </span>
                        ) : (
                            <span className="text-sm text-content-subtle">{t('rules.never')}</span>
                        ),
                },
                {
                    accessorKey: 'executionCount',
                    header: t('rules.colRuns'),
                    cell: ({ row }) => (
                        <span className="text-sm tabular-nums text-content-muted">
                            {row.original.executionCount}
                        </span>
                    ),
                },
                {
                    accessorKey: 'priority',
                    header: t('rules.colPriority'),
                    cell: ({ row }) => (
                        <span className="text-sm tabular-nums text-content-muted">
                            {row.original.priority}
                        </span>
                    ),
                },
            ]),
        [t],
    );

    // Stable table-model identities — a fresh identity here rebuilds
    // the table model mid-double-click and kills row navigation (#1678).
    const getRuleRowId = useCallback((r: AutomationRuleRow) => r.id, []);
    const handleRuleRowClick = useCallback((r: { original: AutomationRuleRow }) => {
        setSelected(r.original);
        setSheetOpen(true);
    }, []);

    return (
        <>
            <EntityListPage<AutomationRuleRow>
                header={{
                    eyebrow: t('rules.eyebrow'),
                    title: t('rules.title'),
                    count: t('rules.count', { count: rows.length }),
                }}
                filters={{
                    defs: buildRuleFilters((k) => t(k as Parameters<typeof t>[0]), (k) => tGroup(k as Parameters<typeof tGroup>[0])),
                    toolbarActions: (
                        <Button variant="secondary" onClick={() => setTemplatesOpen(true)}>
                            {t('rules.templates')}
                        </Button>
                    ),
                    toolbarPrimary: (
                        <Button
                            variant="primary"
                            icon={<Plus />}
                            onClick={() => {
                                setEditRule(null);
                                setBuilderOpen(true);
                            }}
                            id="new-rule-btn"
                        >
                            {t('rules.addRule')}
                        </Button>
                    ),
                }}
                table={{
                    data: rows,
                    columns,
                    loading: isLoading,
                    error: error ? t('rules.loadError') : undefined,
                    getRowId: getRuleRowId,
                    resourceName: (plural) => (plural ? t('rules.resPlural') : t('rules.resSingular')),
                    onRowClick: handleRuleRowClick,
                    emptyState: (
                        <EmptyState
                            title={t('rules.emptyTitle')}
                            description={t('rules.emptyDesc')}
                        />
                    ),
                    'data-testid': 'automation-rules-table',
                }}
            />
            <RuleDetailSheet
                rule={selected}
                open={sheetOpen}
                onOpenChange={setSheetOpen}
                onEdit={(r) => {
                    setSheetOpen(false);
                    setEditRule(r);
                    setBuilderOpen(true);
                }}
            />
            <RuleBuilderModal
                tenantSlug={tenantSlug}
                open={builderOpen}
                setOpen={setBuilderOpen}
                editRule={editRule}
            />
            <TemplateLibraryModal open={templatesOpen} setOpen={setTemplatesOpen} />
        </>
    );
}
