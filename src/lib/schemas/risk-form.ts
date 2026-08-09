/**
 * B2-8 — frontend-safe Zod schema for the new-risk modal form.
 *
 * Mirrors the server contract in `src/app-layer/schemas/` but carries no
 * Prisma-emitted enum imports, so it stays bundle-safe for client code. The
 * server STILL re-validates on POST — this is purely the UX layer, and the
 * comment matters: a reader who assumes this is the authority will
 * eventually relax a rule here and be surprised the API still rejects.
 *
 * ## Why the enums are imported, not re-declared
 *
 * `category` and `treatment` are single-sourced already —
 * `RISK_CATEGORIES` in `@/lib/risk/categories` and
 * `TREATMENT_DECISION_VALUES` in `@/lib/risk-treatment-vocabulary`. Spelling
 * either list again here would create a third copy that drifts silently: the
 * combobox would offer an option the schema rejects, and the failure would
 * surface as an un-submittable form with no visible error on any field.
 *
 * ## The empty string is a real state
 *
 * Every optional field defaults to `''`, not `undefined`, because these are
 * controlled inputs — React needs a defined value or the input flips between
 * controlled and uncontrolled. `''` therefore means "not filled in", and the
 * submit path is what converts it to an omitted key. Modelling them as
 * `.optional()` would make the initial-values object type-legal while still
 * breaking the inputs at runtime.
 */
import { z } from 'zod';
import { RISK_CATEGORIES } from '@/lib/risk/categories';
import { TREATMENT_DECISION_VALUES } from '@/lib/risk-treatment-vocabulary';

/** `''` (not chosen) or one of the canonical categories. */
const optionalCategory = z
    .string()
    .refine((v) => v === '' || (RISK_CATEGORIES as readonly string[]).includes(v), {
        message: 'Unknown category',
    });

/** `''` (not chosen) or one of the canonical treatment decisions. */
const optionalTreatment = z
    .string()
    .refine((v) => v === '' || (TREATMENT_DECISION_VALUES as readonly string[]).includes(v), {
        message: 'Unknown treatment',
    });

/**
 * `''` or a `YYYY-MM-DD` date-input value.
 *
 * Deliberately NOT `z.coerce.date()`: the field is an `<input type=date>`
 * whose value is a string, and coercing here would make `values.nextReviewAt`
 * a `Date` that cannot be fed back into the input. The submit path converts.
 */
const optionalYmd = z
    .string()
    .refine((v) => v === '' || /^\d{4}-\d{2}-\d{2}$/.test(v), {
        message: 'Must be a date',
    });

export const NewRiskFormSchema = z.object({
    // The only genuinely required field — matches the pre-B2-8 gate, which
    // was `form.title.trim().length > 0`.
    title: z.string().trim().min(1).max(500),
    description: z.string().max(10_000),
    category: optionalCategory,
    // The matrix scale is per-tenant (`RiskMatrixConfig`), so the bound here
    // is a sanity ceiling, not the tenant's actual maximum — the steppers
    // clamp to the configured scale and the server enforces it.
    likelihood: z.number().int().min(1).max(10),
    impact: z.number().int().min(1).max(10),
    ownerUserId: z.string(),
    treatment: optionalTreatment,
    treatmentNotes: z.string().max(10_000),
    nextReviewAt: optionalYmd,
});

export type NewRiskFormValues = z.infer<typeof NewRiskFormSchema>;

/**
 * The form's starting state. `likelihood`/`impact` default to 3 — the
 * midpoint of a 5-point scale, which is what the modal shipped with; it is a
 * neutral starting position rather than a claim about the risk.
 */
export const NEW_RISK_FORM_INITIAL: NewRiskFormValues = {
    title: '',
    description: '',
    category: '',
    likelihood: 3,
    impact: 3,
    ownerUserId: '',
    treatment: '',
    treatmentNotes: '',
    nextReviewAt: '',
};
