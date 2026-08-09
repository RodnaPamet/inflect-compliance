'use client';

/**
 * Risk-create form hook — B2-8 `useZodForm` adoption.
 *
 * Risks was the last major surface with no `_form/` directory: assets,
 * audits, policies, tasks and vendors all had one, and `NewRiskModal` still
 * hand-rolled a single `useState` object plus its own `submitting` / `error`
 * slots and a `title.trim().length > 0` submit gate.
 *
 * The return shape deliberately mirrors `useNewVendorForm` — `fields`,
 * `setField`, `submitting`, `error`, `canSubmit`, `submit`, `isDirty`, plus
 * the richer `touchField` / `fieldError` — so the modal mounts it the same
 * way every other surface does.
 *
 * ## What stays OUT of this hook
 *
 * Template selection and control linking. They look like form state and are
 * not:
 *
 *   - `templateId` drives a *fetch*, and picking a template rewrites several
 *     form fields. Folding it into the schema would make "the user typed a
 *     title" and "a template overwrote the title" the same event.
 *   - `selectedControlIds` is not sent with the risk at all. It drives a
 *     SECOND phase after the risk exists (`POST /risks/:id/controls` per
 *     id), because the links need the new risk's id. That phase deliberately
 *     counts failures instead of throwing — the risk is already created, so
 *     a failed link must not present as a failed create.
 *
 * Both stay in the modal. The hook owns the risk payload and nothing else.
 */
import { useTenantApiUrl } from '@/lib/tenant-context-provider';
import { useZodForm } from '@/lib/hooks/use-zod-form';
import {
    NewRiskFormSchema,
    NEW_RISK_FORM_INITIAL,
    type NewRiskFormValues,
} from '@/lib/schemas/risk-form';

export type NewRiskFormFields = NewRiskFormValues;

export interface NewRiskFormReturn {
    /** Alias for `values`, matching the other `_form/` hooks. */
    fields: NewRiskFormFields;
    setField: <K extends keyof NewRiskFormFields>(
        key: K,
        value: NewRiskFormFields[K],
    ) => void;
    touchField: <K extends keyof NewRiskFormFields>(key: K) => void;
    fieldError: <K extends keyof NewRiskFormFields>(key: K) => string | undefined;
    submitting: boolean;
    error: string | null;
    canSubmit: boolean;
    submit: () => Promise<void>;
    isDirty: boolean;
    /** Replace several fields at once — the template-apply path. */
    applyFields: (patch: Partial<NewRiskFormFields>) => void;
    /** Restore initial values + clear dirty/touched/error — modal re-open. */
    reset: () => void;
}

export interface UseNewRiskFormOptions {
    /** Receives the created risk so the modal can run its link phase. */
    onCreated: (risk: { id: string }) => Promise<void> | void;
    /**
     * Observe a failed create. The message is ALREADY on `error` for the
     * banner — this exists so the caller can also report it (form telemetry),
     * which the pre-B2-8 `catch` block did.
     */
    onError?: (err: unknown) => void;
    /** Selected template id, folded into the payload if present. */
    templateId?: string | null;
    /**
     * Localised fallback for when the server sends no message of its own.
     * Passed in because this hook is not a component and has no translator
     * in scope.
     */
    fallbackErrorMessage: string;
}

export function useNewRiskForm({
    onCreated,
    onError,
    templateId,
    fallbackErrorMessage,
}: UseNewRiskFormOptions): NewRiskFormReturn {
    const apiUrl = useTenantApiUrl();

    const zod = useZodForm({
        schema: NewRiskFormSchema,
        initial: NEW_RISK_FORM_INITIAL,
        onSubmit: async (payload) => {
            // The schema keeps optional fields as `''` so the inputs stay
            // controlled; the API wants them ABSENT. This is the one place
            // that translation happens — doing it in the schema would make
            // `values` unusable as input state.
            const body: Record<string, unknown> = {
                title: payload.title.trim(),
                likelihood: payload.likelihood,
                impact: payload.impact,
            };
            if (payload.description.trim()) body.description = payload.description.trim();
            if (payload.category) body.category = payload.category;
            if (payload.ownerUserId) body.ownerUserId = payload.ownerUserId;
            if (payload.treatment) body.treatment = payload.treatment;
            if (payload.treatmentNotes.trim())
                body.treatmentNotes = payload.treatmentNotes.trim();
            // `<input type=date>` gives `YYYY-MM-DD`; the API wants an
            // instant. Converting here rather than in the schema keeps the
            // value feedable back into the input.
            if (payload.nextReviewAt) {
                body.nextReviewAt = new Date(payload.nextReviewAt).toISOString();
            }
            if (templateId) body.templateId = templateId;

            const res = await fetch(apiUrl('/risks'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                // Server messages are already localised and specific (plan
                // limits, duplicate key, validation) — prefer them, and fall
                // back to the caller's translated string.
                throw new Error(data.message || data.error || fallbackErrorMessage);
            }
            const risk = await res.json();
            await onCreated(risk);
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
        /**
         * Never rejects — deliberately narrower than `useZodForm.submit`,
         * which rethrows so callers can add toast/redirect UX on top.
         *
         * Here the failure is already on `error` and the modal renders it as
         * a banner, so a rethrow would buy nothing and cost an unhandled
         * rejection at every call site that forgets to catch (a `void
         * form.submit()` in a click handler rejects silently in the console
         * and, under a strict runtime, crashes the page).
         */
        submit: async () => {
            try {
                await zod.submit();
            } catch (err) {
                onError?.(err);
            }
        },
        isDirty: zod.isDirty,
        reset: zod.reset,
        applyFields: (patch) => {
            for (const [k, v] of Object.entries(patch)) {
                zod.setField(
                    k as keyof NewRiskFormFields,
                    v as NewRiskFormFields[keyof NewRiskFormFields],
                );
            }
        },
    };
}
