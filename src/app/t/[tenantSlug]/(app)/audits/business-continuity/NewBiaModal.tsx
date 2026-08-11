'use client';

/**
 * Create a Business Impact Analysis — the BIA register's one write.
 *
 * **Deliberately NOT on `useTenantMutation`,** and this is the last file in
 * the audits data-access migration's "Remaining" list, so the reason is
 * recorded rather than left as an omission.
 *
 * The register behind this modal is a SERVER component: `page.tsx` calls
 * `listBias(ctx)` and hands the rows down as `initialRows`. There is no client
 * cache entry holding them, so a mutation hook would compute an optimistic
 * update against an empty entry and change nothing on screen. The create then
 * navigates straight to the new BIA's detail page — also server-rendered — so
 * even a correct prediction would never be seen: the list it would paint is
 * unmounted a tick later.
 *
 * Same reasoning that excluded `BiaDetailClient` and the link-control write in
 * `[id]/BiaLinkControlModal.tsx`; see
 * docs/implementation-notes/2026-08-10-audits-data-access.md. If the register
 * ever moves onto `useTenantSWR(CACHE_KEYS.audits.businessContinuity())`, this
 * POST becomes a genuine target and should migrate with it.
 */

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Combobox } from '@/components/ui/combobox';
import { UserCombobox } from '@/components/ui/user-combobox';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { buildBiaCriticalityLabels } from './filter-defs';
import { DependencyPickerRow, useDepTypeLabel, type DependencyDraft } from './BiaDependencyControls';


const optionalHours = z.number().int().min(0).max(100_000).optional();

const formSchema = z.object({
    name: z.string().min(1, 'Name is required'),
    criticality: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']),
    rtoHours: optionalHours,
    rpoHours: optionalHours,
    mtpdHours: optionalHours,
    notes: z.string().optional(),
    // BIA-lifecycle — the accountable owner (was always "—" because the
    // create form never captured it, though createBia has accepted it).
    ownerUserId: z.string().optional(),
});
type FormValues = z.infer<typeof formSchema>;

// Empty number input → undefined (not NaN) so the optional schema passes.
const numberSetValueAs = (v: unknown) => (v === '' || v == null ? undefined : Number(v));

interface Props {
    tenantSlug: string;
    /** Prefill the analysed process node (from the canvas "Add BIA" cross-link). */
    processNodeId?: string;
    onClose: () => void;
    onCreated: (id: string) => void | Promise<void>;
}

