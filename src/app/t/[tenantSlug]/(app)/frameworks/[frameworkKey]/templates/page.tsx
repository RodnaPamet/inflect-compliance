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
        (async () => {
            const [fwRes] = await Promise.all([
                fetch(apiUrl(`/frameworks/${frameworkKey}`)),
            ]);
            if (fwRes.ok) setFramework(await fwRes.json());
            await fetchTemplates();
            setLoading(false);
        })();
    }, [apiUrl, frameworkKey, fetchTemplates]);

    // R14-PR7 — debounced search retired with the input. Filter
    // state changes (category, section) re-fetch immediately.
    useEffect(() => {
        fetchTemplates();
    }, [category, section, fetchTemplates]);

    const installTemplate = async (code: string) => {
        setInstalling(code);
        try {
            await fetch(apiUrl(`/frameworks/${frameworkKey}?action=install-template`), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ templateCode: code }),
            });
            await fetchTemplates();
        } catch { /* ignore */ }
        setInstalling(null);
    };

    const bulkInstall = async () => {
        if (selected.size === 0) return;
        setBulkInstalling(true);
        try {
            await fetch(apiUrl(`/frameworks/${frameworkKey}?action=bulk-install`), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ templateCodes: Array.from(selected) }),
            });
            setSelected(new Set());
            await fetchTemplates();
        } catch { /* ignore */ }
        setBulkInstalling(false);
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
                {selected.size > 0 && (
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
                <Button variant="secondary" size="xs" onClick={selectAll} id="select-all-btn">{tx('templates.selectAllUninstalled')}</Button>
            </div>

            {/* Template cards */}
            <div className="space-y-compact" id="template-list">
                {templates.map(t => {
                    const isExpanded = expandedTemplate === t.code;
                    const isSelected = selected.has(t.code);

                    return (
                        <div key={t.code} className={cn(cardVariants({ density: 'none' }), 'transition-colors', isSelected ? 'ring-1 ring-[var(--ring)]/50' : '')} id={`template-${t.code}`}>
                            <div className="flex items-start gap-compact">
                                {/* Checkbox */}
                                {!t.installed && (
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
                                        {!t.installed && (
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

                                            {/* Suggested evidence */}
                                            <div>
                                                <Eyebrow>{tx('templates.suggestedEvidence')}</Eyebrow>
                                                <div className="flex flex-wrap gap-1">
                                                    {['DOCUMENT', 'SCREENSHOT', 'LOG'].map(type => (
                                                        <span key={type} className="text-xs bg-bg-default text-content-muted px-2 py-0.5 rounded">{type}</span>
                                                    ))}
                                                </div>
                                            </div>
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
