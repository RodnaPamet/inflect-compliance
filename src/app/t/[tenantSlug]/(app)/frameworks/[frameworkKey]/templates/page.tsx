'use client';
/* eslint-disable react-hooks/exhaustive-deps -- Various useEffect/useMemo dep arrays in this file deliberately omit identity-unstable callbacks (handlers recreated each render) or use selector functions whose change-detection happens elsewhere. Adding the deps would either trigger unnecessary re-runs OR cause infinite render loops; the proper structural fix is to wrap parent-level callbacks in useCallback. Tracked as follow-up. */
import { useState, useEffect, useCallback, useMemo } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { isControlCategoryTheme } from '@/lib/controls/control-categories';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { BackAffordance } from '@/components/nav/BackAffordance';
import { StatusBadge } from '@/components/ui/status-badge';
import { Heading, Eyebrow } from '@/components/ui/typography';
import { cardVariants } from '@/components/ui/card';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Input } from '@/components/ui/input';
import { frameworkTemplateRefusal } from '@/lib/framework-template-refusals';
import { planLimitRefusalOf } from '@/lib/billing/plan-limit-message';
import { apiErrorMessage } from '@/lib/api-error';
import { usePermissions } from '@/lib/tenant-context-provider';
import { cn } from '@inflect/ui/lib/cn';
import { useIsBelowMd } from '@/components/ui/hooks';
import {
    TemplateInstallDock,
    TemplateSelectBox,
    TemplateShowMore,
    useProgressiveCount,
} from '@/components/controls-shared/template-library-phone';

// getFramework (framework/catalog.ts) — only the name is read here.
interface FrameworkSummary {
    id: string;
    key: string;
    name: string;
    version: string | null;
}

/** The `ControlFrequency` enum, worded from `templates.frequency.*` (#4735). */
type ControlFrequency = 'AD_HOC' | 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'QUARTERLY' | 'ANNUALLY';

// listTemplates catalog row (catalog.ts return shape).
interface TemplateRequirement {
    code: string;
    title: string;
    section: string | null;
    framework: { key: string; name: string };
}
interface TemplateTask {
    id: string;
    title: string;
    description: string | null;
    /** The proof artefact the task produces, as authored in the catalogue. */
    evidenceHint: string | null;
}
interface CatalogTemplate {
    id: string;
    code: string;
    title: string;
    description: string | null;
    category: string | null;
    defaultFrequency: ControlFrequency | null;
    isGlobal: boolean;
    installed: boolean;
    tasks: TemplateTask[];
    requirements: TemplateRequirement[];
    packs: { key: string; name: string }[];
}

