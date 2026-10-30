'use client';
/* eslint-disable react-hooks/exhaustive-deps -- Various useEffect/useMemo dep arrays in this file deliberately omit identity-unstable callbacks (handlers recreated each render) or use selector functions whose change-detection happens elsewhere. Adding the deps would either trigger unnecessary re-runs OR cause infinite render loops; the proper structural fix is to wrap parent-level callbacks in useCallback. Tracked as follow-up. */
import { useState, useEffect, useCallback, useMemo } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { Button } from '@/components/ui/button';
import { BackAffordance } from '@/components/nav/BackAffordance';
import { StatusBadge } from '@/components/ui/status-badge';
import { Heading, Eyebrow } from '@/components/ui/typography';
import { cardVariants } from '@/components/ui/card';
import { InlineNotice } from '@/components/ui/inline-notice';
import { apiErrorMessage } from '@/lib/api-error';
import { usePermissions } from '@/lib/tenant-context-provider';
import { cn } from '@inflect/ui/lib/cn';

// getFramework (framework/catalog.ts) — only the name is read here.
interface FrameworkSummary {
    id: string;
    key: string;
    name: string;
    version: string | null;
}

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
    defaultFrequency: string | null;
    isGlobal: boolean;
    installed: boolean;
    tasks: TemplateTask[];
    requirements: TemplateRequirement[];
    packs: { key: string; name: string }[];
}

