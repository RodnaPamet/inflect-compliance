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
 * The roles an Entra group may map to: every Role except OWNER and AI_ADMIN.
 *
 * AI_ADMIN (#3699) holds the agent keys, including the one that makes its
 * holder a possible owner of an agent, so it is granted by an OWNER in the
 * product and never by an identity provider's group. The resolver refuses it
 * too (`NEVER_GROUP_MAPPED_ROLES` in `src/lib/auth/entra-role-mapping.ts`), so
 * a row written around this schema cannot yield it either.
 */
export const ENTRA_MAPPABLE_ROLES = ['ADMIN', 'EDITOR', 'READER', 'AUDITOR'] as const;
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
