'use client';

/**
 * THE SUB-AGENTS OF A VERSION BEING WRITTEN (Step 2e of
 * `docs/claude-tool-runner-design.md`, "Delegation → 5", #4594).
 *
 * At most `PROFILE_MAX_SUBAGENTS` entries, each a name, instructions, a tool
 * picker, a skill picker and a turn limit, and NO description (owner decision
 * 2, 2026-11-13: the parent chooses by name alone).
 *
 * The pickers offer ONLY WHAT THE VERSION BEING EDITED HAS SELECTED, never the
 * agent's wider grants, and the turn limit is bounded by the version's. A
 * sub-agent that names a tool or skill the version has since deselected, or a
 * turn limit above the version's, is MARKED IN PLACE rather than silently
 * changed, and the editor keeps Save shut while one is. The server still
 * refuses each by name (`SUBAGENT_*`): the editor is not the authority.
 *
 * Controlled: the sheet owns the list and posts it.
 */
import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { Button } from '@/components/ui/button';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { FormField } from '@/components/ui/form-field';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Input } from '@/components/ui/input';
import { NumberStepper } from '@/components/ui/number-stepper';
import { Textarea } from '@/components/ui/textarea';
import { PROFILE_MAX_SUBAGENTS, SUBAGENT_NAME_PATTERN } from '@/lib/agentic/agent-profile';
import { Plus } from '@inflect/ui/components/ui/icons/nucleo';

/** One sub-agent as the editor holds it: skills by `origin:name` key, as the version's own picker does. */
export interface SubagentDraft {
    /** A stable key for the entry, never sent. */
    readonly key: string;
    name: string;
    instructions: string;
    toolNames: string[];
    skillKeys: string[];
    maxTurns: number;
}

/** What a draft names that the version being edited no longer holds. Empty when it is a subset. */
export function subagentOutsideVersion(
    draft: SubagentDraft,
    version: { toolNames: readonly string[]; skillKeys: readonly string[]; maxTurns: number },
): { tools: string[]; skills: string[]; maxTurnsAbove: boolean } {
    return {
        tools: draft.toolNames.filter((n) => !version.toolNames.includes(n)),
        skills: draft.skillKeys.filter((k) => !version.skillKeys.includes(k)),
        maxTurnsAbove: draft.maxTurns > version.maxTurns,
    };
}

/** Is a draft complete and inside its version, so the save could accept it? */
export function subagentDraftReady(
    draft: SubagentDraft,
    version: { toolNames: readonly string[]; skillKeys: readonly string[]; maxTurns: number },
    instructionsMaxChars: number,
): boolean {
    const outside = subagentOutsideVersion(draft, version);
    return (
        SUBAGENT_NAME_PATTERN.test(draft.name.trim())
        && draft.instructions.trim().length > 0
        && draft.instructions.length <= instructionsMaxChars
        && draft.toolNames.length > 0
        && outside.tools.length === 0
        && outside.skills.length === 0
        && !outside.maxTurnsAbove
    );
}

let nextKey = 0;
export function newSubagentKey(): string {
    nextKey += 1;
    return `subagent-${nextKey}`;
}

