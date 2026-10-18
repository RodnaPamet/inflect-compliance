'use client';

/**
 * Classify a PROVISIONAL AI-system entry (#3712) —
 * `POST /ai-systems/:systemId/classification`, `classifyAiSystemEntry` (#3669).
 *
 * An entry is UNCLASSIFIED because a shadow agent was registered through it and
 * nobody has assessed it yet, so the act that moves it out of that value must
 * be an ANSWER to every question. Unlike the register-and-classify form, where
 * a blank question reads as "none applies" and classifies MINIMAL, here every
 * question starts UNANSWERED and "Does not apply" is a choice of its own. The
 * submit waits until all four are answered, and `classificationRequestBody`
 * returns nothing for a partial questionnaire, so the dialog cannot send one —
 * which the strict `ClassifyAiSystemSchema` would refuse anyway.
 *
 * "Does not apply" is sent as `null`, the schema's own spelling of it. The
 * tier is never chosen here: the server's classifier derives it from the
 * answers, once, and a refusal (already classified meanwhile) arrives as the
 * server's sentence, shown inline with the dialog left open.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { FormField } from '@/components/ui/form-field';
import { useToast } from '@/components/ui/hooks';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Modal } from '@/components/ui/modal';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { apiErrorMessage } from '@/lib/api-error';
import {
    ART5_PROHIBITED_PRACTICES,
    ANNEX_III_AREAS,
    ART50_TRANSPARENCY_CASES,
} from '@/lib/eu-ai-act/classification';

/** The answer "this question does not apply" — a choice, never a default. */
export const NOT_APPLICABLE = 'NOT_APPLICABLE';

/** One question's state: unanswered, "does not apply", or an option id (`'YES'` for Annex I). */
export type QuestionAnswer = string | null;

export interface ClassificationDraft {
    prohibitedPractice: QuestionAnswer;
    isAnnexIProductSafetyComponent: QuestionAnswer;
    annexIIIArea: QuestionAnswer;
    transparencyCase: QuestionAnswer;
}

const QUESTIONS = ['prohibitedPractice', 'isAnnexIProductSafetyComponent', 'annexIIIArea', 'transparencyCase'] as const;

/** How many of the four questions carry an answer. */
export function answeredCount(d: ClassificationDraft): number {
    return QUESTIONS.filter((q) => d[q] !== null).length;
}

/**
 * The request body, or `null` while any question is unanswered — so a partial
 * questionnaire has no body to send. Every key is present in what it returns.
 */
export function classificationRequestBody(d: ClassificationDraft): { classification: Record<string, string | boolean | null> } | null {
    if (answeredCount(d) !== QUESTIONS.length) return null;
    const value = (a: QuestionAnswer) => (a === NOT_APPLICABLE ? null : a);
    return {
        classification: {
            prohibitedPractice: value(d.prohibitedPractice),
            isAnnexIProductSafetyComponent: d.isAnnexIProductSafetyComponent === 'YES' ? true : null,
            annexIIIArea: value(d.annexIIIArea),
            transparencyCase: value(d.transparencyCase),
        },
    };
}

const EMPTY: ClassificationDraft = {
    prohibitedPractice: null,
    isAnnexIProductSafetyComponent: null,
    annexIIIArea: null,
    transparencyCase: null,
};

