'use client';

/**
 * Vendor-create form hook — B6 useZodForm adoption.
 *
 * Pre-B6 this was a hand-rolled `useState` shape with manual
 * isDirty + canSubmit gates. B6 ports it onto the shared
 * `useZodForm` hook driven by `NewVendorFormSchema` so:
 *
 *   - Validation is Zod-typed and lives in `src/lib/schemas/`.
 *   - The return shape preserves the legacy contract
 *     (`fields`, `setField`, `submitting`, `error`, `canSubmit`,
 *     `submit`, `isDirty`) so the wrapping `<NewVendorModal>` +
 *     `<NewVendorFields>` mount with no caller-side changes.
 *   - The richer contract (`touchField`, `fieldError`) is
 *     exposed alongside for fields markup that wants per-field
 *     error rendering — see the corresponding B6 PR notes for
 *     `<NewVendorFields>` adoption.
 */
import { useTenantApiUrl } from '@/lib/tenant-context-provider';
import { useZodForm } from '@/lib/hooks/use-zod-form';
import {
    NewVendorFormSchema,
    type NewVendorFormValues,
} from '@/lib/schemas/vendor-form';

export type NewVendorFormFields = NewVendorFormValues;

export interface NewVendorFormReturn {
    /** Legacy alias for `values` — used by every caller pre-B6. */
    fields: NewVendorFormFields;
    setField: <K extends keyof NewVendorFormFields>(
        key: K,
        value: NewVendorFormFields[K],
    ) => void;
    touchField: <K extends keyof NewVendorFormFields>(key: K) => void;
    fieldError: <K extends keyof NewVendorFormFields>(
        key: K,
    ) => string | undefined;
    submitting: boolean;
    error: string | null;
    canSubmit: boolean;
    submit: () => Promise<void>;
    isDirty: boolean;
}

export interface UseNewVendorFormOptions {
    onSuccess: (vendor: { id: string }) => void;
    /**
     * Localised fallback for when the server sends no message of its own.
     * Passed in rather than resolved here because this hook is not a
     * component and has no translator in scope.
     */
    fallbackErrorMessage: string;
}

const INITIAL: NewVendorFormFields = {
    name: '',
    legalName: '',
    websiteUrl: '',
    domain: '',
    country: '',
    description: '',
    criticality: 'MEDIUM',
    status: 'ONBOARDING',
    dataAccess: '',
    isSubprocessor: false,
    nextReviewAt: '',
    contractRenewalAt: '',
};

export function useNewVendorForm({
    onSuccess,
    fallbackErrorMessage,
}: UseNewVendorFormOptions): NewVendorFormReturn {
    const apiUrl = useTenantApiUrl();
    const zod = useZodForm({
        schema: NewVendorFormSchema,
        initial: INITIAL,
        onSubmit: async (payload) => {
            // The server is the source of truth — re-validates on
            // POST. The frontend schema's `default('')` produces
            // empty strings on optional fields; only forward the
            // non-empty ones to match the legacy POST body shape.
            const body: { name: string; criticality: string; status: string; isSubprocessor: boolean; legalName?: string; websiteUrl?: string; domain?: string; country?: string; description?: string; dataAccess?: string; nextReviewAt?: string; contractRenewalAt?: string } = {
                name: payload.name,
                criticality: payload.criticality,
                status: payload.status,
                isSubprocessor: payload.isSubprocessor,
            };
            if (payload.legalName) body.legalName = payload.legalName;
            if (payload.websiteUrl) body.websiteUrl = payload.websiteUrl;
            if (payload.domain) body.domain = payload.domain;
            if (payload.country) body.country = payload.country;
            if (payload.description) body.description = payload.description;
            if (payload.dataAccess) body.dataAccess = payload.dataAccess;
            if (payload.nextReviewAt) body.nextReviewAt = payload.nextReviewAt;
            if (payload.contractRenewalAt)
                body.contractRenewalAt = payload.contractRenewalAt;

            const res = await fetch(apiUrl('/vendors'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                // The server message is already localised and specific
                // (plan limits, duplicate name, validation). The fallback was
                // a hardcoded English string on an otherwise localised
                // surface — now supplied by the caller.
                throw new Error(err.error?.message || fallbackErrorMessage);
            }
            const vendor = await res.json();
            onSuccess(vendor);
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
