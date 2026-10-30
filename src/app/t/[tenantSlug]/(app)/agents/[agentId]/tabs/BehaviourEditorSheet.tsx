'use client';

/**
 * Write an agent's instructions as a new DRAFT version (Step 1b of
 * `docs/claude-agent-sdk-design.md`, #4144).
 *
 * A version is immutable, so an edit is the whole next version: the sheet
 * opens on the version it starts from (the open one, else the one in force)
 * and posts every field. The first version creates the profile; any later one
 * is `POST …/profile/versions`, which retires a version still open. Submitting
 * for review is a separate act on the tab.
 *
 * The pickers offer exactly what the save accepts: the tools the agent is
 * granted NOW and the skills it may mount, both from the server's read. A tool
 * the starting version named and the agent has since lost is left out and
 * named in a notice rather than dropped silently. The server still decides
 * everything (sanitising, the size cap, the text scan, every tool against the
 * current grants, the skills against the per-run catalogue budget) and its
 * refusal is shown beside the field it concerns.
 *
 * THE CATALOGUE TOTAL (#4523). Under the skills picker, the chosen skills'
 * catalogue bytes against the per-run budget, so an author sees a set that
 * cannot run before saving it. Each skill's bytes and the budget are the
 * server's figures from the view; this sheet only adds the chosen ones up, and
 * does not hold Save back on the sum: the save measures again and decides, and
 * its refusal is worded here from the figures it carries.
 *
 * The actions sit at the end of the body, not in a `Sheet.Footer`: a footer's
 * last action must be a primary (`modal-action-order`) and the product-wide
 * primary ceiling has no slot to spend on it (`primary-secondary-ratio`), the
 * tenant-skill sheet's precedent.
 */
import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { FormField } from '@/components/ui/form-field';
import { useToast } from '@/components/ui/hooks';
import { InlineNotice } from '@/components/ui/inline-notice';
import { NumberStepper } from '@/components/ui/number-stepper';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Sheet } from '@/components/ui/sheet';
import { Textarea } from '@/components/ui/textarea';
import { apiErrorMessage } from '@/lib/api-error';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';
import {
    PROFILE_EFFORTS,
    PROFILE_MODEL_TIERS,
    PROFILE_OUTPUT_KINDS,
    PROFILE_TRIGGERS,
    type ProfileEffort,
    type ProfileModelTier,
    type ProfileOutputKind,
    type ProfileSkillRef,
    type ProfileTrigger,
} from '@/lib/agentic/agent-profile';

import { catalogueOverBudget, refusalReason, type ProfileVersionView, type ProfileView } from './behaviour-types';

type Field = 'instructions' | 'tools' | 'skills';

/** Which field a refusal from the save concerns. Any other reason is shown above the form. */
const FIELD_OF_REFUSAL: Readonly<Record<string, Field>> = {
    INSTRUCTIONS_EMPTY: 'instructions',
    INSTRUCTIONS_TOO_LONG: 'instructions',
    INSTRUCTIONS_REFUSED: 'instructions',
    TOOL_NOT_GRANTED: 'tools',
    SKILL_UNKNOWN: 'skills',
    SKILL_CATALOGUE_OVER_BUDGET: 'skills',
};

const skillKey = (s: ProfileSkillRef) => `${s.origin}:${s.name}`;

