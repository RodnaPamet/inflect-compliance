'use client';
import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { RequirePermission } from '@/components/require-permission';
import { ProgressBar } from '@/components/ui/progress-bar';
import { FrameworkExplorer } from '@/components/frameworks/FrameworkExplorer';
import { FrameworkBuilder } from '@/components/ui/FrameworkBuilder';
import { InheritedCoveragePanel } from '@/components/frameworks/InheritedCoveragePanel';
import { buttonVariants } from '@/components/ui/button-variants';
import { useCelebration, useToast, useToastWithUndo } from '@/components/ui/hooks';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/ui/status-badge';
import { celebrationDedupe, MILESTONES, scopedMilestone } from '@/lib/celebrations';
import type { FrameworkTreePayload } from '@/lib/framework-tree/types';
import { Heading, Caption } from '@/components/ui/typography';
import { KPIStat } from '@/components/ui/metric';
import { MetaStrip } from '@/components/ui/meta-strip';
import { EntityDetailLayout } from '@/components/layout/EntityDetailLayout';
import { cardVariants } from '@/components/ui/card';
import { cn } from '@inflect/ui/lib/cn';
import { useEntityListIds } from '@/lib/hooks/use-entity-list-ids';
import { CACHE_KEYS } from '@/lib/swr-keys';
import { frameworkOrderKey } from '../framework-order';
import { apiErrorMessage } from '@/lib/api-error';
import { InlineNotice } from '@/components/ui/inline-notice';
import { frameworkKindLabel } from '../framework-kind-label';

type Tab = 'requirements' | 'packs' | 'coverage' | 'builder';

// framework → getFramework (framework/catalog.ts)
// coverage  → computeCoverage (framework/coverage.ts) — a superset of the
//             narrow CoveragePayload that <FrameworkExplorer> consumes.
interface FrameworkDetail {
    id: string;
    key: string;
    name: string;
    version: string | null;
    description: string | null;
    kind: string;
    _count: { requirements: number; packs: number };
}
interface FrameworkCoverageSection {
    section: string;
    total: number;
    mapped: number;
    coveragePercent: number;
}
interface FrameworkCoverageUnmapped {
    code: string;
    title: string;
    section: string | null;
}
interface FrameworkCoverage {
    framework: { key: string; name: string; version: string | null };
    total: number;
    mapped: number;
    unmapped: number;
    coveragePercent: number;
    bySection: FrameworkCoverageSection[];
    unmappedRequirements: FrameworkCoverageUnmapped[];
    /** Requirements of packs this workspace did not install — never counted above. */
    outOfScope?: number;
    outOfScopeRequirements?: FrameworkCoverageUnmapped[];
    controlMappings: {
        requirementCode: string;
        requirementTitle: string;
        controlCode: string;
        controlName: string;
        controlStatus: string;
    }[];
}

// Pack summary — listFrameworkPacks (FrameworkPack + _count).
interface FrameworkPackSummary {
    id: string;
    key: string;
    name: string;
    description: string | null;
    version: string | null;
    _count: { templateLinks: number };
    /** This workspace installed it: in scope for a multi-pack framework (#4372). */
    chosen?: boolean;
}

