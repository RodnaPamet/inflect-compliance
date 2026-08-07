'use client';

/**
 * Epic 54 — Create Control modal.
 *
 * Modal-based version of the legacy `/controls/new` full-page form.
 * Mounts inside the Controls list so users don't lose their table
 * state, filters, or scroll position when opening "New Control".
 *
 * Form pattern (Epic 64-FORM):
 *   - `useForm` + `zodResolver` for state + validation
 *   - `<FormField>` wraps each control (Label + error + a11y wiring)
 *   - `register(...)` for plain inputs / textareas
 *   - `<Controller>` for the Combobox primitives (they own their own
 *     value/onChange contract)
 *
 * This is the canonical example of how to build a non-trivial form on
 * the shared form foundation. Mirror this shape when migrating
 * `NewRiskModal`, `NewTaskPage`, etc.
 *
 * Business behaviour is unchanged from the previous useState shape:
 *   - POST /api/t/:slug/controls with the same payload
 *   - Optional NOT_APPLICABLE applicability update on the created control
 *   - On success, invalidate the React-Query cache and route to the
 *     new control's detail page
 *   - Form IDs (#control-name-input, …, #create-control-btn) are
 *     preserved so existing E2E suites pass untouched.
 */

import { zodResolver } from '@hookform/resolvers/zod';
import { useSWRConfig } from 'swr';
import { useRouter } from 'next/navigation';
import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    type Dispatch,
    type SetStateAction,
} from 'react';
import { Controller, useForm } from 'react-hook-form';
import { useTranslations } from 'next-intl';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { CONTROL_CATEGORY_THEMES } from '@/lib/controls/control-categories';
import { UserCombobox } from '@/components/ui/user-combobox';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { InfoTooltip } from '@/components/ui/tooltip';
import { useToast } from '@/components/ui/hooks/use-toast';
import { CACHE_KEYS } from '@/lib/swr-keys';
import { useTenantApiUrl, useTenantHref } from '@/lib/tenant-context-provider';
import { useFormTelemetry } from '@/lib/telemetry/form-telemetry';
import { choiceOrNull, textOrNull } from './_lib/control-write-values';

// ─── Options ─────────────────────────────────────────────────────────

type OptT = (key: string) => string;
const buildFrequencyOptions = (t: OptT): ComboboxOption[] => [
    { value: 'AD_HOC', label: t('freq.adHoc') },
    { value: 'DAILY', label: t('freq.daily') },
    { value: 'WEEKLY', label: t('freq.weekly') },
    { value: 'MONTHLY', label: t('freq.monthly') },
    { value: 'QUARTERLY', label: t('freq.quarterly') },
    { value: 'ANNUALLY', label: t('freq.annually') },
];

// Mirror of EditControlModal's classification options (the Prisma
// enums are the source of truth — keep these two lists in sync).
const buildAutomationTypeOptions = (t: OptT): ComboboxOption[] => [
    { value: 'AUTOMATED', label: t('automationTypeLabels.AUTOMATED') },
    { value: 'MANUAL', label: t('automationTypeLabels.MANUAL') },
    { value: 'IT_DEPENDENT_MANUAL', label: t('automationTypeLabels.IT_DEPENDENT_MANUAL') },
];

const buildMitigationTypeOptions = (t: OptT): ComboboxOption[] => [
    { value: 'PREVENTIVE', label: t('mitigationTypeLabels.PREVENTIVE') },
    { value: 'DETECTIVE', label: t('mitigationTypeLabels.DETECTIVE') },
    { value: 'DETERRENT', label: t('mitigationTypeLabels.DETERRENT') },
    { value: 'CORRECTIVE', label: t('mitigationTypeLabels.CORRECTIVE') },
    { value: 'COMPENSATING', label: t('mitigationTypeLabels.COMPENSATING') },
];

// Canonical category vocabulary — the four ISO 27002:2022 themes (shared with
// the quick-edit panel + the detail edit modal). A create control has no prior
// value, so no preserved legacy option is needed here.
const buildCategoryOptions = (t: OptT): ComboboxOption[] =>
    CONTROL_CATEGORY_THEMES.map((theme) => ({ value: theme, label: t(`categoryLabels.${theme}`) }));

