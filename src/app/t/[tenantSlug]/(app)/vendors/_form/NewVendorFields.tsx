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
import { DatePicker } from '@/components/ui/date-picker/date-picker';
import {
    parseYMD,
    startOfUtcDay,
    toYMD,
} from '@/components/ui/date-picker/date-utils';
import { VENDOR_FIELD_MAX } from '@/lib/schemas/vendor-form';
import type { NewVendorFormFields, NewVendorFormReturn } from './useNewVendorForm';

export function NewVendorFields({ form }: { form: NewVendorFormReturn }) {
    const t = useTranslations('vendors');
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
                    maxLength={VENDOR_FIELD_MAX.name}
                    required
                />
            </FormField>

            <div className="grid grid-cols-2 gap-default">
                <FormField label={t('form.legalName')}>
                    <Input
                        id="vendor-legal-name"
                        value={form.fields.legalName}
                        onChange={(e) => form.setField('legalName', e.target.value)}
                        maxLength={VENDOR_FIELD_MAX.legalName}
                    />
                </FormField>
                <FormField label={t('form.domain')}>
                    <Input
                        id="vendor-domain"
                        value={form.fields.domain}
                        onChange={(e) => form.setField('domain', e.target.value)}
                        placeholder={t('form.domainPlaceholder')}
                        maxLength={VENDOR_FIELD_MAX.domain}
                    />
                </FormField>
            </div>

            <div className="grid grid-cols-2 gap-default">
                {/* A value that is not a full URL (`acme.com`) fails the
                    schema, which disables Create Vendor. The field used to
                    render no error, so the button greyed out with nothing to
                    say why (#4462). The error shows once the field is left. */}
                <FormField
                    label={t('form.websiteUrl')}
                    error={form.fieldError('websiteUrl') ? t('form.websiteUrlInvalid') : undefined}
                >
                    <Input
                        id="vendor-website"
                        type="url"
                        value={form.fields.websiteUrl}
                        onChange={(e) => form.setField('websiteUrl', e.target.value)}
                        onBlur={() => form.touchField('websiteUrl')}
                        placeholder={t('form.websiteUrlPlaceholder')}
                        maxLength={VENDOR_FIELD_MAX.websiteUrl}
                    />
                </FormField>
                <FormField label={t('form.country')}>
                    <Input
                        id="vendor-country"
                        value={form.fields.country}
                        onChange={(e) => form.setField('country', e.target.value)}
                        maxLength={VENDOR_FIELD_MAX.country}
                    />
                </FormField>
            </div>

            <FormField label={t('form.description')}>
                <Textarea
                    id="vendor-description"
                    className="h-20"
                    value={form.fields.description}
                    onChange={(e) => form.setField('description', e.target.value)}
                    maxLength={VENDOR_FIELD_MAX.description}
                />
            </FormField>

            <div className="grid grid-cols-3 gap-default">
                {/* Not a choice (#4462). A new vendor starts Onboarding: Active
                    needs a completed assessment review, and a vendor that does
                    not exist yet has none, so the server refuses it. The form
                    used to offer Active here. */}
                <div>
                    <span className="block text-sm font-medium text-content-default mb-1">
                        {t('form.status')}
                    </span>
                    <p id="vendor-status-on-create" className="pt-1 text-sm text-content-default">
                        {t('form.statusOnboarding')}
                    </p>
                    <p className="mt-1 text-xs text-content-muted">
                        {t('form.statusOnCreateHint')}
                    </p>
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
