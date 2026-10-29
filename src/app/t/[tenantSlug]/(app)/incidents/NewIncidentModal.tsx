'use client';
import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { UserCombobox } from '@/components/ui/user-combobox';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { DatePicker } from '@/components/ui/date-picker/date-picker';
import { apiErrorMessage } from '@/lib/api-error';
import { useHydratedNow } from '@/lib/hooks/use-hydrated-now';
import {
    combineDetectedAt,
    isDetectedAtInFuture,
    localTimeOf,
    pickerDayOf,
} from '@/lib/incidents/detected-at';
import { buildSeverityLabels, buildIncidentTypeLabels } from './filter-defs';

// The server's bounds (CreateIncidentSchema), checked here first so a long
// title is named at its field instead of failing the whole request.
const TITLE_MAX = 300;
const DESCRIPTION_MAX = 20000;

function buildFormSchema(t: (key: string, values?: Record<string, unknown>) => string) {
    return z.object({
        title: z
            .string()
            .min(1, t('new.errors.titleRequired'))
            .max(TITLE_MAX, t('new.errors.titleTooLong', { max: TITLE_MAX })),
        description: z
            .string()
            .max(DESCRIPTION_MAX, t('new.errors.descriptionTooLong', { max: DESCRIPTION_MAX }))
            .optional(),
        severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
        incidentType: z.enum(['RANSOMWARE', 'DATA_BREACH', 'DDOS', 'UNAUTHORIZED_ACCESS', 'OTHER']),
        ownerUserId: z.string().optional(),
    });
}
type FormValues = z.infer<ReturnType<typeof buildFormSchema>>;

export interface NewIncidentModalProps {
    open: boolean;
    onClose: () => void;
    tenantSlug: string;
    onCreated: (incidentId: string) => void | Promise<void>;
}

