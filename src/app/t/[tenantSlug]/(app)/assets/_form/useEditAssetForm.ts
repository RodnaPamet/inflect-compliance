'use client';

/**
 * Asset-edit form hook — modal-form P1 extraction.
 *
 * Unlike the other three entities (create flows), the asset hook is
 * an EDIT flow. The detail page passes `assetId` + `initial` (seeded
 * from the loaded `asset` row); `submit()` PATCHes the partial form
 * back. `onSuccess` receives the updated asset and is expected to
 * close the editor / refresh the detail card.
 *
 * The hook is structurally identical to the create hooks so the P2
 * `<EditAssetModal>` can compose it against the same `<EditAssetFields>`
 * markup. See
 * `docs/implementation-notes/2026-05-24-modal-form-architecture.md`.
 */
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import type { AssetDetail } from '@/lib/dto/asset.types';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';

export interface EditAssetFormFields {
    name: string;
    type: string;
    classification: string;
    /** The owner — real user reference (User.id), '' = unassigned. The legacy
     *  free-text `owner` is import-only and NOT edited here (see the detail
     *  page's single "Owner" concept). */
    ownerUserId: string;
    location: string;
    status: string;
    dataResidency: string;
    externalRef: string;
    dependencies: string;
    businessProcesses: string;
    retention: string;
    retentionUntil: string;
    confidentiality: number;
    integrity: number;
    availability: number;
    cpe: string;
    vendor: string;
    product: string;
    version: string;
}

export interface EditAssetFormReturn {
    fields: EditAssetFormFields;
    setField: <K extends keyof EditAssetFormFields>(
        key: K,
        value: EditAssetFormFields[K],
    ) => void;
    submitting: boolean;
    error: string | null;
    canSubmit: boolean;
    submit: () => Promise<void>;
    isDirty: boolean;
}

export interface UseEditAssetFormOptions {
    assetId: string;
    initial: Partial<EditAssetFormFields>;
    onSuccess: (asset: AssetDetail) => void;
}

const DEFAULTS: EditAssetFormFields = {
    name: '',
    type: 'SYSTEM',
    classification: '',
    ownerUserId: '',
    location: '',
    status: 'ACTIVE',
    dataResidency: '',
    externalRef: '',
    dependencies: '',
    businessProcesses: '',
    retention: '',
    retentionUntil: '',
    confidentiality: 3,
    integrity: 3,
    availability: 3,
    cpe: '',
    vendor: '',
    product: '',
    version: '',
};

export function useEditAssetForm({
    assetId,
    initial,
    onSuccess,
}: UseEditAssetFormOptions): EditAssetFormReturn {
    const apiUrl = useTenantApiUrl();
    const t = useTranslations('assets');

    const [fields, setFields] = useState<EditAssetFormFields>(() => ({
        ...DEFAULTS,
        ...initial,
    }));
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [isDirty, setIsDirty] = useState(false);

    const setField = <K extends keyof EditAssetFormFields>(
        key: K,
        value: EditAssetFormFields[K],
    ) => {
        setFields((f) => ({ ...f, [key]: value }));
        setIsDirty(true);
    };

    const canSubmit = fields.name.trim().length > 0 && !submitting;

    const submit = async (): Promise<void> => {
        setSubmitting(true);
        setError(null);
        try {
            const res = await fetch(apiUrl(`/assets/${assetId}`), {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(fields),
            });
            if (!res.ok) throw new Error(t('form.saveFailed'));
            const payload = await res.json();
            // PATCH /assets/:id returns `{ success, asset }` while GET
            // returns the bare asset. Unwrap so the detail page's
            // optimistic `setAsset(updated)` receives the same shape it
            // loaded with — otherwise the Overview reads undefined fields
            // (e.g. criticality C/I/A) and looks unchanged until a manual
            // refresh re-runs the GET.
            const updated = payload?.asset ?? payload;
            setIsDirty(false);
            onSuccess(updated);
        } catch (err) {
            setError(err instanceof Error ? err.message : t('form.saveFailed'));
        } finally {
            setSubmitting(false);
        }
    };

    return {
        fields,
        setField,
        submitting,
        error,
        canSubmit,
        submit,
        isDirty,
    };
}
