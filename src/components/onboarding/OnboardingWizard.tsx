'use client';

/* TODO(swr-migration): this file has fetch-on-mount + setState
 * patterns flagged by react-hooks/set-state-in-effect. Each call site
 * carries an inline disable directive; collectively they should
 * migrate to useTenantSWR (Epic 69 shape) so the rule can lift. */

import { useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useTenantContext, useTenantHref } from '@/lib/tenant-context-provider';
import { Combobox } from '@/components/ui/combobox';
import { Button } from '@/components/ui/button';
import { useEnterSubmit } from '@/components/ui/hooks';
import {
    Building2,
    Map,
    Server,
    ShieldCheck,
    AlertTriangle,
    Users,
    CheckCircle2,
    ChevronRight,
    ChevronLeft,
    Loader2,
    Save,
    Sparkles,
    ClipboardCheck,
    Landmark,
} from 'lucide-react';
import { StatusBadge } from '@/components/ui/status-badge';
import { Heading } from '@/components/ui/typography';
import { Card, cardVariants } from '@/components/ui/card';
import { InlineNotice } from '@/components/ui/inline-notice';
import { cn } from '@inflect/ui/lib/cn';
import { Nis2SelfAssessmentStep } from './Nis2SelfAssessmentStep';
import { AiGovSelfAssessmentStep } from './AiGovSelfAssessmentStep';
import { SovereigntySelfAssessmentStep } from './SovereigntySelfAssessmentStep';

// ─── Step Definitions ───
//
// Elevation PR-6 — per-step gradient strings retired. Step icons
// render in the canonical state colours (muted at rest, brand when
// active, success when completed).
const STEPS = [
    { key: 'COMPANY_PROFILE', labelKey: 'wizard.steps.companyProfile', icon: Building2 },
    { key: 'FRAMEWORK_SELECTION', labelKey: 'wizard.steps.frameworks', icon: Map },
    // Conditional — rendered only when NIS2 is among the selected
    // frameworks (see stepApplicable / visibleSteps below).
    { key: 'NIS2_SELF_ASSESSMENT', labelKey: 'wizard.steps.nis2Assessment', icon: ClipboardCheck },
    // Conditional — rendered only when an AI framework is selected (or the
    // AI-systems flag). See stepApplicable / visibleSteps below.
    { key: 'AI_GOVERNANCE_SELF_ASSESSMENT', labelKey: 'wizard.steps.aiGovernance', icon: Sparkles },
    // Conditional — rendered only when an EU digital-regulation framework
    // (NIS2 / DORA / EU AI Act) is selected. See stepApplicable / visibleSteps.
    { key: 'SOVEREIGNTY_SELF_ASSESSMENT', labelKey: 'wizard.steps.digitalSovereignty', icon: Landmark },
    { key: 'ASSET_SETUP', labelKey: 'wizard.steps.assets', icon: Server },
    { key: 'CONTROL_BASELINE_INSTALL', labelKey: 'wizard.steps.controls', icon: ShieldCheck },
    { key: 'INITIAL_RISK_REGISTER', labelKey: 'wizard.steps.risks', icon: AlertTriangle },
    { key: 'TEAM_SETUP', labelKey: 'wizard.steps.team', icon: Users },
    { key: 'REVIEW_AND_FINISH', labelKey: 'wizard.steps.reviewFinish', icon: CheckCircle2 },
] as const;

type StepKey = (typeof STEPS)[number]['key'];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type StepData = Record<string, any>;

/**
 * Is a step applicable given the choices so far? Mirrors the server-side
 * `isStepApplicable` in usecases/onboarding.ts. A non-applicable step is
 * filtered out of `visibleSteps` so it's never shown and never counted.
 */
function stepApplicable(key: string, data: StepData): boolean {
    if (key === 'NIS2_SELF_ASSESSMENT') {
        const fws: string[] = data?.FRAMEWORK_SELECTION?.selectedFrameworks ?? [];
        // Case-insensitive — the picker stores lowercase 'nis2'.
        return Array.isArray(fws) && fws.some((f) => String(f).toUpperCase() === 'NIS2');
    }
    if (key === 'AI_GOVERNANCE_SELF_ASSESSMENT') {
        const fws: string[] = data?.FRAMEWORK_SELECTION?.selectedFrameworks ?? [];
        const AI_FWS = new Set(['AISVS', 'ISO42001', 'EU_AI_ACT', 'EU-AI-ACT', 'OWASP-AISVS']);
        const hasAi = Array.isArray(fws) && fws.some((f) => AI_FWS.has(String(f).toUpperCase().replace(/\s+/g, '')));
        return hasAi || data?.COMPANY_PROFILE?.usesAiSystems === true;
    }
    if (key === 'SOVEREIGNTY_SELF_ASSESSMENT') {
        // EU digital-regulation frameworks — mirrors the server-side gate.
        const fws: string[] = data?.FRAMEWORK_SELECTION?.selectedFrameworks ?? [];
        const EU_FWS = new Set(['NIS2', 'DORA', 'EU_AI_ACT', 'EU-AI-ACT', 'EUAIACT']);
        return Array.isArray(fws) && fws.some((f) => EU_FWS.has(String(f).toUpperCase().replace(/\s+/g, '')));
    }
    return true;
}

function computeVisibleSteps(data: StepData) {
    return STEPS.filter((s) => stepApplicable(s.key, data));
}

interface OnboardingState {
    status: string;
    currentStep: string;
    completedSteps: string[];
    stepData: StepData;
    startedAt: string | null;
    completedAt: string | null;
}

// ─── API helpers ───

function apiUrl(tenantSlug: string, path: string) {
    return `/api/t/${tenantSlug}/onboarding/${path}`;
}

