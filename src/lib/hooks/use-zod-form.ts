'use client';

/**
 * B6 — `useZodForm` is the canonical client-side form hook for
 * Zod-validated modal forms. Replaces the per-entity hand-rolled
 * `useNew<Entity>Form` shape that the modal-form roadmap shipped
 * once per entity.
 *
 * Contract surfaced to the consumer:
 *
 *   - `values: T` — current form values (typed off the schema's
 *     output).
 *   - `setField(key, value)` — set a single field. Marks the form
 *     dirty + re-runs validation.
 *   - `touchField(key)` — mark a field touched (for "show error
 *     after the user leaves the field" semantics).
 *   - `fieldError(key)` — string message for the field's first
 *     error, or `undefined` if pristine / valid / not-yet-touched.
 *   - `canSubmit` — schema-parses cleanly AND not currently
 *     submitting.
 *   - `submit()` — calls the caller's submit fn with the parsed
 *     payload. Returns whatever the submit fn returns. Surfaces
 *     submit errors to `error`.
 *   - `submitting`, `error`, `isDirty` — same shape the legacy
 *     hooks used so wrapping modals don't need to rewire props.
 *
 * Design decisions:
 *
 *   - Zod is the contract. The caller passes a FRONTEND-safe
 *     schema. A host application's server-side schemas are
 *     deliberately not reused wholesale, because they sometimes
 *     reach into types the frontend bundle shouldn't pull in
 *     (ORM-emitted enums, etc.).
 *
 *   - Validation is lazy + per-field. `safeParse` runs on every
 *     `setField`; field errors are scoped via `.format()` so a
 *     single broken field doesn't blank out the rest of the form.
 *
 *   - Touched state is per-field. Untouched fields hide their
 *     error message — the user shouldn't see "required" on a
 *     blank form before they've started typing. Submitting marks
 *     every field touched so failing fields surface on the first
 *     submit click.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import { z, type ZodTypeAny } from 'zod';

export interface UseZodFormOptions<TSchema extends ZodTypeAny> {
    schema: TSchema;
    initial: z.input<TSchema>;
    onSubmit: (payload: z.output<TSchema>) => Promise<unknown> | unknown;
}

export interface UseZodFormReturn<TSchema extends ZodTypeAny> {
    values: z.input<TSchema>;
    setField: <K extends keyof z.input<TSchema>>(
        key: K,
        value: z.input<TSchema>[K],
    ) => void;
    touchField: <K extends keyof z.input<TSchema>>(key: K) => void;
    fieldError: <K extends keyof z.input<TSchema>>(key: K) => string | undefined;
    canSubmit: boolean;
    submit: () => Promise<unknown>;
    submitting: boolean;
    error: string | null;
    isDirty: boolean;
    /** Reset every field back to its initial value (e.g. after successful submit). */
    reset: () => void;
}

export function useZodForm<TSchema extends ZodTypeAny>({
    schema,
    initial,
    onSubmit,
}: UseZodFormOptions<TSchema>): UseZodFormReturn<TSchema> {
    type In = z.input<TSchema>;
    // `initial` is captured once — subsequent renders that pass a
    // fresh `initial` object don't restart the form. The hook is
    // single-shot per mount; consumers that need to re-seed should
    // unmount + remount (the modal-open pattern already does this).
    const initialRef = useRef(initial);
    const [values, setValues] = useState<In>(initial);
    const [touched, setTouched] = useState<Record<string, boolean>>({});
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [isDirty, setIsDirty] = useState(false);

    const parseResult = useMemo(
        () => schema.safeParse(values),
        [schema, values],
    );

    const fieldErrors = useMemo(() => {
        if (parseResult.success) return {} as Record<string, string>;
        const out: Record<string, string> = {};
        for (const issue of parseResult.error.issues) {
            const key = issue.path[0];
            if (typeof key !== 'string') continue;
            if (out[key]) continue; // first error wins
            out[key] = issue.message;
        }
        return out;
    }, [parseResult]);

    const setField = useCallback<UseZodFormReturn<TSchema>['setField']>(
        (key, value) => {
            // The schema type is opaque to TS in the generic
            // position; cast to a record to satisfy the spread.
            // Callers see the typed `In` shape; the cast is
            // structurally safe because every schema we hand the
            // hook resolves to an object type.
            setValues((prev) => ({
                ...(prev as unknown as Record<string, unknown>),
                [key]: value,
            }) as In);
            setIsDirty(true);
        },
        [],
    );

    const touchField = useCallback<UseZodFormReturn<TSchema>['touchField']>(
        (key) => {
            setTouched((prev) =>
                prev[key as string] ? prev : { ...prev, [key as string]: true },
            );
        },
        [],
    );

    const fieldError = useCallback<UseZodFormReturn<TSchema>['fieldError']>(
        (key) => {
            if (!touched[key as string]) return undefined;
            return fieldErrors[key as string];
        },
        [fieldErrors, touched],
    );

    const canSubmit = parseResult.success && !submitting;

    const submit = useCallback(async () => {
        setError(null);
        // Mark everything touched so field errors surface on submit.
        const allTouched: Record<string, boolean> = {};
        for (const k of Object.keys(values as object)) allTouched[k] = true;
        setTouched(allTouched);
        if (!parseResult.success) return undefined;
        setSubmitting(true);
        try {
            const result = await onSubmit(parseResult.data);
            setIsDirty(false);
            return result;
        } catch (e) {
            const message =
                e instanceof Error ? e.message : 'Submission failed';
            setError(message);
            throw e;
        } finally {
            setSubmitting(false);
        }
    }, [onSubmit, parseResult, values]);

    const reset = useCallback(() => {
        setValues(initialRef.current);
        setTouched({});
        setError(null);
        setIsDirty(false);
    }, []);

    return {
        values,
        setField,
        touchField,
        fieldError,
        canSubmit,
        submit,
        submitting,
        error,
        isDirty,
        reset,
    };
}
