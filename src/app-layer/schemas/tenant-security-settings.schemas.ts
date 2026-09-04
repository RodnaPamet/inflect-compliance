import { z } from 'zod';

/**
 * Tenant security-settings patch.
 *
 * PATCH-SHAPED BY CONSTRUCTION. Every key is `.optional()`, and the nullable
 * ones accept an explicit `null` to CLEAR. The distinction matters: `undefined`
 * (key absent) means "leave alone", `null` means "unset". The usecase writes
 * only keys that are present, which is what keeps this writer from clobbering
 * `updateTenantMfaPolicy`, the other writer on the same row.
 *
 * `.strict()` so a typo in a field name is a 400 rather than a silently
 * ignored setting — a settings form that appears to save but does not is worse
 * than one that errors.
 *
 * `mfaPolicy` and `sessionMaxAgeMinutes` are deliberately ABSENT: they are
 * owned by `UpdateMfaPolicyInput` on the MFA policy route. Accepting them here
 * too would give one field two owners.
 */
export const UpdateTenantSecuritySettingsInput = z
    .object({
        /** Null = unlimited (the legacy behaviour the column documents). */
        maxConcurrentSessions: z.number().int().min(1).max(100).nullable().optional(),

        /**
         * Null disables audit streaming. The URL is additionally checked
         * against the SSRF structural guard in the usecase — the schema only
         * enforces shape, because "is this a permitted destination" is a
         * security decision that belongs next to the guard, not in Zod.
         */
        auditStreamUrl: z.string().url().nullable().optional(),

        /**
         * PLAINTEXT in. Persisted to `auditStreamSecretEncrypted`, which the
         * Epic B field-encryption middleware encrypts on write. Never returned
         * by any read — the config exposes `hasAuditStreamSecret` instead.
         */
        auditStreamSecret: z.string().min(16).nullable().optional(),

        aiGuardMode: z.enum(['STRICT', 'BALANCED', 'AUDIT']).optional(),
        aiResidency: z.enum(['EXTERNAL', 'LOCAL_ONLY']).optional(),
        aiLocalBaseUrl: z.string().url().nullable().optional(),
        aiLocalModel: z.string().min(1).max(200).nullable().optional(),

        /** When true, an MFA verification failure denies rather than degrades. */
        mfaFailClosed: z.boolean().optional(),
        /**
         * Epic Agentic — the per-tenant agent-registration gate on `/api/mcp`.
         * A plain boolean: it is either enforcing or it is not, and there is no
         * third state worth expressing. Absence of the key means "leave it
         * alone", per this schema's patch semantics.
         */
        requireRegisteredAgent: z.boolean().optional(),
    })
    .strict();

export type UpdateTenantSecuritySettingsInput = z.infer<
    typeof UpdateTenantSecuritySettingsInput
>;