export default function TemplateLibraryPage() {
    const tx = useTranslations('frameworks');
    const tControls = useTranslations('controls');
    // An ISO 27002 theme constant (`TECHNOLOGICAL`) reads as its label; any
    // other category is already prose and passes through.
    const categoryLabel = useCallback(
        (c: string) => (isControlCategoryTheme(c) ? tControls(`categoryLabels.${c}`) : c),
        [tControls],
    );
    const params = useParams();
    const searchParams = useSearchParams();
    const tenantSlug = params.tenantSlug as string;
    const frameworkKey = params.frameworkKey as string;
    const apiUrl = useCallback((path: string) => `/api/t/${tenantSlug}${path}`, [tenantSlug]);
    // #4125 — both install actions call `assertCanInstallFrameworkPack`,
    // which reads `frameworks.install`. Without it no install control is
    // offered: the buttons used to render for every role and fail silently.
    const canInstall = usePermissions().frameworks.install;

    // #4735 — the whole library is read once, and the category, section and
    // name filters apply on the page. The server-filtered list used to be
    // the source of the filters' own options, so choosing a category left
    // only that category to choose, and there was no way to search by name.
    const [allTemplates, setAllTemplates] = useState<CatalogTemplate[]>([]);
    const [framework, setFramework] = useState<FrameworkSummary | null>(null);
    const [loadState, setLoadState] = useState<'loading' | 'ready' | 'failed'>('loading');
    const [loadAttempt, setLoadAttempt] = useState(0);
    // Live search over code and title, as the controls template library
    // does; a `?search=` in the address seeds it.
    const [search, setSearch] = useState(() => searchParams.get('search') ?? '');
    const [category, setCategory] = useState('');
    const [section, setSection] = useState('');
    const [installing, setInstalling] = useState<string | null>(null);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [bulkInstalling, setBulkInstalling] = useState(false);
    const [expandedTemplate, setExpandedTemplate] = useState<string | null>(null);
    const [installError, setInstallError] = useState<string | null>(null);

    /** The whole library; throws on a refused or failed read. */
    const fetchTemplates = useCallback(async () => {
        const res = await fetch(apiUrl(`/frameworks/${frameworkKey}?action=templates`));
        if (!res.ok) throw new Error(`templates ${res.status}`);
        setAllTemplates(await res.json());
    }, [apiUrl, frameworkKey]);

    useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                // The framework's name only titles the page: a failed read
                // of it leaves the generic title, never "Template Library — ".
                const fwRes = await fetch(apiUrl(`/frameworks/${frameworkKey}`)).catch(() => null);
                if (!cancelled && fwRes?.ok) setFramework(await fwRes.json());
                await fetchTemplates();
                if (!cancelled) setLoadState('ready');
            } catch {
                // #4735 — a failed read used to show "No templates match
                // your filters." It says what it is, with a retry.
                if (!cancelled) setLoadState('failed');
            }
        })();
        return () => { cancelled = true; };
    }, [apiUrl, frameworkKey, fetchTemplates, loadAttempt]);

    const retryLoad = () => {
        setLoadState('loading');
        setLoadAttempt((n) => n + 1);
    };

    /**
     * A refused install: a named refusal in the reader's language (#4735);
     * the plan limit, asked before the role note because it is a 403 too and
     * an Owner was told only an Owner or Admin could install (#5764); the
     * role note for any other 403; else the server's own reason. A 5xx, or a
     * refusal with no reason, gets the generic sentence.
     */
    const installFailure = async (res: Response) => {
        const body: unknown = await res.json().catch(() => null);
        const code = frameworkTemplateRefusal(body);
        if (code) return tx(`templates.refused.${code}`);
        const planLimit = planLimitRefusalOf(body);
        if (planLimit) {
            return tx('templates.planLimitReached', { limit: planLimit.limit, current: planLimit.current });
        }
        if (res.status === 403) return tx('templates.installRestricted');
        const fallback = tx('templates.installFailed');
        return res.status >= 500 ? fallback : apiErrorMessage(body, fallback);
    };

    // Both installs check `res.ok` and show the server's own message. They
    // used to ignore the response and swallow every error, so a refused
    // install did nothing visible — and the bulk one cleared the selection
    // as if it had worked. A failed bulk install now keeps the selection.
    const installTemplate = async (code: string) => {
        setInstalling(code);
        setInstallError(null);
        try {
            const res = await fetch(apiUrl(`/frameworks/${frameworkKey}?action=install-template`), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ templateCode: code }),
            });
            if (!res.ok) {
                setInstallError(await installFailure(res));
                return;
            }
            await fetchTemplates();
        } catch {
            setInstallError(tx('templates.installFailed'));
        } finally {
            setInstalling(null);
        }
    };

    const bulkInstall = async () => {
        if (selected.size === 0) return;
        setBulkInstalling(true);
        setInstallError(null);
        try {
            const res = await fetch(apiUrl(`/frameworks/${frameworkKey}?action=bulk-install`), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ templateCodes: Array.from(selected) }),
            });
            if (!res.ok) {
                setInstallError(await installFailure(res));
                return;
            }
            setSelected(new Set());
            await fetchTemplates();
        } catch {
            setInstallError(tx('templates.installFailed'));
        } finally {
            setBulkInstalling(false);
        }
    };

    const toggleSelect = (code: string) => {
        const next = new Set(selected);
        next.has(code) ? next.delete(code) : next.add(code);
        setSelected(next);
    };


    // The options come from the WHOLE library, so each filter keeps every
    // choice whatever the other is set to.
    const categories = useMemo(
        () => [...new Set(allTemplates.map(t => t.category).filter(Boolean))].sort(),
        [allTemplates],
    );
    const sections = useMemo(
        () => [...new Set(allTemplates.flatMap(t => t.requirements.map((r) => r.section)).filter(Boolean))].sort(),
        [allTemplates],
    );
    const templates = useMemo(() => {
        const q = search.trim().toLowerCase();
        return allTemplates.filter((t) =>
            (!category || t.category === category) &&
            (!section || t.requirements.some((r) => r.section === section)) &&
            (!q || t.code.toLowerCase().includes(q) || t.title.toLowerCase().includes(q)),
        );
    }, [allTemplates, category, section, search]);
    const installed = templates.filter(t => t.installed).length;
    const available = templates.filter(t => !t.installed).length;

    /** Select the uninstalled templates the filters show. */
    const selectAll = () => {
        const uninstalled = templates.filter(t => !t.installed).map(t => t.code);
        setSelected(new Set(uninstalled));
    };

    const categoryOptions = useMemo<ComboboxOption[]>(
        () => [
            { value: '', label: tx('templates.allCategories') },
            ...categories.map((c) => ({ value: c as string, label: categoryLabel(c as string) })),
        ],
        [categories, categoryLabel],
    );
    const sectionOptions = useMemo<ComboboxOption[]>(
        () => [
            { value: '', label: tx('templates.allSections') },
            // A section stored as an ISO 27002 theme constant reads as its label too.
            ...sections.map((s) => ({ value: s as string, label: categoryLabel(s as string) })),
        ],
        [sections, categoryLabel],
    );

    // Below `md` (Mobile 4.3): one page of cards at a time, a real 24px
    // checkbox with a 44px tap, titles that wrap, and the bulk install pinned
    // to the bottom of the screen. `false` on the server and the first
    // render, so a larger screen renders exactly what it did.
    const belowMd = useIsBelowMd();
    const phone = useProgressiveCount(`${search.trim().toLowerCase()}|${category}|${section}`);
    const shownTemplates = belowMd ? templates.slice(0, phone.count) : templates;
    // On a phone the install is tapped in the bottom bar or on a card far
    // below the notice; bring a refusal into view.
    useEffect(() => {
        if (belowMd && installError) {
            document.getElementById('template-install-error')?.scrollIntoView?.({ block: 'center' });
        }
    }, [belowMd, installError]);

    if (loadState === 'loading') return <div className="p-8 animate-pulse text-content-muted">{tx('templates.loading')}</div>;
    if (loadState === 'failed') {
        return (
            <div className="space-y-section">
                <BackAffordance />
                <InlineNotice variant="error" id="template-load-failed">{tx('templates.loadFailed')}</InlineNotice>
                <Button variant="secondary" onClick={retryLoad} id="template-load-retry">{tx('templates.retry')}</Button>
            </div>
        );
    }

    return (
        <div className="space-y-section animate-fadeIn">
            <BackAffordance />
            {/* Header */}
            <div className="flex items-center justify-between">
                <div>
                    <Heading level={1} className="mt-2" id="template-library-heading">
                        {framework ? tx('templates.heading', { name: framework.name }) : tx('templates.headingFallback')}
                    </Heading>
                    <div className="flex gap-compact mt-1 text-xs text-content-subtle">
                        <span>{tx('templates.templatesCount', { count: templates.length })}</span>
                        <span className="text-content-success">{tx('templates.installedCount', { count: installed })}</span>
                        <span className="text-[var(--brand-default)]">{tx('templates.availableCount', { count: available })}</span>
                    </div>
                </div>
                {canInstall && selected.size > 0 && (
                    <Button
                        variant="primary"
                        onClick={bulkInstall}
                        disabled={bulkInstalling}
                        id="bulk-install-btn"
                        className="max-md:hidden"
                    >
                        {bulkInstalling ? tx('templates.installing') : tx('templates.installNSelected', { count: selected.size })}
                    </Button>
                )}
            </div>

            {/* Filters — live search by code or title (#4735), then category
                and section. */}
            <div className="flex flex-wrap gap-compact items-center" id="template-filters">
                <div className="w-full sm:w-56">
                    <Input
                        id="template-search"
                        size="sm"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder={tx('templates.searchPlaceholder')}
                        aria-label={tx('templates.searchPlaceholder')}
                    />
                </div>
                <Combobox
                    id="filter-category"
                    options={categoryOptions}
                    selected={categoryOptions.find(o => o.value === category) ?? categoryOptions[0]}
                    setSelected={(opt) => setCategory(opt?.value ?? '')}
                    placeholder={tx('templates.allCategories')}
                    searchPlaceholder={tx('templates.searchCategories')}
                    matchTriggerWidth
                    buttonProps={{ className: 'w-40' }}
                    caret
                />
                <Combobox
                    id="filter-section"
                    options={sectionOptions}
                    selected={sectionOptions.find(o => o.value === section) ?? sectionOptions[0]}
                    setSelected={(opt) => setSection(opt?.value ?? '')}
                    placeholder={tx('templates.allSections')}
                    searchPlaceholder={tx('templates.searchSections')}
                    matchTriggerWidth
                    buttonProps={{ className: 'w-48' }}
                    caret
                />
                {canInstall && (
                    <Button variant="secondary" size="xs" onClick={selectAll} id="select-all-btn">{tx('templates.selectAllUninstalled')}</Button>
                )}
            </div>

            {installError && (
                <InlineNotice variant="error" onDismiss={() => setInstallError(null)} id="template-install-error">
                    {installError}
                </InlineNotice>
            )}

            {/* Template cards */}
            <div className="space-y-compact" id="template-list">
                {shownTemplates.map(t => {
                    const isExpanded = expandedTemplate === t.code;
                    const isSelected = selected.has(t.code);
                    // The template's own authored evidence, one line per
                    // distinct hint across its tasks. Replaces a hardcoded
                    // DOCUMENT / SCREENSHOT / LOG shown for every template.
                    const evidenceHints = [
                        ...new Set(
                            t.tasks
                                .map((task) => task.evidenceHint?.trim())
                                .filter((hint): hint is string => Boolean(hint)),
                        ),
                    ];

                    return (
                        <div key={t.code} className={cn(cardVariants({ density: 'none' }), 'transition-colors', isSelected ? 'ring-1 ring-[var(--ring)]/50' : '')} id={`template-${t.code}`}>
                            <div className="flex items-start gap-compact">
                                {/* Checkbox */}
                                {canInstall && !t.installed && (belowMd ? (
                                    <TemplateSelectBox
                                        id={`template-select-${t.code}`}
                                        checked={isSelected}
                                        onCheckedChange={() => toggleSelect(t.code)}
                                        label={tx('templates.selectTemplateAria', { code: t.code, title: t.title })}
                                    />
                                ) : (
                                    <Checkbox
                                        checked={isSelected}
                                        aria-label={tx('templates.selectTemplateAria', { code: t.code, title: t.title })}
                                        onCheckedChange={() => toggleSelect(t.code)}
                                        className="mt-0.5"
                                    />
                                ))}

                                {/* Main */}
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-tight">
                                        <button
                                            onClick={() => setExpandedTemplate(isExpanded ? null : t.code)}
                                            className="text-left flex-1 min-w-0"
                                        >
                                            {/* Below `md` the title takes a line of its own and
                                                wraps; the code never breaks mid-token. */}
                                            <div className="flex items-center gap-tight max-md:flex-wrap">
                                                <code className="text-xs text-[var(--brand-default)] font-mono whitespace-nowrap">{t.code}</code>
                                                <span className="text-sm font-medium text-content-emphasis md:truncate max-md:order-last max-md:basis-full max-md:break-words" data-testid="template-title">{t.title}</span>
                                                {t.installed ? (
                                                    <StatusBadge variant="success" className="flex-shrink-0">{tx('templates.installed')}</StatusBadge>
                                                ) : (
                                                    <StatusBadge variant="info" className="flex-shrink-0">{tx('templates.available')}</StatusBadge>
                                                )}
                                            </div>
                                        </button>
                                        {/* A row action, so secondary (the R7-PR1 rule): every
                                            uninstalled template renders one. */}
                                        {canInstall && !t.installed && (
                                            <Button
                                                variant="secondary"
                                                size="xs"
                                                onClick={() => installTemplate(t.code)}
                                                disabled={installing === t.code}
                                                className="flex-shrink-0"
                                            >
                                                {installing === t.code ? tx('templates.installing') : tx('templates.install')}
                                            </Button>
                                        )}
                                    </div>

                                    {/* Badges row */}
                                    <div className="flex flex-wrap gap-1.5 mt-1">
                                        {t.category && <span className="text-xs text-content-subtle bg-bg-default px-2 py-0.5 rounded">{categoryLabel(t.category)}</span>}
                                        {t.defaultFrequency && <span className="text-xs text-content-subtle bg-bg-default px-2 py-0.5 rounded">{tx(`templates.frequency.${t.defaultFrequency}`)}</span>}
                                        <span className="text-xs text-content-subtle">{tx('templates.tasksCount', { count: t.tasks.length })}</span>
                                        <span className="text-xs text-content-subtle">{tx('templates.requirementsCount', { count: t.requirements.length })}</span>
                                    </div>

                                    {/* Expanded detail */}
                                    {isExpanded && (
                                        <div className="mt-3 space-y-compact border-t border-border-default/30 pt-3">
                                            {t.description && (
                                                <p className="text-sm text-content-muted">{t.description}</p>
                                            )}

                                            {/* Requirements */}
                                            <div>
                                                <Eyebrow>{tx('templates.mappedRequirements')}</Eyebrow>
                                                <div className="space-y-1">
                                                    {t.requirements.map((r, i: number) => (
                                                        <div key={i} className="flex items-center gap-tight text-xs">
                                                            <code className="text-[var(--brand-default)] font-mono">{r.code}</code>
                                                            <span className="text-content-muted">{r.title}</span>
                                                            <span className="text-content-subtle">({r.framework.name})</span>
                                                        </div>
                                                    ))}
                                                </div>
                                            </div>

                                            {/* Tasks */}
                                            <div>
                                                <Eyebrow>{tx('templates.defaultTasks')}</Eyebrow>
                                                <div className="space-y-1">
                                                    {t.tasks.map((task, i: number) => (
                                                        <div key={i} className="flex items-center gap-tight text-xs">
                                                            <span className="w-1.5 h-1.5 rounded-full bg-border-emphasis" />
                                                            <span className="text-content-default">{task.title}</span>
                                                        </div>
                                                    ))}
                                                </div>
                                            </div>

                                            {/* Suggested evidence — only when the template's
                                                tasks name some. */}
                                            {evidenceHints.length > 0 && (
                                                <div data-testid={`suggested-evidence-${t.code}`}>
                                                    <Eyebrow>{tx('templates.suggestedEvidence')}</Eyebrow>
                                                    <div className="space-y-1">
                                                        {evidenceHints.map((hint) => (
                                                            <div key={hint} className="flex items-center gap-tight text-xs">
                                                                <span className="w-1.5 h-1.5 rounded-full bg-border-emphasis" />
                                                                <span className="text-content-default">{hint}</span>
                                                            </div>
                                                        ))}
                                                    </div>
                                                </div>
                                            )}
                                        </div>
                                    )}
                                </div>
                            </div>
                        </div>
                    );
                })}

                {templates.length === 0 && (
                    <div className={cn(cardVariants({ density: 'none' }), 'text-center py-8 text-content-subtle')}>{tx('templates.emptyFilter')}</div>
                )}
                {shownTemplates.length < templates.length && (
                    <TemplateShowMore
                        id="template-phone-more"
                        onClick={phone.showMore}
                        label={tx('templates.phone.showMore', { remaining: templates.length - shownTemplates.length })}
                    />
                )}
            </div>

            {canInstall && allTemplates.some((tpl) => !tpl.installed) && (
                <TemplateInstallDock
                    id="template-phone-install"
                    installLabel={bulkInstalling ? tx('templates.installing') : tx('templates.installNSelected', { count: selected.size })}
                    onInstall={bulkInstall}
                    disabled={selected.size === 0 || bulkInstalling}
                    clearLabel={selected.size > 0 ? tx('templates.phone.clearSelection') : undefined}
                    onClear={() => setSelected(new Set())}
                />
            )}
        </div>
    );
}
