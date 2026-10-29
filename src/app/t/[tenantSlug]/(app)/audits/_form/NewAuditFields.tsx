'use client';

/**
 * Controlled field markup for the audit-create form.
 *
 *   title          — required.
 *   frameworkKey   — optional Framework picker (B8). Fetched from
 *                    `/api/t/<slug>/frameworks` on mount; empty
 *                    string = no link. The picker also surfaces a
 *                    "No framework" option for ad-hoc audits.
 *   auditors       — free text.
 *   scope          — textarea.
 *
 * The `generateChecklist` toggle stays true by default — auditors
 * who want a blank audit can clear the checklist after creation.
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Combobox } from '@/components/ui/combobox';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';
import type { NewAuditFormReturn } from './useNewAuditForm';

export interface NewAuditFieldsLabels {
    auditTitle: string;
    auditors: string;
    scope: string;
    /**
     * B8 — Framework picker label. Optional in the labels bag so the
     * default English string survives for callers that haven't
     * migrated i18n.
     */
    framework?: string;
}

interface FrameworkOption {
    value: string;
    label: string;
}

interface CycleOption {
    value: string;
    label: string;
}

interface CycleRow {
    id: string;
    name: string;
    frameworkKey: string;
}

export function NewAuditFields({
    form,
    labels,
}: {
    form: NewAuditFormReturn;
    labels: NewAuditFieldsLabels;
}) {
    const tx = useTranslations('audits');
    const apiUrl = useTenantApiUrl();
    // The empty-value "No framework" option label is localised; memoised so it
    // stays reference-stable for the lazy-load effect below.
    const noFrameworkOption = useMemo<FrameworkOption>(
        () => ({ value: '', label: tx('newModal.noFramework') }),
        [tx],
    );
    const [frameworks, setFrameworks] = useState<FrameworkOption[]>([
        noFrameworkOption,
    ]);
    // feat/audit-cycle-unify — the "standalone" (no-cycle) option.
    const noCycleOption = useMemo<CycleOption>(
        () => ({ value: '', label: tx('newModal.noCycle') }),
        [tx],
    );
    const [cycleRows, setCycleRows] = useState<CycleRow[]>([]);
    // A cycle reads "<cycle> · <framework name>". The cycle carries only its
    // framework's KEY ("ISO27001"), so the name comes from the framework
    // catalogue loaded below; the key stands in only when that read failed
    // or does not list the framework.
    const cycles = useMemo<CycleOption[]>(() => {
        const nameOf = (key: string) =>
            frameworks.find((f) => f.value === key && f.value !== '')?.label ?? key;
        return [
            noCycleOption,
            ...cycleRows.map((c) => ({ value: c.id, label: `${c.name} · ${nameOf(c.frameworkKey)}` })),
        ];
    }, [cycleRows, frameworks, noCycleOption]);

    // B8 — lazy-load the framework catalog on mount. The list is
    // small (≈5-10 rows today) and the create-audit modal is
    // opened on demand, so a single GET on open is the right shape.
    useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                const res = await fetch(apiUrl('/frameworks'));
                if (!res.ok) return;
                const rows = (await res.json()) as Array<{
                    key: string;
                    name: string;
                }>;
                if (cancelled) return;
                setFrameworks([
                    noFrameworkOption,
                    ...rows.map((fw) => ({ value: fw.key, label: fw.name })),
                ]);
            } catch {
                // Fail-soft — the picker stays usable with just the
                // "No framework" option so audit creation never
                // blocks on a catalog GET.
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [apiUrl]);

    // feat/audit-cycle-unify — lazy-load the cycle list so an audit can be
    // created as fieldwork within a cycle. Fail-soft (picker stays usable
    // with just "Standalone" if the GET fails).
    useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                const res = await fetch(apiUrl('/audits/cycles'));
                if (!res.ok) return;
                const rows = (await res.json()) as CycleRow[];
                if (cancelled) return;
                setCycleRows(Array.isArray(rows) ? rows : []);
            } catch {
                /* fail-soft */
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [apiUrl]);

    return (
        <>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-default">
                <FormField label={labels.auditTitle} required>
                    <Input
                        id="audit-title-input"
                        value={form.fields.title}
                        onChange={(e) => form.setField('title', e.target.value)}
                        required
                    />
                </FormField>
                <FormField label={labels.framework ?? tx('newModal.framework')}>
                    <Combobox
                        id="audit-framework-select"
                        data-testid="audit-framework-select"
                        options={frameworks}
                        selected={
                            frameworks.find(
                                (o) => o.value === form.fields.frameworkKey,
                            ) ?? noFrameworkOption
                        }
                        setSelected={(opt) =>
                            form.setField('frameworkKey', opt?.value ?? '')
                        }
                        placeholder={tx('newModal.noFramework')}
                        matchTriggerWidth
                    />
                </FormField>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-default">
                <FormField label={labels.auditors}>
                    <Input
                        id="audit-auditors-input"
                        value={form.fields.auditors}
                        onChange={(e) =>
                            form.setField('auditors', e.target.value)
                        }
                    />
                </FormField>
                {/* feat/audit-cycle-unify — create this audit as fieldwork
                    within an audit cycle (or leave standalone). */}
                <FormField label={tx('newModal.cycle')}>
                    <Combobox
                        id="audit-cycle-select"
                        data-testid="audit-cycle-select"
                        options={cycles}
                        selected={
                            cycles.find((o) => o.value === form.fields.auditCycleId) ?? noCycleOption
                        }
                        setSelected={(opt) =>
                            form.setField('auditCycleId', opt?.value ?? '')
                        }
                        placeholder={tx('newModal.noCycle')}
                        matchTriggerWidth
                    />
                </FormField>
            </div>

            <FormField label={labels.scope}>
                <Textarea
                    id="audit-scope-input"
                    className="h-24"
                    value={form.fields.scope}
                    onChange={(e) => form.setField('scope', e.target.value)}
                />
            </FormField>
        </>
    );
}