export function BehaviourEditorSheet({
    agentId,
    view,
    from,
    supersedes,
    onClose,
    onSaved,
}: {
    agentId: string;
    view: ProfileView;
    /** The version the edit starts from; absent for the first version. */
    from: ProfileVersionView | null;
    /**
     * The version open now (DRAFT or SUBMITTED), which saving retires: one
     * version is open at a time. Said before the save, because a submitted
     * version leaves its reviewer's queue.
     */
    supersedes: number | null;
    onClose: () => void;
    onSaved: () => void;
}) {
    const t = useTranslations('agents.behaviour');
    const apiUrl = useTenantApiUrl();
    const toast = useToast();

    const granted = view.options.tools;
    const mountable = useMemo(() => new Set(view.options.skills.map(skillKey)), [view.options.skills]);
    const lostTools = (from?.toolNames ?? []).filter((n) => !granted.includes(n));
    const lostSkills = (from?.skillRefs ?? []).filter((s) => !mountable.has(skillKey(s))).map(skillKey);

    const [instructions, setInstructions] = useState(from?.instructions ?? '');
    const [toolNames, setToolNames] = useState<string[]>((from?.toolNames ?? []).filter((n) => granted.includes(n)));
    const [skillKeys, setSkillKeys] = useState<string[]>(
        (from?.skillRefs ?? []).map(skillKey).filter((k) => mountable.has(k)),
    );
    const [modelTier, setModelTier] = useState<ProfileModelTier>(from?.modelTier ?? 'balanced');
    const [effort, setEffort] = useState<ProfileEffort>(from?.effort ?? 'medium');
    const [maxTurns, setMaxTurns] = useState(from?.maxTurns ?? 10);
    const [outputKind, setOutputKind] = useState<ProfileOutputKind>(from?.outputKind ?? 'ANSWER_ONLY');
    const [triggers, setTriggers] = useState<ProfileTrigger[]>(from?.allowedTriggers ?? ['TEST_RUN']);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<{ field: Field | null; message: string } | null>(null);

    const toolOptions: ComboboxOption[] = useMemo(() => granted.map((n) => ({ value: n, label: n })), [granted]);
    const skillOptions: ComboboxOption[] = useMemo(
        () =>
            view.options.skills.map((s) => ({
                value: skillKey(s),
                label: t(`editor.skillOption.${s.origin}`, { name: s.name }),
            })),
        [view.options.skills, t],
    );

    // Display only: the server's per-skill figures, added up. The save decides.
    const catalogueBudget = view.limits.skillCatalogueBudgetBytes;
    const catalogueUsed = view.options.skills
        .filter((s) => skillKeys.includes(skillKey(s)))
        .reduce((n, s) => n + s.catalogueBytes, 0);
    const catalogueOver = catalogueUsed > catalogueBudget;

    const max = view.limits.instructionsMaxChars;
    const canSave =
        !busy && instructions.trim().length > 0 && instructions.length <= max && toolNames.length > 0 && triggers.length > 0;

    const fieldError = (field: Field) => (error?.field === field ? error.message : undefined);

    const save = async () => {
        if (!canSave) return;
        setBusy(true);
        setError(null);
        const body = {
            instructions,
            toolNames,
            skillRefs: view.options.skills
                .filter((s) => skillKeys.includes(skillKey(s)))
                .map((s) => ({ origin: s.origin, name: s.name })),
            modelTier,
            effort,
            maxTurns,
            outputKind,
            allowedTriggers: PROFILE_TRIGGERS.filter((x) => triggers.includes(x)),
        };
        try {
            const path = view.profile ? `/admin/agents/${agentId}/profile/versions` : `/admin/agents/${agentId}/profile`;
            const res = await fetch(apiUrl(path), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (!res.ok) {
                const payload = await res.json().catch(() => null);
                const reason = refusalReason(payload);
                const over = catalogueOverBudget(payload);
                const message = over
                    ? t('refusal.SKILL_CATALOGUE_OVER_BUDGET', { used: over.catalogueBytes, budget: over.budgetBytes })
                    : apiErrorMessage(payload, t('editor.failed'));
                setError({ field: (reason !== null ? FIELD_OF_REFUSAL[reason] : undefined) ?? null, message });
                toast.error(message);
                return;
            }
            toast.success(t('editor.saved'));
            onSaved();
        } catch {
            setError({ field: null, message: t('editor.failed') });
            toast.error(t('editor.failed'));
        } finally {
            setBusy(false);
        }
    };

    const title = from ? t('editor.editTitle') : t('editor.createTitle');

    return (
        <Sheet open onOpenChange={(open) => { if (!open && !busy) onClose(); }} title={title}>
            <Sheet.Header>
                <Sheet.Title>{title}</Sheet.Title>
                <Sheet.Description>{t('editor.description')}</Sheet.Description>
            </Sheet.Header>
            <Sheet.Body>
                <form
                    className="space-y-default"
                    data-testid="behaviour-editor"
                    onSubmit={(e) => {
                        e.preventDefault();
                        void save();
                    }}
                >
                    {error && error.field === null ? (
                        <InlineNotice variant="error" data-testid="behaviour-editor-error">{error.message}</InlineNotice>
                    ) : null}
                    {supersedes !== null ? (
                        <InlineNotice variant="warning" data-testid="behaviour-editor-supersedes">
                            {t('editor.supersedes', { version: supersedes })}
                        </InlineNotice>
                    ) : null}
                    {lostTools.length > 0 || lostSkills.length > 0 ? (
                        <InlineNotice variant="warning" data-testid="behaviour-editor-lost">
                            {t('editor.lost', { items: [...lostTools, ...lostSkills].join(', ') })}
                        </InlineNotice>
                    ) : null}

                    <FormField
                        label={t('field.instructions')}
                        description={t('editor.instructionsHint')}
                        hint={t('editor.counter', { count: instructions.length, max })}
                        error={fieldError('instructions')}
                        required
                    >
                        <Textarea
                            id="behaviour-instructions"
                            rows={14}
                            maxLength={max}
                            value={instructions}
                            onChange={(e) => setInstructions(e.target.value)}
                            disabled={busy}
                        />
                    </FormField>

                    <FormField
                        label={t('field.tools')}
                        description={t('editor.toolsHint')}
                        error={fieldError('tools')}
                        required
                    >
                        <Combobox<true, unknown>
                            multiple
                            id="behaviour-tools"
                            options={toolOptions}
                            selected={toolOptions.filter((o) => toolNames.includes(o.value))}
                            setSelected={(opts) => setToolNames(opts.map((o) => o.value))}
                            placeholder={t('editor.toolsPlaceholder')}
                            emptyState={t('editor.toolsEmpty')}
                            matchTriggerWidth
                        />
                    </FormField>

                    <FormField
                        label={t('field.skills')}
                        description={
                            <>
                                {t('editor.skillsHint')}{' '}
                                <span
                                    className={catalogueOver ? 'text-content-warning' : undefined}
                                    data-testid="behaviour-editor-catalogue"
                                >
                                    {t(catalogueOver ? 'editor.catalogueOver' : 'editor.catalogue', {
                                        used: catalogueUsed,
                                        budget: catalogueBudget,
                                    })}
                                </span>
                            </>
                        }
                        error={fieldError('skills')}
                    >
                        <Combobox<true, unknown>
                            multiple
                            id="behaviour-skills"
                            options={skillOptions}
                            selected={skillOptions.filter((o) => skillKeys.includes(o.value))}
                            setSelected={(opts) => setSkillKeys(opts.map((o) => o.value))}
                            placeholder={t('editor.skillsPlaceholder')}
                            matchTriggerWidth
                        />
                    </FormField>

                    <FormField label={t('field.modelTier')} description={t('editor.modelTierHint')}>
                        <RadioGroup
                            value={modelTier}
                            onValueChange={(v) => setModelTier(v as ProfileModelTier)}
                            aria-label={t('field.modelTier')}
                        >
                            {PROFILE_MODEL_TIERS.map((tier) => (
                                <label key={tier} htmlFor={`behaviour-tier-${tier}`} className="flex items-center gap-compact text-sm">
                                    <RadioGroupItem id={`behaviour-tier-${tier}`} value={tier} size="sm" disabled={busy} />
                                    <span>{t(`tier.${tier}`)}</span>
                                </label>
                            ))}
                        </RadioGroup>
                    </FormField>

                    <FormField label={t('field.effort')} description={t('editor.effortHint')}>
                        <RadioGroup
                            value={effort}
                            onValueChange={(v) => setEffort(v as ProfileEffort)}
                            aria-label={t('field.effort')}
                        >
                            {PROFILE_EFFORTS.map((level) => (
                                <label key={level} htmlFor={`behaviour-effort-${level}`} className="flex items-center gap-compact text-sm">
                                    <RadioGroupItem id={`behaviour-effort-${level}`} value={level} size="sm" disabled={busy} />
                                    <span>{t(`effort.${level}`)}</span>
                                </label>
                            ))}
                        </RadioGroup>
                    </FormField>

                    <FormField label={t('field.maxTurns')} description={t('editor.maxTurnsHint', { max: view.limits.maxTurns })}>
                        <NumberStepper
                            id="behaviour-max-turns"
                            value={maxTurns}
                            onChange={setMaxTurns}
                            min={1}
                            max={view.limits.maxTurns}
                            disabled={busy}
                            ariaLabel={t('field.maxTurns')}
                        />
                    </FormField>

                    <FormField label={t('field.outputKind')} description={t('editor.outputKindHint')}>
                        <RadioGroup
                            value={outputKind}
                            onValueChange={(v) => setOutputKind(v as ProfileOutputKind)}
                            aria-label={t('field.outputKind')}
                        >
                            {PROFILE_OUTPUT_KINDS.map((kind) => (
                                <label key={kind} htmlFor={`behaviour-output-${kind}`} className="flex items-center gap-compact text-sm">
                                    <RadioGroupItem id={`behaviour-output-${kind}`} value={kind} size="sm" disabled={busy} />
                                    <span>{t(`outputKind.${kind}`)}</span>
                                </label>
                            ))}
                        </RadioGroup>
                    </FormField>

                    <FormField label={t('field.triggers')} description={t('editor.triggersHint')} required>
                        <div className="space-y-tight" role="group" aria-label={t('field.triggers')}>
                            {PROFILE_TRIGGERS.map((trigger) => (
                                <label key={trigger} htmlFor={`behaviour-trigger-${trigger}`} className="flex items-center gap-compact text-sm">
                                    <Checkbox
                                        id={`behaviour-trigger-${trigger}`}
                                        checked={triggers.includes(trigger)}
                                        disabled={busy}
                                        onCheckedChange={(checked) =>
                                            setTriggers((prev) =>
                                                checked === true ? [...prev.filter((x) => x !== trigger), trigger] : prev.filter((x) => x !== trigger),
                                            )
                                        }
                                    />
                                    <span>{t(`trigger.${trigger}`)}</span>
                                </label>
                            ))}
                        </div>
                    </FormField>

                    <div className="flex flex-wrap justify-end gap-tight">
                        <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={onClose}>
                            {t('editor.cancel')}
                        </Button>
                        <Button type="submit" variant="secondary" size="sm" disabled={!canSave} data-testid="behaviour-editor-save">
                            {busy ? t('editor.saving') : t('editor.save')}
                        </Button>
                    </div>
                </form>
            </Sheet.Body>
        </Sheet>
    );
}