async function apiFetch<T>(url: string, method = 'GET', body?: unknown): Promise<T> {
    const res = await fetch(url, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Request failed' }));
        const msg = typeof err.error === 'string' ? err.error
            : typeof err.message === 'string' ? err.message
            : JSON.stringify(err.error ?? err);
        throw new Error(msg || `HTTP ${res.status}`);
    }
    return res.json();
}

// ─── Main Wizard Component ───

export default function OnboardingWizard() {
    const t = useTranslations('onboarding');
    const { tenantSlug, permissions } = useTenantContext();
    const tenantHref = useTenantHref();
    const router = useRouter();

    const [state, setState] = useState<OnboardingState | null>(null);
    const [activeStepIdx, setActiveStepIdx] = useState(0);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [localData, setLocalData] = useState<StepData>({});
    const [successBanner, setSuccessBanner] = useState(false);

    // ─── Load state ───
    const loadState = useCallback(async () => {
        if (!permissions.canAdmin) return;
        try {
            setLoading(true);
            const s = await apiFetch<OnboardingState>(apiUrl(tenantSlug, 'state'));
            setState(s);
            const sd = (s.stepData as StepData) || {};
            setLocalData(sd);

            // Set active step to current — index into the APPLICABLE list
            // (a non-NIS2 tenant has no NIS2 step, so indices shift).
            const idx = computeVisibleSteps(sd).findIndex(st => st.key === s.currentStep);
            if (idx >= 0) setActiveStepIdx(idx);
        } catch (e) {
            setError(e instanceof Error ? e.message : t('wizard.errors.loadState'));
        } finally {
            setLoading(false);
        }
    }, [tenantSlug, permissions.canAdmin, t]);

    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => { loadState(); }, [loadState]);

    // ─── Start onboarding ───
    const handleStart = async () => {
        try {
            setSaving(true);
            const s = await apiFetch<OnboardingState>(apiUrl(tenantSlug, 'start'), 'POST');
            setState(s);
        } catch (e) {
            setError(e instanceof Error ? e.message : t('wizard.errors.start'));
        } finally {
            setSaving(false);
        }
    };

    // ─── Save step data ───
    const handleSaveStep = async (step: StepKey, data: StepData) => {
        try {
            setSaving(true);
            setError(null);
            await apiFetch(apiUrl(tenantSlug, 'step'), 'POST', { step, action: 'save', data });
            setLocalData(prev => ({ ...prev, [step]: data }));
        } catch (e) {
            setError(e instanceof Error ? e.message : t('wizard.errors.save'));
        } finally {
            setSaving(false);
        }
    };

    // ─── Complete step ───
    const handleCompleteStep = async (step: StepKey) => {
        try {
            setSaving(true);
            setError(null);
            // Save any local data first
            const stepLocalData = localData[step] || {};
            if (Object.keys(stepLocalData).length > 0) {
                await apiFetch(apiUrl(tenantSlug, 'step'), 'POST', { step, action: 'save', data: stepLocalData });
            }
            // Then complete
            const s = await apiFetch<OnboardingState>(apiUrl(tenantSlug, 'step'), 'POST', { step, action: 'complete' });
            setState(s);
            // Advance to next applicable step (denominator excludes hidden steps).
            const vis = computeVisibleSteps(localData);
            const nextIdx = activeStepIdx + 1;
            if (nextIdx < vis.length) setActiveStepIdx(nextIdx);
        } catch (e) {
            setError(e instanceof Error ? e.message : t('wizard.errors.completeStep'));
        } finally {
            setSaving(false);
        }
    };

    // ─── NIS2 step: completion + skip drive their own endpoints, then
    // re-sync (the server advances currentStep to ASSET_SETUP). ───
    const handleNis2Completed = async () => {
        await loadState();
    };
    const handleNis2Skip = async () => {
        try {
            setSaving(true);
            await apiFetch(apiUrl(tenantSlug, 'step'), 'POST', {
                step: 'NIS2_SELF_ASSESSMENT',
                action: 'skip',
            });
            await loadState();
        } catch (e) {
            setError(e instanceof Error ? e.message : t('wizard.errors.skipStep'));
        } finally {
            setSaving(false);
        }
    };

    // ─── AI-governance step. Its component drives the assessment complete/
    // materialize endpoints; the onboarding step itself is advanced here. ───
    const handleAiGovCompleted = async () => {
        await handleCompleteStep('AI_GOVERNANCE_SELF_ASSESSMENT');
    };
    const handleAiGovSkip = async () => {
        try {
            setSaving(true);
            await apiFetch(apiUrl(tenantSlug, 'step'), 'POST', {
                step: 'AI_GOVERNANCE_SELF_ASSESSMENT',
                action: 'skip',
            });
            await loadState();
        } catch (e) {
            setError(e instanceof Error ? e.message : t('wizard.errors.skipStep'));
        } finally {
            setSaving(false);
        }
    };

    // ─── Digital Sovereignty step (DS-2). Stateless — the component scores
    // client-side and materialises via its own endpoint; the onboarding step
    // itself is advanced here, like the AI-governance step. ───
    const handleSovereigntyCompleted = async () => {
        await handleCompleteStep('SOVEREIGNTY_SELF_ASSESSMENT');
    };
    const handleSovereigntySkip = async () => {
        try {
            setSaving(true);
            await apiFetch(apiUrl(tenantSlug, 'step'), 'POST', {
                step: 'SOVEREIGNTY_SELF_ASSESSMENT',
                action: 'skip',
            });
            await loadState();
        } catch (e) {
            setError(e instanceof Error ? e.message : t('wizard.errors.skipStep'));
        } finally {
            setSaving(false);
        }
    };

    // ─── Finish ───
    const handleFinish = async () => {
        try {
            setSaving(true);
            setError(null);
            // Complete the last step first
            await apiFetch(apiUrl(tenantSlug, 'step'), 'POST', { step: 'REVIEW_AND_FINISH', action: 'complete' });
            await apiFetch(apiUrl(tenantSlug, 'finish'), 'POST');
            setSuccessBanner(true);
            setTimeout(() => {
                router.push(tenantHref('/dashboard'));
            }, 2000);
        } catch (e) {
            setError(e instanceof Error ? e.message : t('wizard.errors.finish'));
        } finally {
            setSaving(false);
        }
    };

    // ─── Save & exit ───
    const handleSaveAndExit = async () => {
        const currentStepKey = computeVisibleSteps(localData)[activeStepIdx]?.key;
        if (!currentStepKey) {
            router.push(tenantHref('/dashboard'));
            return;
        }
        const stepLocalData = localData[currentStepKey] || {};
        if (Object.keys(stepLocalData).length > 0) {
            await handleSaveStep(currentStepKey, stepLocalData);
        }
        router.push(tenantHref('/dashboard'));
    };

    // ─── Update local step data ───
    const updateStepData = (step: StepKey, data: StepData) => {
        setLocalData(prev => ({ ...prev, [step]: { ...(prev[step] || {}), ...data } }));
    };

    // ─── Admin guard (must be after all hooks) ───
    if (!permissions.canAdmin) {
        return (
            <div className="flex items-center justify-center min-h-[60vh]">
                <Card className="text-center max-w-md">
                    <ShieldCheck className="w-12 h-12 text-content-subtle mx-auto mb-4" />
                    <Heading level={2} className="text-content-emphasis mb-2">{t('wizard.accessRestricted')}</Heading>
                    <p className="text-sm text-content-muted">{t('wizard.accessRestrictedBody')}</p>
                </Card>
            </div>
        );
    }

    // ─── Loading skeleton ───
    if (loading) {
        return (
            <div className="space-y-section animate-fadeIn">
                <div className="h-8 w-48 bg-bg-default rounded animate-pulse" />
                <div className="grid grid-cols-1 lg:grid-cols-4 gap-section">
                    <div className="h-96 bg-bg-default/50 rounded-lg animate-pulse" />
                    <div className="lg:col-span-3 h-96 bg-bg-default/50 rounded-lg animate-pulse" />
                </div>
            </div>
        );
    }

    // ─── Success banner ───
    if (successBanner) {
        return (
            <div className="flex items-center justify-center min-h-[60vh] animate-fadeIn">
                <div className={cn(cardVariants({ density: 'spacious' }), 'text-center max-w-lg')}>
                    <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-bg-success-emphasis flex items-center justify-center">
                        <CheckCircle2 className="w-8 h-8 text-content-inverted" />
                    </div>
                    <Heading level={2} className="text-content-emphasis mb-2">{t('wizard.completeExclaim')}</Heading>
                    <p className="text-content-muted text-sm">{t('wizard.completeRedirect')}</p>
                    {/* NIS2 hand-off — the wizard's gap run is now run #1 in the
                        lifecycle history on the Audits page. Shown only when NIS2
                        was selected. */}
                    {stepApplicable('NIS2_SELF_ASSESSMENT', localData) && (
                        <a href={tenantHref('/audits/nis2-gap')} className="mt-4 inline-block text-sm text-brand-default underline hover:text-content-emphasis">
                            {t('wizard.viewNis2Gap')}
                        </a>
                    )}
                    <div className="mt-4">
                        <Loader2 className="w-5 h-5 mx-auto text-brand-400 animate-spin" />
                    </div>
                </div>
            </div>
        );
    }

    // ─── Not started ───
    if (!state || state.status === 'NOT_STARTED') {
        return (
            <div className="flex items-center justify-center min-h-[60vh] animate-fadeIn">
                <div className={cn(cardVariants({ density: 'spacious' }), 'text-center max-w-lg')}>
                    <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-[var(--brand-default)] flex items-center justify-center">
                        <Sparkles className="w-8 h-8 text-content-inverted" />
                    </div>
                    <Heading level={2} className="text-content-emphasis mb-2">{t('wizard.welcome')}</Heading>
                    <p className="text-content-muted text-sm mb-6">{t('wizard.welcomeBody')}</p>
                    <Button variant="primary" size="lg" onClick={handleStart} disabled={saving}>
                        {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                        {t('wizard.startSetup')}
                    </Button>
                </div>
            </div>
        );
    }

    // ─── Completed ───
    if (state.status === 'COMPLETED') {
        return (
            <div className="flex items-center justify-center min-h-[60vh] animate-fadeIn">
                <div className={cn(cardVariants({ density: 'spacious' }), 'text-center max-w-lg')}>
                    <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-bg-success-emphasis flex items-center justify-center">
                        <CheckCircle2 className="w-8 h-8 text-content-inverted" />
                    </div>
                    <Heading level={2} className="text-content-emphasis mb-2">{t('wizard.completeTitle')}</Heading>
                    <p className="text-content-muted text-sm mb-6">{t('wizard.completeBody')}</p>
                    <Button variant="primary" size="lg" onClick={() => router.push(tenantHref('/dashboard'))}>
                        {t('wizard.goToDashboard')}
                    </Button>
                </div>
            </div>
        );
    }

    // Only applicable steps are shown/counted; `activeStepIdx` indexes this.
    const visibleSteps = computeVisibleSteps(localData);
    const currentStep = visibleSteps[activeStepIdx] ?? visibleSteps[visibleSteps.length - 1];
    const isComplete = (key: string) => state.completedSteps.includes(key);
    const isLast = activeStepIdx === visibleSteps.length - 1;
    const visibleCompletedCount = state.completedSteps.filter((s) =>
        visibleSteps.some((v) => v.key === s),
    ).length;

    return (
        <div className="space-y-default animate-fadeIn" data-testid="onboarding-wizard">
            {/* Header */}
            <div className="flex flex-wrap items-center justify-between gap-compact">
                <div>
                    <Heading level={1}>{t('wizard.title')}</Heading>
                    <p className="text-content-muted text-sm mt-1">{t('wizard.subtitle')}</p>
                </div>
                <Button variant="ghost" size="sm" onClick={handleSaveAndExit}>
                    <Save className="w-3.5 h-3.5" /> {t('wizard.saveExit')}
                </Button>
            </div>

            {error && (
                <div className={cn(cardVariants({ density: 'compact' }), 'border-border-error text-sm text-content-error flex items-center gap-tight')}>
                    <AlertTriangle className="w-4 h-4 flex-shrink-0" />
                    {error}
                    <button onClick={() => setError(null)} className="ml-auto text-content-error hover:text-content-emphasis text-xs">&times;</button>
                </div>
            )}

            <div className="grid grid-cols-1 lg:grid-cols-4 gap-section">
                {/* ─── Progress Sidebar ─── */}
                <div className={cn(cardVariants({ density: 'none' }), 'overflow-hidden')}>
                    <div className="p-4 border-b border-border-subtle">
                        <p className="text-xs text-content-muted font-medium uppercase tracking-wider">{t('wizard.progress')}</p>
                        <div className="flex items-center gap-tight mt-2">
                            <div className="flex-1 bg-bg-default rounded-full h-2 overflow-hidden">
                                <div className="h-full bg-[var(--brand-default)] rounded-full transition-all duration-500"
                                    style={{ width: `${visibleSteps.length ? (visibleCompletedCount / visibleSteps.length) * 100 : 0}%` }} />
                            </div>
                            <span className="text-xs text-content-muted font-medium">{visibleCompletedCount}/{visibleSteps.length}</span>
                        </div>
                    </div>
                    <nav className="p-2">
                        {visibleSteps.map((step, i) => {
                            const Icon = step.icon;
                            const completed = isComplete(step.key);
                            const active = i === activeStepIdx;
                            return (
                                <button key={step.key}
                                    onClick={() => setActiveStepIdx(i)}
                                    data-testid={`step-nav-${step.key}`}
                                    className={`w-full flex items-center gap-compact px-3 py-2.5 rounded-lg text-sm transition-colors duration-150 ease-out ${
                                        active ? 'bg-brand-subtle text-content-emphasis font-medium' : 'text-content-muted hover:text-content-emphasis hover:bg-bg-muted/50'
                                    }`}
                                >
                                    <div className={`w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 ${
                                        completed ? 'bg-bg-success' : active ? `bg-[var(--brand-default)]` : 'bg-bg-muted/50'
                                    }`}>
                                        {completed ? (
                                            <CheckCircle2 className="w-4 h-4 text-content-success" />
                                        ) : (
                                            <Icon className={`w-3.5 h-3.5 ${active ? 'text-content-inverted' : 'text-content-subtle'}`} />
                                        )}
                                    </div>
                                    <span className="truncate">{t(step.labelKey)}</span>
                                    {active && <ChevronRight className="w-3.5 h-3.5 ml-auto text-content-subtle" />}
                                </button>
                            );
                        })}
                    </nav>
                </div>

                {/* ─── Step Content ─── */}
                <div className="lg:col-span-3">
                    <div className={cardVariants({ density: 'none' })}>
                        <div className="p-5 border-b border-border-subtle flex items-center gap-compact">
                            <div className={`w-9 h-9 rounded-full bg-[var(--brand-default)] flex items-center justify-center`}>
                                <currentStep.icon className="w-4.5 h-4.5 text-content-inverted" />
                            </div>
                            <div>
                                <Heading level={2} className="text-content-emphasis">{t(currentStep.labelKey)}</Heading>
                                <p className="text-xs text-content-muted">{t('wizard.stepOf', { current: activeStepIdx + 1, total: visibleSteps.length })}</p>
                            </div>
                            {isComplete(currentStep.key) && (
                                <StatusBadge variant="success" className="ml-auto">{t('wizard.completedBadge')}</StatusBadge>
                            )}
                        </div>
                        <div className="p-5">
                            <StepContent
                                step={currentStep.key}
                                data={localData[currentStep.key] || {}}
                                onUpdate={(data) => updateStepData(currentStep.key, data)}
                                completedSteps={state.completedSteps}
                                allData={localData}
                                tenantSlug={tenantSlug}
                                onNis2Completed={handleNis2Completed}
                                onNis2Skip={handleNis2Skip}
                                onAiGovCompleted={handleAiGovCompleted}
                                onAiGovSkip={handleAiGovSkip}
                                onSovereigntyCompleted={handleSovereigntyCompleted}
                                onSovereigntySkip={handleSovereigntySkip}
                            />
                        </div>
                        {/* Navigation footer */}
                        <div className="p-4 border-t border-border-subtle flex items-center justify-between gap-compact">
                            <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setActiveStepIdx(Math.max(0, activeStepIdx - 1))}
                                disabled={activeStepIdx === 0}
                            >
                                <ChevronLeft className="w-3.5 h-3.5" /> {t('wizard.back')}
                            </Button>
                            <div className="flex items-center gap-tight">
                                {/* NIS2 step drives its own Complete/Skip inside
                                    the step component, so suppress the generic
                                    Continue button there. */}
                                {!isLast && currentStep.key !== 'NIS2_SELF_ASSESSMENT' && currentStep.key !== 'AI_GOVERNANCE_SELF_ASSESSMENT' && currentStep.key !== 'SOVEREIGNTY_SELF_ASSESSMENT' && (
                                    <Button
                                        variant="primary"
                                        onClick={() => handleCompleteStep(currentStep.key)}
                                        disabled={saving}
                                    >
                                        {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                                        {t('wizard.continue')} <ChevronRight className="w-3.5 h-3.5" />
                                    </Button>
                                )}
                                {isLast && (
                                    <Button
                                        variant="primary"
                                        size="lg"
                                        onClick={handleFinish}
                                        disabled={saving}
                                    >
                                        {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                                        {t('wizard.completeSetup')}
                                    </Button>
                                )}
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}

// ─── Step Content Components ───

function StepContent({ step, data, onUpdate, completedSteps, allData, tenantSlug, onNis2Completed, onNis2Skip, onAiGovCompleted, onAiGovSkip, onSovereigntyCompleted, onSovereigntySkip }: {
    step: StepKey;
    data: StepData;
    onUpdate: (d: StepData) => void;
    completedSteps: string[];
    allData: StepData;
    tenantSlug: string;
    onNis2Completed: () => void;
    onNis2Skip: () => void;
    onAiGovCompleted: () => void;
    onAiGovSkip: () => void;
    onSovereigntyCompleted: () => void;
    onSovereigntySkip: () => void;
}) {
    const t = useTranslations('onboarding');
    switch (step) {
        case 'COMPANY_PROFILE': return <CompanyProfileStep data={data} onUpdate={onUpdate} />;
        case 'FRAMEWORK_SELECTION': return <FrameworkSelectionStep data={data} onUpdate={onUpdate} />;
        case 'NIS2_SELF_ASSESSMENT': return <Nis2SelfAssessmentStep tenantSlug={tenantSlug} onCompleted={onNis2Completed} onSkip={onNis2Skip} />;
        case 'AI_GOVERNANCE_SELF_ASSESSMENT': return <AiGovSelfAssessmentStep tenantSlug={tenantSlug} onCompleted={onAiGovCompleted} onSkip={onAiGovSkip} />;
        case 'SOVEREIGNTY_SELF_ASSESSMENT': return <SovereigntySelfAssessmentStep tenantSlug={tenantSlug} onCompleted={onSovereigntyCompleted} onSkip={onSovereigntySkip} />;
        case 'ASSET_SETUP': return <AssetSetupStep data={data} onUpdate={onUpdate} />;
        case 'CONTROL_BASELINE_INSTALL': return <ControlInstallStep data={data} onUpdate={onUpdate} allData={allData} />;
        case 'INITIAL_RISK_REGISTER': return <RiskRegisterStep data={data} onUpdate={onUpdate} />;
        case 'TEAM_SETUP': return <TeamSetupStep data={data} onUpdate={onUpdate} />;
        case 'REVIEW_AND_FINISH': return <ReviewStep completedSteps={completedSteps} allData={allData} />;
        default: return <p className="text-content-muted">{t('wizard.unknownStep')}</p>;
    }
}

// ─── COMPANY_PROFILE ───

type OnboardingT = ReturnType<typeof useTranslations>;

function buildIndustryOptions(t: OnboardingT): { value: string; label: string }[] {
    return [
        { value: 'technology', label: t('wizard.industry.technology') },
        { value: 'finance', label: t('wizard.industry.finance') },
        { value: 'healthcare', label: t('wizard.industry.healthcare') },
        { value: 'manufacturing', label: t('wizard.industry.manufacturing') },
        { value: 'government', label: t('wizard.industry.government') },
        { value: 'energy', label: t('wizard.industry.energy') },
        { value: 'retail', label: t('wizard.industry.retail') },
        { value: 'other', label: t('wizard.industry.other') },
    ];
}

function buildSizeOptions(t: OnboardingT): { value: string; label: string }[] {
    return [
        { value: '1-50', label: t('wizard.size.upTo50') },
        { value: '51-200', label: t('wizard.size.upTo200') },
        { value: '201-1000', label: t('wizard.size.upTo1000') },
        { value: '1000+', label: t('wizard.size.over1000') },
    ];
}

function CompanyProfileStep({ data, onUpdate }: { data: StepData; onUpdate: (d: StepData) => void }) {
    const t = useTranslations('onboarding');
    const industryOptions = buildIndustryOptions(t);
    const sizeOptions = buildSizeOptions(t);
    return (
        <div className="space-y-default max-w-lg animate-fadeIn">
            <p className="text-sm text-content-muted mb-4">{t('wizard.companyProfile.intro')}</p>
            <div>
                <label className="input-label">{t('wizard.companyProfile.nameLabel')}</label>
                <input className="input" placeholder={t('wizard.companyProfile.namePlaceholder')} value={data.name || ''}
                    onChange={(e) => onUpdate({ name: e.target.value })} data-testid="company-name" />
            </div>
            <div>
                <label className="input-label">{t('wizard.companyProfile.industryLabel')}</label>
                <Combobox
                    hideSearch
                    selected={industryOptions.find(o => o.value === (data.industry || '')) ?? null}
                    setSelected={(opt) => onUpdate({ industry: opt?.value ?? '' })}
                    options={industryOptions}
                    placeholder={t('wizard.companyProfile.industryPlaceholder')}
                    matchTriggerWidth
                />
            </div>
            <div className="grid grid-cols-2 gap-compact">
                <div>
                    <label className="input-label">{t('wizard.companyProfile.countryLabel')}</label>
                    <input className="input" placeholder={t('wizard.companyProfile.countryPlaceholder')} value={data.country || ''}
                        onChange={(e) => onUpdate({ country: e.target.value })} />
                </div>
                <div>
                    <label className="input-label">{t('wizard.companyProfile.sizeLabel')}</label>
                    <Combobox
                        hideSearch
                        selected={sizeOptions.find(o => o.value === (data.size || '')) ?? null}
                        setSelected={(opt) => onUpdate({ size: opt?.value ?? '' })}
                        options={sizeOptions}
                        placeholder={t('wizard.companyProfile.sizePlaceholder')}
                        matchTriggerWidth
                    />
                </div>
            </div>
            {/* Screening toggle — gates the conditional AI-governance
                self-assessment step (also triggered by selecting an AI
                framework). */}
            <label className="flex items-start gap-tight cursor-pointer rounded-lg border border-border-subtle p-3">
                <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={data.usesAiSystems === true}
                    onChange={(e) => onUpdate({ usesAiSystems: e.target.checked })}
                    data-testid="company-uses-ai"
                />
                <span className="text-sm">
                    <span className="font-medium text-content-default">{t('wizard.companyProfile.usesAiTitle')}</span>
                    <span className="block text-xs text-content-muted">
                        {t('wizard.companyProfile.usesAiHint')}
                    </span>
                </span>
            </label>
        </div>
    );
}

// ─── FRAMEWORK_SELECTION ───

interface InstallableFramework {
    key: string;
    name: string;
    version: string | null;
    description: string | null;
    kind: string;
    requirementCount: number;
    controlCount: number;
}

/**
 * Pick the card badge for a framework. Curation lives client-side so the
 * catalog usecase stays pure data: ISO 27001 is the popular default; EU
 * directives/regulations carry an "EU" badge.
 */
function frameworkBadge(fw: InstallableFramework): string | null {
    if (fw.key === 'ISO27001') return 'wizard.frameworks.badgeMostPopular';
    if (fw.kind === 'EU_DIRECTIVE' || fw.kind === 'REGULATION') return 'wizard.frameworks.badgeEu';
    if (['NIS2', 'DORA', 'EU_AI_ACT'].includes(fw.key)) return 'wizard.frameworks.badgeEu';
    return null;
}

function FrameworkSelectionStep({ data, onUpdate }: { data: StepData; onUpdate: (d: StepData) => void }) {
    const t = useTranslations('onboarding');
    const { tenantSlug } = useTenantContext();
    const [frameworks, setFrameworks] = useState<InstallableFramework[]>([]);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const list = await apiFetch<InstallableFramework[]>(apiUrl(tenantSlug, 'frameworks'));
                if (!cancelled) setFrameworks(list);
            } catch (e) {
                if (!cancelled) setLoadError(e instanceof Error ? e.message : t('wizard.frameworks.loadError'));
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, [tenantSlug, t]);

    const selected: string[] = data.selectedFrameworks || [];
    // Case-insensitive membership: a legacy onboarding state may hold lowercase
    // keys ('nis2') written by the pre-catalog picker, while cards now carry
    // canonical DB keys ('NIS2'). Without this the legacy card reads as
    // unselected AND can't be cleared, yet the (case-insensitive) step gate
    // still shows the conditional step — see the NIS2-step bug.
    const isSelected = (key: string) => selected.some(s => s.toLowerCase() === key.toLowerCase());

    const toggle = (fw: InstallableFramework) => {
        const has = isSelected(fw.key);
        // Remove every case-variant on deselect (clears a legacy 'nis2'); on
        // select, drop variants then add the canonical key so the stored list
        // stays deduped and canonical.
        const withoutFw = selected.filter(s => s.toLowerCase() !== fw.key.toLowerCase());
        const next = has ? withoutFw : [...withoutFw, fw.key];
        // Keep a key→display-name map alongside the selection so downstream
        // steps (Controls, Review) can label frameworks without re-fetching.
        const labels: Record<string, string> = { ...(data.frameworkLabels || {}) };
        for (const k of Object.keys(labels)) {
            if (k.toLowerCase() === fw.key.toLowerCase()) delete labels[k];
        }
        if (!has) labels[fw.key] = fw.name;
        onUpdate({ selectedFrameworks: next, frameworkLabels: labels });
    };

    return (
        <div className="space-y-default animate-fadeIn">
            <p className="text-sm text-content-muted mb-4">{t('wizard.frameworks.intro')}</p>

            {loading ? (
                <div className="flex items-center gap-tight text-sm text-content-muted py-6" data-testid="fw-loading">
                    <Loader2 className="w-4 h-4 animate-spin" /> {t('wizard.frameworks.loading')}
                </div>
            ) : loadError ? (
                <InlineNotice variant="error" icon={null}>{loadError}</InlineNotice>
            ) : frameworks.length === 0 ? (
                <InlineNotice variant="warning" icon={null}>
                    {t('wizard.frameworks.none')}
                </InlineNotice>
            ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-default">
                    {frameworks.map(fw => {
                        const active = isSelected(fw.key);
                        const badge = frameworkBadge(fw);
                        return (
                            <button key={fw.key} onClick={() => toggle(fw)} data-testid={`fw-${fw.key.toLowerCase()}`}
                                className={`text-left p-4 rounded-lg border-2 transition-colors duration-150 ease-out ${
                                    active ? 'border-[var(--brand-default)] bg-brand-subtle' : 'border-border-subtle bg-bg-default/30 hover:border-border-default'
                                }`}
                            >
                                <div className="flex items-center justify-between mb-2">
                                    <span className="font-semibold text-content-emphasis text-sm">{fw.name}</span>
                                    {badge && <StatusBadge variant="info" size="sm">{t(badge)}</StatusBadge>}
                                </div>
                                {fw.description && <p className="text-xs text-content-muted leading-relaxed">{fw.description}</p>}
                                <p className="mt-2 text-xs text-content-subtle">
                                    {fw.controlCount > 0 && <>{t(fw.controlCount === 1 ? 'wizard.frameworks.installsControl' : 'wizard.frameworks.installsControls', { count: fw.controlCount })}</>}
                                    {t(fw.requirementCount === 1 ? 'wizard.frameworks.requirement' : 'wizard.frameworks.requirements', { count: fw.requirementCount })}
                                </p>
                                {active && <div className="mt-2 flex items-center gap-1 text-brand-400 text-xs font-medium"><CheckCircle2 className="w-3.5 h-3.5" /> {t('wizard.frameworks.selected')}</div>}
                            </button>
                        );
                    })}
                </div>
            )}

            {!loading && !loadError && frameworks.length > 0 && selected.length === 0 && (
                <p className="text-xs text-content-warning">{t('wizard.frameworks.selectAtLeastOne')}</p>
            )}
        </div>
    );
}

// ─── ASSET_SETUP ───

function AssetSetupStep({ data, onUpdate }: { data: StepData; onUpdate: (d: StepData) => void }) {
    const t = useTranslations('onboarding');
    const assets: string[] = data.assets || [];
    const [newAsset, setNewAsset] = useState('');

    const addAsset = () => {
        if (newAsset.trim() && !assets.includes(newAsset.trim())) {
            const next = [...assets, newAsset.trim()];
            onUpdate({ assets: next });
            setNewAsset('');
        }
    };

    // Epic 60 — useEnterSubmit replaces the inline
    // `onKeyDown={(e) => e.key === 'Enter' && addAsset()}`. Wins: IME
    // composition guard (no phantom adds mid-candidate), Shift+Enter
    // preserved for paste-with-newlines, disabled opt-out plumbed.
    const { handleKeyDown: assetKeyDown } = useEnterSubmit({ onSubmit: addAsset });

    const removeAsset = (name: string) => {
        onUpdate({ assets: assets.filter(a => a !== name) });
    };

    return (
        <div className="space-y-default max-w-lg animate-fadeIn">
            <p className="text-sm text-content-muted mb-4">{t('wizard.assets.intro')}</p>
            <div className="flex gap-tight">
                <input className="input flex-1" placeholder={t('wizard.assets.placeholder')} value={newAsset}
                    onChange={(e) => setNewAsset(e.target.value)} onKeyDown={assetKeyDown} data-testid="asset-input" />
                <Button variant="primary" onClick={addAsset}>{t('wizard.assets.add')}</Button>
            </div>
            {assets.length > 0 && (
                <div className="space-y-1">
                    {assets.map(a => (
                        <div key={a} className="flex items-center justify-between bg-bg-default/50 rounded-lg px-3 py-2 text-sm">
                            <div className="flex items-center gap-tight">
                                <Server className="w-3.5 h-3.5 text-content-subtle" />
                                <span className="text-content-emphasis">{a}</span>
                            </div>
                            <button onClick={() => removeAsset(a)} className="text-content-subtle hover:text-content-error text-xs">&times;</button>
                        </div>
                    ))}
                </div>
            )}
            <p className="text-xs text-content-subtle">{t('wizard.assets.importLater')}</p>
        </div>
    );
}

// ─── CONTROL_BASELINE_INSTALL ───

function ControlInstallStep({ data, onUpdate, allData }: { data: StepData; onUpdate: (d: StepData) => void; allData: StepData }) {
    const t = useTranslations('onboarding');
    const selectedFrameworks: string[] = allData['FRAMEWORK_SELECTION']?.selectedFrameworks || [];
    const fwLabels: Record<string, string> = allData['FRAMEWORK_SELECTION']?.frameworkLabels || {};

    return (
        <div className="space-y-default max-w-lg animate-fadeIn">
            <p className="text-sm text-content-muted mb-4">{t('wizard.controls.intro')}</p>
            {selectedFrameworks.length === 0 ? (
                <InlineNotice variant="warning" icon={null}>
                    {t('wizard.controls.frameworksRequired')}
                </InlineNotice>
            ) : (
                <div className="space-y-compact">
                    {selectedFrameworks.map(fw => (
                        <div key={fw} className="flex items-center gap-compact p-3 bg-bg-default/50 rounded-lg">
                            <ShieldCheck className="w-5 h-5 text-brand-400" />
                            <div>
                                <span className="text-sm font-medium text-content-emphasis">{fwLabels[fw] || fw}</span>
                                <p className="text-xs text-content-subtle">{t('wizard.controls.willInstall')}</p>
                            </div>
                            <CheckCircle2 className="w-4 h-4 text-content-success ml-auto" />
                        </div>
                    ))}
                </div>
            )}
            <label className="flex items-center gap-tight text-sm text-content-default cursor-pointer">
                <input type="checkbox" checked={data.confirmed || false} onChange={(e) => onUpdate({ confirmed: e.target.checked })}
                    className="w-4 h-4 rounded border-border-default bg-bg-default text-brand-500 focus:ring-brand-500" />
                {t('wizard.controls.confirm')}
            </label>
        </div>
    );
}

// ─── INITIAL_RISK_REGISTER ───

function RiskRegisterStep({ data, onUpdate }: { data: StepData; onUpdate: (d: StepData) => void }) {
    const t = useTranslations('onboarding');
    return (
        <div className="space-y-default max-w-lg animate-fadeIn">
            <p className="text-sm text-content-muted mb-4">{t('wizard.risks.intro')}</p>
            <div className="p-4 rounded-lg bg-gradient-to-br from-amber-500/10 to-orange-500/10 border border-border-warning">
                <div className="flex items-center gap-compact mb-3">
                    <AlertTriangle className="w-5 h-5 text-content-warning" />
                    <span className="font-medium text-content-emphasis text-sm">{t('wizard.risks.starterTitle')}</span>
                </div>
                <p className="text-xs text-content-muted leading-relaxed">{t('wizard.risks.starterBody')}</p>
            </div>
            <label className="flex items-center gap-tight text-sm text-content-default cursor-pointer">
                <input type="checkbox" checked={data.generate !== false} onChange={(e) => onUpdate({ generate: e.target.checked })}
                    className="w-4 h-4 rounded border-border-default bg-bg-default text-brand-500 focus:ring-brand-500" />
                {t('wizard.risks.generate')}
            </label>
        </div>
    );
}

// ─── TEAM_SETUP ───

function TeamSetupStep({ data, onUpdate }: { data: StepData; onUpdate: (d: StepData) => void }) {
    const t = useTranslations('onboarding');
    const emails: string[] = data.inviteEmails || [];
    const [newEmail, setNewEmail] = useState('');

    const addEmail = () => {
        const email = newEmail.trim().toLowerCase();
        if (email && email.includes('@') && !emails.includes(email)) {
            onUpdate({ inviteEmails: [...emails, email] });
            setNewEmail('');
        }
    };

    // Epic 60 — same Enter-submit story as the asset input above.
    const { handleKeyDown: emailKeyDown } = useEnterSubmit({ onSubmit: addEmail });

    const removeEmail = (email: string) => {
        onUpdate({ inviteEmails: emails.filter(e => e !== email) });
    };

    return (
        <div className="space-y-default max-w-lg animate-fadeIn">
            <p className="text-sm text-content-muted mb-4">{t('wizard.team.intro')}</p>
            <div className="flex gap-tight">
                <input className="input flex-1" placeholder={t('wizard.team.placeholder')} type="email" value={newEmail}
                    onChange={(e) => setNewEmail(e.target.value)} onKeyDown={emailKeyDown} data-testid="invite-email" />
                <Button variant="primary" onClick={addEmail}>{t('wizard.team.invite')}</Button>
            </div>
            {emails.length > 0 && (
                <div className="space-y-1">
                    {emails.map(e => (
                        <div key={e} className="flex items-center justify-between bg-bg-default/50 rounded-lg px-3 py-2 text-sm">
                            <div className="flex items-center gap-tight">
                                <Users className="w-3.5 h-3.5 text-content-subtle" />
                                <span className="text-content-emphasis">{e}</span>
                            </div>
                            <button onClick={() => removeEmail(e)} className="text-content-subtle hover:text-content-error text-xs">&times;</button>
                        </div>
                    ))}
                </div>
            )}
            <p className="text-xs text-content-subtle">{t('wizard.team.inviteLater')}</p>
        </div>
    );
}

// ─── REVIEW_AND_FINISH ───

function ReviewStep({ completedSteps, allData }: { completedSteps: string[]; allData: StepData }) {
    const t = useTranslations('onboarding');
    const summaryItems = [
        { key: 'COMPANY_PROFILE', label: t('wizard.steps.companyProfile'), detail: allData['COMPANY_PROFILE']?.name || t('wizard.review.notConfigured') },
        { key: 'FRAMEWORK_SELECTION', label: t('wizard.steps.frameworks'), detail: (() => {
            const keys: string[] = allData['FRAMEWORK_SELECTION']?.selectedFrameworks || [];
            const labels: Record<string, string> = allData['FRAMEWORK_SELECTION']?.frameworkLabels || {};
            return keys.map(k => labels[k] || k).join(', ') || t('wizard.review.noneSelected');
        })() },
        { key: 'ASSET_SETUP', label: t('wizard.steps.assets'), detail: t('wizard.review.assetsAdded', { count: (allData['ASSET_SETUP']?.assets || []).length }) },
        { key: 'CONTROL_BASELINE_INSTALL', label: t('wizard.steps.controls'), detail: allData['CONTROL_BASELINE_INSTALL']?.confirmed ? t('wizard.review.baselineConfirmed') : t('wizard.review.pendingConfirmation') },
        { key: 'INITIAL_RISK_REGISTER', label: t('wizard.review.riskRegister'), detail: allData['INITIAL_RISK_REGISTER']?.generate !== false ? t('wizard.review.starterWillGenerate') : t('wizard.review.skipped') },
        { key: 'TEAM_SETUP', label: t('wizard.steps.team'), detail: t('wizard.review.invitationsPending', { count: (allData['TEAM_SETUP']?.inviteEmails || []).length }) },
    ];

    return (
        <div className="space-y-default animate-fadeIn">
            <p className="text-sm text-content-muted mb-4">{t('wizard.review.intro')}</p>
            <div className="space-y-tight">
                {summaryItems.map(item => {
                    const done = completedSteps.includes(item.key);
                    return (
                        <div key={item.key} className="flex items-center gap-compact p-3 bg-bg-default/30 rounded-lg" data-testid={`review-${item.key}`}>
                            {done ? (
                                <CheckCircle2 className="w-5 h-5 text-content-success flex-shrink-0" />
                            ) : (
                                <div className="w-5 h-5 rounded-full border-2 border-border-default flex-shrink-0" />
                            )}
                            <div className="flex-1 min-w-0">
                                <span className="text-sm font-medium text-content-emphasis">{item.label}</span>
                                <p className="text-xs text-content-subtle truncate">{item.detail}</p>
                            </div>
                        </div>
                    );
                })}
            </div>
            <InlineNotice variant="success" icon={null}>
                {t('wizard.review.finishNotice')}
            </InlineNotice>
        </div>
    );
}