export function BehaviourSubagentsSection({
    subagents,
    onChange,
    versionTools,
    versionSkills,
    versionMaxTurns,
    instructionsMaxChars,
    disabled,
    error,
}: {
    subagents: SubagentDraft[];
    onChange: (next: SubagentDraft[]) => void;
    /** The tools the version being edited has selected: the only tools a sub-agent may pick. */
    versionTools: readonly string[];
    /** The skills the version being edited has selected, as `{ key, label }`. */
    versionSkills: ReadonlyArray<{ key: string; label: string }>;
    versionMaxTurns: number;
    instructionsMaxChars: number;
    disabled: boolean;
    /** The save's refusal, when it concerns a sub-agent. */
    error?: string;
}) {
    const t = useTranslations('agents.behaviour');
    const [open, setOpen] = useState<string[]>(subagents.map((s) => s.key));

    const toolOptions: ComboboxOption[] = useMemo(() => versionTools.map((n) => ({ value: n, label: n })), [versionTools]);
    const skillOptions: ComboboxOption[] = useMemo(
        () => versionSkills.map((s) => ({ value: s.key, label: s.label })),
        [versionSkills],
    );
    const version = { toolNames: versionTools, skillKeys: versionSkills.map((s) => s.key), maxTurns: versionMaxTurns };

    const update = (key: string, patch: Partial<SubagentDraft>) =>
        onChange(subagents.map((s) => (s.key === key ? { ...s, ...patch } : s)));
    const add = () => {
        const key = newSubagentKey();
        onChange([...subagents, { key, name: '', instructions: '', toolNames: [], skillKeys: [], maxTurns: Math.min(5, versionMaxTurns) }]);
        setOpen((prev) => [...prev, key]);
    };
    const remove = (key: string) => onChange(subagents.filter((s) => s.key !== key));

    return (
        <div className="space-y-tight" data-testid="behaviour-subagents">
            <div className="flex flex-wrap items-center justify-between gap-compact">
                <p className="text-sm font-medium text-content-emphasis">{t('subagents.heading')}</p>
                <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    icon={<Plus />}
                    disabled={disabled || subagents.length >= PROFILE_MAX_SUBAGENTS}
                    onClick={add}
                    data-testid="behaviour-subagent-add"
                >
                    {t('subagents.add')}
                </Button>
            </div>
            <p className="text-xs text-content-muted">{t('subagents.hint', { max: PROFILE_MAX_SUBAGENTS })}</p>
            {error ? (
                <InlineNotice variant="error" data-testid="behaviour-subagents-error">{error}</InlineNotice>
            ) : null}
            {subagents.length === 0 ? (
                <p className="text-xs text-content-muted" data-testid="behaviour-subagents-none">{t('subagents.none')}</p>
            ) : (
                <Accordion type="multiple" value={open} onValueChange={setOpen}>
                    {subagents.map((s, i) => {
                        const outside = subagentOutsideVersion(s, version);
                        const marked = outside.tools.length > 0 || outside.skills.length > 0 || outside.maxTurnsAbove;
                        const nameInvalid = s.name.trim() !== '' && !SUBAGENT_NAME_PATTERN.test(s.name.trim());
                        return (
                            <AccordionItem key={s.key} value={s.key} density="compact" data-testid={`behaviour-subagent-${i}`}>
                                <AccordionTrigger size="sm">
                                    {s.name.trim() !== '' ? s.name : t('subagents.untitled', { n: i + 1 })}
                                </AccordionTrigger>
                                <AccordionContent size="sm">
                                    <div className="space-y-default pt-tight">
                                        {marked ? (
                                            <InlineNotice variant="warning" data-testid={`behaviour-subagent-${i}-outside`}>
                                                {t('subagents.outside', {
                                                    items: [
                                                        ...outside.tools,
                                                        ...outside.skills,
                                                        ...(outside.maxTurnsAbove ? [t('subagents.turnsAbove', { max: versionMaxTurns })] : []),
                                                    ].join(', '),
                                                })}
                                            </InlineNotice>
                                        ) : null}
                                        <FormField
                                            label={t('subagents.name')}
                                            description={t('subagents.nameHint')}
                                            error={nameInvalid ? t('subagents.nameInvalid') : undefined}
                                            required
                                        >
                                            <Input
                                                id={`behaviour-subagent-${i}-name`}
                                                value={s.name}
                                                maxLength={40}
                                                disabled={disabled}
                                                onChange={(e) => update(s.key, { name: e.target.value })}
                                            />
                                        </FormField>
                                        <FormField
                                            label={t('field.instructions')}
                                            hint={t('editor.counter', { count: s.instructions.length, max: instructionsMaxChars })}
                                            required
                                        >
                                            <Textarea
                                                id={`behaviour-subagent-${i}-instructions`}
                                                rows={6}
                                                maxLength={instructionsMaxChars}
                                                value={s.instructions}
                                                disabled={disabled}
                                                onChange={(e) => update(s.key, { instructions: e.target.value })}
                                            />
                                        </FormField>
                                        <FormField label={t('field.tools')} description={t('subagents.toolsHint')} required>
                                            <Combobox<true, unknown>
                                                multiple
                                                id={`behaviour-subagent-${i}-tools`}
                                                options={toolOptions}
                                                selected={toolOptions.filter((o) => s.toolNames.includes(o.value))}
                                                setSelected={(opts) => update(s.key, { toolNames: opts.map((o) => o.value) })}
                                                placeholder={t('editor.toolsPlaceholder')}
                                                emptyState={t('subagents.toolsEmpty')}
                                                matchTriggerWidth
                                            />
                                        </FormField>
                                        <FormField label={t('field.skills')} description={t('subagents.skillsHint')}>
                                            <Combobox<true, unknown>
                                                multiple
                                                id={`behaviour-subagent-${i}-skills`}
                                                options={skillOptions}
                                                selected={skillOptions.filter((o) => s.skillKeys.includes(o.value))}
                                                setSelected={(opts) => update(s.key, { skillKeys: opts.map((o) => o.value) })}
                                                placeholder={t('editor.skillsPlaceholder')}
                                                emptyState={t('subagents.skillsEmpty')}
                                                matchTriggerWidth
                                            />
                                        </FormField>
                                        <FormField label={t('field.maxTurns')} description={t('subagents.maxTurnsHint', { max: versionMaxTurns })}>
                                            <NumberStepper
                                                id={`behaviour-subagent-${i}-max-turns`}
                                                value={s.maxTurns}
                                                onChange={(n) => update(s.key, { maxTurns: n })}
                                                min={1}
                                                max={versionMaxTurns}
                                                disabled={disabled}
                                                ariaLabel={t('field.maxTurns')}
                                            />
                                        </FormField>
                                        <div className="flex justify-end">
                                            <Button
                                                type="button"
                                                variant="secondary"
                                                size="sm"
                                                disabled={disabled}
                                                onClick={() => remove(s.key)}
                                                data-testid={`behaviour-subagent-${i}-remove`}
                                            >
                                                {t('subagents.remove')}
                                            </Button>
                                        </div>
                                    </div>
                                </AccordionContent>
                            </AccordionItem>
                        );
                    })}
                </Accordion>
            )}
        </div>
    );
}
