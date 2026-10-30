/**
 * Epic O-2 — Zod input schemas for organization-layer routes.
 *
 * Slug shape matches the existing tenant-slug convention (lowercase
 * alphanumeric + hyphens, no leading/trailing hyphen, 2–64 chars).
 * The DB-level unique constraint catches collisions; this schema
 * just enforces the format.
 */
import { z } from 'zod';

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const SlugField = z
    .string()
    .min(2, 'Slug must be at least 2 characters')
    .max(64, 'Slug is too long')
    .regex(SLUG_RE, 'Slug must be lowercase alphanumeric + hyphens');

const NameField = z
    .string()
    .min(1, 'Name is required')
    .max(120, 'Name is too long');

const EmailField = z
    .string()
    .min(1, 'Email is required')
    .max(320)
    .email('Invalid email');

// ── POST /api/org ─────────────────────────────────────────────────────

export const CreateOrganizationInput = z
    .object({
        name: NameField,
        slug: SlugField,
    })
    .strict();

export type CreateOrganizationInputType = z.infer<typeof CreateOrganizationInput>;

// ── POST /api/org/[orgSlug]/tenants ───────────────────────────────────

export const CreateOrgTenantInput = z
    .object({
        name: NameField,
        slug: SlugField,
    })
    .strict();

export type CreateOrgTenantInputType = z.infer<typeof CreateOrgTenantInput>;

// ── POST /api/org/[orgSlug]/members ───────────────────────────────────

export const AddOrgMemberInput = z
    .object({
        /** Target user — looked up by email. Created as a placeholder
         *  if no user row matches yet (mirrors the createTenantWithOwner
         *  pattern; the user populates the rest of their row on first
         *  sign-in). */
        userEmail: EmailField,
        role: z.enum(['ORG_ADMIN', 'ORG_READER']),
    })
    .strict();

export type AddOrgMemberInputType = z.infer<typeof AddOrgMemberInput>;

// ── PUT /api/org/[orgSlug]/members ────────────────────────────────────
//
// Atomic role change for an EXISTING org member. The legacy remove-
// and-readd workaround (DELETE + POST) is no longer required; that
// path created a brief deprovisioning window and a two-step admin
// operation. See `changeOrgMemberRole` in `org-members.ts`.

export const ChangeOrgMemberRoleInput = z
    .object({
        userId: z.string().min(1, 'userId is required'),
        // ORG_OWNER since #4576 deploy 2: the role change is the ONE writer
        // that makes an owner, and only an owner may (the usecase refuses
        // anybody else, audited). The add and the invite never write it.
        role: z.enum(['ORG_OWNER', 'ORG_ADMIN', 'ORG_READER']),
    })
    .strict();

export type ChangeOrgMemberRoleInputType = z.infer<typeof ChangeOrgMemberRoleInput>;
