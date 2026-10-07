'use client';
/* TODO(swr-migration): this file has fetch-on-mount + setState
 * patterns flagged by react-hooks/set-state-in-effect. Each call site
 * carries an inline disable directive; collectively they should
 * migrate to useTenantSWR (Epic 69 shape) so the rule can lift. */

import { useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { apiErrorMessage } from '@/lib/api-error';
import { useParams, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { BackAffordance } from '@/components/nav/BackAffordance';
import { buttonVariants } from '@/components/ui/button-variants';
import { Heading } from '@/components/ui/typography';
import { KPIStat } from '@/components/ui/metric';
import { cardVariants } from '@/components/ui/card';
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
}
interface InstallPreview {
    packKey: string;
    packName: string;
    framework: { key: string; name: string; version: string | null };
    totalTemplates: number;
    newControls: number;
    existingControls: number;
    templates: InstallPreviewTemplate[];
}
interface InstallResult {
    packKey: string;
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

    const [framework, setFramework] = useState<InstallFramework | null>(null);
    const [packs, setPacks] = useState<FrameworkPackSummary[]>([]);
    const [selectedPack, setSelectedPack] = useState<string>('');
    const [preview, setPreview] = useState<InstallPreview | null>(null);
    const [loading, setLoading] = useState(true);
    const [installing, setInstalling] = useState(false);
    const [result, setResult] = useState<InstallResult | null>(null);
    const [error, setError] = useState('');

    // Step: 'select' | 'preview' | 'done'
    const [step, setStep] = useState<'select' | 'preview' | 'done'>('select');

    useEffect(() => {
        (async () => {
            try {
                const [fwRes, packRes] = await Promise.all([
                    fetch(apiUrl(`/frameworks/${frameworkKey}`)),
                    fetch(apiUrl(`/frameworks/${frameworkKey}?action=packs`)),
                ]);
                if (fwRes.ok) setFramework(await fwRes.json());
                if (packRes.ok) {
                    const ps = await packRes.json();
                    setPacks(ps);
                    // Auto-select if only one pack or requested
                    if (requestedPack) {
                        setSelectedPack(requestedPack);
                    } else if (ps.length === 1) {
                        setSelectedPack(ps[0].key);
                    }
                }
            } catch { /* ignore */ }
            setLoading(false);
        })();
    }, [apiUrl, frameworkKey, requestedPack]);

    // Fetch preview when pack selected
    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        if (!selectedPack) { setPreview(null); return; }
        fetch(apiUrl(`/frameworks/${frameworkKey}?action=preview&packKey=${selectedPack}`))
            .then(r => r.ok ? r.json() : null)
            .then(p => { setPreview(p); if (p) setStep('preview'); });
    }, [selectedPack, apiUrl, frameworkKey]);

    const handleInstall = async () => {
        setInstalling(true);
        setError('');
        try {
            const res = await fetch(apiUrl(`/frameworks/${frameworkKey}`), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ packKey: selectedPack }),
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({ error: tx('install.installFailed') }));
                setError(apiErrorMessage(err, tx('install.installFailed')));
                return;
            }
            const data = await res.json();
            setResult(data);
            setStep('done');
        } catch (e) {
            setError(e instanceof Error ? e.message : tx('install.networkError'));
        } finally {
            setInstalling(false);
        }
    };

    if (loading) return <div className="p-8 animate-pulse text-content-muted">{tx('install.loading')}</div>;
    if (!framework) return <div className="p-8 text-content-error">{tx('install.notFound')}</div>;

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

            {/* Step indicator */}
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

            {/* Step 1: Select Pack */}
            {step === 'select' && (
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
                                        <div className="text-xs text-content-subtle">{tx('install.packMeta', { count: p._count?.templateLinks || 0, version: p.version || tx('install.latest') })}</div>
                                    </div>
                                </label>
                            ))}
                        </div>
                    )}
                </div>
            )}

            {/* Step 2: Preview */}
            {step === 'preview' && preview && (
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
                                    {t.alreadyInstalled && <span className="text-xs text-content-success">{tx('install.exists')}</span>}
                                    {!t.alreadyInstalled && <span className="text-xs text-[var(--brand-default)]">{tx('install.tasksCount', { count: t.tasks })}</span>}
                                </div>
                            ))}
                        </div>
                    </div>

                    {error && (
                        <div className={cn(cardVariants({ density: 'none' }), 'border-border-error bg-bg-error text-content-error text-sm')}>{error}</div>
                    )}

                    <div className="flex gap-compact">
                        <Button variant="secondary" onClick={() => { setStep('select'); setSelectedPack(''); }}>
                            {tx('install.back')}
                        </Button>
                        <Button
                            variant="primary"
                            className="flex-1"
                            onClick={handleInstall}
                            disabled={installing || preview.newControls === 0}
                            id="confirm-install-btn"
                        >
                            {installing ? (
                                <span className="flex items-center gap-tight">
                                    {tx('install.installing')}
                                </span>
                            ) : preview.newControls === 0 ? (
                                tx('install.allInstalled')
                            ) : (
                                tx('install.installN', { count: preview.newControls })
                            )}
                        </Button>
                    </div>
                </div>
            )}

            {/* Step 3: Done */}
            {step === 'done' && result && (
                <div className={cn(cardVariants({ density: 'none' }), 'text-center space-y-default')} id="install-result">
                    <div className="text-4xl"></div>
                    <Heading level={1}>{tx('install.successHeading')}</Heading>
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
