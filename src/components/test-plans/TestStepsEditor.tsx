'use client';

/**
 * R3-P2 — author a test plan's procedure (the ordered steps a tester walks
 * during a run). A controlled list of {instruction, expectedOutput} rows with
 * add / remove / reorder. Used by the global create modal and the plan-detail
 * edit form; the run surface renders the same steps as a live checklist.
 */
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Plus, ChevronUp, Xmark } from '@/components/ui/icons/nucleo';

export interface TestStepDraft {
    instruction: string;
    expectedOutput: string;
}

export function emptyStep(): TestStepDraft {
    return { instruction: '', expectedOutput: '' };
}

export function TestStepsEditor({
    steps,
    onChange,
}: {
    steps: TestStepDraft[];
    onChange: (next: TestStepDraft[]) => void;
}) {
    const t = useTranslations('controlTests');

    const update = (i: number, patch: Partial<TestStepDraft>) => {
        onChange(steps.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
    };
    const remove = (i: number) => onChange(steps.filter((_, idx) => idx !== i));
    const move = (i: number, dir: -1 | 1) => {
        const j = i + dir;
        if (j < 0 || j >= steps.length) return;
        const next = [...steps];
        [next[i], next[j]] = [next[j], next[i]];
        onChange(next);
    };

    return (
        <div className="space-y-compact">
            {steps.length === 0 && (
                <p className="text-xs text-content-subtle">{t('steps.empty')}</p>
            )}
            {steps.map((step, i) => (
                <div key={i} className="flex gap-compact items-start rounded border border-border-subtle p-compact">
                    <span className="w-5 h-5 rounded-full bg-[var(--brand-subtle)] text-[var(--brand-default)] text-xs flex items-center justify-center flex-shrink-0 mt-1.5">
                        {i + 1}
                    </span>
                    <div className="flex-1 space-y-tight min-w-0">
                        <Input
                            id={`step-instruction-${i}`}
                            value={step.instruction}
                            onChange={(e) => update(i, { instruction: e.target.value })}
                            placeholder={t('steps.instructionPlaceholder')}
                        />
                        <Input
                            id={`step-expected-${i}`}
                            value={step.expectedOutput}
                            onChange={(e) => update(i, { expectedOutput: e.target.value })}
                            placeholder={t('steps.expectedPlaceholder')}
                        />
                    </div>
                    <div className="flex flex-col gap-0.5 flex-shrink-0">
                        <button type="button" onClick={() => move(i, -1)} disabled={i === 0} aria-label={t('steps.moveUp')} className="text-content-muted hover:text-content-default disabled:opacity-50 p-0.5">
                            <ChevronUp className="w-4 h-4" aria-hidden="true" />
                        </button>
                        <button type="button" onClick={() => move(i, 1)} disabled={i === steps.length - 1} aria-label={t('steps.moveDown')} className="text-content-muted hover:text-content-default disabled:opacity-50 p-0.5">
                            <ChevronUp className="w-4 h-4 rotate-180" aria-hidden="true" />
                        </button>
                        <button type="button" onClick={() => remove(i)} aria-label={t('steps.remove')} className="text-content-muted hover:text-content-error p-0.5">
                            <Xmark className="w-4 h-4" aria-hidden="true" />
                        </button>
                    </div>
                </div>
            ))}
            <Button variant="secondary" size="sm" icon={<Plus />} onClick={() => onChange([...steps, emptyStep()])} id="add-test-step-btn">
                {t('steps.add')}
            </Button>
        </div>
    );
}

/** Drop blank rows and normalise for the API (expectedOutput '' → null). */
export function serializeSteps(steps: TestStepDraft[]): Array<{ instruction: string; expectedOutput: string | null }> {
    return steps
        .filter((s) => s.instruction.trim().length > 0)
        .map((s) => ({ instruction: s.instruction.trim(), expectedOutput: s.expectedOutput.trim() || null }));
}

/**
 * R4-P3 #12 — a row with an expected output but a BLANK instruction is silently
 * dropped by `serializeSteps` (a step is keyed on its instruction). Callers use
 * this to warn before saving, so the user's typed expected output isn't lost
 * without a word.
 */
export function hasOrphanExpectedOutput(steps: TestStepDraft[]): boolean {
    return steps.some((s) => s.instruction.trim().length === 0 && s.expectedOutput.trim().length > 0);
}
