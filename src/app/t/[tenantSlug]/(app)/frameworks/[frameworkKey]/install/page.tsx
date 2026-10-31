'use client';
/* TODO(swr-migration): this file has fetch-on-mount + setState
 * patterns flagged by react-hooks/set-state-in-effect. Each call site
 * carries an inline disable directive; collectively they should
 * migrate to useTenantSWR (Epic 69 shape) so the rule can lift. */

import { useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { frameworkInstallRefusal } from '@/lib/framework-install-refusals';
import { useParams, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { BackAffordance } from '@/components/nav/BackAffordance';
import { buttonVariants } from '@/components/ui/button-variants';
import { Heading } from '@/components/ui/typography';
import { KPIStat } from '@/components/ui/metric';
import { cardVariants } from '@/components/ui/card';
import { InlineNotice } from '@/components/ui/inline-notice';
import { usePermissions } from '@/lib/tenant-context-provider';
import { cn } from '@inflect/ui/lib/cn';

// Shapes cross-walked from the framework install API:
//   framework → getFramework (framework/catalog.ts)
//   preview   → previewPackInstall (framework/install.ts)
//   result    → installPack (framework/install.ts)
interface InstallFramework {
    id: string;
    key: string;
    name: string;
    version: string | null;
    description: string | null;
    kind: string;
    _count: { requirements: number; packs: number };
}
interface InstallPreviewTemplate {
    code: string;
    title: string;
    tasks: number;
    requirements: { code: string; title: string }[];
    alreadyInstalled: boolean;
    /** Mappings the existing control is missing; a re-install restores them. */
    missingMappings?: number;
}
interface InstallPreview {
    // previewPackInstall names one pack; previewPacksInstall lists the chosen ones.
    packKey?: string;
    packName?: string;
    packKeys?: string[];
    framework: { key: string; name: string; version: string | null };
    totalTemplates: number;
    newControls: number;
    existingControls: number;
    /** Requirement mappings missing from controls that already exist (#4731). */
    missingMappings?: number;
    templates: InstallPreviewTemplate[];
}
interface InstallResult {
    packKey?: string;
    packName: string;
    framework: string;
    controlsCreated: number;
    tasksCreated: number;
    mappingsCreated: number;
}

// Pack summary — listFrameworkPacks (FrameworkPack + _count).
interface FrameworkPackSummary {
    id: string;
    key: string;
    name: string;
    description: string | null;
    version: string | null;
    _count: { templateLinks: number };
}

export default function InstallWizardPage() {
    const tx = useTranslations('frameworks');
    const params = useParams();
    const searchParams = useSearchParams();
    const tenantSlug = params.tenantSlug as string;
    const frameworkKey = params.frameworkKey as string;
    const requestedPack = searchParams.get('pack');
    const apiUrl = useCallback((path: string) => `/api/t/${tenantSlug}${path}`, [tenantSlug]);
    const tenantHref = useCallback((path: string) => `/t/${tenantSlug}${path}`, [tenantSlug]);
    // #4125 — the install API checks `frameworks.install`
    // (`assertCanInstallFrameworkPack`). Without it the wizard's steps are
    // not offered: a member who opens this URL directly is told who can
    // install, rather than walking the wizard to be refused at its last click.
    const canInstall = usePermissions().frameworks.install;

    const [framework, setFramework] = useState<InstallFramework | null>(null);
    const [packs, setPacks] = useState<FrameworkPackSummary[]>([]);
    const [selectedPack, setSelectedPack] = useState<string>('');
    // A framework with several packs is installed by CHOOSING among them — the
    // EU drone framework's packs are its operating subcategories — so they are
    // checkboxes, at least one is required, and the shared controls install
    // once. A single-pack framework keeps the one-click radio flow.
    const multiPack = packs.length > 1;
    const [chosenPacks, setChosenPacks] = useState<string[]>([]);
    const [preview, setPreview] = useState<InstallPreview | null>(null);
    // #4731 — a failed read is not "not found", and an empty pack list is not
    // a failed one: each says what it is, and a failure offers a retry.
    const [loadState, setLoadState] = useState<'loading' | 'ready' | 'notFound' | 'failed'>('loading');
    const [loadAttempt, setLoadAttempt] = useState(0);
    // Kept as data and worded at render, so the preview effect does not
    // depend on the translator.
    const [previewFailure, setPreviewFailure] = useState<{ status: number; body: unknown } | 'network' | null>(null);
    const [previewAttempt, setPreviewAttempt] = useState(0);
    const [installing, setInstalling] = useState(false);
    const [result, setResult] = useState<InstallResult | null>(null);
    const [error, setError] = useState('');

    // Step: 'select' | 'preview' | 'done'
    const [step, setStep] = useState<'select' | 'preview' | 'done'>('select');

    /**
     * What a refused preview or install tells the person: the named refusal
     * in their language, the role note for a 403, else the fallback. The
     * server's English sentence and the browser's "Failed to fetch" are not
     * shown (#4731).
     */
    const refusalText = useCallback(
        (status: number, body: unknown, fallback: string) => {
            const code = frameworkInstallRefusal(body);
            if (code) return tx(`install.refused.${code}`);
            if (status === 403) return tx('install.restricted');
            return fallback;
        },
        [tx],
    );

    useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                const [fwRes, packRes] = await Promise.all([
                    fetch(apiUrl(`/frameworks/${frameworkKey}`)),
                    fetch(apiUrl(`/frameworks/${frameworkKey}?action=packs`)),
                ]);
                if (cancelled) return;
                if (fwRes.status === 404) { setLoadState('notFound'); return; }
                if (!fwRes.ok || !packRes.ok) { setLoadState('failed'); return; }
                setFramework(await fwRes.json());
                {
                    const ps = await packRes.json();
                    setPacks(ps);
                    // Auto-select if only one pack or requested. With several
                    // packs a requested one is pre-ticked, never installed
                    // without the tenant confirming the rest of the choice.
                    if (ps.length > 1) {
                        if (requestedPack && ps.some((p: FrameworkPackSummary) => p.key === requestedPack)) {
                            setChosenPacks([requestedPack]);
                        }
                    } else if (requestedPack) {
                        setSelectedPack(requestedPack);
                    } else if (ps.length === 1) {
                        setSelectedPack(ps[0].key);
                    }
                }
                if (!cancelled) setLoadState('ready');
            } catch {
                if (!cancelled) setLoadState('failed');
            }
        })();
        return () => { cancelled = true; };
    }, [apiUrl, frameworkKey, requestedPack, loadAttempt]);

    const retryLoad = () => {
        setLoadState('loading');
        setLoadAttempt((n) => n + 1);
    };

    // Fetch preview when pack selected
    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        if (!selectedPack) { setPreview(null); setPreviewFailure(null); return; }
        let cancelled = false;
        // A failure yields no preview — never the PREVIOUS pack's preview under
        // the newly selected pack's name — and says so (#4731: it used to do
        // nothing, so choosing the pack looked ignored).
        fetch(apiUrl(`/frameworks/${frameworkKey}?action=preview&packKey=${encodeURIComponent(selectedPack)}`))
            .then(async (r) => {
                const body = await r.json().catch(() => null);
                if (cancelled) return;
                if (!r.ok) {
                    setPreview(null);
                    setPreviewFailure({ status: r.status, body });
                    return;
                }
                setPreviewFailure(null);
                setPreview(body);
                if (body) setStep('preview');
            })
            .catch(() => {
                if (cancelled) return;
                setPreview(null);
                setPreviewFailure('network');
            });
        return () => { cancelled = true; };
    }, [selectedPack, apiUrl, frameworkKey, previewAttempt]);

    const toggleChosen = (key: string) =>
        setChosenPacks((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));

    const previewChosen = async () => {
        if (chosenPacks.length === 0) return;
        setError('');
        const keys = packs.map((p) => p.key).filter((k) => chosenPacks.includes(k));
        try {
            const res = await fetch(apiUrl(`/frameworks/${frameworkKey}?action=preview&packKeys=${keys.map(encodeURIComponent).join(',')}`));
            const body = await res.json().catch(() => null);
            if (!res.ok) {
                setError(refusalText(res.status, body, tx('install.previewFailed')));
                return;
            }
            setPreview(body);
            setStep('preview');
        } catch {
            setError(tx('install.networkError'));
        }
    };

    const handleInstall = async () => {
        setInstalling(true);
        setError('');
        try {
            const res = await fetch(apiUrl(`/frameworks/${frameworkKey}`), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(
                    multiPack
                        ? { packKeys: packs.map((p) => p.key).filter((k) => chosenPacks.includes(k)) }
                        : { packKey: selectedPack },
                ),
            });
            const body = await res.json().catch(() => null);
            if (!res.ok) {
                setError(refusalText(res.status, body, tx('install.installFailed')));
                return;
            }
            setResult(body);
            setStep('done');
        } catch {
            setError(tx('install.networkError'));
        } finally {
            setInstalling(false);
        }
    };

    if (loadState === 'loading') return <div className="p-8 animate-pulse text-content-muted">{tx('install.loading')}</div>;
    if (loadState === 'failed') {
        return (
            <div className="max-w-2xl mx-auto space-y-section">
                <BackAffordance />
                <InlineNotice variant="error" id="install-load-failed">
                    {tx('install.loadFailed')}
                </InlineNotice>
                <Button variant="secondary" onClick={retryLoad} id="install-load-retry">{tx('install.retry')}</Button>
            </div>
        );
    }
    if (loadState === 'notFound' || !framework) return <div className="p-8 text-content-error">{tx('install.notFound')}</div>;

    const previewError = previewFailure === null
        ? ''
        : previewFailure === 'network'
            ? tx('install.networkError')
            : refusalText(previewFailure.status, previewFailure.body, tx('install.previewFailed'));

    /** "{count} templates • v{version}", or without a version when the pack has none. */
    const packMeta = (p: FrameworkPackSummary) =>
        p.version
            ? tx('install.packMeta', { count: p._count?.templateLinks || 0, version: p.version })
            : tx('install.packMetaUnversioned', { count: p._count?.templateLinks || 0 });

    return (
        <div className="max-w-2xl mx-auto space-y-section">
            <BackAffordance />
            {/* Header */}
            <div>
                <Heading level={1} className="mt-2" id="install-wizard-heading">
                    {tx('install.heading', { name: framework.name })}
                </Heading>
                <p className="text-sm text-content-muted mt-1">
                    {tx('install.description')}
                </p>
            </div>

            {!canInstall && (
                <InlineNotice variant="info" title={tx('install.restrictedTitle')} id="install-restricted">
                    {tx('install.restricted')}
                </InlineNotice>
            )}

            {/* Step indicator */}
            {canInstall && (
                <div className="flex items-center gap-tight text-xs">
                    {['stepSelect', 'stepPreview', 'stepInstall'].map((s, i) => (
                        <div key={s} className="flex items-center gap-tight">
                            <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${i === 0 && step === 'select' ? 'bg-brand-600 text-content-emphasis' :
                                    i === 1 && step === 'preview' ? 'bg-brand-600 text-content-emphasis' :
                                        i === 2 && step === 'done' ? 'bg-bg-success-emphasis text-content-emphasis' :
                                            step === 'done' || (step === 'preview' && i === 0) ? 'bg-bg-success text-content-success' :
                                                'bg-bg-elevated text-content-subtle'
                                }`}>{i + 1}</div>
                            <span className="text-content-muted">{tx(`install.${s}`)}</span>
                            {i < 2 && <span className="text-content-subtle">→</span>}
                        </div>
                    ))}
                </div>
            )}

            {/* Step 1: Choose packs — several packs, at least one required */}
            {canInstall && step === 'select' && multiPack && (
                <div className={cn(cardVariants({ density: 'none' }), 'space-y-default')} id="install-choose-packs">
                    <Heading level={2}>{tx('install.choosePacks')}</Heading>
                    <p className="text-sm text-content-muted">{tx('install.choosePacksHint')}</p>
                    <div className="space-y-tight">
                        {packs.map(p => {
                            const checked = chosenPacks.includes(p.key);
                            return (
                                <label key={p.key} htmlFor={`pack-${p.key}`} className={`flex items-start gap-compact p-3 rounded-lg border cursor-pointer transition-colors ${checked ? 'border-[var(--brand-default)] bg-[var(--brand-subtle)]' : 'border-border-subtle hover:border-border-emphasis'
                                    }`}>
                                    <Checkbox
                                        id={`pack-${p.key}`}
                                        checked={checked}
                                        onCheckedChange={() => toggleChosen(p.key)}
                                        className="mt-0.5"
                                    />
                                    <div>
                                        <div className="text-sm font-medium text-content-emphasis">{p.name}</div>
                                        {p.description && <div className="text-xs text-content-muted mt-0.5">{p.description}</div>}
                                        <div className="text-xs text-content-subtle mt-0.5">{packMeta(p)}</div>
                                    </div>
                                </label>
                            );
                        })}
                    </div>
                    {chosenPacks.length === 0 && (
                        <p className="text-xs text-content-warning" id="install-choose-packs-required">{tx('install.choosePacksRequired')}</p>
                    )}
                    {error && (
                        <div className="text-sm text-content-error">{error}</div>
                    )}
                    <Button
                        variant="secondary"
                        onClick={previewChosen}
                        disabled={chosenPacks.length === 0}
                        id="preview-chosen-packs-btn"
                    >
                        {tx('install.previewChosen', { count: chosenPacks.length })}
                    </Button>
                </div>
            )}

            {/* Step 1: Select Pack */}
            {canInstall && step === 'select' && !multiPack && (
                <div className={cn(cardVariants({ density: 'none' }), 'space-y-default')}>
                    <Heading level={2}>{tx('install.selectAPack')}</Heading>
                    {packs.length === 0 ? (
                        <p className="text-content-subtle">{tx('install.packsEmpty')}</p>
                    ) : (
                        <div className="space-y-tight">
                            {packs.map(p => (
                                <label key={p.key} className={`flex items-center gap-compact p-3 rounded-lg border cursor-pointer transition-colors ${selectedPack === p.key ? 'border-[var(--brand-default)] bg-[var(--brand-subtle)]' : 'border-border-default hover:border-border-emphasis'
                                    }`}>
                                    <input
                                        type="radio"
                                        name="pack"
                                        value={p.key}
                                        checked={selectedPack === p.key}
                                        onChange={() => setSelectedPack(p.key)}
                                        className="accent-[var(--brand-default)]"
                                    />
                                    <div>
                                        <div className="text-sm font-medium text-content-emphasis">{p.name}</div>
                                        <div className="text-xs text-content-subtle">{packMeta(p)}</div>
                                    </div>
                                </label>
                            ))}
                        </div>
                    )}
                    {previewError && (
                        <div className="flex flex-wrap items-center gap-compact" id="install-preview-error">
                            <p className="text-sm text-content-error">{previewError}</p>
                            <Button variant="secondary" size="sm" onClick={() => setPreviewAttempt((n) => n + 1)} id="install-preview-retry">
                                {tx('install.retry')}
                            </Button>
                        </div>
                    )}
                </div>
            )}

            {/* Step 2: Preview */}
            {canInstall && step === 'preview' && preview && (
                <div className="space-y-default">
                    <div className={cardVariants({ density: 'none' })}>
                        <Heading level={2} className="mb-4">{tx('install.installPreview')}</Heading>
                        <div className="grid grid-cols-3 gap-default mb-4">
                            <div className="p-3 rounded-lg bg-bg-default/50">
                                <KPIStat id="preview-new-controls" value={preview.newControls} label={tx('install.newControls')} />
                            </div>
                            <div className="p-3 rounded-lg bg-bg-default/50">
                                <KPIStat value={preview.existingControls} label={tx('install.alreadyExist')} tone="attention" />
                            </div>
                            <div className="p-3 rounded-lg bg-bg-default/50">
                                <KPIStat value={preview.totalTemplates} label={tx('install.totalTemplates')} />
                            </div>
                        </div>

                        {/* Template list */}
                        <div className="max-h-64 overflow-y-auto space-y-1 border-t border-border-default/50 pt-3">
                            {preview.templates?.map((t) => (
                                <div key={t.code} className="flex items-center gap-compact px-3 py-1.5 rounded-md text-sm">
                                    <span className={`w-2 h-2 rounded-full flex-shrink-0 ${t.alreadyInstalled ? 'bg-bg-success-emphasis' : 'bg-[var(--brand-default)]'}`} />
                                    <code className="text-xs text-content-subtle font-mono w-24 flex-shrink-0">{t.code}</code>
                                    <span className="text-content-default flex-1">{t.title}</span>
                                    {t.alreadyInstalled && (t.missingMappings ?? 0) > 0 && (
                                        <span className="text-xs text-content-warning">{tx('install.missingCount', { count: t.missingMappings ?? 0 })}</span>
                                    )}
                                    {t.alreadyInstalled && (t.missingMappings ?? 0) === 0 && <span className="text-xs text-content-success">{tx('install.exists')}</span>}
                                    {!t.alreadyInstalled && <span className="text-xs text-[var(--brand-default)]">{tx('install.tasksCount', { count: t.tasks })}</span>}
                                </div>
                            ))}
                        </div>
                    </div>

                    {(preview.missingMappings ?? 0) > 0 && (
                        <InlineNotice variant="info" id="install-restore-notice">
                            {tx('install.mappingsToRestore', { count: preview.missingMappings ?? 0 })}
                        </InlineNotice>
                    )}

                    {error && (
                        <div className={cn(cardVariants({ density: 'none' }), 'border-border-error bg-bg-error text-content-error text-sm')}>{error}</div>
                    )}

                    <div className="flex gap-compact">
                        <Button variant="secondary" onClick={() => { setStep('select'); setSelectedPack(''); setPreview(null); }}>
                            {tx('install.back')}
                        </Button>
                        <Button
                            variant="primary"
                            className="flex-1"
                            onClick={handleInstall}
                            // #4731 — a re-install also restores the mappings an
                            // existing control lost, so it is offered while any is
                            // missing, not only for new controls.
                            disabled={installing || (preview.newControls === 0 && (preview.missingMappings ?? 0) === 0)}
                            id="confirm-install-btn"
                        >
                            {installing ? (
                                <span className="flex items-center gap-tight">
                                    {tx('install.installing')}
                                </span>
                            ) : preview.newControls > 0 ? (
                                tx('install.installN', { count: preview.newControls })
                            ) : (preview.missingMappings ?? 0) > 0 ? (
                                tx('install.restoreN', { count: preview.missingMappings ?? 0 })
                            ) : (
                                tx('install.allInstalled')
                            )}
                        </Button>
                    </div>
                </div>
            )}

            {/* Step 3: Done */}
            {canInstall && step === 'done' && result && (
                <div className={cn(cardVariants({ density: 'none' }), 'text-center space-y-default')} id="install-result">
                    <Heading level={1}>
                        {result.controlsCreated === 0 && result.mappingsCreated > 0
                            ? tx('install.restoredHeading')
                            : tx('install.successHeading')}
                    </Heading>
                    <div className="grid grid-cols-3 gap-default">
                        <div className="p-3 rounded-lg bg-bg-success">
                            <KPIStat id="result-controls" value={result.controlsCreated} label={tx('install.controlsCreated')} tone="success" />
                        </div>
                        <div className="p-3 rounded-lg bg-[var(--brand-subtle)]">
                            <KPIStat id="result-tasks" value={result.tasksCreated} label={tx('install.tasksCreated')} />
                        </div>
                        <div className="p-3 rounded-lg bg-bg-info/40">
                            <KPIStat id="result-mappings" value={result.mappingsCreated} label={tx('install.mappingsCreated')} />
                        </div>
                    </div>
                    <div className="flex gap-compact justify-center">
                        <Link href={tenantHref('/controls')} className={buttonVariants({ variant: 'primary' })} id="go-to-controls">
                            {tx('install.viewControls')}
                        </Link>
                        <Link href={tenantHref(`/frameworks/${frameworkKey}`)} className={buttonVariants({ variant: 'secondary' })}>
                            {tx('install.backToFramework')}
                        </Link>
                    </div>
                </div>
            )}
        </div>
    );
}