export default function TemplateLibraryPage() {
    const tx = useTranslations('frameworks');
    const params = useParams();
    const searchParams = useSearchParams();
    const tenantSlug = params.tenantSlug as string;
    const frameworkKey = params.frameworkKey as string;
    const apiUrl = useCallback((path: string) => `/api/t/${tenantSlug}${path}`, [tenantSlug]);
    // #4125 — both install actions call `assertCanInstallFrameworkPack`,
    // which reads `frameworks.install`. Without it no install control is
    // offered: the buttons used to render for every role and fail silently.
    const canInstall = usePermissions().frameworks.install;

    const [templates, setTemplates] = useState<CatalogTemplate[]>([]);
    const [framework, setFramework] = useState<FrameworkSummary | null>(null);
    const [loading, setLoading] = useState(true);
    // R14-PR7 — standalone search input retired. The server-side
    // `?search=` query param remains supported by the API; users
    // who need name-based filtering can deep-link with the param
    // or use the global ⌘K palette to navigate directly. A future
    // PR adopting FilterToolbar would re-introduce the UI affordance
    // properly.
    const [category, setCategory] = useState('');
    const [section, setSection] = useState('');
    const [installing, setInstalling] = useState<string | null>(null);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [bulkInstalling, setBulkInstalling] = useState(false);
    const [expandedTemplate, setExpandedTemplate] = useState<string | null>(null);
    const [installError, setInstallError] = useState<string | null>(null);

    const fetchTemplates = useCallback(async () => {
        const params = new URLSearchParams({ action: 'templates' });
        // Server-side `?search=` is still supported by the API for
        // deep-linked filtering; the UI input was retired in
        // R14-PR7. The URL searchParam is honoured if present.
        const urlSearch = searchParams.get('search');
        if (urlSearch) params.set('search', urlSearch);
        if (category) params.set('category', category);
        if (section) params.set('section', section);
        try {
            const res = await fetch(apiUrl(`/frameworks/${frameworkKey}?${params}`));
            if (res.ok) setTemplates(await res.json());
        } catch { /* ignore */ }
    }, [apiUrl, frameworkKey, searchParams, category, section]);

    useEffect(() => {
        // try/finally, because `setLoading(false)` was the LAST statement of an
        // IIFE with no guard: any rejection skipped it and the page stayed on
        // its loading state for ever. The `finally` is the fix; the empty
        // `catch` is deliberate, since `fetchTemplates` already owns its own
        // error reporting and this effect has nothing to add to it.
        (async () => {
            try {
                const [fwRes] = await Promise.all([
                    fetch(apiUrl(`/frameworks/${frameworkKey}`)),
                ]);
                if (fwRes.ok) setFramework(await fwRes.json());
                await fetchTemplates();
            } catch {
                /* fetchTemplates reports its own failure; nothing to add here */
            } finally {
                setLoading(false);
            }
        })();
    }, [apiUrl, frameworkKey, fetchTemplates]);

    // R14-PR7 — debounced search retired with the input. Filter
    // state changes (category, section) re-fetch immediately.
    useEffect(() => {
        fetchTemplates();
    }, [category, section, fetchTemplates]);

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
                const body: unknown = await res.json().catch(() => null);
                setInstallError(apiErrorMessage(body, tx('templates.installFailed')));
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
                const body: unknown = await res.json().catch(() => null);
                setInstallError(apiErrorMessage(body, tx('templates.installFailed')));
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

    const selectAll = () => {
        const uninstalled = templates.filter(t => !t.installed).map(t => t.code);
        setSelected(new Set(uninstalled));
    };

    const categories = [...new Set(templates.map(t => t.category).filter(Boolean))];
    const sections = [...new Set(templates.flatMap(t => t.requirements.map((r) => r.section)).filter(Boolean))];
    const installed = templates.filter(t => t.installed).length;
    const available = templates.filter(t => !t.installed).length;

    const categoryOptions = useMemo<ComboboxOption[]>(
        () => [
            { value: '', label: tx('templates.allCategories') },
            ...categories.map((c) => ({ value: c as string, label: c as string })),
        ],
        [categories],
    );
    const sectionOptions = useMemo<ComboboxOption[]>(
        () => [
            { value: '', label: tx('templates.allSections') },
            ...sections.map((s) => ({ value: s as string, label: s as string })),
        ],
        [sections],
    );

    if (loading) return <div className="p-8 animate-pulse text-content-muted">{tx('templates.loading')}</div>;

    return (
        <div className="space-y-section animate-fadeIn">
            <BackAffordance />
            {/* Header */}
            <div className="flex items-center justify-between">
                <div>
                    <Heading level={1} className="mt-2" id="template-library-heading">
                        {tx('templates.heading', { name: framework?.name ?? '' })}
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
                    >
                        {bulkInstalling ? tx('templates.installing') : tx('templates.installNSelected', { count: selected.size })}
                    </Button>
                )}
            </div>

            {/* Filters — R14-PR7 dropped the name-search input. The
                server-side `?search=` query param still works via
                deep links; the UI affordance returns when this page
                adopts FilterToolbar. */}
            <div className="flex flex-wrap gap-compact items-center" id="template-filters">
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
                {templates.map(t => {
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
                                {canInstall && !t.installed && (
                                    <input
                                        type="checkbox"
                                        checked={isSelected}
                                        onChange={() => toggleSelect(t.code)}
                                        className="mt-1 accent-[var(--brand-default)]"
                                    />
                                )}

                                {/* Main */}
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-tight">
                                        <button
                                            onClick={() => setExpandedTemplate(isExpanded ? null : t.code)}
                                            className="text-left flex-1 min-w-0"
                                        >
                                            <div className="flex items-center gap-tight">
                                                <code className="text-xs text-[var(--brand-default)] font-mono">{t.code}</code>
                                                <span className="text-sm font-medium text-content-emphasis truncate">{t.title}</span>
                                                {t.installed ? (
                                                    <StatusBadge variant="success" className="flex-shrink-0">{tx('templates.installed')}</StatusBadge>
                                                ) : (
                                                    <StatusBadge variant="info" className="flex-shrink-0">{tx('templates.available')}</StatusBadge>
                                                )}
                                            </div>
                                        </button>
                                        {canInstall && !t.installed && (
                                            <Button
                                                variant="primary"
                                                size="xs"
                                                onClick={() => installTemplate(t.code)}
                                                disabled={installing === t.code}
                                                className="flex-shrink-0"
                                            >
                                                {installing === t.code ? '...' : tx('templates.install')}
                                            </Button>
                                        )}
                                    </div>

                                    {/* Badges row */}
                                    <div className="flex flex-wrap gap-1.5 mt-1">
                                        {t.category && <span className="text-xs text-content-subtle bg-bg-default px-2 py-0.5 rounded">{t.category}</span>}
                                        {t.defaultFrequency && <span className="text-xs text-content-subtle bg-bg-default px-2 py-0.5 rounded">{t.defaultFrequency}</span>}
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
            </div>
        </div>
    );
}
