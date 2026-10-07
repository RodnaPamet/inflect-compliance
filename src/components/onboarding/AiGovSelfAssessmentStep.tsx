'use client';

/**
 * Unified AI-governance self-assessment onboarding step.
 *
 * Renders the 30-question AI-governance self-assessment (AISVS / ISO 42001 /
 * EU AI Act) grouped by domain, with per-answer autosave. ONE answer set
 * produces THREE coverage readouts — shown as KPIStat cards at the top. Shown
 * by <OnboardingWizard> only when an AI framework is selected (or the AI-systems
 * flag). Platform primitives throughout — Accordion, RadioGroup, InfoTooltip,
 * StatusBadge, KPIStat, ToggleGroup.
 *
 * This is a self-assessment AID, NOT legal advice (rendered below).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';

import {
    Accordion,
    AccordionContent,
    AccordionItem,
    AccordionTrigger,
} from '@/components/ui/accordion';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { InfoTooltip } from '@/components/ui/tooltip';
import { StatusBadge } from '@/components/ui/status-badge';
import { KPIStat } from '@/components/ui/metric';
import { ToggleGroup } from '@/components/ui/toggle-group';
import { Button } from '@/components/ui/button';
import { LoadingSpinner } from '@inflect/ui/components/ui/icons/loading-spinner';

// Required attribution — AISVS is CC-BY-SA-4.0; rendered wherever questions
// show via `onboarding.aiGov.attribution` / `.disclaimer`.
const AISVS_SOURCE_URL = 'https://github.com/OWASP/AISVS';

type AiGovT = ReturnType<typeof useTranslations>;

type Architecture = 'NONE' | 'RAG' | 'AGENTIC' | 'BOTH';
type AnswerVal = 'NA' | 'NO' | 'PARTIALLY' | 'YES';
type Mappings = { aisvs: string[]; iso42001: string[]; euAiAct: string[] };
type Domain = { id: number; code: string; name: string };
type Question = {
    id: string;
    domainId: number;
    text: string;
    criticality: string;
    conditional: string | null;
    mappings: Mappings;
    applicable: boolean;
    answer: AnswerVal | null;
};
type CoverageCell = { percent: number | null };
type Coverage = {
    aisvs: CoverageCell;
    iso42001: CoverageCell;
    euAiAct: CoverageCell;
    overall: CoverageCell;
    byDomain: Array<{ domainId: number; percent: number | null }>;
    criticalGaps: string[];
    answered: number;
    total: number;
};
type AssessmentState = {
    assessmentId: string;
    status: string;
    architecture: Architecture;
    domains: Domain[];
    questions: Question[];
    coverage: Coverage;
};

function buildAnswerOptions(t: AiGovT): { value: AnswerVal; label: string }[] {
    return [
        { value: 'NA', label: t('aiGov.answer.na') },
        { value: 'NO', label: t('aiGov.answer.no') },
        { value: 'PARTIALLY', label: t('aiGov.answer.partially') },
        { value: 'YES', label: t('aiGov.answer.yes') },
    ];
}

function buildArchOptions(t: AiGovT) {
    return [
        { value: 'NONE', label: t('aiGov.arch.none') },
        { value: 'RAG', label: t('aiGov.arch.rag') },
        { value: 'AGENTIC', label: t('aiGov.arch.agentic') },
        { value: 'BOTH', label: t('aiGov.arch.both') },
    ];
}

function criticalityVariant(c: string): 'error' | 'warning' | 'info' | 'neutral' {
    if (c === 'CRITICAL') return 'error';
    if (c === 'HIGH') return 'warning';
    if (c === 'MEDIUM') return 'info';
    return 'neutral';
}

function mappingSummary(m: Mappings): string {
    const parts: string[] = [];
    if (m.aisvs.length) parts.push(`AISVS ${m.aisvs.join(', ')}`);
    if (m.iso42001.length) parts.push(`ISO 42001 ${m.iso42001.join(', ')}`);
    if (m.euAiAct.length) parts.push(`EU AI Act ${m.euAiAct.join(', ')}`);
    return parts.join(' · ');
}

function pct(c: CoverageCell): string {
    return c.percent == null ? '—' : `${c.percent}%`;
}

export function AiGovSelfAssessmentStep({
    tenantSlug,
    onCompleted,
    onSkip,
}: {
    tenantSlug: string;
    onCompleted?: () => void;
    onSkip?: () => void;
}) {
    const t = useTranslations('onboarding');
    const answerOptions = buildAnswerOptions(t);
    const archOptions = buildArchOptions(t);
    const [state, setState] = useState<AssessmentState | null>(null);
    const [answers, setAnswers] = useState<Record<string, { answer: AnswerVal; note: string | null }>>({});
    const [architecture, setArchitecture] = useState<Architecture>('NONE');
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [savingId, setSavingId] = useState<string | null>(null);
    const [completing, setCompleting] = useState(false);
    const [materializing, setMaterializing] = useState(false);
    const [materializeMsg, setMaterializeMsg] = useState<string | null>(null);
    const [confirmSkip, setConfirmSkip] = useState(false);

    const base = `/api/t/${tenantSlug}/onboarding/ai-gov-assessment`;

    const load = useCallback(async (arch: Architecture) => {
        setLoading(true);
        try {
            const res = await fetch(`${base}?architecture=${arch}`);
            if (!res.ok) throw new Error(t('aiGov.loadError'));
            const data: AssessmentState = await res.json();
            setState(data);
            const map: Record<string, { answer: AnswerVal; note: string | null }> = {};
            for (const q of data.questions) {
                if (q.answer) map[q.id] = { answer: q.answer, note: null };
            }
            setAnswers(map);
        } catch (e) {
            setError(e instanceof Error ? e.message : t('aiGov.loadError'));
        } finally {
            setLoading(false);
        }
    }, [base, t]);

    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => {
        load(architecture);
    }, [load, architecture]);

    const saveAnswer = useCallback(
        async (questionId: string, answer: AnswerVal, note: string | null) => {
            setSavingId(questionId);
            setAnswers((prev) => ({ ...prev, [questionId]: { answer, note } }));
            try {
                const res = await fetch(`${base}/answers/${questionId}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ answer, note }),
                });
                if (!res.ok) throw new Error(t('aiGov.saveError'));
                // Refresh the coverage readout after a save (cheap, keeps the
                // three cards live) without blocking the UI.
                load(architecture);
            } catch (e) {
                setError(e instanceof Error ? e.message : t('aiGov.saveError'));
            } finally {
                setSavingId(null);
            }
        },
        [base, load, architecture, t],
    );

    const handleComplete = useCallback(async () => {
        setCompleting(true);
        try {
            const res = await fetch(`${base}/complete`, { method: 'POST' });
            if (!res.ok) throw new Error(t('aiGov.completeError'));
            onCompleted?.();
        } catch (e) {
            setError(e instanceof Error ? e.message : t('aiGov.completeError'));
        } finally {
            setCompleting(false);
        }
    }, [base, onCompleted, t]);

    const handleMaterialize = useCallback(async () => {
        setMaterializing(true);
        setMaterializeMsg(null);
        try {
            const res = await fetch(`${base}/materialize`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ architecture }),
            });
            if (!res.ok) throw new Error(t('aiGov.findingsError'));
            const data: { created: string[] } = await res.json();
            setMaterializeMsg(
                data.created.length
                    ? t(data.created.length === 1 ? 'aiGov.materializeCreatedOne' : 'aiGov.materializeCreatedMany', { count: data.created.length })
                    : t('aiGov.materializeNone'),
            );
        } catch (e) {
            setError(e instanceof Error ? e.message : t('aiGov.findingsError'));
        } finally {
            setMaterializing(false);
        }
    }, [base, architecture, t]);

    const questionsByDomain = useMemo(() => {
        const m = new Map<number, Question[]>();
        for (const q of state?.questions ?? []) {
            const list = m.get(q.domainId) ?? [];
            list.push(q);
            m.set(q.domainId, list);
        }
        return m;
    }, [state]);

    if (loading && !state) {
        return (
            <div className="flex items-center gap-tight text-content-muted text-sm">
                <LoadingSpinner className="w-4 h-4" /> {t('aiGov.loading')}
            </div>
        );
    }
    if (error && !state) return <p className="text-sm text-content-error">{error}</p>;
    if (!state) return null;

    const cov = state.coverage;

    return (
        <div className="space-y-section" data-testid="ai-gov-self-assessment">
            <div className="space-y-tight">
                <p className="text-sm text-content-muted">
                    {t('aiGov.intro')}
                </p>
                {/* Architecture selector — gates the RAG / agentic questions. */}
                <div className="flex items-center gap-tight flex-wrap">
                    <span className="text-xs text-content-muted">{t('aiGov.systemType')}</span>
                    <ToggleGroup
                        size="sm"
                        ariaLabel={t('aiGov.archAriaLabel')}
                        options={archOptions}
                        selected={architecture}
                        selectAction={(v) => setArchitecture(v as Architecture)}
                    />
                </div>
            </div>

            {/* The 3-way coverage cards — the differentiator. */}
            <div className="grid grid-cols-1 gap-default sm:grid-cols-3" data-testid="ai-gov-coverage-cards">
                <KPIStat value={pct(cov.aisvs)} label={t('aiGov.covAisvs')} data-testid="ai-gov-cov-aisvs" />
                <KPIStat value={pct(cov.iso42001)} label={t('aiGov.covIso')} data-testid="ai-gov-cov-iso42001" />
                <KPIStat value={pct(cov.euAiAct)} label={t('aiGov.covEuAiAct')} data-testid="ai-gov-cov-eu-ai-act" />
            </div>

            {cov.criticalGaps.length > 0 && (
                <div
                    className="rounded-lg border border-border-emphasis bg-bg-subtle px-3 py-2 text-sm text-content-default"
                    data-testid="ai-gov-critical-gaps"
                >
                    <strong>{t(cov.criticalGaps.length === 1 ? 'aiGov.criticalGap' : 'aiGov.criticalGaps', { count: cov.criticalGaps.length })}</strong>{' '}
                    {t('aiGov.criticalGapsSuffix')}
                </div>
            )}

            {error && <p className="text-sm text-content-error">{error}</p>}

            <Accordion type="multiple" className="space-y-tight">
                {state.domains.map((domain) => {
                    const qs = questionsByDomain.get(domain.id) ?? [];
                    const domAnswered = qs.filter((q) => answers[q.id] || !q.applicable).length;
                    return (
                        <AccordionItem key={domain.id} value={String(domain.id)}>
                            <AccordionTrigger>
                                <span className="flex items-center gap-compact text-left">
                                    <StatusBadge variant="neutral" size="sm">D{domain.id}</StatusBadge>
                                    <span className="font-medium">{domain.name}</span>
                                    <span className="text-xs text-content-muted">{domAnswered}/{qs.length}</span>
                                </span>
                            </AccordionTrigger>
                            <AccordionContent>
                                <div className="space-y-default">
                                    {qs.map((q) => {
                                        const current = answers[q.id]?.answer;
                                        const naByArch = !q.applicable;
                                        return (
                                            <div
                                                key={q.id}
                                                data-testid={`ai-gov-question-${q.id}`}
                                                className={
                                                    'rounded-lg border border-border-subtle p-3 space-y-tight ' +
                                                    (naByArch ? 'opacity-60' : '')
                                                }
                                            >
                                                <div className="flex items-start gap-tight flex-wrap">
                                                    <span className="text-sm text-content-default flex-1 min-w-[12rem]">
                                                        {q.text}
                                                    </span>
                                                    <InfoTooltip
                                                        content={t('aiGov.mapsTo', { summary: mappingSummary(q.mappings) })}
                                                        aria-label={t('aiGov.showReferences')}
                                                    />
                                                    <StatusBadge variant={criticalityVariant(q.criticality)} size="sm">
                                                        {q.criticality}
                                                    </StatusBadge>
                                                </div>
                                                {naByArch ? (
                                                    <p className="text-xs italic text-content-muted">
                                                        {t('aiGov.notApplicable', { conditional: q.conditional ?? '' })}
                                                    </p>
                                                ) : (
                                                    <>
                                                        <RadioGroup
                                                            className="flex flex-wrap gap-compact"
                                                            value={current ?? ''}
                                                            onValueChange={(v) =>
                                                                saveAnswer(q.id, v as AnswerVal, answers[q.id]?.note ?? null)
                                                            }
                                                        >
                                                            {answerOptions.map((opt) => (
                                                                <label key={opt.value} className="flex items-center gap-tight text-sm cursor-pointer">
                                                                    <RadioGroupItem value={opt.value} />
                                                                    {opt.label}
                                                                </label>
                                                            ))}
                                                        </RadioGroup>
                                                        <NoteField
                                                            initial={answers[q.id]?.note ?? ''}
                                                            saving={savingId === q.id}
                                                            onSave={(note) =>
                                                                saveAnswer(q.id, (answers[q.id]?.answer ?? 'NA') as AnswerVal, note || null)
                                                            }
                                                            disabled={!current}
                                                        />
                                                    </>
                                                )}
                                            </div>
                                        );
                                    })}
                                </div>
                            </AccordionContent>
                        </AccordionItem>
                    );
                })}
            </Accordion>

            {/* Footer actions */}
            <div className="flex items-center justify-between gap-compact border-t border-border-subtle pt-4">
                {confirmSkip ? (
                    <div className="flex items-center gap-tight text-sm">
                        <span className="text-content-muted">{t('aiGov.youCanCompleteLater')}</span>
                        <Button variant="ghost" size="sm" onClick={() => setConfirmSkip(false)}>{t('aiGov.keepGoing')}</Button>
                        <Button variant="secondary" size="sm" onClick={() => onSkip?.()}>{t('aiGov.skipForNow')}</Button>
                    </div>
                ) : (
                    <Button variant="ghost" size="sm" onClick={() => setConfirmSkip(true)}>{t('aiGov.skipForNow')}</Button>
                )}
                <div className="flex items-center gap-tight">
                    <Button variant="secondary" size="sm" onClick={handleMaterialize} disabled={materializing} data-testid="ai-gov-materialize">
                        {materializing ? <LoadingSpinner className="w-3.5 h-3.5" /> : null}
                        {t('aiGov.createFindings')}
                    </Button>
                    <Button variant="primary" onClick={handleComplete} disabled={completing}>
                        {completing ? <LoadingSpinner className="w-3.5 h-3.5" /> : null}
                        {t('aiGov.completeAssessment')}
                    </Button>
                </div>
            </div>
            {materializeMsg && <p className="text-xs text-content-muted">{materializeMsg}</p>}

            {/* Attribution + the not-legal-advice disclaimer — required wherever questions render */}
            <div className="space-y-tight">
                <p className="text-xs text-content-subtle" data-testid="ai-gov-disclaimer">{t('aiGov.disclaimer')}</p>
                <p className="text-xs text-content-subtle">
                    {t('aiGov.attribution')}{' '}
                    <a href={AISVS_SOURCE_URL} target="_blank" rel="noopener noreferrer" className="underline hover:text-content-muted">
                        {t('aiGov.aisvsSource')}
                    </a>
                </p>
            </div>
        </div>
    );
}

/** Collapsed-by-default optional note for one answer; saves on blur. */
function NoteField({
    initial,
    saving,
    onSave,
    disabled,
}: {
    initial: string;
    saving: boolean;
    onSave: (note: string) => void;
    disabled: boolean;
}) {
    const t = useTranslations('onboarding');
    const [open, setOpen] = useState(initial.trim() !== '');
    const [val, setVal] = useState(initial);
    if (disabled) return null;
    if (!open) {
        return (
            <button
                type="button"
                onClick={() => setOpen(true)}
                className="text-xs text-content-muted underline hover:text-content-default"
            >
                {t('aiGov.addNote')}
            </button>
        );
    }
    return (
        <textarea
            className="w-full rounded-md border border-border-subtle bg-bg-default p-2 text-sm"
            rows={2}
            placeholder={t('aiGov.notePlaceholder')}
            value={val}
            disabled={saving}
            onChange={(e) => setVal(e.target.value)}
            onBlur={() => {
                if (val !== initial) onSave(val);
            }}
        />
    );
}
