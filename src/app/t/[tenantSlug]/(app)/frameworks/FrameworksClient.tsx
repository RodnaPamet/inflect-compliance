'use client';

/**
 * Epic 66 — frameworks page client island.
 *
 * Owns the table/cards view toggle and the rendering for both
 * variants. The server page (`page.tsx`) does the data fetch and
 * passes the resolved `frameworks` + `coverages` as props so this
 * component stays presentational.
 *
 * Cards view uses the shared `<CardList>` compound primitives.
 * Table view uses the shared `<DataTable>`. The toggle is the
 * shared `<ViewToggle>` + `useViewMode` hook so the preference
 * persists per-page in `localStorage` under
 * `inflect:view-mode:frameworks`.
 */

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
    BadgeCheck,
    Car,
    ClipboardList,
    Flag,
    Package,
    Plus,
    ShieldCheck,
    type LucideIcon,
} from 'lucide-react';
import { cardVariants } from '@/components/ui/card';
import { cn } from '@/lib/cn';

import { Button } from '@/components/ui/button';
import { CardList } from '@/components/ui/card-list';
import { Modal } from '@/components/ui/modal';
import { ProgressBar } from '@/components/ui/progress-bar';
import { StatusBadge } from '@/components/ui/status-badge';
import { Tooltip } from '@/components/ui/tooltip';
import { DataTable, createColumns, useColumnsDropdown } from '@/components/ui/table';
import { ViewToggle } from '@/components/ui/view-toggle';
import { useViewMode } from '@/components/ui/hooks';
import { Heading } from '@/components/ui/typography';
import { BackAffordance } from '@/components/nav/BackAffordance';
import { usePublishDisplayedOrder } from '@/lib/hooks/use-entity-list-ids';
import { CACHE_KEYS } from '@/lib/swr-keys';

import { frameworkOrderKey } from './framework-order';

const FW_META: Record<string, { icon: LucideIcon; color: string }> = {
    ISO27001: { icon: ShieldCheck, color: 'from-indigo-500 to-purple-600' },
    NIS2: { icon: Flag, color: 'from-blue-500 to-cyan-600' },
    ISO9001: { icon: BadgeCheck, color: 'from-emerald-500 to-green-600' },
    ISO28000: { icon: Package, color: 'from-orange-500 to-amber-600' },
    ISO39001: { icon: Car, color: 'from-rose-500 to-pink-600' },
};
const FW_DEFAULT: { icon: LucideIcon; color: string } = {
    icon: ClipboardList,
    color: 'from-slate-500 to-slate-600',
};

export interface FrameworksClientProps {
    frameworks: FrameworkListItem[];
    coverages: Record<string, { coveragePercent: number; mapped: number; total: number }>;
    /** R2-P3 — framework keys whose coverage failed to compute (≠ genuine 0%). */
    coverageErrors?: string[];
    tenantSlug: string;
}

// listFrameworks row (Framework + _count).
interface FrameworkListItem {
    id: string;
    key: string;
    name: string;
    description: string | null;
    version: string | null;
    kind: string;
    /** JSON blob carrying provider / copyright / license provenance. */
    metadataJson?: string | null;
    _count: { requirements: number; packs: number };
}

/** Provenance surfaced on the framework card (e.g. OWASP attribution). */
interface FwProvenance {
    provider?: string;
    license?: string;
    sourceUrl?: string;
    /** When true, IC stores an index + links to canonical text (not the prose). */
    referenceIndexOnly?: boolean;
}

/**
 * Parse the framework's metadataJson into a small provenance object. Both the
 * library-importer and the seed write `{ provider, copyright, license?,
 * sourceUrl?, referenceIndexOnly? }`; we surface attribution + license on the
 * card so an upstream standard's terms (e.g. AISVS CC-BY-SA-4.0) are honoured.
 */
