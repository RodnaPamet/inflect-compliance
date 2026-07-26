'use client';

/**
 * Audit-create form hook — B6 useZodForm adoption.
 *
 * Pre-B6 this was a hand-rolled `useState` shape; B6 ports it onto
 * `useZodForm` driven by `NewAuditFormSchema`. Return shape stays
 * compatible with `<NewAuditModal>` + `<NewAuditFields>`.
 */
import { useTranslations } from 'next-intl';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';
import { useZodForm } from '@/lib/hooks/use-zod-form';
import {
    NewAuditFormSchema,
    type NewAuditFormValues,
} from '@/lib/schemas/audit-form';

export type NewAuditFormFields = NewAuditFormValues;

export interface NewAuditFormReturn {
    fields: NewAuditFormFields;
    setField: <K extends keyof NewAuditFormFields>(
        key: K,
        value: NewAuditFormFields[K],
    ) => void;
    touchField: <K extends keyof NewAuditFormFields>(key: K) => void;
    fieldError: <K extends keyof NewAuditFormFields>(
        key: K,
    ) => string | undefined;
    submitting: boolean;
    error: string | null;
    canSubmit: boolean;
    submit: () => Promise<void>;
    isDirty: boolean;
}

export interface UseNewAuditFormOptions {
    onSuccess: (audit: { id: string }) => void;
    /**
     * feat/audits-surface — seed `auditCycleId` from the list's active
     * `?cycleId` filter so creating an audit while a cycle is selected
     * defaults the new audit to that cycle. `useZodForm` captures `initial`
     * once at mount, so this reflects the filter active when the modal
     * first mounted.
     */
    initialCycleId?: string;
}

const INITIAL: NewAuditFormFields = {
    title: '',
    scope: '',
    auditors: '',
    // B8 — empty string = no framework. The hook trims + null-coerces
    // before POSTing so the API receives `null` not `""`.
    frameworkKey: '',
    // feat/audit-cycle-unify — empty string = standalone audit (no cycle).
    auditCycleId: '',
    generateChecklist: true,
};

export function useNewAuditForm({
    onSuccess,
    initialCycleId,
}: UseNewAuditFormOptions): NewAuditFormReturn {
    const apiUrl = useTenantApiUrl();
    const t = useTranslations('audits');
    const zod = useZodForm({
        schema: NewAuditFormSchema,
        // feat/audits-surface — prefill the cycle from the active list filter.
        initial: { ...INITIAL, auditCycleId: initialCycleId ?? '' },
        onSubmit: async (payload) => {
            const res = await fetch(apiUrl('/audits'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    title: payload.title,
                    scope: payload.scope,
                    auditors: payload.auditors,
                    // B8 — null-coerce empty string. The API rejects
                    // string fields that exceed their cap but accepts
                    // null for an unbound audit.
                    frameworkKey: payload.frameworkKey?.trim() || null,
                    // feat/audit-cycle-unify — null-coerce so a standalone
                    // audit posts `null`, and fieldwork posts the cycle id.
                    auditCycleId: payload.auditCycleId?.trim() || null,
                    generateChecklist: payload.generateChecklist,
                }),
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(
                    err.error?.message || t('newModal.createFailed'),
                );
            }
            const audit = await res.json();
            onSuccess(audit);
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
