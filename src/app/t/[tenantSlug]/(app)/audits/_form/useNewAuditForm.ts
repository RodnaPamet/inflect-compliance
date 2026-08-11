'use client';

/**
 * Audit-create form hook — B6 useZodForm adoption.
 *
 * Pre-B6 this was a hand-rolled `useState` shape; B6 ports it onto
 * `useZodForm` driven by `NewAuditFormSchema`. Return shape stays
 * compatible with `<NewAuditModal>` + `<NewAuditFields>`.
 *
 * P3.1 (audits data-access) — the POST underneath is a
 * `useTenantMutation` keyed off `CACHE_KEYS`, so the create shares the
 * surface's one write lifecycle (request → error capture → re-throw →
 * revalidate) instead of re-deciding it here.
 */
import { z } from 'zod';
import { useTranslations } from 'next-intl';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';
import { useTenantMutation } from '@/lib/hooks/use-tenant-mutation';
import { CACHE_KEYS } from '@/lib/swr-keys';
import type { CappedList } from '@/lib/list-backfill-cap';
import { useZodForm } from '@/lib/hooks/use-zod-form';
import {
    NewAuditFormSchema,
    type NewAuditFormValues,
} from '@/lib/schemas/audit-form';

export type NewAuditFormFields = NewAuditFormValues;

/**
 * What `useZodForm` hands `onSubmit` — the PARSED payload, so every
 * `.default()`-ed field is a concrete value by the time it reaches the
 * wire (`z.input` would leave them `| undefined` and JSON.stringify
 * would drop them).
 */
type NewAuditPayload = z.output<typeof NewAuditFormSchema>;

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

    /**
     * The create POST, as the surface's one write shape.
     *
     * Keyed at the audits LIST, not a detail key — the server mints the
     * id, so there is no detail entry to target yet. The key is
     * cycle-scoped exactly when the list is: `AuditsClient` reads
     * `/audits?cycleId=…` under an active cycle filter and the bare
     * `/audits` key otherwise, and both sides derive it from
     * `CACHE_KEYS.audits.list()`. A near-miss string here would update
     * nothing and read as a slow network.
     *
     * `TData` is the list envelope (`{ rows, truncated }`, not a bare
     * array) — the row shape never surfaces, because:
     *
     * No `optimisticUpdate`. The server mints the id, the createdAt, the
     * status and (when `generateChecklist` is set) the whole checklist —
     * none of it derivable client-side. A guessed row would visibly shift
     * on revalidation; waiting is the honest answer.
     *
     * No `invalidate` either. The cycles LIST (`listAuditCycles`) carries
     * each cycle's PACKS, not its audits, so it is not stale after a
     * create. The cycle DETAIL entry (`getAuditCycle`) does carry them —
     * but `auditCycleId` is a field the user can still change, so the
     * target cycle is unknown until submit while `invalidate` binds here;
     * naming a cycle now would be exactly the near-miss key above.
     * `<NewAuditModal>`'s `onSuccess` keeps the cross-key fan-out — it
     * revalidates EVERY `/audits` list variant, which one key cannot
     * express.
     */
    const createMutation = useTenantMutation<
        CappedList<unknown>,
        NewAuditPayload,
        { id: string }
    >({
        key: initialCycleId
            ? `${CACHE_KEYS.audits.list()}?cycleId=${initialCycleId}`
            : CACHE_KEYS.audits.list(),
        mutationFn: async (payload) => {
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
            return res.json();
        },
    });

    const zod = useZodForm({
        schema: NewAuditFormSchema,
        // feat/audits-surface — prefill the cycle from the active list filter.
        initial: { ...INITIAL, auditCycleId: initialCycleId ?? '' },
        onSubmit: async (payload) => {
            // `trigger` re-throws the error built in `mutationFn`, so the
            // message `useZodForm` surfaces as `error` (rendered in
            // `#new-audit-error`) is the same string, from the same place,
            // as before the migration.
            const audit = await createMutation.trigger(payload);
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
