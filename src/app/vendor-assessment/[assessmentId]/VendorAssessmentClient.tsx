'use client';
/* TODO(swr-migration): this file has fetch-on-mount + setState
 * patterns flagged by react-hooks/set-state-in-effect. Each call site
 * carries an inline disable directive; collectively they should
 * migrate to useTenantSWR (Epic 69 shape) so the rule can lift. */

/**
 * Epic G-3 — vendor-facing response form (public, token-gated).
 *
 * Three states:
 *
 *   • LOADING   — fetching the assessment + template
 *   • READY     — form rendered, vendor fills in answers
 *   • SUBMITTED — confirmation screen
 *
 * Plus terminal error states for `expired` / `wrong_status` (link no
 * longer active) and any other fetch failure.
 *
 * The component is intentionally minimal — no app-shell chrome, no
 * tenant-context dependency, no internal admin concepts. Vendors
 * see only what they need.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Heading } from '@/components/ui/typography';
import { formatDate } from '@/lib/format-date';
import { RequiredMarker } from '@/components/ui/required-marker';

interface Question {
    id: string;
    sortOrder: number;
    prompt: string;
    answerType:
        | 'YES_NO'
        | 'SINGLE_SELECT'
        | 'MULTI_SELECT'
        | 'TEXT'
        | 'NUMBER'
        | 'SCALE'
        | 'FILE_UPLOAD';
    required: boolean;
    weight: number;
    optionsJson: unknown;
    scaleConfigJson: unknown;
}
interface Section {
    id: string;
    sortOrder: number;
    title: string;
    description: string | null;
    questions: Question[];
}
interface LoadResponse {
    assessmentId: string;
    status: string;
    expiresAtIso: string | null;
    vendor: { name: string };
    template: {
        name: string;
        description: string | null;
        sections: Section[];
    };
    answers: Array<{ questionId: string; answerJson: unknown }>;
}

type Phase = 'loading' | 'ready' | 'submitted' | 'error';

export function VendorAssessmentClient({
    assessmentId,
    initialToken,
}: {
    assessmentId: string;
    initialToken: string;
}) {
    const t = useTranslations('external.vendorAssessment');
    const [phase, setPhase] = useState<Phase>('loading');
    const [errorReason, setErrorReason] = useState<string | null>(null);
    const [data, setData] = useState<LoadResponse | null>(null);
    const [answers, setAnswers] = useState<Record<string, unknown>>({});
    const [submitting, setSubmitting] = useState(false);
    const [submitErrors, setSubmitErrors] = useState<
        Array<{ questionId: string | null; message: string }>
    >([]);

    const load = useCallback(async () => {
        if (!initialToken) return;
        setPhase('loading');
        try {
            const res = await fetch(
                `/api/vendor-assessment/${assessmentId}?t=${encodeURIComponent(initialToken)}`,
            );
            if (!res.ok) {
                const body = (await res
                    .json()
                    .catch(() => ({}))) as { reason?: string };
                setPhase('error');
                setErrorReason(body.reason ?? 'unknown');
                return;
            }
            const payload = (await res.json()) as LoadResponse;
            setData(payload);
            // Pre-populate from existing answers if any.
            const initial: Record<string, unknown> = {};
            for (const a of payload.answers) initial[a.questionId] = a.answerJson;
            setAnswers(initial);
            setPhase('ready');
        } catch {
            // A thrown fetch is a TRANSPORT failure — the respondent is
            // offline, or on hotel wifi, or the request was aborted. It says
            // nothing about the invitation. Mapping it to the same
            // "no longer active" screen as a revoked token tells someone with
            // a perfectly good link that it has been cancelled, and offers
            // them no way to try again.
            setPhase('error');
            setErrorReason('network');
        }
    }, [assessmentId, initialToken]);

    // There is no draft-save on this surface — nothing PATCHes partial
    // answers, which is also why the IN_PROGRESS status is unreachable
    // anywhere in the codebase. Until that exists, the least we can do is not
    // let a stray back-navigation or tab close silently discard a
    // half-completed questionnaire the respondent may have spent an hour on.
    const hasUnsavedAnswers =
        phase === 'ready' && Object.values(answers).some((v) => {
            if (v == null) return false;
            if (typeof v === 'string') return v.trim().length > 0;
            if (Array.isArray(v)) return v.length > 0;
            if (typeof v === 'object' && 'value' in (v as object)) {
                const inner = (v as { value: unknown }).value;
                return inner != null && String(inner).trim().length > 0;
            }
            return true;
        });

    useEffect(() => {
        if (!hasUnsavedAnswers) return;
        const onBeforeUnload = (e: BeforeUnloadEvent) => {
            e.preventDefault();
            // Browsers ignore custom text now and show their own copy; the
            // assignment is still required to trigger the prompt at all.
            e.returnValue = '';
        };
        window.addEventListener('beforeunload', onBeforeUnload);
        return () => window.removeEventListener('beforeunload', onBeforeUnload);
    }, [hasUnsavedAnswers]);

    useEffect(() => {
        if (!initialToken) {
            // eslint-disable-next-line react-hooks/set-state-in-effect
            setPhase('error');
            setErrorReason('missing_token');
            return;
        }
        void load();
        // `load` is stable for a given (assessmentId, token) pair.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [assessmentId, initialToken]);

    if (phase === 'loading') {
        return (
            <div className="min-h-screen flex items-center justify-center bg-bg-subtle">
                <p className="text-sm text-content-subtle">{t('loading')}</p>
            </div>
        );
    }

    if (phase === 'error') {
        return (
            <div className="min-h-screen flex items-center justify-center bg-bg-subtle p-6">
                <div
                    className="max-w-md text-center bg-bg-default p-8 rounded-lg shadow"
                    data-testid="vendor-assessment-error"
                >
                    <h1 className="text-xl font-semibold text-content-emphasis mb-2">
                        {/* Three distinct situations that used to share one
                            screen. A missing token is not a dead link — the
                            reminder email deliberately omits it. A network
                            failure is not a dead link either; it says nothing
                            about the invitation at all. */}
                        {errorReason === 'missing_token'
                            ? t('missingTokenTitle')
                            : errorReason === 'network'
                                ? t('networkTitle')
                                : t('errorTitle')}
                    </h1>
                    <p className="text-sm text-content-muted">
                        {errorReason === 'missing_token'
                            ? t('errorMissingToken')
                            : errorReason === 'network'
                                ? t('errorNetwork')
                                : errorReason === 'expired'
                                    ? t('errorExpired')
                                    : errorReason === 'wrong_status'
                                        ? t('errorWrongStatus')
                                        : t('errorDefault')}
                    </p>
                    {errorReason === 'network' && (
                        <button
                            type="button"
                            onClick={() => void load()}
                            data-testid="vendor-assessment-retry"
                            className="mt-4 inline-flex items-center justify-center rounded-md border border-border-subtle px-4 py-2 text-sm font-medium text-content-default hover:bg-bg-muted"
                        >
                            {t('retry')}
                        </button>
                    )}
                </div>
            </div>
        );
    }

    if (phase === 'submitted') {
        return (
            <div className="min-h-screen flex items-center justify-center bg-bg-subtle p-6">
                <div
                    className="max-w-md text-center bg-bg-default p-8 rounded-lg shadow"
                    data-testid="vendor-assessment-submitted"
                >
                    <h1 className="text-xl font-semibold text-content-emphasis mb-2">
                        {t('submittedTitle')}
                    </h1>
                    <p className="text-sm text-content-muted">
                        {t('submittedBody')}
                    </p>
                </div>
            </div>
        );
    }

    if (!data) return null;

    async function handleSubmit() {
        setSubmitting(true);
        setSubmitErrors([]);
        try {
            const payload = Object.entries(answers).map(([questionId, value]) => ({
                questionId,
                answerJson: { value },
                evidenceId: null,
            }));
            const res = await fetch(
                `/api/vendor-assessment/${assessmentId}/submit`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ token: initialToken, answers: payload }),
                },
            );
            if (!res.ok) {
                const body = (await res.json().catch(() => ({}))) as {
                    error?: string;
                    fieldErrors?: Array<{
                        questionId: string | null;
                        message: string;
                    }>;
                    reason?: string;
                };
                if (body.error === 'validation_failed' && body.fieldErrors) {
                    setSubmitErrors(body.fieldErrors);
                    return;
                }
                if (body.error === 'access_denied') {
                    // Do NOT switch to the error phase here. There is no
                    // draft-save on this surface, so replacing the form with
                    // an error screen destroys every answer the respondent
                    // has typed — with no export and no way back. Report it
                    // in place instead, so the text is still on screen and
                    // can be copied out while they ask for a fresh link.
                    setSubmitErrors([
                        {
                            questionId: null,
                            message:
                                body.reason === 'revoked'
                                    ? t('submitRevoked')
                                    : body.reason === 'expired'
                                        ? t('submitExpired')
                                        : t('submitAccessDenied'),
                        },
                    ]);
                    return;
                }
                setSubmitErrors([
                    {
                        questionId: null,
                        message: t('submitFailed'),
                    },
                ]);
                return;
            }
            setPhase('submitted');
        } catch {
            // try/finally with NO catch: a dropped connection during submit
            // un-spun the button and did nothing else, so the respondent had
            // no idea whether their answers had been received. They had
            // typed the whole form by this point.
            setSubmitErrors([
                { questionId: null, message: t('submitNetworkFailed') },
            ]);
        } finally {
            setSubmitting(false);
        }
    }

    return (
        <div className="min-h-screen bg-bg-subtle py-10 px-4">
            <div
                className="max-w-2xl mx-auto bg-bg-default rounded-lg shadow p-8"
                data-testid="vendor-assessment-form"
            >
                <header className="border-b pb-4 mb-6">
                    <p className="text-xs uppercase tracking-wide text-content-subtle">
                        {t('headerFor', { vendor: data.vendor.name })}
                    </p>
                    <Heading level={1} className="text-content-emphasis mt-1">
                        {data.template.name}
                    </Heading>
                    {data.template.description && (
                        <p className="text-sm text-content-muted mt-2">
                            {data.template.description}
                        </p>
                    )}
                    {/* The payload has carried expiresAtIso all along and the
                        page never rendered it, so the respondent had no way
                        to know how long they had — and no warning before a
                        mid-form expiry threw their answers away. */}
                    {data.expiresAtIso && (
                        <p
                            className="text-sm text-content-muted mt-2"
                            data-testid="vendor-assessment-deadline"
                        >
                            {t('deadline', {
                                date: formatDate(data.expiresAtIso),
                            })}
                        </p>
                    )}
                </header>

                {submitErrors.length > 0 && (
                    <div
                        className="border border-border-error bg-bg-error-emphasis text-content-error text-sm p-4 rounded mb-4"
                        role="alert"
                        data-testid="vendor-assessment-submit-errors"
                    >
                        <strong>{t('fixErrors')}</strong>
                        <ul className="mt-2 list-disc list-inside">
                            {submitErrors.map((e, i) => (
                                <li key={`${e.questionId ?? 'global'}:${i}`}>
                                    {e.message}
                                </li>
                            ))}
                        </ul>
                    </div>
                )}

                <form
                    onSubmit={(e) => {
                        e.preventDefault();
                        handleSubmit();
                    }}
                    className="space-y-page"
                >
                    {data.template.sections.map((section) => (
                        <section key={section.id}>
                            <Heading level={2} className="text-content-emphasis mb-1">
                                {section.title}
                            </Heading>
                            {section.description && (
                                <p className="text-sm text-content-muted mb-4">
                                    {section.description}
                                </p>
                            )}
                            <div className="space-y-default">
                                {section.questions.map((q) => (
                                    <QuestionField
                                        key={q.id}
                                        question={q}
                                        value={answers[q.id]}
                                        onChange={(v) =>
                                            setAnswers((prev) => ({
                                                ...prev,
                                                [q.id]: v,
                                            }))
                                        }
                                    />
                                ))}
                            </div>
                        </section>
                    ))}

                    <div className="flex justify-end pt-4 border-t">
                        <button
                            type="submit"
                            disabled={submitting}
                            data-testid="vendor-assessment-submit-btn"
                            className="bg-brand-default text-content-inverted px-6 py-2 rounded-md font-medium disabled:opacity-50"
                        >
                            {submitting ? t('submitting') : t('submit')}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}