export default function FrameworkDetailPage() {
    const t = useTranslations('frameworks');
    const params = useParams();
    const tenantSlug = params.tenantSlug as string;
    const frameworkKey = params.frameworkKey as string;
    const apiUrl = useCallback((path: string) => `/api/t/${tenantSlug}${path}`, [tenantSlug]);
    const tenantHref = useCallback((path: string) => `/t/${tenantSlug}${path}`, [tenantSlug]);

    const [activeTab, setActiveTab] = useState<Tab>('requirements');
    const [framework, setFramework] = useState<FrameworkDetail | null>(null);
    const [tree, setTree] = useState<FrameworkTreePayload | null>(null);
    const [packs, setPacks] = useState<FrameworkPackSummary[]>([]);
    const [coverage, setCoverage] = useState<FrameworkCoverage | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    // #4694 — which of the tab reads failed. A failed read used to look like
    // an empty answer: a blank Coverage tab, "No packs", or "Loading tree…"
    // for good.
    const [failed, setFailed] = useState({ tree: false, packs: false, coverage: false });
    const toast = useToast();
    const triggerUndoToast = useToastWithUndo();

    // #98 — ordered framework SLUGS for the prev/next stepper beside the name.
    // The list page publishes the order it rendered; `frameworkOrderKey` is the
    // extractor both sides share, because this route is keyed by
    // `Framework.key` rather than `Framework.id`. Nothing published (a deep
    // link straight here) falls back to the frameworks list endpoint, which
    // returns the same order the list page renders server-side.
    const frameworkKeys = useEntityListIds<{ key: string }>(
        CACHE_KEYS.frameworks.list(),
        { getId: frameworkOrderKey },
    );

    // Epic 62 — celebrate when this framework hits 100% coverage.
    // `scopedMilestone` namespaces the dedupe key per framework so
    // each framework's first reach earns its own moment in the same
    // session (otherwise a single global `framework-100` key would
    // mean only the first framework ever celebrates).
    const { celebrate } = useCelebration(celebrationDedupe);
    useEffect(() => {
        if (coverage?.coveragePercent !== 100) return;
        const baseDescription = MILESTONES['framework-100'].description ?? '';
        celebrate(
            scopedMilestone('framework-100', frameworkKey, {
                descriptionOverride: framework?.name
                    ? `${framework.name} — ${baseDescription}`.trim()
                    : undefined,
            }),
        );
    }, [coverage?.coveragePercent, frameworkKey, framework?.name, celebrate]);

    useEffect(() => {
        // Epic 46 — fetch the new `/tree` endpoint instead of the
        // flat `?action=requirements` payload. The tree endpoint
        // already includes the `framework` descriptor, so the
        // separate `getFramework` call only stays around to keep the
        // header rendering identical (it carries no data the tree
        // doesn't, but `<FrameworkExplorer>` shouldn't be the source
        // of truth for the page title).
        void (async () => {
            setError(null);
            try {
                const [fwRes, treeRes, packRes, covRes] = await Promise.all([
                    fetch(apiUrl(`/frameworks/${frameworkKey}`)),
                    fetch(apiUrl(`/frameworks/${frameworkKey}/tree`)),
                    fetch(apiUrl(`/frameworks/${frameworkKey}?action=packs`)),
                    fetch(apiUrl(`/frameworks/${frameworkKey}?action=coverage`)),
                ]);
                if (fwRes.ok) setFramework(await fwRes.json());
                if (treeRes.ok) setTree((await treeRes.json()) as FrameworkTreePayload);
                else if (treeRes.status === 404) setError(t('detail.notFound'));
                if (packRes.ok) setPacks(await packRes.json());
                if (covRes.ok) setCoverage(await covRes.json());
                setFailed({
                    tree: !treeRes.ok && treeRes.status !== 404,
                    packs: !packRes.ok,
                    coverage: !covRes.ok,
                });
            } catch {
                setError(t('detail.loadFailed'));
            }
            setLoading(false);
        })();
    }, [apiUrl, frameworkKey, t]);

    // After the chosen packs change, the scope does too: the packs, the
    // requirements tree and the coverage all reread it.
    const refreshScope = useCallback(async () => {
        const [treeRes, packRes, covRes] = await Promise.all([
            fetch(apiUrl(`/frameworks/${frameworkKey}/tree`)),
            fetch(apiUrl(`/frameworks/${frameworkKey}?action=packs`)),
            fetch(apiUrl(`/frameworks/${frameworkKey}?action=coverage`)),
        ]);
        if (treeRes.ok) setTree((await treeRes.json()) as FrameworkTreePayload);
        if (packRes.ok) setPacks(await packRes.json());
        if (covRes.ok) setCoverage(await covRes.json());
        setFailed({ tree: !treeRes.ok, packs: !packRes.ok, coverage: !covRes.ok });
    }, [apiUrl, frameworkKey]);

    // A failed tab read, with a way to read it again.
    const loadFailedNotice = (message: string, id: string) => (
        <InlineNotice variant="error" id={id}>
            <span>{message}</span>{' '}
            <Button variant="ghost" size="sm" onClick={() => void refreshScope()} id={`${id}-retry`}>
                {t('detail.retry')}
            </Button>
        </InlineNotice>
    );

    // #4372 — take a chosen pack out of scope. Its controls stay; only its
    // requirements stop counting. The POST goes out when the undo window
    // closes, so Undo sends nothing.
    function removePack(pack: FrameworkPackSummary) {
        const snapshot = packs;
        setPacks((current) => current.map((p) => (p.key === pack.key ? { ...p, chosen: false } : p)));
        triggerUndoToast({
            message: t('detail.packRemoved', { name: pack.name }),
            undoMessage: t('detail.undo'),
            action: async () => {
                const res = await fetch(apiUrl(`/frameworks/${frameworkKey}?action=remove-pack`), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ packKey: pack.key }),
                });
                if (!res.ok) {
                    const j: unknown = await res.json().catch(() => ({}));
                    throw new Error(apiErrorMessage(j, t('detail.packRemoveFailed')));
                }
                await refreshScope();
            },
            undoAction: () => setPacks(snapshot),
            onError: (e) => {
                setPacks(snapshot);
                toast.error(e instanceof Error && e.message ? e.message : t('detail.packRemoveFailed'));
            },
        });
    }

    const breadcrumbs = [
        { label: t('crumb.dashboard'), href: tenantHref('/dashboard') },
        { label: t('crumb.frameworks'), href: tenantHref('/frameworks') },
        { label: framework?.name ?? frameworkKey },
    ];
    if (loading) {
        return (
            <EntityDetailLayout loading title="" breadcrumbs={breadcrumbs}>
                <></>
            </EntityDetailLayout>
        );
    }
    if (error || !framework) {
        return (
            <EntityDetailLayout error={error ?? t('detail.notFound')} title="" breadcrumbs={breadcrumbs}>
                <></>
            </EntityDetailLayout>
        );
    }

    const chosenPackCount = packs.filter((p) => p.chosen).length;

    const tabs: { key: Tab; label: string; count?: number }[] = [
        { key: 'requirements', label: t('detail.reqTab'), count: tree?.totals.requirements },
        { key: 'packs', label: t('detail.packsTab'), count: packs.length },
        { key: 'coverage', label: t('detail.coverageTab') },
        // Epic 46.4 — builder MVP. Permission-gated below by
        // wrapping the panel in <RequirePermission>; the tab itself
        // stays visible so non-admins see it exists.
        { key: 'builder', label: t('detail.builderTab') },
    ];

    async function handleReorderSave(body: { sections: { sectionId: string; requirementIds: string[] }[] }) {
        const res = await fetch(apiUrl(`/frameworks/${frameworkKey}/reorder`), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            const j: unknown = await res.json().catch(() => ({}));
            throw new Error(apiErrorMessage(j, t('detail.reorderFailed')));
        }
        // Refetch the tree so the explorer reflects the new order.
        const fresh = await fetch(apiUrl(`/frameworks/${frameworkKey}/tree`));
        if (fresh.ok) setTree((await fresh.json()) as FrameworkTreePayload);
    }

    return (
        <EntityDetailLayout
            id="framework-detail-page"
            back={{ smart: true }}
            breadcrumbs={breadcrumbs}

            title={<span id="framework-detail-heading">{framework.name}</span>}
            prevNext={{
                ids: frameworkKeys,
                currentId: frameworkKey,
                hrefFor: (key) => tenantHref(`/frameworks/${key}`),
                labelSingular: 'framework',
            }}
            meta={
                <MetaStrip
                    items={[
                        ...(framework.version
                            ? [
                                  {
                                      kind: 'status' as const,
                                      label: t('detail.version'),
                                      value: `v${framework.version}`,
                                      variant: 'info' as const,
                                  },
                              ]
                            : []),
                        ...(framework.kind
                            ? [
                                  {
                                      label: t('detail.kind'),
                                      value: frameworkKindLabel(t, framework.kind) ?? framework.kind,
                                  } as const,
                              ]
                            : []),
                    ]}
                />
            }
            actions={
                <>
                    <Link href={tenantHref(`/frameworks/${frameworkKey}/templates`)} className={buttonVariants({ variant: 'secondary' })} id="browse-templates-cta">
                        {t('detail.browseTemplates')}
                    </Link>
                    {/* #4732 — the requirements diff had no way in but a typed URL. */}
                    <Link href={tenantHref(`/frameworks/${frameworkKey}/diff`)} className={buttonVariants({ variant: 'secondary' })} id="compare-requirements-cta">
                        {t('detail.compareRequirements')}
                    </Link>
                    <RequirePermission resource="frameworks" action="install">
                        <Link href={tenantHref(`/frameworks/${frameworkKey}/install`)} className={buttonVariants({ variant: 'primary' })} id="install-pack-cta">
                            {t('detail.installPack')}
                        </Link>
                    </RequirePermission>
                </>
            }
            tabs={tabs}
            activeTab={activeTab}
            onTabChange={(next) => setActiveTab(next as Tab)}
        >
            {framework.description && <Caption className="-mt-2">{framework.description}</Caption>}

            {/* Requirements Tab — Epic 46 tree explorer */}
            {activeTab === 'requirements' && (
                <div id="requirements-panel">
                    {tree ? (
                        <FrameworkExplorer tree={tree} coverage={coverage ?? null} />
                    ) : failed.tree ? (
                        loadFailedNotice(t('detail.treeLoadFailed'), 'framework-tree-load-failed')
                    ) : (
                        <div className={cn(cardVariants({ density: 'none' }), 'text-center py-10 text-content-subtle')}>
                            {t('detail.loadingTree')}
                        </div>
                    )}
                </div>
            )}

            {/* Packs Tab */}
            {activeTab === 'packs' && (
                <div className="space-y-default" id="packs-panel">
                    {packs.map((p) => (
                        <div key={p.id} className={cardVariants({ density: 'none' })}>
                            <div className="flex items-start justify-between">
                                <div>
                                    <Heading level={2}>{p.name}</Heading>
                                    {p.description && <p className="text-sm text-content-muted mt-1">{p.description}</p>}
                                    <div className="flex items-center gap-compact mt-2 text-xs text-content-subtle">
                                        <span>{t('detail.templatesCount', { count: p._count?.templateLinks || 0 })}</span>
                                        {p.version && <span>v{p.version}</span>}
                                        {/* Scope is per pack only when there are several. */}
                                        {packs.length > 1 && p.chosen && (
                                            <StatusBadge variant="success" size="sm">{t('detail.packChosen')}</StatusBadge>
                                        )}
                                    </div>
                                </div>
                                <RequirePermission resource="frameworks" action="install">
                                    <div className="flex items-center gap-compact">
                                        {packs.length > 1 && p.chosen && (
                                            <Button
                                                variant="secondary"
                                                id={`remove-pack-${p.key}`}
                                                onClick={() => removePack(p)}
                                                // The Button renders its disabled shell whenever it
                                                // is given a disabledTooltip, so it gets one only
                                                // for the last chosen pack.
                                                disabledTooltip={chosenPackCount <= 1 ? t('detail.packRemoveLast') : undefined}
                                            >
                                                {t('detail.removePack')}
                                            </Button>
                                        )}
                                        <Link
                                            href={tenantHref(`/frameworks/${frameworkKey}/install?pack=${p.key}`)}
                                            className={buttonVariants({ variant: 'primary' })}
                                            id={`install-pack-${p.key}`}
                                        >
                                            {t('detail.installPack')}
                                        </Link>
                                    </div>
                                </RequirePermission>
                            </div>
                        </div>
                    ))}
                    {failed.packs
                        ? loadFailedNotice(t('detail.packsLoadFailed'), 'framework-packs-load-failed')
                        : packs.length === 0 && (
                              <div className={cn(cardVariants({ density: 'none' }), 'text-center py-8 text-content-subtle')}>{t('detail.packsEmpty')}</div>
                          )}
                </div>
            )}

            {/* Coverage Tab */}
            {activeTab === 'coverage' && !coverage && failed.coverage &&
                loadFailedNotice(t('detail.coverageLoadFailed'), 'framework-coverage-load-failed')}
            {activeTab === 'coverage' && coverage && (
                <div className="space-y-default" id="coverage-panel">
                    {/* Summary cards — Polish PR-2: KPIStat primitive. */}
                    <div className={cn('grid grid-cols-1 gap-default', coverage.outOfScope ? 'md:grid-cols-4' : 'md:grid-cols-3')}>
                        <div className={cardVariants({ density: 'none' })}>
                            <KPIStat value={coverage.total} label={t('detail.totalRequirements')} />
                        </div>
                        <div className={cardVariants({ density: 'none' })}>
                            <KPIStat value={coverage.mapped} label={t('detail.mapped')} tone="success" />
                        </div>
                        <div className={cardVariants({ density: 'none' })}>
                            <KPIStat
                                value={coverage.unmapped}
                                label={t('detail.unmapped')}
                                tone={coverage.unmapped > 0 ? 'attention' : 'success'}
                            />
                        </div>
                        {!!coverage.outOfScope && (
                            <div className={cardVariants({ density: 'none' })}>
                                <KPIStat value={coverage.outOfScope} label={t('detail.outOfScope')} />
                            </div>
                        )}
                    </div>

                    {/* Coverage donut */}
                    <div className={cardVariants({ density: 'none' })}>
                        <div className="flex items-center justify-between mb-4">
                            <Heading level={2}>{t('detail.overallCoverage')}</Heading>
                            <span className={`text-xl font-semibold tabular-nums ${coverage.coveragePercent === 100 ? 'text-content-success' : 'text-[var(--brand-default)]'}`}>
                                {coverage.coveragePercent}%
                            </span>
                        </div>
                        <ProgressBar
                            value={coverage.coveragePercent}
                            size="sm"
                            variant={coverage.coveragePercent === 100 ? 'success' : 'brand'}
                            aria-label={t('detail.coverageAria')}
                        />
                    </div>

                    {/* Section breakdown */}
                    {coverage.bySection?.length > 0 && (
                        <div className={cardVariants({ density: 'none' })}>
                            <Heading level={3} className="mb-3">{t('detail.coverageBySection')}</Heading>
                            <div className="space-y-compact">
                                {coverage.bySection.map((s) => (
                                    <div key={s.section}>
                                        <div className="flex items-center justify-between text-xs mb-1">
                                            <span className="text-content-default">{s.section}</span>
                                            <span className="text-content-muted">{s.mapped}/{s.total} ({s.coveragePercent}%)</span>
                                        </div>
                                        <ProgressBar
                                            value={s.coveragePercent}
                                            size="sm"
                                            variant={
                                                s.coveragePercent === 100
                                                    ? 'success'
                                                    : s.coveragePercent > 0
                                                        ? 'brand'
                                                        : 'neutral'
                                            }
                                            aria-label={t('detail.sectionCoverageAria', { section: s.section })}
                                        />
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Unmapped requirements */}
                    {coverage.unmappedRequirements?.length > 0 && (
                        <div className={cardVariants({ density: 'none' })}>
                            <Heading level={3} className="text-content-warning mb-3">
                                {t('detail.unmappedRequirements', { count: coverage.unmappedRequirements.length })}
                            </Heading>
                            <div className="space-y-1 max-h-64 overflow-y-auto">
                                {coverage.unmappedRequirements.map((r, i: number) => (
                                    <div key={i} className="flex items-center gap-compact px-3 py-1.5 rounded-md hover:bg-bg-muted/50 text-sm">
                                        <span className="w-2 h-2 rounded-full bg-border-emphasis flex-shrink-0" />
                                        <code className="text-xs text-content-subtle font-mono w-16 sm:w-28 flex-shrink-0 truncate">{r.code}</code>
                                        <span className="text-content-muted">{r.title}</span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Requirements of packs the workspace did not choose.
                        Listed so nothing silently disappears, but they are not
                        gaps and the figures above leave them out. */}
                    {!!coverage.outOfScopeRequirements?.length && (
                        <div className={cardVariants({ density: 'none' })} id="out-of-scope-requirements">
                            <Heading level={3} className="mb-1">
                                {t('detail.outOfScopeRequirements', { count: coverage.outOfScopeRequirements.length })}
                            </Heading>
                            <p className="text-sm text-content-muted mb-3">{t('detail.outOfScopeHint')}</p>
                            <div className="space-y-1 max-h-64 overflow-y-auto">
                                {coverage.outOfScopeRequirements.map((r) => (
                                    <div key={r.code} className="flex items-center gap-compact px-3 py-1.5 rounded-md text-sm">
                                        <code className="text-xs text-content-subtle font-mono w-16 sm:w-28 flex-shrink-0 truncate">{r.code}</code>
                                        <span className="text-content-subtle">{r.title}</span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* What the tenant's controls on OTHER frameworks reach
                        here through a mapping. Fetched by the panel itself, so
                        a framework nobody opens the Coverage tab of costs
                        nothing; never added to the figures above. */}
                    <InheritedCoveragePanel tenantSlug={tenantSlug} frameworkKey={frameworkKey} />

                </div>
            )}

            {/* Builder Tab — Epic 46.4 MVP */}
            {activeTab === 'builder' && (
                <div id="builder-panel">
                    {tree ? (
                        <RequirePermission
                            resource="frameworks"
                            action="install"
                            fallback={
                                <div className={cn(cardVariants({ density: 'none' }), 'text-center py-10 text-content-subtle')}>
                                    {t('detail.reorderRestricted')}
                                </div>
                            }
                        >
                            <FrameworkBuilder tree={tree} onSave={handleReorderSave} />
                        </RequirePermission>
                    ) : (
                        <div className={cn(cardVariants({ density: 'none' }), 'text-center py-10 text-content-subtle')}>
                            {t('detail.loadingTree')}
                        </div>
                    )}
                </div>
            )}
        </EntityDetailLayout>
    );
}
