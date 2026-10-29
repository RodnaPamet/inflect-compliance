/**
 * B6 — frontend-safe Zod schema for the new-vendor modal form.
 *
 * Mirrors the server-side `CreateVendorSchema` in
 * `src/app-layer/schemas/vendor.schemas.ts` but stripped of any
 * Prisma-emitted enum imports so the schema is bundle-safe for
 * client code. Validation rules match the server contract; the
 * server STILL re-validates on POST so this is purely a UX layer.
 *
 * The shape is the `<NewVendorFields>` field set:
 *   - `name`        — required, trimmed, min 1.
 *   - `legalName`   — optional free text.
 *   - `websiteUrl`  — optional, must be a valid URL when present.
 *   - `domain`      — optional free text.
 *   - `country`     — optional free text.
 *   - `description` — optional free text.
 *   - `criticality` — one of LOW / MEDIUM / HIGH / CRITICAL.
 *   - `dataAccess`  — optional, one of NONE / LOW / MEDIUM / HIGH.
 *   - `isSubprocessor` — boolean.
 *   - `nextReviewAt`     — optional `YYYY-MM-DD` string.
 *   - `contractRenewalAt` — optional `YYYY-MM-DD` string.
 *
 * No `status` (#4462). A new vendor starts ONBOARDING (the server default):
 * ACTIVE needs a completed assessment review, which a vendor that does not
 * exist yet cannot have, and `createVendor` refuses it with
 * `VENDOR_ACTIVATION_NEEDS_REVIEW`. The form used to offer Active, and the
 * server used to accept it.
 */
import { z } from 'zod';

/**
 * The server's length limits (`CreateVendorSchema` in `src/lib/schemas`),
 * restated here because that module is backend-only. The form used larger
 * ones (name 255, website 1024, …), so a value inside the form's limit and
 * outside the server's came back as "Invalid request payload" (#4462). The
 * fields also pass these as `maxLength`, so the limit cannot be typed past.
 * `tests/unit/schemas/vendor-form-schema.test.ts` holds the two in step.
 */
export const VENDOR_FIELD_MAX = {
    name: 200,
    legalName: 300,
    websiteUrl: 500,
    domain: 200,
    country: 100,
    description: 5000,
} as const;

// Empty-string-tolerant URL — pre-B6 the hand-rolled validator only
// inserted the field when non-empty; that semantic is preserved.
const optionalUrl = z
    .string()
    .trim()
    .max(VENDOR_FIELD_MAX.websiteUrl)
    .refine(
        (v) => {
            if (!v) return true;
            try {
                new URL(v);
                return true;
            } catch {
                return false;
            }
        },
        { message: 'Must be a valid URL or empty' },
    );

const optionalYmd = z
    .string()
    .trim()
    .refine((v) => !v || /^\d{4}-\d{2}-\d{2}$/.test(v), {
        message: 'Must be YYYY-MM-DD',
    });

export const NewVendorFormSchema = z.object({
    name: z.string().trim().min(1, 'Vendor name is required').max(VENDOR_FIELD_MAX.name),
    legalName: z.string().trim().max(VENDOR_FIELD_MAX.legalName).default(''),
    websiteUrl: optionalUrl.default(''),
    domain: z.string().trim().max(VENDOR_FIELD_MAX.domain).default(''),
    country: z.string().trim().max(VENDOR_FIELD_MAX.country).default(''),
    description: z.string().trim().max(VENDOR_FIELD_MAX.description).default(''),
    criticality: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
    dataAccess: z
        .string()
        .refine(
            (v) => !v || ['NONE', 'LOW', 'MEDIUM', 'HIGH'].includes(v),
            { message: 'Invalid data-access level' },
        )
        .default(''),
    isSubprocessor: z.boolean().default(false),
    nextReviewAt: optionalYmd.default(''),
    contractRenewalAt: optionalYmd.default(''),
});

export type NewVendorFormValues = z.input<typeof NewVendorFormSchema>;
