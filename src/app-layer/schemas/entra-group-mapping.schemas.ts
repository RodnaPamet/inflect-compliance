/**
 * EI-2 — Zod schemas for `TenantEntraGroupMapping` (Entra security-group → IC
 * role).
 *
 * OWNER is intentionally NOT a mappable target: tenant ownership carries
 * `admin.tenant_lifecycle` + `admin.owner_management` and the last-OWNER guard,
 * so it must stay manually granted. ADMIN *is* permitted because a mapping is
 * deliberately configured by an existing admin (unlike SSO-JIT, which clamps to
 * READER|EDITOR because no human vets the assignment).
 */
import { z } from 'zod';

/**
 * The roles an Entra group may map to: every Role except OWNER.
 *
 * AI_ADMIN is mappable since deploy 2 of #3699 (owner decision, 2026-10-18), so
 * a tenant can map its "AI_Admin" group to the role — but a mapping that yields
 * it is created, changed and removed by an OWNER only
 * (`entra-group-mappings.ts`, `OWNER_MANAGED_ROLES`), as on the members page.
 * The resolver drops a stored OWNER row too (`NEVER_GROUP_MAPPED_ROLES` in
 * `src/lib/auth/entra-role-mapping.ts`), so a row written around this schema
 * cannot confer ownership either.
 */
export const ENTRA_MAPPABLE_ROLES = ['ADMIN', 'EDITOR', 'READER', 'AUDITOR', 'AI_ADMIN'] as const;
export type EntraMappableRole = (typeof ENTRA_MAPPABLE_ROLES)[number];

export const EntraGroupMappingCreateSchema = z.object({
    /** Entra security-group object id (GUID). */
    aadGroupId: z.string().uuid(),
    /** Cached Graph display name — admin-UI cosmetics only. */
    aadGroupName: z.string().trim().min(1).max(256).optional(),
    role: z.enum(ENTRA_MAPPABLE_ROLES),
    /** Higher wins when a user matches several mappings. */
    priority: z.number().int().min(0).max(1000).default(0),
});

export const EntraGroupMappingUpdateSchema = z
    .object({
        aadGroupName: z.string().trim().min(1).max(256).optional(),
        role: z.enum(ENTRA_MAPPABLE_ROLES).optional(),
        priority: z.number().int().min(0).max(1000).optional(),
    })
    .refine((v) => v.role !== undefined || v.priority !== undefined || v.aadGroupName !== undefined, {
        message: 'At least one field must be provided',
    });

export type EntraGroupMappingCreate = z.infer<typeof EntraGroupMappingCreateSchema>;
export type EntraGroupMappingUpdate = z.infer<typeof EntraGroupMappingUpdateSchema>;