function parseProvenance(metadataJson?: string | null): FwProvenance | null {
    if (!metadataJson) return null;
    try {
        const m = JSON.parse(metadataJson) as Record<string, unknown>;
        const provider = typeof m.provider === 'string' ? m.provider : undefined;
        const license =
            typeof m.license === 'string'
                ? m.license
                : typeof m.copyright === 'string' && /CC-BY-SA-4\.0/i.test(m.copyright)
                ? 'CC-BY-SA-4.0'
                : undefined;
        const sourceUrl = typeof m.sourceUrl === 'string' ? m.sourceUrl : undefined;
        const referenceIndexOnly = m.referenceIndexOnly === true;
        if (!provider && !license) return null;
        return { provider, license, sourceUrl, referenceIndexOnly };
    } catch {
        return null;
    }
}

interface FwRow {
    id: string;
    key: string;
    name: string;
    description?: string;
    version?: string | null;
    kind?: string | null;
    requirementCount: number;
    packCount: number;
    coveragePercent: number;
    coverageError: boolean;
    mapped: number;
    total: number;
    isInstalled: boolean;
    href: string;
    installHref: string;
    provenance: FwProvenance | null;
}

export function FrameworksClient({
    frameworks,
    coverages,
    coverageErrors = [],
    tenantSlug,
}: FrameworksClientProps) {
    const t = useTranslations('frameworks');
    const [view, setView] = useViewMode('frameworks', 'cards');
    // B8 — explanatory modal for custom-framework creation. Custom
    // frameworks require a tenantId column on the (currently global)
    // Framework model + matching RLS policies — a substantial change
    // queued for a follow-up. The modal surfaces the path and links
    // to the existing import flow as the today-answer.
    const [customFwModalOpen, setCustomFwModalOpen] = useState(false);
    const href = (path: string) => `/t/${tenantSlug}${path}`;

    // R10-PR7 — column-visibility gear, table-mode only.
    const frameworkColumnList = useMemo(
        () => [
            { id: 'name', label: t('list.framework') },
            { id: 'kind', label: t('list.domain') },
            { id: 'requirementCount', label: t('list.requirements') },
            { id: 'coverage', label: t('list.coverage') },
            { id: 'status', label: t('list.status') },
        ],
        [t],
    );
    const {
        columnVisibility,
        setColumnVisibility,
        dropdown: columnsDropdown,
    } = useColumnsDropdown({
        storageKey: 'inflect:col-vis:frameworks',
        columns: frameworkColumnList,
    });

    // B8 — pick the first uninstalled framework as the "Import"
    // CTA target. Falls back to the first framework when everything
    // is already installed; if there are none at all the CTA hides.
    const importHref = useMemo(() => {
        const uninstalled = frameworks.find((fw) => {
            const cov = coverages[fw.key];
            return !cov || cov.mapped === 0;
        });
        const target = uninstalled ?? frameworks[0];
        return target ? href(`/frameworks/${target.key}/install`) : null;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [frameworks, coverages, coverageErrors]);

    const rows: FwRow[] = useMemo(
        () =>
            frameworks.map((fw): FwRow => {
                const cov = coverages[fw.key];
                const coveragePercent = cov?.coveragePercent ?? 0;
                return {
                    coverageError: coverageErrors.includes(fw.key),
                    id: fw.id,
                    key: fw.key,
                    name: fw.name,
                    description: fw.description ?? undefined,
                    version: fw.version,
                    kind: fw.kind,
                    requirementCount: fw._count?.requirements ?? 0,
                    packCount: fw._count?.packs ?? 0,
                    coveragePercent,
                    mapped: cov?.mapped ?? 0,
                    total: cov?.total ?? 0,
                    isInstalled: !!(cov && cov.mapped > 0),
                    href: href(`/frameworks/${fw.key}`),
                    installHref: href(`/frameworks/${fw.key}/install`),
                    provenance: parseProvenance(fw.metadataJson),
                };
            }),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [frameworks, coverages, coverageErrors],
    );

    // #98 — publish the order the page RENDERS so the framework detail page's
    // stepper walks it. `rows` is the single array both the cards view and the
    // table view map over, so it is the displayed order in either view.
    //
    // Two things differ from the other seven publishers. The order is keyed by
    // the framework SLUG (`frameworkOrderKey`), because that is what the
    // `[frameworkKey]` route carries. And there is no SWR read here at all —
    // this page is server-rendered and gets its rows as props — which the
    // publish hook does not care about: it takes rows, not a fetch.
    usePublishDisplayedOrder(CACHE_KEYS.frameworks.list(), rows, frameworkOrderKey);

    return (
        <div className="space-y-section animate-fadeIn">
            <div className="flex items-end justify-between gap-default flex-wrap">
                <div>
                    <BackAffordance />
                    <Heading level={1} id="frameworks-heading">
                        {t('list.heading')}
                    </Heading>
                    <p className="text-sm text-content-muted mt-1">
                        {t('list.description')}
                    </p>
                </div>
                <div className="flex items-center gap-tight">
                    {view === 'table' && columnsDropdown}
                    <ViewToggle
                        view={view}
                        onChange={setView}
                        data-testid="frameworks-view-toggle"
                    />
                    {/* B8 — Custom-framework explainer CTA. Opens
                        the modal that documents the design + links
                        out to the import path. */}
                    <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => setCustomFwModalOpen(true)}
                        id="create-framework-btn"
                        data-testid="create-framework-btn"
                    >
                        {t('list.createFramework')}
                    </Button>
                    {/* B8 — primary action: jump to the import flow
                        for the first uninstalled framework. Hides
                        when there's literally nothing in the
                        catalogue (seed not run). */}
                    {importHref && (
                        <Link href={importHref}>
                            <Button
                                variant="primary"
                                size="sm"
                                icon={<Plus className="-ml-0.5 -mr-2.5" />}
                                id="import-framework-btn"
                                data-testid="import-framework-btn"
                            >
                                {t('list.importFramework')}
                            </Button>
                        </Link>
                    )}
                </div>
            </div>

            {view === 'cards' && (
                <CardList aria-label={t('list.ariaLabel')} data-testid="frameworks-card-list">
                    {rows.map((row) => {
                        const meta = FW_META[row.key] || FW_DEFAULT;
                        const FwIcon = meta.icon;
                        return (
                            <CardList.Card
                                key={row.id}
                                data-testid={`fw-card-${row.key}`}
                                onClick={() => {
                                    if (typeof window !== 'undefined') {
                                        window.location.href = row.href;
                                    }
                                }}
                            >
                                <CardList.CardHeader
                                    title={
                                        <span className="inline-flex items-center gap-tight">
                                            <FwIcon
                                                className="w-5 h-5"
                                                aria-hidden="true"
                                            />
                                            <Link
                                                href={row.href}
                                                className="text-content-emphasis hover:underline"
                                            >
                                                {row.name}
                                            </Link>
                                        </span>
                                    }
                                    subtitle={
                                        row.kind
                                            ? row.kind.replace('_', ' ')
                                            : undefined
                                    }
                                    badge={
                                        row.isInstalled ? (
                                            <StatusBadge variant="success">{t('list.installed')}</StatusBadge>
                                        ) : (
                                            <StatusBadge variant="warning">{t('list.available')}</StatusBadge>
                                        )
                                    }
                                />
                                <CardList.CardContent
                                    kv={[
                                        {
                                            label: t('list.requirements'),
                                            value: row.requirementCount,
                                        },
                                        {
                                            label: t('list.packs'),
                                            value: row.packCount,
                                        },
                                        {
                                            label: t('list.coverage'),
                                            value: `${row.coveragePercent}%`,
                                        },
                                    ]}
                                >
                                    {row.description && (
                                        <p className="text-xs text-content-muted line-clamp-2">
                                            {row.description}
                                        </p>
                                    )}
                                    {row.provenance && (
                                        <p
                                            className="text-[10px] text-content-subtle"
                                            data-testid={`fw-provenance-${row.key}`}
                                        >
                                            {row.provenance.provider && (
                                                <>{t('list.source', { provider: row.provenance.provider })}</>
                                            )}
                                            {row.provenance.license && (
                                                <> · {row.provenance.license}</>
                                            )}
                                            {row.provenance.referenceIndexOnly && (
                                                <> · {t('list.referenceIndexNote')}</>
                                            )}
                                        </p>
                                    )}
                                    <ProgressBar
                                        value={row.coveragePercent}
                                        size="sm"
                                        variant={
                                            row.coveragePercent === 100
                                                ? 'success'
                                                : row.coveragePercent > 0
                                                ? 'brand'
                                                : 'neutral'
                                        }
                                        aria-label={`${row.name} coverage`}
                                    />
                                </CardList.CardContent>
                            </CardList.Card>
                        );
                    })}
                </CardList>
            )}

            {view === 'table' && (
                <DataTable<FwRow>
                    data={rows}
                    columnVisibility={columnVisibility}
                    onColumnVisibilityChange={setColumnVisibility}
                    columns={createColumns<FwRow>([
                        {
                            id: 'name',
                            header: t('list.framework'),
                            cell: ({ row }) => (
                                <Link
                                    href={row.original.href}
                                    className="font-medium text-content-emphasis hover:underline"
                                >
                                    {row.original.name}
                                </Link>
                            ),
                        },
                        {
                            id: 'kind',
                            header: t('list.domain'),
                            cell: ({ row }) =>
                                row.original.kind ? (
                                    <span className="text-xs text-content-muted">
                                        {row.original.kind.replace('_', ' ')}
                                    </span>
                                ) : (
                                    <span className="text-content-subtle">—</span>
                                ),
                        },
                        {
                            id: 'requirementCount',
                            header: t('list.requirements'),
                            cell: ({ row }) => (
                                <span className="tabular-nums text-xs text-content-default">
                                    {row.original.requirementCount}
                                </span>
                            ),
                        },
                        {
                            id: 'coverage',
                            header: t('list.coverage'),
                            cell: ({ row }) => (
                                row.original.coverageError ? (
                                    <Tooltip content={t('list.coverageError')}>
                                        <span className="text-xs text-content-subtle underline decoration-dotted">
                                            {t('list.coverageUnknownShort')}
                                        </span>
                                    </Tooltip>
                                ) : (
                                    <span className="tabular-nums text-xs text-content-default">
                                        {row.original.coveragePercent}%
                                    </span>
                                )
                            ),
                        },
                        {
                            id: 'status',
                            header: t('list.status'),
                            cell: ({ row }) =>
                                row.original.isInstalled ? (
                                    <StatusBadge variant="success">{t('list.installed')}</StatusBadge>
                                ) : (
                                    <StatusBadge variant="warning">{t('list.available')}</StatusBadge>
                                ),
                        },
                    ])}
                />
            )}

            {rows.length === 0 && (
                <div className={cn(cardVariants({ density: 'none' }), 'text-center py-12')}>
                    <p className="text-content-subtle">
                        {t('list.empty')}
                    </p>
                </div>
            )}

            {/* B8 — Custom-framework explainer modal. Documents the
                today-answer (import from catalogue + customise per-
                requirement after install) and the planned future
                (full tenant-scoped frameworks). Pure UX surface — no
                schema change behind it yet. */}
            <Modal
                showModal={customFwModalOpen}
                setShowModal={setCustomFwModalOpen}
                size="md"
                title={t('list.customTitle')}
                description={t('list.customDescription')}
            >
                <Modal.Header
                    title={t('list.customTitle')}
                    description={t('list.customDescription')}
                />
                <Modal.Body>
                    <div className="space-y-default text-sm text-content-default">
                        <p>
                            {t.rich('list.customToday', {
                                b: (c) => <strong>{c}</strong>,
                                em: (c) => <em>{c}</em>,
                            })}
                        </p>
                        <p>
                            {t.rich('list.customComingSoon', {
                                b: (c) => <strong>{c}</strong>,
                            })}
                        </p>
                    </div>
                </Modal.Body>
                <Modal.Actions>
                    <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => setCustomFwModalOpen(false)}
                    >
                        {t('list.close')}
                    </Button>
                    {importHref && (
                        <Link href={importHref}>
                            <Button
                                variant="primary"
                                size="sm"
                                onClick={() => setCustomFwModalOpen(false)}
                            >
                                {t('list.importFramework')}
                            </Button>
                        </Link>
                    )}
                </Modal.Actions>
            </Modal>
        </div>
    );
}

export default FrameworksClient;