export function NewIncidentModal({ open, onClose, tenantSlug, onCreated }: NewIncidentModalProps) {
    const t = useTranslations('incidents');
    const tRef = (k: string, v?: Record<string, unknown>) => t(k as Parameters<typeof t>[0], v as Parameters<typeof t>[1]);
    const SEVERITY_OPTIONS: ComboboxOption[] = Object.entries(buildSeverityLabels(tRef)).map(([value, label]) => ({ value, label }));
    const TYPE_OPTIONS: ComboboxOption[] = Object.entries(buildIncidentTypeLabels(tRef)).map(([value, label]) => ({ value, label }));
    const [apiError, setApiError] = useState<string | null>(null);
    const formSchema = useMemo(
        () => buildFormSchema((k, v) => t(k as Parameters<typeof t>[0], v as Parameters<typeof t>[1])),
        [t],
    );
    // "Detected at" is a full timestamp: the day from the DatePicker (which is
    // day-level by design) and the time from a time field, both defaulting to
    // the moment the form opened, in the person's own time zone. It drives
    // every Article 23 deadline, so midnight of the chosen day would not do.
    // The clock is read once the client has painted, never during render
    // (`useHydratedNow`), and seeds both fields that one time.
    const openedAt = useHydratedNow();
    const [detectedDay, setDetectedDay] = useState<Date | null>(null);
    const [detectedTime, setDetectedTime] = useState('');
    const [seededFrom, setSeededFrom] = useState<Date | null>(null);
    if (openedAt && seededFrom !== openedAt) {
        setSeededFrom(openedAt);
        setDetectedDay(pickerDayOf(openedAt));
        setDetectedTime(localTimeOf(openedAt));
    }
    const [detectedError, setDetectedError] = useState<string | null>(null);
    const timeZone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);

    const {
        register,
        handleSubmit,
        control,
        watch,
        formState: { errors, isSubmitting },
    } = useForm<FormValues>({
        resolver: zodResolver(formSchema),
        defaultValues: { title: '', description: '', severity: 'MEDIUM', incidentType: 'OTHER', ownerUserId: '' },
        mode: 'onTouched',
    });

    // eslint-disable-next-line react-hooks/incompatible-library
    const titleValue = watch('title');

    const onSubmit = async (values: FormValues) => {
        setApiError(null);
        const detectedAt = combineDetectedAt(detectedDay, detectedTime);
        if (!detectedAt) {
            setDetectedError(t('new.errors.detectedTimeRequired'));
            return;
        }
        if (isDetectedAtInFuture(detectedAt, new Date())) {
            setDetectedError(t('new.errors.detectedInFuture'));
            return;
        }
        setDetectedError(null);
        try {
            const res = await fetch(`/api/t/${tenantSlug}/incidents`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    title: values.title,
                    description: values.description || undefined,
                    severity: values.severity,
                    incidentType: values.incidentType,
                    ownerUserId: values.ownerUserId || undefined,
                    detectedAt: detectedAt.toISOString(),
                }),
            });
            if (!res.ok) {
                // The server's reason (e.g. an owner who is not a member),
                // falling back to the generic message only when it sent none.
                let body: unknown = null;
                try {
                    body = await res.json();
                } catch {
                    /* no JSON body — fall back to the generic message */
                }
                throw new Error(apiErrorMessage(body, t('new.createFailed')));
            }
            const created = (await res.json()) as { id: string };
            await onCreated(created.id);
        } catch (e) {
            setApiError(e instanceof Error ? e.message : t('new.createFailed'));
        }
    };

    return (
        <Modal
            showModal={open}
            setShowModal={(v) => {
                if (!v && !isSubmitting) onClose();
            }}
            size="lg"
            title={t('new.title')}
            description={t('new.desc')}
            preventDefaultClose={isSubmitting}
        >
            <Modal.Header
                title={t('new.title')}
                description={t('new.descLong')}
            />
            <Modal.Form onSubmit={handleSubmit(onSubmit)}>
                <Modal.Body>
                    {apiError && (
                        <div
                            className="mb-4 rounded-lg border border-border-error bg-bg-error px-3 py-2 text-sm text-content-error"
                            id="new-incident-error"
                            role="alert"
                        >
                            {apiError}
                        </div>
                    )}
                    <div className="space-y-default">
                        <FormField label={t('new.fields.title')} required error={errors.title?.message}>
                            <Input
                                id="incident-title-input"
                                type="text"
                                placeholder={t('new.placeholders.title')}
                                autoComplete="off"
                                {...register('title')}
                            />
                        </FormField>
                        <FormField label={t('new.fields.description')} error={errors.description?.message}>
                            <Textarea
                                id="incident-description-input"
                                rows={3}
                                placeholder={t('new.placeholders.description')}
                                {...register('description')}
                            />
                        </FormField>
                        <div className="grid grid-cols-1 gap-default sm:grid-cols-2">
                            <FormField label={t('new.fields.severity')} required error={errors.severity?.message}>
                                <Controller
                                    control={control}
                                    name="severity"
                                    render={({ field }) => (
                                        <Combobox
                                            id="incident-severity-input"
                                            name="severity"
                                            options={SEVERITY_OPTIONS}
                                            selected={SEVERITY_OPTIONS.find((o) => o.value === field.value) ?? null}
                                            setSelected={(o) => field.onChange(o?.value ?? 'MEDIUM')}
                                            placeholder={t('new.placeholders.severity')}
                                            hideSearch
                                            matchTriggerWidth
                                            forceDropdown
                                            buttonProps={{ className: 'w-full' }}
                                            caret
                                        />
                                    )}
                                />
                            </FormField>
                            <FormField label={t('new.fields.type')} required error={errors.incidentType?.message}>
                                <Controller
                                    control={control}
                                    name="incidentType"
                                    render={({ field }) => (
                                        <Combobox
                                            id="incident-type-input"
                                            name="incidentType"
                                            options={TYPE_OPTIONS}
                                            selected={TYPE_OPTIONS.find((o) => o.value === field.value) ?? null}
                                            setSelected={(o) => field.onChange(o?.value ?? 'OTHER')}
                                            placeholder={t('new.placeholders.type')}
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
                            <FormField label={t('new.fields.detectedAt')} hint={t('new.detectedHint')}>
                                <DatePicker
                                    value={detectedDay}
                                    onChange={(d) => {
                                        setDetectedDay(d);
                                        setDetectedError(null);
                                    }}
                                    // No later day than today; the time field
                                    // and the submit check refuse a later time today.
                                    disabledDays={openedAt ? { after: openedAt } : undefined}
                                    placeholder={t('new.placeholders.detectedAt')}
                                />
                            </FormField>
                            <FormField
                                label={t('new.fields.detectedTime')}
                                hint={t('new.detectedTimeHint', { zone: timeZone })}
                                error={detectedError ?? undefined}
                            >
                                <Input
                                    id="incident-detected-time-input"
                                    type="time"
                                    value={detectedTime}
                                    onChange={(e) => {
                                        setDetectedTime(e.target.value);
                                        setDetectedError(null);
                                    }}
                                />
                            </FormField>
                        </div>
                        <div className="grid grid-cols-1 gap-default sm:grid-cols-2">
                            <FormField label={t('new.fields.commander')}>
                                <Controller
                                    control={control}
                                    name="ownerUserId"
                                    render={({ field }) => (
                                        <UserCombobox
                                            tenantSlug={tenantSlug}
                                            selectedId={field.value || null}
                                            onChange={(id) => field.onChange(id ?? '')}
                                            forceDropdown
                                            matchTriggerWidth
                                            placeholder={t('new.placeholders.commander')}
                                            id="incident-owner-input"
                                        />
                                    )}
                                />
                            </FormField>
                        </div>
                    </div>
                </Modal.Body>
                <Modal.Actions>
                    <Button
                        variant="secondary"
                        size="sm"
                        id="new-incident-cancel-btn"
                        onClick={() => {
                            if (!isSubmitting) onClose();
                        }}
                        disabled={isSubmitting}
                    >
                        {t('new.cancel')}
                    </Button>
                    <Button
                        type="submit"
                        variant="primary"
                        size="sm"
                        id="create-incident-btn"
                        disabled={isSubmitting || titleValue.trim().length === 0}
                    >
                        {isSubmitting ? t('new.creating') : t('new.create')}
                    </Button>
                </Modal.Actions>
            </Modal.Form>
        </Modal>
    );
}