export function NewBiaModal({ tenantSlug, processNodeId, onClose, onCreated }: Props) {
    const tx = useTranslations('audits');
    const CRITICALITY_OPTIONS = useMemo(
        () =>
            Object.entries(
                buildBiaCriticalityLabels((k, v) => tx(k as Parameters<typeof tx>[0], v as Parameters<typeof tx>[1])),
            ).map(([value, label]) => ({ value, label })),
        [tx],
    );
    const depTypeLabel = useDepTypeLabel();
    const [apiError, setApiError] = useState<string | null>(null);
    const [dependencies, setDependencies] = useState<DependencyDraft[]>([]);
    const {
        register,
        handleSubmit,
        control,
        formState: { errors, isSubmitting },
    } = useForm<FormValues>({
        resolver: zodResolver(formSchema),
        defaultValues: { name: '', criticality: 'HIGH', notes: '' },
        mode: 'onTouched',
    });

    const onSubmit = async (values: FormValues) => {
        setApiError(null);
        try {
            const res = await fetch(`/api/t/${tenantSlug}/business-continuity`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: values.name,
                    criticality: values.criticality,
                    rtoHours: values.rtoHours,
                    rpoHours: values.rpoHours,
                    mtpdHours: values.mtpdHours,
                    notes: values.notes || undefined,
                    ownerUserId: values.ownerUserId || undefined,
                    processNodeId: processNodeId || undefined,
                    dependencies: dependencies.map((d) => ({ dependsOnType: d.dependsOnType, dependsOnId: d.dependsOnId })),
                }),
            });
            if (!res.ok) throw new Error(tx('bia.createFailed'));
            const created = (await res.json()) as { id: string };
            await onCreated(created.id);
        } catch (e) {
            setApiError(e instanceof Error ? e.message : tx('bia.createFailed'));
        }
    };

    return (
        <Modal
            showModal
            setShowModal={(v) => {
                if (!v && !isSubmitting) onClose();
            }}
            size="lg"
            title={tx('bia.createTitle')}
            description={tx('bia.createDescShort')}
            preventDefaultClose={isSubmitting}
        >
            <Modal.Header title={tx('bia.createTitle')} description={tx('bia.createDescLong')} />
            <Modal.Form onSubmit={handleSubmit(onSubmit)}>
                <Modal.Body>
                    {apiError && (
                        <div className="mb-4 rounded-lg border border-border-error bg-bg-error px-3 py-2 text-sm text-content-error" role="alert">
                            {apiError}
                        </div>
                    )}
                    <div className="space-y-default">
                        <FormField label={tx('bia.fieldProcess')} required error={errors.name?.message}>
                            <Input id="bia-name-input" type="text" placeholder={tx('bia.phProcess')} autoComplete="off" {...register('name')} />
                        </FormField>
                        <FormField label={tx('bia.fieldCriticality')} required error={errors.criticality?.message}>
                            <Controller
                                control={control}
                                name="criticality"
                                render={({ field }) => (
                                    <Combobox
                                        id="bia-criticality-input"
                                        name="criticality"
                                        options={CRITICALITY_OPTIONS}
                                        selected={CRITICALITY_OPTIONS.find((o) => o.value === field.value) ?? null}
                                        setSelected={(o) => field.onChange(o?.value ?? 'HIGH')}
                                        placeholder={tx('bia.phCriticality')}
                                        hideSearch
                                        matchTriggerWidth
                                        forceDropdown
                                        buttonProps={{ className: 'w-full' }}
                                        caret
                                    />
                                )}
                            />
                        </FormField>
                        <div className="grid grid-cols-1 gap-default sm:grid-cols-3">
                            <FormField label={tx('bia.fieldRto')} hint={tx('bia.hintRto')} error={errors.rtoHours?.message}>
                                <Input id="bia-rto-input" type="text" inputMode="numeric" placeholder={tx('bia.phRto')} {...register('rtoHours', { setValueAs: numberSetValueAs })} />
                            </FormField>
                            <FormField label={tx('bia.fieldRpo')} hint={tx('bia.hintRpo')} error={errors.rpoHours?.message}>
                                <Input id="bia-rpo-input" type="text" inputMode="numeric" placeholder={tx('bia.phRpo')} {...register('rpoHours', { setValueAs: numberSetValueAs })} />
                            </FormField>
                            <FormField label={tx('bia.fieldMtpd')} hint={tx('bia.hintMtpd')} error={errors.mtpdHours?.message}>
                                <Input id="bia-mtpd-input" type="text" inputMode="numeric" placeholder={tx('bia.phMtpd')} {...register('mtpdHours', { setValueAs: numberSetValueAs })} />
                            </FormField>
                        </div>
                        <FormField label={tx('bia.fieldOwner')}>
                            <Controller
                                control={control}
                                name="ownerUserId"
                                render={({ field }) => (
                                    <UserCombobox
                                        id="bia-owner-input"
                                        tenantSlug={tenantSlug}
                                        selectedId={field.value ?? null}
                                        onChange={(uid) => field.onChange(uid ?? undefined)}
                                        placeholder={tx('bia.phOwner')}
                                        forceDropdown
                                        matchTriggerWidth
                                    />
                                )}
                            />
                        </FormField>
                        <FormField label={tx('bia.fieldNotes')} error={errors.notes?.message}>
                            <Textarea id="bia-notes-input" rows={3} placeholder={tx('bia.phNotes')} {...register('notes')} />
                        </FormField>
                        <FormField label={tx('bia.fieldDependencies')} hint={tx('bia.hintDependencies')}>
                            <div className="space-y-tight">
                                <DependencyPickerRow
                                    tenantSlug={tenantSlug}
                                    excludeIds={dependencies.map((d) => d.dependsOnId)}
                                    onAdd={(d) => setDependencies((prev) => [...prev, d])}
                                />
                                {dependencies.length === 0 ? (
                                    <p className="text-sm text-content-subtle">{tx('bia.depEmpty')}</p>
                                ) : (
                                    <ul className="space-y-tight">
                                        {dependencies.map((d) => (
                                            <li
                                                key={`${d.dependsOnType}:${d.dependsOnId}`}
                                                className="flex items-center justify-between rounded-lg border border-border-subtle px-3 py-1.5 text-sm"
                                            >
                                                <span className="text-content-default">
                                                    <span className="text-content-subtle">{depTypeLabel(d.dependsOnType)}</span> · {d.label}
                                                </span>
                                                <button
                                                    type="button"
                                                    onClick={() => setDependencies((prev) => prev.filter((x) => x.dependsOnId !== d.dependsOnId))}
                                                    className="text-content-muted hover:text-content-error"
                                                    aria-label={tx('bia.depRemove')}
                                                >
                                                    {tx('bia.depRemove')}
                                                </button>
                                            </li>
                                        ))}
                                    </ul>
                                )}
                            </div>
                        </FormField>
                    </div>
                </Modal.Body>
                <Modal.Footer>
                    <Button type="button" variant="secondary" onClick={onClose} disabled={isSubmitting}>
                        {tx('bia.cancel')}
                    </Button>
                    <Button type="submit" variant="primary" disabled={isSubmitting}>
                        {isSubmitting ? tx('bia.creating') : tx('bia.create')}
                    </Button>
                </Modal.Footer>
            </Modal.Form>
        </Modal>
    );
}
