'use client';

/**
 * Register an agent.
 *
 * The form asks TWO different sets of questions and keeps them visibly apart:
 *
 *   1. The agent's own properties — how autonomous, how far into tenant data,
 *      how reversible, whose code. These decide operational authority.
 *   2. The EU AI Act questionnaire. Its answers drive the deterministic
 *      classifier on the SERVER; the tier is never set from here, and there is
 *      no field for it. Leaving every question blank yields MINIMAL (Art 95).
 *
 * None of the three exposure axes carries a default in this form beyond the
 * least-exposing value being pre-selected for the two enums where a choice is
 * mandatory anyway — the server refuses an omitted axis rather than scoring it
 * zero, so the form must always send one.
 */
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Combobox } from '@/components/ui/combobox';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { NumberStepper } from '@/components/ui/number-stepper';
import {
    ART5_PROHIBITED_PRACTICES,
    ANNEX_III_AREAS,
    ART50_TRANSPARENCY_CASES,
} from '@/lib/eu-ai-act/classification';
import {
    AGENT_AUTONOMY_MAX,
    AGENT_AUTONOMY_MIN,
} from '@/app-layer/schemas/agent-registry.schemas';

export interface OwnerOption {
    id: string;
    label: string;
}
export interface VendorOption {
    id: string;
    name: string;
}

const ACCESS_SCOPES = [
    'NONE',
    'READ_METADATA',
    'READ_TENANT_DATA',
    'WRITE_TENANT_DATA',
    'EXTERNAL_EGRESS',
] as const;
const REVERSIBILITIES = ['REVERSIBLE', 'COMPENSABLE', 'TERMINAL'] as const;

const formSchema = z.object({
    name: z.string().min(2),
    description: z.string().optional(),
    ownerUserId: z.string().min(1),
    autonomyLevel: z.number().int().min(AGENT_AUTONOMY_MIN).max(AGENT_AUTONOMY_MAX),
    dataAccessScope: z.enum(ACCESS_SCOPES),
    reversibility: z.enum(REVERSIBILITIES),
    provenance: z.enum(['FIRST_PARTY', 'THIRD_PARTY']),
    vendorId: z.string().optional(),
    prohibitedPractice: z.string().optional(),
    isAnnexIProductSafetyComponent: z.boolean().optional(),
    annexIIIArea: z.string().optional(),
    transparencyCase: z.string().optional(),
});
type FormValues = z.infer<typeof formSchema>;

interface Props {
    tenantSlug: string;
    owners: OwnerOption[];
    vendors: VendorOption[];
    onClose: () => void;
    onCreated: (id: string) => void | Promise<void>;
}

