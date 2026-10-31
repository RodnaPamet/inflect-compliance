'use client';

import { useState, useRef, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useTenantApiUrl, useTenantHref, useTenantContext } from '@/lib/tenant-context-provider';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { AppIcon } from '@/components/icons/AppIcon';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DataTable, createColumns, TableEmptyState } from '@/components/ui/table';
import { InlineEmptyState } from '@/components/ui/inline-empty-state';
import { InlineNotice } from '@/components/ui/inline-notice';
import { StatusBadge } from '@/components/ui/status-badge';
import { Heading } from '@/components/ui/typography';
import { cardVariants } from '@/components/ui/card';
import { BackAffordance } from '@/components/nav/BackAffordance';
import { cn } from '@inflect/ui/lib/cn';
import { apiErrorMessage } from '@/lib/api-error';
import { parsePlanLimitMessage } from '@/lib/billing/plan-limit-message';

// listControlTemplates → ControlTemplateRepository.list (ControlTemplate model).
interface ControlTemplateRow {
    id: string;
    code: string;
    title: string;
    category: string | null;
    description: string | null;
    // Pre-install preview — what installing this template creates.
    // `ControlTemplateRepository.list` includes this `_count` select.
    _count?: { tasks: number; requirementLinks: number };
}

export default function ControlTemplatesPage() {
    const apiUrl = useTenantApiUrl();
    const tenantHref = useTenantHref();
    const router = useRouter();
    // Success-redirect timer — see the install handler below.
    const redirectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(
        () => () => {
            if (redirectTimer.current) clearTimeout(redirectTimer.current);
        },
        [],
    );
    const { permissions, appPermissions } = useTenantContext();
    // #4795 — installing creates controls, and the server asks the write
    // tier AND `controls.create` (assertCanCreateControl). Only a viewer it
    // would accept is offered the selection and the install bar.
    const canInstall = permissions.canWrite && appPermissions.controls.create;
    const t = useTranslations('controls');


    // Epic 69 — SWR-backed list (was fetch-on-mount + setState-in-effect).
    // The API returns a bare array; `mutate` powers the inline retry.
    const { data: templates = [], isLoading, error: loadError, mutate } =
        useTenantSWR<ControlTemplateRow[]>('/controls/templates');
    // Live client-side search over the loaded templates (code / title /
    // category). Typing filters immediately — no Enter. The list is small
    // enough that a client filter is the right tool; the page has no
    // FilterToolbar/FilterProvider, so a shared <Input> is the primitive.
    const [search, setSearch] = useState('');
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    const [installing, setInstalling] = useState(false);
    const [error, setError] = useState('');
    const [success, setSuccess] = useState('');
    const [unresolvedCount, setUnresolvedCount] = useState(0);

    const toggle = (id: string) => {
        setSelectedIds(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
        });
    };

    const toggleAll = () => {
        if (selectedIds.size === filtered.length) {
            setSelectedIds(new Set());
        } else {
            setSelectedIds(new Set(filtered.map(t => t.id)));
        }
    };

    const handleInstall = async () => {
        if (selectedIds.size === 0) return;
        setInstalling(true);
        setError('');
        setUnresolvedCount(0);
        try {
            const res = await fetch(apiUrl('/controls/templates/install'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ templateIds: Array.from(selectedIds) }),
            });
            if (!res.ok) {
                // The error body is the envelope `{ error: { code, message } }`;
                // reading `data.error` as a string or `data.message` dropped
                // the server's reason for the generic fallback (#4126).
                // A 5xx says nothing a person can act on; keep the fallback.
                // The plan-limit refusal is machine-shaped, so it is said in
                // words (#4795), as the new-control modal does.
                const data = res.status >= 500 ? null : await res.json().catch(() => null);
                const reason = apiErrorMessage(data, '');
                const planLimit = parsePlanLimitMessage(reason);
                throw new Error(
                    planLimit
                        ? t('templates.planLimitReached', { limit: planLimit.limit, current: planLimit.current })
                        : reason || t('templates.installFailed'),
                );
            }
            const result = await res.json();
            // Each row carries `skipped: true` when a control with that code
            // already existed (no-op). Count only real installs; call out any
            // skipped-existing so the toast never over-reports.
            const rows: Array<{ skipped?: boolean; unresolvedTemplateId?: string }> = Array.isArray(result) ? result : [];
            const installed = rows.filter((r) => !r.skipped).length;
            // A template that no longer resolves is not an "existing" control:
            // it is reported on its own (#4795).
            const unresolved = rows.filter((r) => r.skipped && r.unresolvedTemplateId).length;
            const skipped = rows.filter((r) => r.skipped && !r.unresolvedTemplateId).length;
            setUnresolvedCount(unresolved);
            setSuccess(
                skipped > 0
                    ? t('templates.installedWithSkipped', { installed, skipped })
                    : t('templates.installed', { count: installed }),
            );
            // Held in a ref and cleared on unmount. Uncleaned, this fires
            // against an unmounted component if the user navigates within the
            // 1.5s the success message is shown — a real leak, not a
            // theoretical one, because the message invites you to look away.
            redirectTimer.current = setTimeout(
                () => router.push(tenantHref('/controls')),
                1500,
            );

        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setInstalling(false);
        }
    };

    // Plain computed value — the React Compiler auto-memoizes; a manual
    // useMemo here tripped react-hooks/preserve-manual-memoization.
    const filterQuery = search.trim().toLowerCase();
    const filtered = !filterQuery
        ? templates
        : templates.filter(
              (tpl) =>
                  (tpl.code ?? '').toLowerCase().includes(filterQuery) ||
                  (tpl.title ?? '').toLowerCase().includes(filterQuery) ||
                  (tpl.category ?? '').toLowerCase().includes(filterQuery),
          );


    return (
        <div className="space-y-section animate-fadeIn">
            <BackAffordance />
            {/* Header */}
            <div className="flex items-center justify-between">
                <div>
                    <Heading level={1} id="templates-heading"><AppIcon name="templates" className="inline-block mr-2 align-text-bottom" /> {t('templates.title')}</Heading>
                    <p className="text-content-muted text-sm">{t('templates.subtitle')}</p>
                </div>
            </div>

            {error && (
                <InlineNotice variant="error" icon={null}>{error}</InlineNotice>
            )}
            {success && (
                <InlineNotice variant="success" icon={null} id="install-success">{success}</InlineNotice>
            )}
            {unresolvedCount > 0 && (
                <InlineNotice variant="warning" icon={null} id="install-unresolved">
                    {t('templates.unresolvedNotice', { count: unresolvedCount })}
                </InlineNotice>
            )}

            {/* Install bar — bulk-install the selected templates. */}
            {canInstall && (
                <div className={cardVariants({ density: 'compact' })}>
                    <div className="flex items-center justify-end">
                        <Button
                            variant="primary"
                            onClick={handleInstall}
                            disabled={selectedIds.size === 0 || installing}
                            id="install-selected-btn"
                        >
                            {installing ? t('templates.installing') : t('templates.installSelected', { count: selectedIds.size })}
                        </Button>
                    </div>
                </div>
            )}

            {/* Live search — filters the loaded templates as you type. */}
            <div className="max-w-sm">
                <Input
                    id="templates-search"
                    size="sm"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder={t('templates.searchPlaceholder')}
                    aria-label={t('templates.searchPlaceholder')}
                />
            </div>

            {/* Template list */}
            <div className={cn(cardVariants({ density: 'none' }), 'overflow-hidden')}>
                {isLoading ? (
                    <div className="p-12 text-center text-content-subtle animate-pulse">{t('templates.loading')}</div>
                ) : loadError ? (
                    <div className="p-12 text-center space-y-default">
                        <p className="text-content-error">{t('templates.loadFailed')}</p>
                        <Button variant="secondary" onClick={() => mutate()} id="templates-retry-btn">
                            {t('templates.retry')}
                        </Button>
                    </div>
                ) : filtered.length === 0 ? (
                    // #4795 — a search that matches nothing is not an empty
                    // library: say which, and offer the way back.
                    templates.length > 0 ? (
                        <div className="space-y-default p-default text-center">
                            <InlineEmptyState
                                title={t('templates.noMatchTitle')}
                                description={t('templates.noMatchDesc')}
                            />
                            <Button variant="secondary" size="sm" onClick={() => setSearch('')} id="templates-clear-search">
                                {t('templates.clearSearch')}
                            </Button>
                        </div>
                    ) : (
                        <InlineEmptyState
                            title={t('templates.emptyTitle')}
                            description={t('templates.emptyDesc')}
                        />
                    )
                ) : (
                    (() => {
                        // #4795 — the selection exists only to install, so it is
                        // offered only to a viewer who can; each box is named.
                        const selectColumn = {
                            id: 'select', header: () => (
                                <input
                                    type="checkbox"
                                    checked={selectedIds.size === filtered.length && filtered.length > 0}
                                    onChange={toggleAll}
                                    className="rounded"
                                    aria-label={t('templates.selectAll')}
                                />
                            ),
                            cell: ({ row }: { row: { original: ControlTemplateRow } }) => (
                                <input
                                    type="checkbox"
                                    checked={selectedIds.has(row.original.id)}
                                    onChange={() => toggle(row.original.id)}
                                    className="rounded"
                                    aria-label={t('templates.selectRow', { name: row.original.code ? `${row.original.code} ${row.original.title}` : row.original.title })}
                                />
                            ),
                        };
                        const templateCols = createColumns<ControlTemplateRow>([
                            ...(canInstall ? [selectColumn] : []),
                            { accessorKey: 'code', header: t('templates.colCode'), cell: ({ getValue }) => <span className="text-xs text-content-muted font-mono">{getValue() || '—'}</span> },
                            { accessorKey: 'title', header: t('templates.colName'), cell: ({ getValue }) => <span className="font-medium text-content-emphasis">{getValue()}</span> },
                            {
                                accessorKey: 'category', header: t('templates.colCategory'),
                                cell: ({ getValue }) => getValue() ? <StatusBadge variant="info">{getValue()}</StatusBadge> : null,
                            },
                            {
                                // Pre-install preview — what installing creates.
                                id: 'preview', header: t('templates.colPreview'),
                                cell: ({ row }) => {
                                    const c = row.original._count;
                                    return (
                                        <span className="text-xs text-content-subtle whitespace-nowrap">
                                            {t('templates.previewSummary', { tasks: c?.tasks ?? 0, requirements: c?.requirementLinks ?? 0 })}
                                        </span>
                                    );
                                },
                            },
                            { accessorKey: 'description', header: t('templates.colDescription'), cell: ({ getValue }) => <span className="text-xs text-content-subtle truncate max-w-xs">{getValue() || '—'}</span> },
                        ]);
                        return (
                            <DataTable
                                data={filtered}
                                columns={templateCols}
                                getRowId={(t) => t.id}
                                onRowClick={canInstall ? (row) => toggle(row.original.id) : undefined}
                                // The page's own column is the install set
                                // (#4795). DataTable's default selection column
                                // drew a second, unused set of boxes beside it,
                                // for every role.
                                selectionEnabled={false}
                                emptyState={
                                    <TableEmptyState
                                        title={t('templates.emptyTitle')}
                                        description={t('templates.emptyDesc')}
                                    />
                                }
                                resourceName={(p) => p ? t('templates.resourcePlural') : t('templates.resourceSingular')}
                                data-testid="templates-table"
                            />
                        );
                    })()
                )}
            </div>
        </div>
    );
}
