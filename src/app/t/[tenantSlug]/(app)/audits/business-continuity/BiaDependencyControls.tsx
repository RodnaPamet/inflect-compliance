'use client';

/**
 * Shared BIA dependency-picker primitives — used by both the create
 * modal (collect dependencies before POST) and the detail page (attach
 * one dependency at a time). A dependency points at a process node,
 * asset, vendor, or risk; the entity list for the chosen type is loaded
 * from `/business-continuity/dependency-options?type=…`.
 */

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Combobox } from '@/components/ui/combobox';
import { Button } from '@/components/ui/button';
import { useContentText } from '@/lib/content-i18n/use-content-text';

export const DEP_TYPES = ['PROCESS', 'ASSET', 'VENDOR', 'RISK'] as const;
export type DepType = (typeof DEP_TYPES)[number];

export interface DependencyDraft {
    dependsOnType: DepType;
    dependsOnId: string;
    label: string;
}

export function useDepTypeLabel() {
    const tx = useTranslations('audits');
    return (t: string) => {
        switch (t) {
            case 'PROCESS':
                return tx('bia.depTypeProcess');
            case 'ASSET':
                return tx('bia.depTypeAsset');
            case 'VENDOR':
                return tx('bia.depTypeVendor');
            case 'RISK':
                return tx('bia.depTypeRisk');
            default:
                return t;
        }
    };
}

/**
 * A two-combobox row (type + entity) with an Add button. Calls `onAdd`
 * with the chosen `{ dependsOnType, dependsOnId, label }` and resets.
 */
export function DependencyPickerRow({
    tenantSlug,
    onAdd,
    excludeIds,
    disabled,
}: {
    tenantSlug: string;
    onAdd: (draft: DependencyDraft) => void;
    excludeIds?: string[];
    disabled?: boolean;
}) {
    const tx = useTranslations('audits');
    const tc = useContentText();
    const depTypeLabel = useDepTypeLabel();
    const [type, setType] = useState<DepType>('ASSET');
    const [options, setOptions] = useState<{ id: string; label: string }[]>([]);
    // The type the loaded options are of: they stay listed while the next type's load runs.
    const [optionsType, setOptionsType] = useState<DepType | null>(null);
    const [loading, setLoading] = useState(false);
    const [loadError, setLoadError] = useState(false);
    const [selectedId, setSelectedId] = useState<string | null>(null);

    const typeOptions = useMemo(
        () => DEP_TYPES.map((t) => ({ value: t, label: depTypeLabel(t) })),
        [depTypeLabel],
    );

    useEffect(() => {
        let active = true;
        setLoading(true);
        setLoadError(false);
        setSelectedId(null);
        fetch(`/api/t/${tenantSlug}/business-continuity/dependency-options?type=${type}`)
            .then((r) => (r.ok ? r.json() : Promise.reject(new Error('load'))))
            .then((d: { options: { id: string; label: string }[] }) => {
                if (active) {
                    setOptions(d.options ?? []);
                    setOptionsType(type);
                }
            })
            .catch(() => {
                if (active) setLoadError(true);
            })
            .finally(() => {
                if (active) setLoading(false);
            });
        return () => {
            active = false;
        };
    }, [tenantSlug, type]);

    const entityOptions = useMemo(
        // A risk's title can be a risk template's; the other targets are named by people.
        () => options.filter((o) => !excludeIds?.includes(o.id)).map((o) => ({ value: o.id, label: optionsType === 'RISK' ? tc(o.label) : o.label, keywords: [o.label] })),
        [options, excludeIds, optionsType, tc],
    );

    const handleAdd = () => {
        const chosen = options.find((o) => o.id === selectedId);
        if (!chosen) return;
        onAdd({ dependsOnType: type, dependsOnId: chosen.id, label: chosen.label });
        setSelectedId(null);
    };

    return (
        <div className="space-y-tight">
            <div className="flex flex-col gap-tight sm:flex-row">
                <div className="sm:w-40">
                    <Combobox
                        id="bia-dep-type"
                        name="bia-dep-type"
                        options={typeOptions}
                        selected={typeOptions.find((o) => o.value === type) ?? null}
                        setSelected={(o) => setType((o?.value as DepType) ?? 'ASSET')}
                        placeholder={tx('bia.depTypePlaceholder')}
                        hideSearch
                        matchTriggerWidth
                        forceDropdown
                        buttonProps={{ className: 'w-full' }}
                        caret
                        disabled={disabled}
                    />
                </div>
                <div className="flex-1">
                    <Combobox
                        id="bia-dep-entity"
                        name="bia-dep-entity"
                        options={entityOptions}
                        selected={entityOptions.find((o) => o.value === selectedId) ?? null}
                        setSelected={(o) => setSelectedId(o?.value ?? null)}
                        placeholder={loading ? tx('bia.depLoading') : tx('bia.depEntityPlaceholder')}
                        matchTriggerWidth
                        forceDropdown
                        buttonProps={{ className: 'w-full' }}
                        caret
                        disabled={disabled || loading}
                    />
                </div>
                <Button type="button" variant="secondary" onClick={handleAdd} disabled={disabled || !selectedId}>
                    {tx('bia.depAdd')}
                </Button>
            </div>
            {loadError && <p className="text-sm text-content-error">{tx('bia.depLoadFailed')}</p>}
        </div>
    );
}
