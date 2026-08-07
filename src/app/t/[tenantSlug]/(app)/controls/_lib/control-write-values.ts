/**
 * The Control edit form → PATCH body mapping.
 *
 * Extracted from the detail page so it can be tested directly. It was inline
 * in the `useTenantMutation` callback, where the only way to observe it was
 * to mount a 1,383-line page — which is why two fields could be missing from
 * it for as long as they were: `automationType` and `mitigationType` are
 * rendered as wired Comboboxes, seeded from the loaded control, accepted by
 * Zod and written by `updateControl`, yet absent from the request. The modal
 * closed, `toast.success` fired, and the stale value re-rendered on refetch.
 *
 * The optimistic update on the same mutation must stay in step with this: a
 * paint that omits a field the request sends flashes the old value and then
 * corrects itself, which reads as a bug even when the write succeeded.
 */

/** The edit form's shape — every field is held as a string by the inputs. */
export interface ControlEditForm {
    name: string;
    objective: string;
    successCriteria: string;
    testingMethodology: string;
    category: string;
    frequency: string;
    automationType: string;
    mitigationType: string;
    annualCost: string;
    effectiveness: string;
}

/**
 * THE ONE RULE for empty values on every Control write surface.
 *
 * The three surfaces disagreed, and the same "clear this field" gesture had
 * three different outcomes:
 *
 *   detail page       '' -> null      unparseable -> undefined (KEY OMITTED,
 *                                     old value silently kept)
 *   ControlEditPanel  '' -> null
 *   NewControlModal   '' -> undefined (key omitted, so a cleared field
 *                                     no-opped on create)
 *
 * The rule, applied by every helper below:
 *
 *   - `''` (or whitespace) means CLEAR  -> `null`
 *   - a field not passed at all means UNCHANGED -> key absent
 *   - an unparseable value is REJECTED, never silently dropped
 *
 * "Rejected" is deliberate and visible: the raw string is sent, the server's
 * Zod schema fails it, and the caller's existing `if (!res.ok)` path shows
 * the error. Omitting the key instead — the old detail-page behaviour — told
 * the user their edit succeeded while keeping the previous value.
 */

/** Trim; empty means clear. */
export function textOrNull(raw: string | null | undefined): string | null {
    if (raw == null) return null;
    const trimmed = raw.trim();
    return trimmed === '' ? null : trimmed;
}

/** Select/enum values: empty means clear. */
export function choiceOrNull(raw: string | null | undefined): string | null {
    return raw ? raw : null;
}

/**
 * Numeric fields arrive as strings from `<input type="number">`.
 *
 * Empty clears. A parseable value is sent as a number. Anything else is
 * returned AS THE RAW STRING so the server rejects it — see the note above
 * on why this is not `undefined`.
 */
export function numberOrNull(raw: string | null | undefined): number | null | string {
    if (raw == null) return null;
    const trimmed = raw.trim();
    if (trimmed === '') return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : trimmed;
}

/** Build the PATCH body for `PATCH /controls/:id`. */
export function buildControlPatchBody(form: ControlEditForm) {
    return {
        name: form.name.trim(),
        objective: textOrNull(form.objective),
        successCriteria: textOrNull(form.successCriteria),
        testingMethodology: textOrNull(form.testingMethodology),
        category: textOrNull(form.category),
        frequency: choiceOrNull(form.frequency),
        automationType: choiceOrNull(form.automationType),
        mitigationType: choiceOrNull(form.mitigationType),
        // RQ3-8 — empty clears the price.
        annualCost: numberOrNull(form.annualCost),
        // Declared operating-effectiveness fallback (0–100). Measured pass
        // rate wins downstream when tests exist.
        effectiveness: numberOrNull(form.effectiveness),
    };
}
