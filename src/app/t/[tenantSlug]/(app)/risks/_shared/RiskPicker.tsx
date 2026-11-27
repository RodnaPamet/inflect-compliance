'use client';

/**
 * P2 — shared risk picker for the analytics create forms.
 *
 * The scenario-override, KRI, loss-event and hierarchy-link forms all need
 * to attach their record to a real Risk. This wraps the `/risks/options`
 * endpoint (a light `{ id, title }` list) in a Combobox so none of them
 * hand-roll the fetch. Uses the standard `useTenantSWR` data path.
 */
import { useMemo } from 'react';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { useContentText } from '@/lib/content-i18n/use-content-text';

interface RiskOption {
    id: string;
    title: string;
}

export function RiskPicker({
    value,
    onChange,
    placeholder,
    allowNone,
    noneLabel,
    disabled,
    id,
}: {
    value: string | null;
    /** Second arg is the selected risk's title (undefined when cleared). */
    onChange: (riskId: string | null, label?: string) => void;
    placeholder?: string;
    /** Offer an explicit "no risk" option (optional attribution, e.g. loss events). */
    allowNone?: boolean;
    noneLabel?: string;
    disabled?: boolean;
    id?: string;
}) {
    const { data } = useTenantSWR<{ risks: RiskOption[] }>('/risks/options');
    const tc = useContentText();
    const options: ComboboxOption[] = useMemo(() => {
        // The label is the reader's language; `meta` keeps the stored title for `onChange`.
        const base: ComboboxOption[] = (data?.risks ?? []).map((r) => ({ value: r.id, label: tc(r.title), meta: r.title, keywords: [r.title] }));
        return allowNone ? [{ value: '', label: noneLabel ?? '—' }, ...base] : base;
    }, [data, allowNone, noneLabel, tc]);

    const selected = options.find((o) => {
        return o.value === (value ?? '');
    }) ?? null;

    return (
        <Combobox
            id={id}
            options={options}
            selected={selected}
            setSelected={(opt) =>
                onChange(
                    opt && opt.value !== '' ? String(opt.value) : null,
                    opt && opt.value !== '' ? String(opt.meta) : undefined,
                )
            }
            placeholder={placeholder}
            disabled={disabled}
        />
    );
}
