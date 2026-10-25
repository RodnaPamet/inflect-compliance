'use client';

/**
 * NIS2 self-assessment onboarding step.
 *
 * Renders the imported NIS2 gap-assessment question set (CC BY 4.0 — see
 * prisma/fixtures/nis2-gap-assessment.LICENSE.md) grouped by domain, with
 * per-answer autosave. Shown by <OnboardingWizard> only when NIS2 is among
 * the selected frameworks. Uses platform primitives throughout — Accordion,
 * RadioGroup, InfoTooltip, StatusBadge — never hand-rolled equivalents.
 *
 * Autosave (PUT per answer) is deliberate: 116 questions is far too many to
 * risk a single submit. The user can leave and resume — this same component
 * is reachable from the NIS2 framework view (resume-later surface).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';

import {
    Accordion,
    AccordionContent,
    AccordionItem,
    AccordionTrigger,
} from '@/components/ui/accordion';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { InfoTooltip } from '@/components/ui/tooltip';
import { StatusBadge } from '@/components/ui/status-badge';
import { Button } from '@/components/ui/button';
import { Loader2 } from 'lucide-react';

// Required CC BY 4.0 attribution — MUST render wherever the questions show.
export const NIS2_ATTRIBUTION_TEXT =
    'NIS2 gap-assessment questions © NISD2 contributors (Kardashev Catalyst UG / nisd2.eu), CC BY 4.0';
const NIS2_SOURCE_URL = 'https://github.com/NISD2/nis2-gap-assessment-schema';

type Bilingual = { en: string; de: string };
type Domain = { id: number; code: string; name: Bilingual; day: number };
type Question = {
    id: string;
    domainId: number;
    text: Bilingual;
    plainText: Bilingual;
    legalBasis: string;
    criticality: string;
    respondent: string;
    consequence: string;
    fineExposure: boolean;
    timeToFix: string;
    day: number;
    dependsOn: string[];
};
type AnswerVal = 'NA' | 'NO' | 'PARTIALLY' | 'YES';
type Answer = { questionId: string; answer: AnswerVal; note: string | null };

type AssessmentState = {
    assessmentId: string;
    status: string;
    domains: Domain[];
    questions: Question[];
    answers: Answer[];
    progress: { answered: number; total: number };
};

const ANSWER_OPTIONS: { value: AnswerVal; label: string }[] = [
    { value: 'NA', label: 'Not applicable' },
    { value: 'NO', label: 'No' },
    { value: 'PARTIALLY', label: 'Partially' },
    { value: 'YES', label: 'Yes' },
];

const RESPONDENT_LABEL: Record<string, string> = {
    CEO: 'CEO / Management',
    IT: 'IT',
    HR: 'HR',
    PROCUREMENT: 'Procurement',
    ANYONE: 'Anyone',
};

function criticalityVariant(c: string): 'error' | 'warning' | 'info' | 'neutral' {
    if (c === 'CRITICAL') return 'error';
    if (c === 'HIGH') return 'warning';
    if (c === 'MEDIUM') return 'info';
    return 'neutral';
}

export function Nis2SelfAssessmentStep({
    tenantSlug,
    onCompleted,
    onSkip,
}: {
    tenantSlug: string;
    onCompleted?: () => void;
    onSkip?: () => void;
}) {
    const t = useTranslations('common.ui');
    const locale = useLocale();
    const lang = locale === 'de' ? 'de' : 'en';
    const [state, setState] = useState<AssessmentState | null>(null);
    const [answers, setAnswers] = useState<Record<string, Answer>>({});
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [savingId, setSavingId] = useState<string | null>(null);
    const [completing, setCompleting] = useState(false);
    const [confirmSkip, setConfirmSkip] = useState(false);

    const base = `/api/t/${tenantSlug}/onboarding/nis2-assessment`;

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const res = await fetch(base);
            if (!res.ok) throw new Error('Failed to load the NIS2 assessment.');
            const data: AssessmentState = await res.json();
            setState(data);
            const map: Record<string, Answer> = {};
            for (const a of data.answers) map[a.questionId] = a;
            setAnswers(map);
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to load the NIS2 assessment.');
        } finally {
            setLoading(false);
        }
    }, [base]);

    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => {
        load();
    }, [load]);

    const saveAnswer = useCallback(
        async (questionId: string, answer: AnswerVal, note: string | null) => {
            setSavingId(questionId);
            setAnswers((prev) => ({ ...prev, [questionId]: { questionId, answer, note } }));
            try {
                const res = await fetch(`${base}/answers/${questionId}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ answer, note }),
                });
                if (!res.ok) throw new Error('Failed to save answer.');
            } catch (e) {
                setError(e instanceof Error ? e.message : 'Failed to save answer.');
            } finally {
                setSavingId(null);
            }
        },
        [base],
    );

    const handleComplete = useCallback(async () => {
        setCompleting(true);
        try {
            const res = await fetch(`${base}/complete`, { method: 'POST' });
            if (!res.ok) throw new Error('Failed to complete the assessment.');
            onCompleted?.();
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to complete the assessment.');
        } finally {
            setCompleting(false);
        }
    }, [base, onCompleted]);

    const questionsByDomain = useMemo(() => {
        const m = new Map<number, Question[]>();
        for (const q of state?.questions ?? []) {
            const list = m.get(q.domainId) ?? [];
            list.push(q);
            m.set(q.domainId, list);
        }
        return m;
    }, [state]);

    if (loading) {
        return (
            <div className="flex items-center gap-tight text-content-muted text-sm">
                <Loader2 className="w-4 h-4 animate-spin" /> Loading the NIS2 self-assessment…
            </div>
        );
    }

    if (error && !state) {
        return <p className="text-sm text-content-error">{error}</p>;
    }
    if (!state) return null;

    const answeredCount = Object.keys(answers).length;
    const total = state.questions.length;
    const overallPct = total ? Math.round((answeredCount / total) * 100) : 0;

    return (
        <div className="space-y-section" data-testid="nis2-self-assessment">
            <div className="space-y-tight">
                <p className="text-sm text-content-muted">
                    You selected NIS2. Answer these gap-assessment questions to find
                    your compliance gaps. Your answers save automatically — you can
                    leave and return any time.
                </p>
                {/* Overall progress */}
                <div className="flex items-center gap-tight">
                    <div className="flex-1 bg-bg-default rounded-full h-2 overflow-hidden">
                        <div
                            className="h-full bg-[var(--brand-default)] rounded-full transition-all duration-500"
                            style={{ width: `${overallPct}%` }}
                        />
                    </div>
                    <span className="text-xs text-content-muted font-medium">
                        {answeredCount}/{total} answered
                    </span>
                </div>
            </div>

            {error && <p className="text-sm text-content-error">{error}</p>}

            <Accordion type="multiple" className="space-y-tight">
                {state.domains.map((domain) => {
                    const qs = questionsByDomain.get(domain.id) ?? [];
                    const domAnswered = qs.filter((q) => answers[q.id]).length;
                    return (
                        <AccordionItem key={domain.id} value={String(domain.id)}>
                            <AccordionTrigger>
                                <span className="flex items-center gap-compact text-left">
                                    <StatusBadge variant="neutral" size="sm">
                                        {domain.code}
                                    </StatusBadge>
                                    <span className="font-medium">{domain.name[lang]}</span>
                                    <span className="text-xs text-content-muted">
                                        {domAnswered}/{qs.length}
                                    </span>
                                </span>
                            </AccordionTrigger>
                            <AccordionContent>
                                <div className="space-y-default">
                                    {qs.map((q) => {
                                        const current = answers[q.id]?.answer;
                                        // dependsOn: dim + collapse when a prerequisite
                                        // is unanswered or answered NO/NA (not yet relevant).
                                        const prereqMet = q.dependsOn.every((dep) => {
                                            const da = answers[dep]?.answer;
                                            return da === 'YES' || da === 'PARTIALLY';
                                        });
                                        const dimmed = q.dependsOn.length > 0 && !prereqMet;
                                        return (
                                            <div
                                                key={q.id}
                                                data-testid={`nis2-question-${q.id}`}
                                                className={
                                                    'rounded-lg border border-border-subtle p-3 space-y-tight ' +
                                                    (dimmed ? 'opacity-60' : '')
                                                }
                                            >
                                                <div className="flex items-start gap-tight flex-wrap">
                                                    <span className="text-sm text-content-default flex-1 min-w-[12rem]">
                                                        {q.plainText[lang]}
                                                    </span>
                                                    <InfoTooltip
                                                        content={q.text[lang]}
                                                        aria-label={t('regulatorWording')}
                                                    />
                                                    <StatusBadge
                                                        variant={criticalityVariant(q.criticality)}
                                                        size="sm"
                                                    >
                                                        {q.criticality}
                                                    </StatusBadge>
                                                </div>
                                                <div className="flex items-center gap-tight flex-wrap text-xs text-content-muted">
                                                    <span className="rounded bg-bg-subtle px-1.5 py-0.5">
                                                        {q.legalBasis}
                                                    </span>
                                                    <span className="rounded bg-bg-subtle px-1.5 py-0.5">
                                                        Best answered by: {RESPONDENT_LABEL[q.respondent] ?? q.respondent}
                                                    </span>
                                                    {dimmed && (
                                                        <span className="italic">
                                                            depends on {q.dependsOn.join(', ')}
                                                        </span>
                                                    )}
                                                </div>
                                                <RadioGroup
                                                    className="flex flex-wrap gap-compact"
                                                    value={current ?? ''}
                                                    onValueChange={(v) =>
                                                        saveAnswer(q.id, v as AnswerVal, answers[q.id]?.note ?? null)
                                                    }
                                                >
                                                    {ANSWER_OPTIONS.map((opt) => (
                                                        <label
                                                            key={opt.value}
                                                            className="flex items-center gap-tight text-sm cursor-pointer"
                                                        >
                                                            <RadioGroupItem value={opt.value} />
                                                            {opt.label}
                                                        </label>
                                                    ))}
                                                </RadioGroup>
                                                <NoteField
                                                    initial={answers[q.id]?.note ?? ''}
                                                    saving={savingId === q.id}
                                                    onSave={(note) =>
                                                        saveAnswer(
                                                            q.id,
                                                            (answers[q.id]?.answer ?? 'NA') as AnswerVal,
                                                            note || null,
                                                        )
                                                    }
                                                    disabled={!current}
                                                />
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
                        <span className="text-content-muted">
                            You can complete this later from the NIS2 dashboard.
                        </span>
                        <Button variant="ghost" size="sm" onClick={() => setConfirmSkip(false)}>
                            Keep going
                        </Button>
                        <Button variant="secondary" size="sm" onClick={() => onSkip?.()}>
                            Skip for now
                        </Button>
                    </div>
                ) : (
                    <Button variant="ghost" size="sm" onClick={() => setConfirmSkip(true)}>
                        Skip for now
                    </Button>
                )}
                <Button variant="primary" onClick={handleComplete} disabled={completing}>
                    {completing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                    Complete assessment
                </Button>
            </div>

            {/* Hand-off to the lifecycle home — this run becomes assessment #1 in
                the NIS2 gap history on the Audits page, where you can re-run it,
                track the trend, and turn priority gaps into remediation. */}
            <a
                href={`/t/${tenantSlug}/audits/nis2-gap`}
                className="inline-block text-sm text-brand-default underline hover:text-content-emphasis"
            >
                View your NIS2 Gap Assessment →
            </a>

            {/* CC BY 4.0 attribution — required wherever the questions render */}
            <p className="text-xs text-content-subtle">
                {NIS2_ATTRIBUTION_TEXT}{' '}
                <a
                    href={NIS2_SOURCE_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline hover:text-content-muted"
                >
                    source
                </a>
            </p>
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
                Add a note
            </button>
        );
    }
    return (
        <textarea
            className="w-full rounded-md border border-border-subtle bg-bg-default p-2 text-sm"
            rows={2}
            placeholder="Optional note (saved automatically)…"
            value={val}
            disabled={saving}
            onChange={(e) => setVal(e.target.value)}
            onBlur={() => {
                if (val !== initial) onSave(val);
            }}
        />
    );
}