export function NewAgentModal({ tenantSlug, owners, vendors, onClose, onCreated }: Props) {
    const t = useTranslations('admin');
    // `common.cancel` rather than an agent-specific key — the word is the same
    // one every modal in the product uses, and a second copy of it is a second
    // thing to translate.
    const tCommon = useTranslations('common');
    const [apiError, setApiError] = useState<string | null>(null);

    const noneOption = { value: '', label: t('agentRegistry.new.noneApplicable') };
    const toClauseOptions = (opts: readonly { id: string; clause: string; label: string }[]) => [
        noneOption,
        ...opts.map((o) => ({ value: o.id, label: `${o.clause} — ${o.label}` })),
    ];

    const ownerOptions = owners.map((o) => ({ value: o.id, label: o.label }));
    const vendorOptions = [noneOption, ...vendors.map((v) => ({ value: v.id, label: v.name }))];
    const scopeOptions = ACCESS_SCOPES.map((s) => ({
        value: s,
        label: t(`agentRegistry.filterEnums.accessScope.${s}`),
    }));
    const reversibilityOptions = REVERSIBILITIES.map((r) => ({
        value: r,
        label: t(`agentRegistry.reversibility.${r}`),
    }));
    const provenanceOptions = [
        { value: 'FIRST_PARTY', label: t('agentRegistry.new.provenanceFirstParty') },
        { value: 'THIRD_PARTY', label: t('agentRegistry.new.provenanceThirdParty') },
    ];

    const {
        register,
        handleSubmit,
        control,
        watch,
        formState: { errors, isSubmitting },
    } = useForm<FormValues>({
        resolver: zodResolver(formSchema),
        defaultValues: {
            name: '',
            description: '',
            ownerUserId: owners[0]?.id ?? '',
            autonomyLevel: 0,
            dataAccessScope: 'NONE',
            reversibility: 'REVERSIBLE',
            provenance: 'FIRST_PARTY',
            vendorId: '',
            prohibitedPractice: '',
            isAnnexIProductSafetyComponent: false,
            annexIIIArea: '',
            transparencyCase: '',
        },
        mode: 'onTouched',
    });

    const provenance = watch('provenance');

    const onSubmit = async (values: FormValues) => {
        setApiError(null);
        try {
            const res = await fetch(`/api/t/${tenantSlug}/admin/agents`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: values.name,
                    description: values.description || undefined,
                    ownerUserId: values.ownerUserId,
                    autonomyLevel: values.autonomyLevel,
                    dataAccessScope: values.dataAccessScope,
                    reversibility: values.reversibility,
                    provenance: values.provenance,
                    vendorId: values.vendorId || undefined,
                    classification: {
                        prohibitedPractice: values.prohibitedPractice || undefined,
                        isAnnexIProductSafetyComponent:
                            values.isAnnexIProductSafetyComponent || undefined,
                        annexIIIArea: values.annexIIIArea || undefined,
                        transparencyCase: values.transparencyCase || undefined,
                    },
                }),
            });
            if (!res.ok) {
                const body = (await res.json().catch(() => null)) as { error?: string } | null;
                throw new Error(body?.error ?? t('agentRegistry.new.errorFallback'));
            }
            const created = (await res.json()) as { id: string };
            await onCreated(created.id);
        } catch (e) {
            setApiError(e instanceof Error ? e.message : t('agentRegistry.new.errorFallback'));
        }
    };

    const clauseSelect = (
        name: 'prohibitedPractice' | 'annexIIIArea' | 'transparencyCase',
        options: { value: string; label: string }[],
    ) => (
        <Controller
            control={control}
            name={name}
            render={({ field }) => (
                <Combobox
                    id={`agent-${name}-input`}
                    name={name}
                    options={options}
                    selected={options.find((o) => o.value === (field.value ?? '')) ?? options[0]}
                    setSelected={(o) => field.onChange(o?.value ?? '')}
                    placeholder={t('agentRegistry.new.noneApplicable')}
                    matchTriggerWidth
                    forceDropdown
                    buttonProps={{ className: 'w-full' }}
                    caret
                />
            )}
        />
    );

    const enumSelect = (
        name: 'dataAccessScope' | 'reversibility' | 'provenance' | 'ownerUserId' | 'vendorId',
        options: { value: string; label: string }[],
        placeholder: string,
        hideSearch = true,
    ) => (
        <Controller
            control={control}
            name={name}
            render={({ field }) => (
                <Combobox
                    id={`agent-${name}-input`}
                    name={name}
                    options={options}
                    selected={options.find((o) => o.value === (field.value ?? '')) ?? null}
                    setSelected={(o) => field.onChange(o?.value ?? '')}
                    placeholder={placeholder}
                    hideSearch={hideSearch}
                    matchTriggerWidth
                    forceDropdown
                    buttonProps={{ className: 'w-full' }}
                    caret
                />
            )}
        />
    );

    return (
        <Modal
            showModal
            setShowModal={(v) => {
                if (!v && !isSubmitting) onClose();
            }}
            size="lg"
            title={t('agentRegistry.new.title')}
            description={t('agentRegistry.new.descShort')}
            preventDefaultClose={isSubmitting}
        >
            <Modal.Header
                title={t('agentRegistry.new.title')}
                description={t('agentRegistry.new.descLong')}
            />
            <Modal.Form onSubmit={handleSubmit(onSubmit)}>
                <Modal.Body>
                    {apiError && (
                        <div
                            className="mb-4 rounded-lg border border-border-error bg-bg-error px-3 py-2 text-sm text-content-error"
                            role="alert"
                        >
                            {apiError}
                        </div>
                    )}
                    <div className="space-y-default">
                        <FormField
                            label={t('agentRegistry.new.nameLabel')}
                            required
                            error={errors.name?.message}
                        >
                            <Input
                                id="agent-name-input"
                                type="text"
                                placeholder={t('agentRegistry.new.namePlaceholder')}
                                autoComplete="off"
                                {...register('name')}
                            />
                        </FormField>

                        <FormField
                            label={t('agentRegistry.new.descriptionLabel')}
                            hint={t('agentRegistry.new.encryptedHint')}
                            error={errors.description?.message}
                        >
                            <Textarea
                                id="agent-description-input"
                                rows={2}
                                placeholder={t('agentRegistry.new.descriptionPlaceholder')}
                                {...register('description')}
                            />
                        </FormField>

                        <div className="grid grid-cols-1 gap-default sm:grid-cols-2">
                            <FormField
                                label={t('agentRegistry.new.ownerLabel')}
                                required
                                error={errors.ownerUserId?.message}
                            >
                                {enumSelect(
                                    'ownerUserId',
                                    ownerOptions,
                                    t('agentRegistry.new.ownerPlaceholder'),
                                    false,
                                )}
                            </FormField>
                            <FormField
                                label={t('agentRegistry.new.autonomyLabel')}
                                hint={t('agentRegistry.new.autonomyHint')}
                                required
                                error={errors.autonomyLevel?.message}
                            >
                                <Controller
                                    control={control}
                                    name="autonomyLevel"
                                    render={({ field }) => (
                                        <NumberStepper
                                            id="agent-autonomy-input"
                                            value={field.value}
                                            onChange={field.onChange}
                                            min={AGENT_AUTONOMY_MIN}
                                            max={AGENT_AUTONOMY_MAX}
                                            ariaLabel={t('agentRegistry.new.autonomyLabel')}
                                        />
                                    )}
                                />
                            </FormField>
                        </div>

                        <div className="grid grid-cols-1 gap-default sm:grid-cols-2">
                            <FormField
                                label={t('agentRegistry.new.accessLabel')}
                                required
                                error={errors.dataAccessScope?.message}
                            >
                                {enumSelect('dataAccessScope', scopeOptions, scopeOptions[0].label)}
                            </FormField>
                            <FormField
                                label={t('agentRegistry.new.reversibilityLabel')}
                                required
                                error={errors.reversibility?.message}
                            >
                                {enumSelect(
                                    'reversibility',
                                    reversibilityOptions,
                                    reversibilityOptions[0].label,
                                )}
                            </FormField>
                        </div>

                        <div className="grid grid-cols-1 gap-default sm:grid-cols-2">
                            <FormField
                                label={t('agentRegistry.new.provenanceLabel')}
                                required
                                error={errors.provenance?.message}
                            >
                                {enumSelect(
                                    'provenance',
                                    provenanceOptions,
                                    provenanceOptions[0].label,
                                )}
                            </FormField>
                            {/* Only shown for a third-party agent, because that
                                is the only case where the server requires it —
                                and it requires it absolutely. */}
                            {provenance === 'THIRD_PARTY' && (
                                <FormField
                                    label={t('agentRegistry.new.vendorLabel')}
                                    hint={t('agentRegistry.new.vendorHint')}
                                    required
                                    error={errors.vendorId?.message}
                                >
                                    {enumSelect(
                                        'vendorId',
                                        vendorOptions,
                                        t('agentRegistry.new.vendorPlaceholder'),
                                        false,
                                    )}
                                </FormField>
                            )}
                        </div>

                        <div className="rounded-lg border border-border-subtle bg-bg-subtle p-3 space-y-default">
                            <p className="text-sm font-medium text-content-emphasis">
                                {t('agentRegistry.new.classificationHeading')}
                            </p>
                            <p className="text-xs text-content-subtle">
                                {t('agentRegistry.new.classificationHelp')}
                            </p>
                            <FormField label={t('agentRegistry.new.art5Label')}>
                                {clauseSelect(
                                    'prohibitedPractice',
                                    toClauseOptions(ART5_PROHIBITED_PRACTICES),
                                )}
                            </FormField>
                            <FormField label={t('agentRegistry.new.annexIIILabel')}>
                                {clauseSelect('annexIIIArea', toClauseOptions(ANNEX_III_AREAS))}
                            </FormField>
                            <label className="flex items-center gap-tight text-sm text-content-default">
                                <input
                                    id="agent-annexi-input"
                                    type="checkbox"
                                    {...register('isAnnexIProductSafetyComponent')}
                                />
                                {t('agentRegistry.new.art6Checkbox')}
                            </label>
                            <FormField label={t('agentRegistry.new.art50Label')}>
                                {clauseSelect(
                                    'transparencyCase',
                                    toClauseOptions(ART50_TRANSPARENCY_CASES),
                                )}
                            </FormField>
                        </div>
                    </div>
                </Modal.Body>
                <Modal.Footer>
                    <Button type="button" variant="secondary" onClick={onClose} disabled={isSubmitting}>
                        {tCommon('cancel')}
                    </Button>
                    <Button type="submit" variant="primary" disabled={isSubmitting}>
                        {isSubmitting
                            ? t('agentRegistry.new.submitting')
                            : t('agentRegistry.new.submit')}
                    </Button>
                </Modal.Footer>
            </Modal.Form>
        </Modal>
    );
}