function QuestionField({
    question,
    value,
    onChange,
}: {
    question: Question;
    value: unknown;
    onChange: (v: unknown) => void;
}) {
    const t = useTranslations('external.vendorAssessment');
    const tCommon = useTranslations('common');
    const baseLabel = (
        <label className="block text-sm font-medium text-content-emphasis mb-1">
            {question.prompt}
            {question.required && <RequiredMarker />}
        </label>
    );

    switch (question.answerType) {
        case 'YES_NO':
            return (
                <div data-testid={`q-${question.id}`}>
                    {baseLabel}
                    <div className="flex gap-default">
                        {['yes', 'no'].map((opt) => (
                            <label
                                key={opt}
                                className="inline-flex items-center text-sm text-content-default"
                            >
                                <input
                                    type="radio"
                                    name={question.id}
                                    value={opt}
                                    checked={value === opt}
                                    onChange={() => onChange(opt)}
                                    className="mr-2"
                                />
                                {opt === 'yes' ? tCommon('yes') : tCommon('no')}
                            </label>
                        ))}
                    </div>
                </div>
            );

        case 'TEXT':
            return (
                <div data-testid={`q-${question.id}`}>
                    {baseLabel}
                    <textarea
                        value={typeof value === 'string' ? value : ''}
                        onChange={(e) => onChange(e.target.value)}
                        rows={4}
                        className="w-full border border-border-subtle rounded-md px-3 py-2 text-sm"
                    />
                </div>
            );

        case 'NUMBER':
            return (
                <div data-testid={`q-${question.id}`}>
                    {baseLabel}
                    <input
                        type="text"
                        inputMode="decimal"
                        pattern="-?[0-9]*\.?[0-9]*"
                        value={typeof value === 'number' ? String(value) : ''}
                        onChange={(e) => {
                            const txt = e.target.value;
                            if (txt === '') return onChange(null);
                            const n = Number(txt);
                            onChange(Number.isFinite(n) ? n : null);
                        }}
                        className="border border-border-subtle rounded-md px-3 py-2 text-sm w-40"
                    />
                </div>
            );

        case 'SCALE': {
            const cfg = question.scaleConfigJson as
                | { min?: number; max?: number; labels?: string[] }
                | null;
            const min = cfg?.min ?? 1;
            const max = cfg?.max ?? 5;
            const labels = cfg?.labels;
            const cur = typeof value === 'number' ? value : null;
            return (
                <div data-testid={`q-${question.id}`}>
                    {baseLabel}
                    <div className="flex items-center gap-tight">
                        {Array.from(
                            { length: max - min + 1 },
                            (_, i) => i + min,
                        ).map((n) => (
                            <button
                                key={n}
                                type="button"
                                onClick={() => onChange(n)}
                                className={`w-9 h-9 rounded-full border text-sm ${
                                    cur === n
                                        ? 'bg-brand-default text-content-inverted border-brand-default'
                                        : 'bg-bg-default text-content-default border-border-subtle'
                                }`}
                            >
                                {n}
                            </button>
                        ))}
                    </div>
                    {labels && labels.length >= 2 && (
                        <div className="flex justify-between text-xs text-content-subtle mt-1 max-w-xs">
                            <span>{labels[0]}</span>
                            <span>{labels[labels.length - 1]}</span>
                        </div>
                    )}
                </div>
            );
        }

        case 'SINGLE_SELECT':
        case 'MULTI_SELECT': {
            const opts = Array.isArray(question.optionsJson)
                ? (question.optionsJson as Array<{
                      label: string;
                      value: string;
                  }>)
                : [];
            const isMulti = question.answerType === 'MULTI_SELECT';
            const arrValue = Array.isArray(value)
                ? (value as string[])
                : [];
            return (
                <div data-testid={`q-${question.id}`}>
                    {baseLabel}
                    <div className="space-y-1">
                        {opts.map((o) => {
                            const checked = isMulti
                                ? arrValue.includes(o.value)
                                : value === o.value;
                            return (
                                <label
                                    key={o.value}
                                    className="flex items-center text-sm text-content-default"
                                >
                                    <input
                                        type={isMulti ? 'checkbox' : 'radio'}
                                        name={question.id}
                                        value={o.value}
                                        checked={checked}
                                        onChange={() => {
                                            if (isMulti) {
                                                const next = checked
                                                    ? arrValue.filter(
                                                          (v) => v !== o.value,
                                                      )
                                                    : [...arrValue, o.value];
                                                onChange(next);
                                            } else {
                                                onChange(o.value);
                                            }
                                        }}
                                        className="mr-2"
                                    />
                                    {o.label}
                                </label>
                            );
                        })}
                    </div>
                </div>
            );
        }

        case 'FILE_UPLOAD':
            return (
                <div data-testid={`q-${question.id}`}>
                    {baseLabel}
                    <p className="text-xs text-content-subtle italic">
                        {t('fileUploadHint')}
                    </p>
                    <textarea
                        value={typeof value === 'string' ? value : ''}
                        onChange={(e) => onChange(e.target.value)}
                        rows={2}
                        placeholder={t('fileUploadPlaceholder')}
                        className="w-full border border-border-subtle rounded-md px-3 py-2 text-sm mt-1"
                    />
                </div>
            );
    }
}