// ─── Schema ──────────────────────────────────────────────────────────
//
// Zod schema is the source of truth for the form contract. Server-side
// validation lives in `src/lib/schemas/index.ts`; the
// client form intentionally enforces a SUBSET (name required + the
// not-applicable-needs-justification rule). Cross-field validation runs
// in `superRefine` so the error is attached to the right field.

// The schema is a factory so its user-facing validation messages route
// through next-intl (`t`). It's memoised per-render inside the component
// (see `formSchema` below) and passed to `zodResolver`.
const buildFormSchema = (t: OptT) =>
    z
        .object({
            code: z.string().max(64).optional(),
            name: z.string().min(1, t('new.nameRequired')),
            category: z.string().optional(),
            frequency: z.string().optional(),
            ownerUserId: z.string().optional(),
            automationType: z.string().optional(),
            mitigationType: z.string().optional(),
            applicability: z.enum(['APPLICABLE', 'NOT_APPLICABLE']),
            justification: z.string().optional(),
        })
        .superRefine((data, ctx) => {
            if (
                data.applicability === 'NOT_APPLICABLE' &&
                !data.justification?.trim()
            ) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    path: ['justification'],
                    message: t('justificationRequired'),
                });
            }
        });

type FormValues = z.infer<ReturnType<typeof buildFormSchema>>;

const DEFAULT_VALUES: FormValues = {
    code: '',
    name: '',
    category: '',
    frequency: '',
    ownerUserId: '',
    automationType: '',
    mitigationType: '',
    applicability: 'APPLICABLE',
    justification: '',
};

// ─── Component ───────────────────────────────────────────────────────

export interface NewControlModalProps {
    open: boolean;
    setOpen: Dispatch<SetStateAction<boolean>>;
    /**
     * Tenant slug for react-query invalidation. The mutation already
     * uses tenant-scoped apiUrl helpers; this is only used for keys.
     */
    tenantSlug: string;
}

