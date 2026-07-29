'use client';

/**
 * Controlled field markup for the vendor-create form.
 */
import { useTranslations } from 'next-intl';
import { Checkbox } from '@/components/ui/checkbox';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { DatePicker } from '@/components/ui/date-picker/date-picker';
import {
    parseYMD,
    startOfUtcDay,
    toYMD,
} from '@/components/ui/date-picker/date-utils';
import type { NewVendorFormFields, NewVendorFormReturn } from './useNewVendorForm';

export function NewVendorFields({ form }: { form: NewVendorFormReturn }) {
    const t = useTranslations('vendors');
    const STATUS_OPTIONS = [
        { value: 'ACTIVE', label: t('form.statusActive') },
        { value: 'ONBOARDING', label: t('form.statusOnboarding') },
    ];
    const CRIT_OPTIONS: ComboboxOption[] = [
        { value: 'LOW', label: t('form.critLow') },
        { value: 'MEDIUM', label: t('form.critMedium') },
        { value: 'HIGH', label: t('form.critHigh') },
        { value: 'CRITICAL', label: t('form.critCritical') },
    ];
    const DATA_ACCESS_OPTIONS: ComboboxOption[] = [
        { value: 'NONE', label: t('form.dataNone') },
        { value: 'LOW', label: t('form.dataLow') },
        { value: 'MEDIUM', label: t('form.dataMedium') },
        { value: 'HIGH', label: t('form.dataHigh') },
    ];
    return (
        <>
            <FormField label={t('form.name')} required>
                <Input
                    id="vendor-name-input"
                    value={form.fields.name}
                    onChange={(e) => form.setField('name', e.target.value)}
                    required
                />
            </FormField>

            <div className="grid grid-cols-2 gap-default">
                <FormField label={t('form.legalName')}>
                    <Input
                        id="vendor-legal-name"
                        value={form.fields.legalName}
                        onChange={(e) => form.setField('legalName', e.target.value)}
                    />
                </FormField>
                <FormField label={t('form.domain')}>
                    <Input
                        id="vendor-domain"
                        value={form.fields.domain}
                        onChange={(e) => form.setField('domain', e.target.value)}
                        placeholder={t('form.domainPlaceholder')}
                    />
                </FormField>
            </div>

            <div className="grid grid-cols-2 gap-default">
                <FormField label={t('form.websiteUrl')}>
                    <Input
                        id="vendor-website"
                        type="url"
                        value={form.fields.websiteUrl}
                        onChange={(e) => form.setField('websiteUrl', e.target.value)}
                    />
                </FormField>
                <FormField label={t('form.country')}>
                    <Input
                        id="vendor-country"
                        value={form.fields.country}
                        onChange={(e) => form.setField('country', e.target.value)}
                    />
                </FormField>
            </div>

            <FormField label={t('form.description')}>
                <Textarea
                    id="vendor-description"
                    className="h-20"
                    value={form.fields.description}
                    onChange={(e) => form.setField('description', e.target.value)}
                />
            </FormField>

            <div className="grid grid-cols-3 gap-default">
                <div>
                    <label className="block text-sm font-medium text-content-default mb-1">
                        {t('form.status')}
                    </label>
                    <RadioGroup
                        id="vendor-status-select"
                        value={form.fields.status}
                        onValueChange={(v) =>
                            form.setField('status', v as NewVendorFormFields['status'])
                        }
                        className="flex gap-default pt-1"
                    >
                        {STATUS_OPTIONS.map((o) => {
                            const itemId = `vendor-status-${o.value.toLowerCase()}`;
                            return (
                                <div
                                    key={o.value}
                                    className="flex items-center gap-tight"
                                >
                                    <RadioGroupItem value={o.value} id={itemId} />
                                    <Label
                                        htmlFor={itemId}
                                        className="cursor-pointer"
                                    >
                                        {o.label}
                                    </Label>
                                </div>
                            );
                        })}
                    </RadioGroup>
                </div>
                <FormField label={t('form.criticality')}>
                    <Combobox
                        id="vendor-criticality-select"
                        name="criticality"
                        options={CRIT_OPTIONS}
                        selected={
                            CRIT_OPTIONS.find(
                                (o) => o.value === form.fields.criticality,
                            ) ?? null
                        }
                        setSelected={(o) =>
                            form.setField(
                                'criticality',
                                (o?.value ?? 'MEDIUM') as NewVendorFormFields['criticality'],
                            )
                        }
                        placeholder={t('form.criticalityPlaceholder')}
                        hideSearch
                        matchTriggerWidth
                        buttonProps={{ className: 'w-full' }}
                        caret
                    />
                </FormField>
                <FormField label={t('form.dataAccess')}>
                    <Combobox
                        id="vendor-data-access"
                        name="dataAccess"
                        options={DATA_ACCESS_OPTIONS}
                        selected={
                            DATA_ACCESS_OPTIONS.find(
                                (o) => o.value === form.fields.dataAccess,
                            ) ?? null
                        }
                        setSelected={(o) =>
                            form.setField('dataAccess', o?.value ?? '')
                        }
                        placeholder={t('form.dataAccessPlaceholder')}
                        hideSearch
                        matchTriggerWidth
                        buttonProps={{ className: 'w-full' }}
                        caret
                    />
                </FormField>
            </div>

            <div className="grid grid-cols-2 gap-default">
                <FormField label={t('form.nextReviewDate')}>
                    <DatePicker
                        id="vendor-next-review"
                        className="w-full"
                        placeholder={t('form.datePlaceholder')}
                        clearable
                        align="start"
                        value={parseYMD(form.fields.nextReviewAt)}
                        onChange={(next) =>
                            form.setField('nextReviewAt', toYMD(next) ?? '')
                        }
                        disabledDays={{
                            before: startOfUtcDay(new Date()),
                        }}
                        aria-label={t('form.nextReviewDate')}
                    />
                </FormField>
                <FormField label={t('form.contractRenewalDate')}>
                    <DatePicker
                        id="vendor-contract-renewal"
                        className="w-full"
                        placeholder={t('form.datePlaceholder')}
                        clearable
                        align="start"
                        value={parseYMD(form.fields.contractRenewalAt)}
                        onChange={(next) =>
                            form.setField('contractRenewalAt', toYMD(next) ?? '')
                        }
                        disabledDays={{
                            before: startOfUtcDay(new Date()),
                        }}
                        aria-label={t('form.contractRenewalDate')}
                    />
                </FormField>
            </div>

            <label className="flex items-center gap-tight text-sm text-content-default">
                <Checkbox
                    checked={form.fields.isSubprocessor}
                    onCheckedChange={(v) =>
                        form.setField('isSubprocessor', !!v)
                    }
                    id="vendor-subprocessor"
                />
                {t('form.isSubprocessor')}
            </label>
        </>
    );
}
