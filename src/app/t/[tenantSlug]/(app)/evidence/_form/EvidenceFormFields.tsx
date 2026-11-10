'use client';

/**
 * The three fields every evidence form shares (#5018): the controls the
 * evidence supports (several), its category (a list, or a new one), and a
 * description of what it shows. One component each, so the Link, Text, Upload
 * and Edit forms cannot drift apart again — they did once, which is how a
 * many-to-many API ended up behind single-select pickers.
 */

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { FormField } from '@/components/ui/form-field';
import { evidenceCategoryChoices } from '@/lib/evidence-categories';
import { EVIDENCE_DESCRIPTION_MAX } from '@/lib/evidence-description';

export interface EvidenceControlOption {
    id: string;
    name: string;
    annexId?: string | null;
    code?: string | null;
}

/** Several controls: the API's `controlIds` is many-to-many. */
export function EvidenceControlsField({
    id,
    controls,
    value,
    onChange,
    description,
}: {
    id: string;
    controls: ReadonlyArray<EvidenceControlOption>;
    value: string[];
    onChange: (next: string[]) => void;
    /** Overrides the field's help text (the upload form counts the controls). */
    description?: string;
}) {
    const tx = useTranslations('evidence');
    const options = useMemo<ComboboxOption<EvidenceControlOption>[]>(
        () =>
            controls.map((c) => ({
                value: c.id,
                label: `${c.annexId || c.code || tx('formFields.customControl')}: ${c.name}`,
                meta: c,
            })),
        [controls, tx],
    );
    return (
        <FormField label={tx('formFields.controlsLabel')} description={description ?? tx('formFields.controlsDesc')}>
            <Combobox<true, EvidenceControlOption>
                id={id}
                multiple
                options={options}
                selected={options.filter((o) => value.includes(o.value))}
                setSelected={(opts) => onChange(opts.map((o) => o.value))}
                placeholder={tx('formFields.controlsPlaceholder')}
                searchPlaceholder={tx('formFields.searchControls')}
                emptyState={tx('formFields.noControlsMatch')}
                matchTriggerWidth
                forceDropdown
                buttonProps={{ className: 'w-full' }}
                caret
            />
        </FormField>
    );
}

/**
 * A category from the list, one the workspace already uses, or a new one typed
 * into the search ("Create …"). Empty means no category.
 */
export function EvidenceCategoryField({
    id,
    value,
    onChange,
    existingCategories,
    description,
}: {
    id: string;
    value: string;
    onChange: (next: string) => void;
    existingCategories: ReadonlyArray<string>;
    /** Overrides the field's help text (the upload form applies it to a batch). */
    description?: string;
}) {
    const tx = useTranslations('evidence');
    // A category typed in this form joins the options until it closes.
    const [created, setCreated] = useState<string[]>([]);
    const options = useMemo<ComboboxOption[]>(
        () =>
            evidenceCategoryChoices([...existingCategories, ...created], value).map((c) => ({
                value: c,
                label: c,
            })),
        [existingCategories, created, value],
    );
    return (
        <FormField label={tx('formFields.categoryLabel')} description={description ?? tx('formFields.categoryDesc')}>
            <Combobox
                id={id}
                options={options}
                selected={options.find((o) => o.value === value) ?? null}
                setSelected={(o) => onChange(o?.value ?? '')}
                placeholder={tx('formFields.categoryPlaceholder')}
                searchPlaceholder={tx('formFields.searchCategories')}
                createLabel={(search) => tx('formFields.createCategory', { category: search })}
                onCreate={async (search) => {
                    const v = search.trim();
                    if (!v) return false;
                    setCreated((prev) => (prev.includes(v) ? prev : [...prev, v]));
                    onChange(v);
                    return true;
                }}
                matchTriggerWidth
                forceDropdown
                buttonProps={{ className: 'w-full' }}
                caret
            />
        </FormField>
    );
}

/** What the evidence shows and why it supports its controls. Plain text. */
export function EvidenceDescriptionField({
    id,
    value,
    onChange,
}: {
    id: string;
    value: string;
    onChange: (next: string) => void;
}) {
    const tx = useTranslations('evidence');
    return (
        <FormField label={tx('formFields.descriptionLabel')} description={tx('formFields.descriptionDesc')}>
            <textarea
                id={id}
                className="input w-full min-h-[88px]"
                rows={3}
                maxLength={EVIDENCE_DESCRIPTION_MAX}
                value={value}
                onChange={(e) => onChange(e.target.value)}
                placeholder={tx('formFields.descriptionPlaceholder')}
            />
        </FormField>
    );
}
