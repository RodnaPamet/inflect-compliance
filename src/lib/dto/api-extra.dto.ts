/**
 * Request/response components for critical routes whose schemas were
 * previously inline-and-unnamed (auth, admin lifecycle, audit packs,
 * key rotation). These exist so the route-level path operations in
 * `src/lib/openapi/paths/*` can `$ref` a named component instead of
 * inlining an anonymous shape.
 *
 * Request components mirror the route's inline Zod body exactly.
 * Response components for surfaces that have no domain DTO use
 * `.passthrough()` — they GUARANTEE the documented fields and allow
 * additional ones, which is the honest contract for a hand-modelled
 * response (vs. over-constraining to a shape that may carry more).
 */
import { z } from '@/lib/openapi/zod';

// ─── Auth request bodies ───

export const AuthChangePasswordRequestSchema = z.object({
    currentPassword: z.string().min(1),
    newPassword: z.string().min(1),
}).strip().openapi('AuthChangePasswordRequest', {
    description: 'Authenticated password change. The new password is screened against HIBP and must differ from the current one; success revokes every session for the account.',
});

export const AuthForgotPasswordRequestSchema = z.object({
    email: z.string().trim().email(),
}).strip().openapi('AuthForgotPasswordRequest', {
    description: 'Request a password-reset link. The response is always {ok:true} — the endpoint is enumeration-safe and never reveals whether the email is registered.',
});

export const AuthResetPasswordRequestSchema = z.object({
    token: z.string().min(1),
    newPassword: z.string().min(1),
}).strip().openapi('AuthResetPasswordRequest', {
    description: 'Consume a single-use reset token and set a new password (HIBP-screened). Consuming the token revokes every session for the account.',
});

// ─── Auth responses ───

export const AuthOkResponseSchema = z.object({
    ok: z.literal(true),
    reauthRequired: z.boolean().optional(),
}).openapi('AuthOkResponse', {
    description: 'Auth mutation acknowledgement. reauthRequired=true (change/reset password) signals the caller\'s own session was revoked and they must sign in again.',
});

export const AuthMeResponseSchema = z.object({
    user: z.object({
        id: z.string().optional(),
        email: z.string().optional(),
        name: z.string().nullable().optional(),
        role: z.string(),
    }),
    tenant: z.object({
        id: z.string(),
        name: z.string(),
        slug: z.string(),
    }).nullable(),
}).openapi('AuthMeResponse', {
    description: 'The authenticated principal and their primary (oldest ACTIVE) tenant membership. role defaults to READER and tenant is null when the user has no active membership.',
});

// ─── Admin tenant lifecycle ───

export const TenantCreateRequestSchema = z.object({
    name: z.string().min(1).max(200),
    slug: z.string().regex(/^[a-z0-9-]+$/).min(2).max(80),
    ownerEmail: z.string().email(),
}).strip().openapi('TenantCreateRequest', {
    description: 'Platform-admin tenant bootstrap (X-Platform-Admin-Key gated). Atomically creates the tenant + encrypted DEK, an OWNER membership for ownerEmail, and the onboarding row.',
});

export const TenantCreateResponseSchema = z.object({
    tenant: z.object({ id: z.string(), slug: z.string(), name: z.string() }),
    ownerUserId: z.string(),
}).openapi('TenantCreateResponse', {
    description: 'Result of tenant bootstrap — the created tenant and the user id of its OWNER.',
});

export const TenantTransferOwnershipRequestSchema = z.object({
    currentOwnerUserId: z.string().min(1),
    newOwnerEmail: z.string().email(),
}).strip().openapi('TenantTransferOwnershipRequest', {
    description: 'Platform-admin ownership transfer (X-Platform-Admin-Key gated). Promotes the new OWNER before demoting the old to satisfy the last-OWNER DB trigger.',
});

export const TenantTransferOwnershipResponseSchema = z.object({
    tenantId: z.string(),
}).passthrough().openapi('TenantTransferOwnershipResponse', {
    description: 'Acknowledgement of an ownership transfer. Guarantees tenantId; the usecase may echo additional membership detail.',
});

// ─── Key rotation (job-enqueue) ───

export const JobStatusResponseSchema = z.object({
    jobId: z.string(),
    state: z.string().optional(),
}).passthrough().openapi('JobStatusResponse', {
    description: 'A background-job handle. POST enqueues the rotation sweep and returns its jobId; GET?jobId=… reports the BullMQ state (waiting/active/completed/failed).',
});

// ─── Audit packs ───

export const AuditPackCreateRequestSchema = z.object({
    auditCycleId: z.string().min(1),
    name: z.string().min(1).max(200),
}).strip().openapi('AuditPackCreateRequest', {
    description: 'Create an audit-readiness pack bound to an audit cycle. The pack collects controls/policies/evidence into a shareable, freezable bundle for external auditors.',
});

export const AuditPackUpdateRequestSchema = z.object({
    name: z.string().min(1).max(200).optional(),
    notes: z.string().max(5000).optional(),
}).strip().openapi('AuditPackUpdateRequest', {
    description: 'Update audit-pack metadata. Item membership, freeze, share, and clone are action-multiplexed POST operations on the same path (see the operation description).',
});

export const AuditPackResponseSchema = z.object({
    id: z.string(),
    name: z.string(),
    status: z.string().optional(),
    auditCycleId: z.string().optional(),
}).passthrough().openapi('AuditPackResponse', {
    description: 'An audit-readiness pack. Guarantees id + name; list/detail variants add _count, cycle, items[], and frozenBy. passthrough so the documented surface never over-constrains.',
});

export const SharedAuditPackResponseSchema = z.object({
    id: z.string(),
    name: z.string(),
}).passthrough().openapi('SharedAuditPackResponse', {
    description: 'Public, share-token-scoped read view of a frozen audit pack. No authentication — the opaque token in the path is the capability.',
});

/**
 * `POST /api/auth/register`'s success body, as the route returns it (#5132).
 * `tenant` is null for an account-only registration that a pending
 * invitation will attach to its workspace at sign-in.
 */
export const AuthRegisterResponseSchema = z.object({
    user: z.object({
        id: z.string(),
        email: z.string(),
        name: z.string().nullable(),
        role: z.string().nullable(),
    }),
    tenant: z.object({ id: z.string(), name: z.string(), slug: z.string() }).nullable(),
    emailVerificationRequired: z.boolean(),
}).passthrough().openapi('AuthRegisterResponse', {
    description: 'The account created, the workspace created with it (null for an account-only registration that an invitation will attach), and whether the email must be verified before sign-in.',
});