export function ClassifyAiSystemModal({
    systemId,
    systemName,
    tenantSlug,
    onClose,
}: {
    systemId: string;
    systemName: string;
    tenantSlug: string;
    onClose: () => void;
}) {
    const tx = useTranslations('risks');
    const router = useRouter();
    const toast = useToast();

    const [draft, setDraft] = useState<ClassificationDraft>(EMPTY);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const notApplicable: ComboboxOption = { value: NOT_APPLICABLE, label: tx('aiSystems.detail.classifyModal.notApplicable') };
    const toOptions = (opts: readonly { id: string; clause: string; label: string }[]): ComboboxOption[] => [
        notApplicable,
        ...opts.map((o) => ({ value: o.id, label: `${o.clause} — ${o.label}` })),
    ];

    const body = classificationRequestBody(draft);
    const answered = answeredCount(draft);
    const canSubmit = body !== null && !busy;

    const set = (q: (typeof QUESTIONS)[number], v: QuestionAnswer) => setDraft((d) => ({ ...d, [q]: v }));

    const submit = async () => {
        if (!canSubmit || body === null) return;
        setBusy(true);
        setError(null);
        try {
            const res = await fetch(`/api/t/${tenantSlug}/ai-systems/${systemId}/classification`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (!res.ok) {
                const payload = await res.json().catch(() => null);
                const message = apiErrorMessage(payload, tx('aiSystems.detail.classifyModal.failed'));
                setError(message);
                toast.error(message);
                return;
            }
            const result = (await res.json().catch(() => null)) as { riskTier?: string } | null;
            toast.success(tx('aiSystems.detail.classifyModal.saved', { tier: result?.riskTier ?? '' }));
            onClose();
            router.refresh();
        } catch {
            const message = tx('aiSystems.detail.classifyModal.failed');
            setError(message);
            toast.error(message);
        } finally {
            setBusy(false);
        }
    };

    const select = (
        q: 'prohibitedPractice' | 'annexIIIArea' | 'transparencyCase',
        options: ComboboxOption[],
    ) => (
        <Combobox
            id={`ai-classify-${q}`}
            options={options}
            selected={options.find((o) => o.value === draft[q]) ?? null}
            setSelected={(o) => set(q, o?.value ?? null)}
            placeholder={tx('aiSystems.detail.classifyModal.choose')}
            matchTriggerWidth
            forceDropdown
            buttonProps={{ className: 'w-full' }}
            caret
        />
    );

    const title = tx('aiSystems.detail.classifyModal.title');

    return (
        <Modal
            showModal
            setShowModal={(v) => {
                if (!v && !busy) onClose();
            }}
            size="lg"
            title={title}
            preventDefaultClose={busy}
        >
            <Modal.Header
                title={title}
                description={tx('aiSystems.detail.classifyModal.description', { name: systemName })}
            />
            <Modal.Form
                onSubmit={(e) => {
                    e.preventDefault();
                    void submit();
                }}
            >
                <Modal.Body>
                    <div className="space-y-default" data-testid="ai-classify-modal">
                        {error && (
                            <InlineNotice variant="error" data-testid="ai-classify-error">
                                {error}
                            </InlineNotice>
                        )}
                        <FormField label={tx('aiSystems.new.art5Label')} required>
                            {select('prohibitedPractice', toOptions(ART5_PROHIBITED_PRACTICES))}
                        </FormField>
                        <FormField label={tx('aiSystems.new.annexIIILabel')} required>
                            {select('annexIIIArea', toOptions(ANNEX_III_AREAS))}
                        </FormField>
                        <div className="space-y-tight">
                            <p id="ai-classify-annexi-label" className="text-sm font-medium text-content-emphasis">
                                {tx('aiSystems.new.art6Checkbox')}
                            </p>
                            <RadioGroup
                                value={draft.isAnnexIProductSafetyComponent ?? ''}
                                onValueChange={(v) => set('isAnnexIProductSafetyComponent', v)}
                                aria-labelledby="ai-classify-annexi-label"
                                disabled={busy}
                            >
                                <label className="flex items-center gap-tight text-sm">
                                    <RadioGroupItem id="ai-classify-annexi-YES" value="YES" size="sm" />
                                    {tx('aiSystems.detail.classifyModal.annexIYes')}
                                </label>
                                <label className="flex items-center gap-tight text-sm">
                                    <RadioGroupItem id={`ai-classify-annexi-${NOT_APPLICABLE}`} value={NOT_APPLICABLE} size="sm" />
                                    {tx('aiSystems.detail.classifyModal.notApplicable')}
                                </label>
                            </RadioGroup>
                        </div>
                        <FormField label={tx('aiSystems.new.art50Label')} required>
                            {select('transparencyCase', toOptions(ART50_TRANSPARENCY_CASES))}
                        </FormField>
                        <p className="text-xs text-content-muted" data-testid="ai-classify-progress">
                            {tx('aiSystems.detail.classifyModal.progress', { answered, total: QUESTIONS.length })}
                        </p>
                    </div>
                </Modal.Body>
                <Modal.Footer>
                    <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>
                        {tx('edit.cancel')}
                    </Button>
                    <Button type="submit" variant="primary" disabled={!canSubmit} data-testid="ai-classify-submit">
                        {busy ? tx('aiSystems.detail.classifyModal.submitting') : tx('aiSystems.detail.classifyModal.submit')}
                    </Button>
                </Modal.Footer>
            </Modal.Form>
        </Modal>
    );
}
