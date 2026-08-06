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
 * Numeric fields come off `<input type="number">` as strings.
 *
 * Empty means "clear this" → `null`. A parseable number is sent through. An
 * unparseable value currently yields `undefined`, which OMITS the key and so
 * silently keeps the old value — a third semantic that disagrees with the
 * other two write surfaces. That is a known inconsistency, tracked
 * separately; this helper isolates it so there is one place to change when
 * the three surfaces are reconciled.
 */
function numericOrNull(raw: string): number | null | undefined {
    if (raw.trim() === '') return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
}

/** Build the PATCH body for `PATCH /controls/:id`. */
export function buildControlPatchBody(form: ControlEditForm) {
    return {
        name: form.name.trim(),
        objective: form.objective.trim() || null,
        successCriteria: form.successCriteria.trim() || null,
        testingMethodology: form.testingMethodology.trim() || null,
        category: form.category.trim() || null,
        frequency: form.frequency || null,
        automationType: form.automationType || null,
        mitigationType: form.mitigationType || null,
        // RQ3-8 — empty string clears the price (honest null).
        annualCost: numericOrNull(form.annualCost),
        // Declared operating-effectiveness fallback (0–100). Empty → null
        // clears the declared value; measured pass rate wins downstream when
        // tests exist.
        effectiveness: numericOrNull(form.effectiveness),
    };
}