export function NewControlModal({ open, setOpen, tenantSlug }: NewControlModalProps) {
    const t = useTranslations('controls');
    const FREQUENCY_OPTIONS = useMemo(() => buildFrequencyOptions(t), [t]);
    const AUTOMATION_TYPE_OPTIONS = useMemo(() => buildAutomationTypeOptions(t), [t]);
    const MITIGATION_TYPE_OPTIONS = useMemo(() => buildMitigationTypeOptions(t), [t]);
    const CATEGORY_OPTIONS = useMemo(() => buildCategoryOptions(t), [t]);
    const formSchema = useMemo(() => buildFormSchema(t), [t]);
    const close = useCallback(() => setOpen(false), [setOpen]);
    const apiUrl = useTenantApiUrl();
    const tenantHref = useTenantHref();
    const router = useRouter();
    const toast = useToast();
    const { mutate: swrMutate } = useSWRConfig();
    const telemetry = useFormTelemetry('NewControlModal');

    // Holds the id of a control that was created in a prior submit whose
    // applicability follow-up then failed. Retrying re-runs ONLY the
    // applicability step against this id — it never re-creates the
    // control (which would leave a duplicate). Cleared on full success
    // and whenever the modal (re)opens.
    const createdControlIdRef = useRef<string | null>(null);

    const {
        register,
        handleSubmit,
        control,
        watch,
        reset,
        setError: setFormError,
        setFocus,
        formState: { errors, isSubmitting },
    } = useForm<FormValues>({
        resolver: zodResolver(formSchema),
        defaultValues: DEFAULT_VALUES,
        mode: 'onTouched',
    });

    // react-hook-form's `watch` triggers a re-subscription on every call;
    // the React Compiler rule flags it as incompatible-library because
    // it's not designed for the new strict reactivity model. Working as
    // intended in production.
    // eslint-disable-next-line react-hooks/incompatible-library
    const applicability = watch('applicability');
    // Watch name so the submit button can mirror the legacy disabled
    // gate (`disabled until name is non-empty`). RHF's `formState.isValid`
    // is unreliable under `mode: 'onTouched'` for the initial render
    // (true before the user touches anything); explicit watch matches
    // the documented E2E selector + assertion.
    const nameValue = watch('name');
    const justificationValue = watch('justification');
    const submitDisabled =
        isSubmitting ||
        nameValue.trim().length === 0 ||
        (applicability === 'NOT_APPLICABLE' &&
            (justificationValue?.trim().length ?? 0) === 0);

    // Reset form + focus the name input each time the modal opens.
    useEffect(() => {
        if (!open) return;
        reset(DEFAULT_VALUES);
        // A fresh open starts a fresh control — drop any id cached by a
        // prior partial-failure retry so the next submit creates anew.
        createdControlIdRef.current = null;
        // Give Radix's focus manager a beat before we override.
        const t = setTimeout(() => setFocus('name'), 60);
        return () => clearTimeout(t);
    }, [open, reset, setFocus]);

    const onSubmit = async (values: FormValues) => {
        telemetry.trackSubmit({
            applicability: values.applicability,
            hasCategory: Boolean(values.category),
            hasFrequency: Boolean(values.frequency),
        });
        try {
            // Step 1 — create the control. Guarded by the cached id so a
            // retry after a partial failure (control created, applicability
            // step failed) does NOT create a duplicate.
            let createdId = createdControlIdRef.current;
            if (!createdId) {
                // Same empty-value rule as the detail page and the quick-edit
                // panel — see _lib/control-write-values. These used to map ''
                // to `undefined`, which omits the key: the same "leave this
                // blank" gesture cleared the field on the detail page and
                // no-opped here.
                const body = {
                    name: values.name.trim(),
                    code: textOrNull(values.code),
                    category: choiceOrNull(values.category),
                    frequency: choiceOrNull(values.frequency),
                    ownerUserId: choiceOrNull(values.ownerUserId),
                    automationType: choiceOrNull(values.automationType),
                    mitigationType: choiceOrNull(values.mitigationType),
                    isCustom: true,
                };
                const res = await fetch(apiUrl('/controls'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                });
                if (!res.ok) {
                    const data = await res.json().catch(() => ({}));
                    // Carry the server-supplied message when present; an
                    // empty message lets the catch apply the localized
                    // default — the fallback string lives in ONE place
                    // (the catch), so it is never dead code here.
                    const serverMsg =
                        typeof data.error === 'string'
                            ? data.error
                            : typeof data.message === 'string'
                              ? data.message
                              : '';
                    throw new Error(serverMsg);
                }
                const created: { id: string } = await res.json();
                createdId = created.id;
                createdControlIdRef.current = createdId;
            }

            // Step 2 — applicability follow-up. A failure here is NOT
            // swallowed: the control already exists as APPLICABLE and the
            // typed justification would otherwise be lost. Surface the
            // partial failure and let the catch keep the modal open (form
            // state, incl. the justification, is preserved) so the user
            // can retry just this step.
            if (
                values.applicability === 'NOT_APPLICABLE' &&
                values.justification?.trim()
            ) {
                const applicabilityRes = await fetch(
                    apiUrl(`/controls/${createdId}/applicability`),
                    {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            applicability: 'NOT_APPLICABLE',
                            justification: values.justification,
                        }),
                    },
                );
                if (!applicabilityRes.ok) {
                    throw new Error(t('new.applicabilityFailed'));
                }
            }

            // Both steps succeeded — clear the cached id.
            createdControlIdRef.current = null;

            // Revalidate every variant of the controls list key (unfiltered +
            // each `?<filters>`) so the new control appears under any filter.
            const controlsUrlPrefix = apiUrl(CACHE_KEYS.controls.list());
            swrMutate(
                (key) =>
                    typeof key === 'string' &&
                    (key === controlsUrlPrefix || key.startsWith(`${controlsUrlPrefix}?`)),
                undefined,
                { revalidate: true },
            );

            telemetry.trackSuccess({ controlId: createdId });
            close();
            router.push(tenantHref(`/controls/${createdId}`));
        } catch (err) {
            telemetry.trackError(err);
            const message =
                err instanceof Error && err.message
                    ? err.message
                    : t('new.createFailed');
            // Surface as a transient toast AND via RHF's root-error slot so
            // both the notification and the inline banner carry the failure.
            toast.error(message);
            setFormError('root.api', { type: 'api', message });
        }
    };

    const apiError = errors.root?.api?.message;

    return (
        <Modal
            showModal={open}
            setShowModal={setOpen}
            size="lg"
            title={t('new.ariaTitle')}
            description={t('new.desc')}
            preventDefaultClose={isSubmitting}
        >
            <Modal.Header
                title={t('new.title')}
                description={t('new.desc')}
            />
            <Modal.Form onSubmit={handleSubmit(onSubmit)}>
                <Modal.Body>
                    {apiError && (
                        <div
                            className="mb-4 rounded-lg border border-border-error bg-bg-error px-3 py-2 text-sm text-content-error"
                            id="new-control-error"
                            role="alert"
                        >
                            {apiError}
                        </div>
                    )}

                    <div className="space-y-default">
                        <FormField label={t('new.codeLabel')} error={errors.code?.message}>
                            <Input
                                id="control-code-input"
                                type="text"
                                placeholder={t('new.codePlaceholder')}
                                autoComplete="off"
                                {...register('code')}
                            />
                        </FormField>
                        <FormField
                            label={t('new.nameLabel')}
                            required
                            error={errors.name?.message}
                        >
                            <Input
                                id="control-name-input"
                                type="text"
                                placeholder={t('new.namePlaceholder')}
                                autoComplete="off"
                                {...register('name')}
                            />
                        </FormField>
                        <div className="grid grid-cols-1 gap-default sm:grid-cols-2">
                            <FormField
                                label={t('new.categoryLabel')}
                                error={errors.category?.message}
                            >
                                <Controller
                                    control={control}
                                    name="category"
                                    render={({ field }) => (
                                        <Combobox
                                            id="control-category-input"
                                            name="category"
                                            options={CATEGORY_OPTIONS}
                                            selected={
                                                CATEGORY_OPTIONS.find(
                                                    (o) => o.value === field.value,
                                                ) ?? null
                                            }
                                            setSelected={(o) =>
                                                field.onChange(o?.value ?? '')
                                            }
                                            placeholder={t('new.categoryPlaceholder')}
                                            searchPlaceholder={t('new.categorySearch')}
                                            matchTriggerWidth
                                            forceDropdown
                                            buttonProps={{ className: 'w-full' }}
                                            caret
                                        />
                                    )}
                                />
                            </FormField>
                            <FormField
                                label={t('new.frequencyLabel')}
                                hint={t('new.frequencyHint')}
                                error={errors.frequency?.message}
                            >
                                <Controller
                                    control={control}
                                    name="frequency"
                                    render={({ field }) => (
                                        <Combobox
                                            id="control-frequency-input"
                                            name="frequency"
                                            options={FREQUENCY_OPTIONS}
                                            selected={
                                                FREQUENCY_OPTIONS.find(
                                                    (o) => o.value === field.value,
                                                ) ?? null
                                            }
                                            setSelected={(o) =>
                                                field.onChange(o?.value ?? '')
                                            }
                                            placeholder={t('new.frequencyPlaceholder')}
                                            hideSearch
                                            matchTriggerWidth
                                            forceDropdown
                                            buttonProps={{ className: 'w-full' }}
                                            caret
                                        />
                                    )}
                                />
                            </FormField>
                        </div>
                        <div className="grid grid-cols-1 gap-default sm:grid-cols-2">
                            <FormField
                                label={t('new.automationLabel')}
                                error={errors.automationType?.message}
                            >
                                <Controller
                                    control={control}
                                    name="automationType"
                                    render={({ field }) => (
                                        <Combobox
                                            id="control-automation-type-input"
                                            name="automationType"
                                            options={AUTOMATION_TYPE_OPTIONS}
                                            selected={
                                                AUTOMATION_TYPE_OPTIONS.find(
                                                    (o) => o.value === field.value,
                                                ) ?? null
                                            }
                                            setSelected={(o) =>
                                                field.onChange(o?.value ?? '')
                                            }
                                            placeholder={t('new.automationPlaceholder')}
                                            hideSearch
                                            matchTriggerWidth
                                            forceDropdown
                                            buttonProps={{ className: 'w-full' }}
                                            caret
                                        />
                                    )}
                                />
                            </FormField>
                            <FormField
                                label={t('new.mitigationLabel')}
                                error={errors.mitigationType?.message}
                            >
                                <Controller
                                    control={control}
                                    name="mitigationType"
                                    render={({ field }) => (
                                        <Combobox
                                            id="control-mitigation-type-input"
                                            name="mitigationType"
                                            options={MITIGATION_TYPE_OPTIONS}
                                            selected={
                                                MITIGATION_TYPE_OPTIONS.find(
                                                    (o) => o.value === field.value,
                                                ) ?? null
                                            }
                                            setSelected={(o) =>
                                                field.onChange(o?.value ?? '')
                                            }
                                            placeholder={t('new.mitigationPlaceholder')}
                                            hideSearch
                                            matchTriggerWidth
                                            forceDropdown
                                            buttonProps={{ className: 'w-full' }}
                                            caret
                                        />
                                    )}
                                />
                            </FormField>
                        </div>
                        <FormField label={t('new.ownerLabel')} error={errors.ownerUserId?.message}>
                            <Controller
                                control={control}
                                name="ownerUserId"
                                render={({ field }) => (
                                    <UserCombobox
                                        id="control-owner-input"
                                        name="ownerUserId"
                                        tenantSlug={tenantSlug}
                                        selectedId={field.value || null}
                                        onChange={(userId) =>
                                            field.onChange(userId ?? '')
                                        }
                                        placeholder={t('new.ownerPlaceholder')}
                                    />
                                )}
                            />
                        </FormField>
                        <div role="group" aria-labelledby="applicability-legend">
                            <div className="mb-1 flex items-center gap-1.5">
                                <span
                                    id="applicability-legend"
                                    className="text-sm text-content-default"
                                >
                                    {t('new.applicability')}
                                </span>
                                <InfoTooltip
                                    aria-label={t('new.applicabilityHelp')}
                                    iconClassName="h-3.5 w-3.5"
                                    content={t('new.applicabilityTooltip')}
                                />
                            </div>
                            <div className="flex gap-default">
                                <label className="flex items-center gap-tight text-sm text-content-default">
                                    <input
                                        type="radio"
                                        value="APPLICABLE"
                                        {...register('applicability')}
                                    />
                                    {t('new.applicable')}
                                </label>
                                <label className="flex items-center gap-tight text-sm text-content-default">
                                    <input
                                        type="radio"
                                        value="NOT_APPLICABLE"
                                        {...register('applicability')}
                                    />
                                    {t('new.notApplicable')}
                                </label>
                            </div>
                            {applicability === 'NOT_APPLICABLE' && (
                                <FormField
                                    label=""
                                    error={errors.justification?.message}
                                    className="mt-2"
                                >
                                    <Textarea
                                        id="control-justification-input"
                                        rows={2}
                                        placeholder={t('new.justificationPlaceholder')}
                                        aria-label={t('new.justificationAria')}
                                        {...register('justification')}
                                    />
                                </FormField>
                            )}
                        </div>
                    </div>
                </Modal.Body>
                <Modal.Actions>
                    <Button
                        variant="secondary"
                        size="sm"
                        id="new-control-cancel-btn"
                        onClick={() => {
                            if (!isSubmitting) close();
                        }}
                        disabled={isSubmitting}
                    >
                        {t('new.cancel')}
                    </Button>
                    <Button
                        type="submit"
                        variant="primary"
                        size="sm"
                        id="create-control-btn"
                        disabled={submitDisabled}
                    >
                        {isSubmitting ? t('new.creating') : t('new.submit')}
                    </Button>
                </Modal.Actions>
            </Modal.Form>
        </Modal>
    );
}
