'use client';

/**
 * Asset-create form hook — B6 useZodForm adoption.
 *
 * Pre-B6 this was a hand-rolled `useState` shape with a canSubmit
 * gate. B6 ports it onto `useZodForm` driven by
 * `NewAssetFormSchema` so the validation is Zod-typed + the
 * shared hook owns dirty/touch/submit semantics.
 *
 * Return shape preserves the legacy contract so the wrapping
 * `<NewAssetModal>` + `<NewAssetFields>` mount with no caller-side
 * changes.
 */
import { useTranslations } from 'next-intl';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';
import { useZodForm } from '@/lib/hooks/use-zod-form';
import {
    NewAssetFormSchema,
    type NewAssetFormValues,
} from '@/lib/schemas/asset-form';

export type NewAssetFormFields = NewAssetFormValues;

export interface NewAssetFormReturn {
    fields: NewAssetFormFields;
    setField: <K extends keyof NewAssetFormFields>(
        key: K,
        value: NewAssetFormFields[K],
    ) => void;
    touchField: <K extends keyof NewAssetFormFields>(key: K) => void;
    fieldError: <K extends keyof NewAssetFormFields>(
        key: K,
    ) => string | undefined;
    submitting: boolean;
    error: string | null;
    canSubmit: boolean;
    submit: () => Promise<void>;
    isDirty: boolean;
}

export interface UseNewAssetFormOptions {
    onSuccess: (asset: { id: string }) => void;
}

const INITIAL: NewAssetFormFields = {
    name: '',
    type: 'SYSTEM',
    status: 'ACTIVE',
    classification: '',
    ownerUserId: '',
    location: '',
    dataResidency: '',
    confidentiality: 3,
    integrity: 3,
    availability: 3,
    cpe: '',
    vendor: '',
    product: '',
    version: '',
    externalRef: '',
    dependencies: '',
    businessProcesses: '',
    retention: '',
    retentionUntil: '',
};

export function useNewAssetForm({
    onSuccess,
}: UseNewAssetFormOptions): NewAssetFormReturn {
    const apiUrl = useTenantApiUrl();
    const t = useTranslations('assets');
    const zod = useZodForm({
        schema: NewAssetFormSchema,
        initial: INITIAL,
        onSubmit: async (payload) => {
            const body: { name: string; type: string; status: string; confidentiality: number; integrity: number; availability: number; classification?: string; ownerUserId?: string; location?: string; dataResidency?: string; cpe?: string; vendor?: string; product?: string; version?: string; externalRef?: string; dependencies?: string; businessProcesses?: string; retention?: string; retentionUntil?: string } = {
                name: payload.name,
                type: payload.type,
                status: payload.status,
                confidentiality: payload.confidentiality,
                integrity: payload.integrity,
                availability: payload.availability,
            };
            if (payload.classification) body.classification = payload.classification;
            if (payload.ownerUserId) body.ownerUserId = payload.ownerUserId;
            if (payload.location) body.location = payload.location;
            if (payload.dataResidency) body.dataResidency = payload.dataResidency;
            if (payload.cpe) body.cpe = payload.cpe;
            if (payload.vendor) body.vendor = payload.vendor;
            if (payload.product) body.product = payload.product;
            if (payload.version) body.version = payload.version;
            if (payload.externalRef) body.externalRef = payload.externalRef;
            if (payload.dependencies) body.dependencies = payload.dependencies;
            if (payload.businessProcesses) body.businessProcesses = payload.businessProcesses;
            if (payload.retention) body.retention = payload.retention;
            if (payload.retentionUntil) body.retentionUntil = payload.retentionUntil;

            const res = await fetch(apiUrl('/assets'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.error?.message || t('form.createFailed'));
            }
            const asset = await res.json();
            onSuccess(asset);
        },
    });

    return {
        fields: zod.values,
        setField: zod.setField,
        touchField: zod.touchField,
        fieldError: zod.fieldError,
        submitting: zod.submitting,
        error: zod.error,
        canSubmit: zod.canSubmit,
        submit: async () => {
            await zod.submit();
        },
        isDirty: zod.isDirty,
    };
}
