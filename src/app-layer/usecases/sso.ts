import type { RequestContext } from '@/app-layer/types';
import type { TenantIdentityProvider, UserIdentityLink } from '@prisma/client';
import * as SsoConfigRepo from '@/app-layer/repositories/SsoConfigRepository';
import * as IdentityLinkRepo from '@/app-layer/repositories/IdentityLinkRepository';
import { SSO_SECRET_KEYS, SSO_SECRET_MASK, UpsertSsoConfigInput } from '@/app-layer/schemas/sso-config.schemas';
import { badRequest, forbidden, notFound } from '@/lib/errors/types';
import prisma from '@/lib/prisma';
import { logger } from '@/lib/observability/logger';
import { hashForLookup } from '@/lib/security/encryption';
import { BREAK_GLASS_ROLES, isBreakGlassRole } from '@/lib/auth/sso-enforcement';
import {
    SSO_TRUST_OWNER_TIER_MESSAGE,
    SSO_TRUST_OWNER_TIER_REFUSAL,
    changedSsoTrustFields,
    type SsoTrustState,
} from '@/lib/auth/sso-trust-fields';
import { logEvent } from '@/app-layer/events/audit';

/**
 * Enterprise SSO Usecases
 *
 * These usecases manage tenant-scoped identity provider configuration and
 * external identity linking. They enforce RBAC, tenant isolation, and safe
 * account linking rules.
 */

// ─── Configuration Management ────────────────────────────────────────

/**
 * List all SSO identity providers configured for the tenant.
 * Requires ADMIN role.
 */
export async function getTenantSsoConfig(
    ctx: RequestContext
): Promise<TenantIdentityProvider[]> {
    if (!ctx.permissions.canAdmin) throw forbidden('Only admins can view SSO configuration');
    return SsoConfigRepo.findByTenantId(ctx.tenantId);
}

/**
 * Get a single SSO provider by ID.
 * Requires ADMIN role.
 */
export async function getTenantSsoConfigById(
    ctx: RequestContext,
    providerId: string
): Promise<TenantIdentityProvider> {
    if (!ctx.permissions.canAdmin) throw forbidden('Only admins can view SSO configuration');
    const provider = await SsoConfigRepo.findById(ctx.tenantId, providerId);
    if (!provider) throw notFound('Identity provider not found');
    return provider;
}

/**
 * Create or update a tenant identity provider.
 * Requires ADMIN role. Validates input via Zod schema.
 *
 * Creating a provider, or changing whom it trusts (`changedSsoTrustFields`),
 * is Owner-tier: it needs `admin.owner_management`. A sign-in through the
 * provider becomes a session for whichever member the identity provider
 * names, so an ADMIN who could point it at an identity provider they run
 * could sign in as an OWNER. A trust change also removes every identity link
 * to the provider. An ADMIN keeps every other field, and enable, enforce and
 * delete.
 */
export async function upsertTenantSsoConfig(
    ctx: RequestContext,
    input: UpsertSsoConfigInput
): Promise<TenantIdentityProvider> {
    if (!ctx.permissions.canAdmin) throw forbidden('Only admins can manage SSO configuration');

    logger.info('sso config upsert', {
        component: 'sso', action: input.id ? 'update' : 'create',
        providerType: input.type, isEnforced: input.isEnforced,
    });

    // If updating, verify the provider belongs to this tenant
    const existing = input.id ? await SsoConfigRepo.findById(ctx.tenantId, input.id) : null;
    if (input.id && !existing) throw notFound('Identity provider not found');

    const ownerTier = ctx.appPermissions.admin.owner_management;
    if (!existing && !ownerTier) {
        throw forbidden(SSO_TRUST_OWNER_TIER_MESSAGE, { reason: SSO_TRUST_OWNER_TIER_REFUSAL, fields: ['provider'] });
    }

    const config = withStoredSecretsKept(input.config, existing?.configJson);
    // A save that leaves out the JIT settings keeps the stored ones. The
    // admin page never sends them, so a default here turned JIT off on every
    // save, and would now read as a trust change.
    const storedJit = extractJitConfig(existing);
    const jit = {
        allowJitProvisioning: input.allowJitProvisioning ?? storedJit.allowJitProvisioning,
        jitDefaultRole: input.jitDefaultRole ?? storedJit.jitDefaultRole,
    };
    const trustChanged = existing
        ? changedSsoTrustFields(trustStateOf(existing), {
              type: input.type,
              // Absent means unchanged: the update leaves the column alone.
              emailDomains: input.emailDomains ?? existing.emailDomains,
              config,
              ...jit,
          })
        : [];
    if (trustChanged.length > 0 && !ownerTier) {
        throw forbidden(SSO_TRUST_OWNER_TIER_MESSAGE, { reason: SSO_TRUST_OWNER_TIER_REFUSAL, fields: trustChanged });
    }

    // Saving the form turns enforcement on too, so it needs the same
    // break-glass check as the enforce toggle — or this was the way round it.
    if (input.isEnforced && !existing?.isEnforced) {
        await assertBreakGlassAvailable(ctx.tenantId, input.id);
    }

    const fields = {
        name: input.name,
        type: input.type,
        isEnabled: input.isEnabled,
        isEnforced: input.isEnforced,
        emailDomains: input.emailDomains,
        // JIT settings are persisted alongside the IdP config.
        configJson: { ...config, _jit: jit },
    };
    const { provider, linksRemoved } =
        existing && trustChanged.length > 0
            ? await SsoConfigRepo.updateAndRemoveLinks(ctx.tenantId, existing.id, fields)
            : { provider: await SsoConfigRepo.upsert(ctx.tenantId, { id: input.id, ...fields }), linksRemoved: 0 };

    await logEvent(prisma, ctx, {
        action: existing ? 'UPDATE' : 'CREATE',
        entityType: 'TenantIdentityProvider',
        entityId: provider.id,
        details: existing
            ? `Updated ${input.type} SSO provider${trustChanged.length ? `; changed whom it trusts and removed ${linksRemoved} identity link(s)` : ''}`
            : `Configured ${input.type} SSO provider`,
        detailsJson: {
            category: 'entity_lifecycle',
            entityName: 'TenantIdentityProvider',
            operation: existing ? 'updated' : 'created',
            changedFields: trustChanged,
            after: {
                type: input.type,
                isEnabled: provider.isEnabled,
                isEnforced: provider.isEnforced,
                identityLinksRemoved: linksRemoved,
            },
            summary: existing ? 'SSO provider updated' : 'SSO provider configured',
        },
    });

    return provider;
}

/** A stored provider's trust fields (`src/lib/auth/sso-trust-fields.ts`). */
function trustStateOf(provider: TenantIdentityProvider): SsoTrustState {
    const config = (provider.configJson && typeof provider.configJson === 'object' ? provider.configJson : {}) as Record<string, unknown>;
    return {
        type: provider.type,
        emailDomains: provider.emailDomains ?? [],
        config,
        ...extractJitConfig(provider),
    };
}

/**
 * Delete a tenant identity provider.
 * Requires ADMIN role. Also removes all identity links for this provider.
 */
export async function deleteTenantSsoConfig(
    ctx: RequestContext,
    providerId: string
): Promise<void> {
    if (!ctx.permissions.canAdmin) throw forbidden('Only admins can manage SSO configuration');

    const existing = await SsoConfigRepo.findById(ctx.tenantId, providerId);
    if (!existing) throw notFound('Identity provider not found');

    // Cascade: remove identity links, then the provider
    await SsoConfigRepo.remove(ctx.tenantId, providerId);

    await logEvent(prisma, ctx, {
        action: 'DELETE',
        entityType: 'TenantIdentityProvider',
        entityId: providerId,
        details: `Deleted ${existing.type} SSO provider and its identity links`,
        detailsJson: {
            category: 'entity_lifecycle',
            entityName: 'TenantIdentityProvider',
            operation: 'deleted',
            before: { type: existing.type, isEnabled: existing.isEnabled, isEnforced: existing.isEnforced },
            summary: 'SSO provider deleted',
        },
    });
}

/**
 * Enable or disable a tenant SSO provider.
 * Requires ADMIN role.
 */
export async function toggleTenantSso(
    ctx: RequestContext,
    providerId: string,
    enabled: boolean
): Promise<TenantIdentityProvider> {
    if (!ctx.permissions.canAdmin) throw forbidden('Only admins can manage SSO configuration');

    const existing = await SsoConfigRepo.findById(ctx.tenantId, providerId);
    if (!existing) throw notFound('Identity provider not found');

    const provider = await SsoConfigRepo.setEnabled(ctx.tenantId, providerId, enabled);
    await logSwitch(ctx, provider, 'isEnabled', existing.isEnabled, enabled);
    return provider;
}

/**
 * Set whether SSO is enforced (local login disabled) for a provider.
 * Requires ADMIN role.
 *
 * When enforced:
 *   - Users cannot log in with credentials
 *   - SSO is the only authentication method
 *   - Break-glass: OWNER and ADMIN users who have passwordHash set can still use local login
 */
export async function setTenantSsoEnforced(
    ctx: RequestContext,
    providerId: string,
    enforced: boolean
): Promise<TenantIdentityProvider> {
    if (!ctx.permissions.canAdmin) throw forbidden('Only admins can manage SSO configuration');

    logger.info('sso enforcement toggle', {
        component: 'sso', providerId, enforced,
    });

    const existing = await SsoConfigRepo.findById(ctx.tenantId, providerId);
    if (!existing) throw notFound('Identity provider not found');

    if (enforced) await assertBreakGlassAvailable(ctx.tenantId, providerId);

    const provider = await SsoConfigRepo.setEnforced(ctx.tenantId, providerId, enforced);
    await logSwitch(ctx, provider, 'isEnforced', existing.isEnforced, enforced);
    return provider;
}

/** The audit entry for the enable and enforce switches. */
async function logSwitch(
    ctx: RequestContext,
    provider: TenantIdentityProvider,
    field: 'isEnabled' | 'isEnforced',
    before: boolean,
    after: boolean,
): Promise<void> {
    await logEvent(prisma, ctx, {
        action: 'UPDATE',
        entityType: 'TenantIdentityProvider',
        entityId: provider.id,
        details: `${field === 'isEnabled' ? (after ? 'Enabled' : 'Disabled') : after ? 'Enforced' : 'Stopped enforcing'} ${provider.type} SSO provider`,
        detailsJson: {
            category: 'entity_lifecycle',
            entityName: 'TenantIdentityProvider',
            operation: 'updated',
            changedFields: before === after ? [] : [field],
            before: { [field]: before },
            after: { [field]: after },
            summary: 'SSO provider switch changed',
        },
    });
}

/**
 * Refuse to turn enforcement on unless somebody could still get in with a
 * password if the identity provider failed: an ACTIVE OWNER or ADMIN who
 * has one. OWNER counts — an OWNER-run workspace with no ADMIN could
 * otherwise never enforce SSO.
 */
async function assertBreakGlassAvailable(tenantId: string, providerId?: string): Promise<void> {
    const adminMembers = await prisma.tenantMembership.findMany({
        where: { tenantId, role: { in: [...BREAK_GLASS_ROLES] }, status: 'ACTIVE' },
        include: { user: true },
    });
    if (!adminMembers.some((m) => m.user.passwordHash)) {
        logger.warn('sso enforcement blocked — no break-glass admin', { component: 'sso', providerId });
        throw forbidden(
            'Cannot enforce SSO: at least one admin must have a local password for break-glass access'
        );
    }
}

/**
 * A saved config with each secret the admin left alone (sent back as
 * `SSO_SECRET_MASK`) replaced by the stored value. A new provider has no
 * stored value, so the mask there is a missing secret, not a kept one —
 * and so is a stored mask: that is a secret an earlier save of this form
 * overwrote, and it must be entered again.
 */
function withStoredSecretsKept(
    config: Record<string, unknown>,
    stored: unknown,
): Record<string, unknown> {
    const previous = (stored && typeof stored === 'object' ? stored : {}) as Record<string, unknown>;
    const kept = { ...config };
    for (const key of SSO_SECRET_KEYS) {
        if (kept[key] !== SSO_SECRET_MASK) continue;
        if (typeof previous[key] !== 'string' || !previous[key] || previous[key] === SSO_SECRET_MASK) {
            throw badRequest(`Enter the ${key === 'certificate' ? 'certificate' : 'client secret'} for this provider.`);
        }
        kept[key] = previous[key];
    }
    return kept;
}

// ─── SSO Login Resolution ────────────────────────────────────────────

/**
 * Resolve the SSO configuration for a tenant login page.
 * This is a public/unauthenticated operation — no ctx required.
 *
 * Returns only the minimal info needed for the login page:
 * - provider type, name, isEnforced
 * - does NOT expose configJson secrets
 */
export async function resolveSsoForTenant(
    tenantSlug: string
): Promise<{
    hasSso: boolean;
    isEnforced: boolean;
    providers: Array<{ id: string; type: string; name: string }>;
}> {
    const tenant = await prisma.tenant.findUnique({
        where: { slug: tenantSlug },
        select: { id: true },
    });

    if (!tenant) {
        return { hasSso: false, isEnforced: false, providers: [] };
    }

    const enabledProviders = await SsoConfigRepo.findEnabledByTenantId(tenant.id);

    if (enabledProviders.length === 0) {
        return { hasSso: false, isEnforced: false, providers: [] };
    }

    return {
        hasSso: true,
        isEnforced: enabledProviders.some((p) => p.isEnforced),
        providers: enabledProviders.map((p) => ({
            id: p.id,
            type: p.type,
            name: p.name,
        })),
    };
}

/**
 * Resolve SSO provider by email domain.
 * Used for domain-based auto-discovery on the login page.
 */
export async function resolveSsoByDomain(
    email: string
): Promise<{
    found: boolean;
    tenantSlug?: string;
    providerId?: string;
    providerName?: string;
}> {
    const domain = email.split('@')[1]?.toLowerCase();
    if (!domain) return { found: false };

    const provider = await SsoConfigRepo.findByDomain(domain);
    if (!provider) return { found: false };

    const tenant = await prisma.tenant.findUnique({
        where: { id: provider.tenantId },
        select: { slug: true },
    });

    return {
        found: true,
        tenantSlug: tenant?.slug,
        providerId: provider.id,
        providerName: provider.name,
    };
}

// ─── Identity Linking ────────────────────────────────────────────

/**
 * Result type for linkExternalIdentity — provides explicit rejection reasons.
 */
export type LinkResult =
    | { status: 'linked'; userId: string; isNewLink: boolean }
    | { status: 'jit_created'; userId: string }
    | { status: 'rejected'; reason: LinkRejectionReason };

export type LinkRejectionReason =
    | 'cross_tenant'       // Existing link belongs to different tenant
    | 'domain_mismatch'    // Email domain not in provider's allowed domains
    | 'no_user'            // No local user found
    | 'no_membership'      // User exists but has no tenant membership
    | 'subject_conflict'   // User linked to a different subject for same provider
    | 'jit_disabled'       // Would need JIT but it's turned off
    | 'no_email';          // IdP didn't provide an email

/**
 * Validate an email against a provider's allowed domains.
 * Returns true if:
 *   - provider has no domain restrictions (emailDomains is empty)
 *   - email's domain is in the allowed list
 */
export function validateEmailAgainstDomains(
    email: string,
    emailDomains: string[]
): boolean {
    if (emailDomains.length === 0) return true;
    const domain = email.split('@')[1]?.toLowerCase();
    if (!domain) return false;
    return emailDomains.some((d) => d.toLowerCase() === domain);
}

/**
 * Link an external identity to a local user during SSO callback.
 *
 * Hardened resolution with explicit safety checks:
 * 1. Validate email against provider's allowed domains
 * 2. Check for existing link by (providerId, externalSubject)
 * 3. Verify cross-tenant safety
 * 4. If no link, match by email → User → TenantMembership
 * 5. If no user/membership found, attempt JIT provisioning if enabled
 * 6. Never auto-provision ADMIN role via JIT
 *
 * Returns explicit status with rejection reasons for audit logging.
 */
export async function linkExternalIdentity(
    tenantId: string,
    providerId: string,
    externalSubject: string,
    email: string
): Promise<LinkResult> {
    logger.info('sso identity link started', { component: 'sso', providerId });

    if (!email) {
        logger.warn('sso identity link rejected', { component: 'sso', reason: 'no_email' });
        return { status: 'rejected', reason: 'no_email' };
    }

    const normalizedEmail = email.toLowerCase();

    // Load provider config for domain validation and JIT settings
    const provider = await prisma.tenantIdentityProvider.findFirst({
        where: { id: providerId, tenantId },
    });

    // ── Step 1: Domain validation ──
    if (provider) {
        if (!validateEmailAgainstDomains(normalizedEmail, provider.emailDomains)) {
            logger.warn('sso identity link rejected', { component: 'sso', reason: 'domain_mismatch' });
            return { status: 'rejected', reason: 'domain_mismatch' };
        }
    }

    // ── Step 2: Check for existing link ──
    const existingLink = await IdentityLinkRepo.findByProviderAndSubject(
        providerId,
        externalSubject
    );

    if (existingLink) {
        // ── Step 3: Cross-tenant safety ──
        if (existingLink.tenantId !== tenantId) {
            logger.warn('sso identity link rejected', { component: 'sso', reason: 'cross_tenant' });
            return { status: 'rejected', reason: 'cross_tenant' };
        }
        await IdentityLinkRepo.updateLastLogin(existingLink.id);
        logger.info('sso identity link resolved', { component: 'sso', status: 'linked', isNewLink: false });
        return { status: 'linked', userId: existingLink.userId, isNewLink: false };
    }

    // ── Step 4: Match by email ──
    const user = await prisma.user.findUnique({
        where: { emailHash: hashForLookup(normalizedEmail) },
        select: { id: true },
    });

    if (user) {
        // Check tenant membership
        const membership = await prisma.tenantMembership.findUnique({
            where: {
                tenantId_userId: { tenantId, userId: user.id },
            },
        });

        if (!membership) {
            return { status: 'rejected', reason: 'no_membership' };
        }

        // Check for subject conflict
        const existingUserLink = await IdentityLinkRepo.findByUserAndProvider(
            user.id,
            providerId
        );

        if (existingUserLink) {
            return { status: 'rejected', reason: 'subject_conflict' };
        }

        // Create link for existing user
        await IdentityLinkRepo.linkIdentity({
            userId: user.id,
            tenantId,
            providerId,
            externalSubject,
            emailAtLinkTime: normalizedEmail,
            emailAtLinkTimeHash: hashForLookup(normalizedEmail),
        });

        logger.info('sso identity link resolved', { component: 'sso', status: 'linked', isNewLink: true });
        return { status: 'linked', userId: user.id, isNewLink: true };
    }

    // ── Step 5: JIT provisioning ──
    const jitConfig = extractJitConfig(provider);

    if (!jitConfig.allowJitProvisioning) {
        return { status: 'rejected', reason: 'jit_disabled' };
    }

    // JIT: create user + membership + link in a transaction
    // SAFETY: JIT role is always READER or EDITOR — never ADMIN
    const safeRole = jitConfig.jitDefaultRole === 'EDITOR' ? 'EDITOR' : 'READER';

    const newUser = await prisma.$transaction(async (tx) => {
        // Create user
        const created = await tx.user.create({
            data: {
                email: normalizedEmail,
                emailHash: hashForLookup(normalizedEmail),
                name: normalizedEmail.split('@')[0],
            },
        });

        // Create membership
        await tx.tenantMembership.create({
            data: {
                tenantId,
                userId: created.id,
                role: safeRole as 'READER' | 'EDITOR',
            },
        });

        // Create identity link
        await tx.userIdentityLink.create({
            data: {
                userId: created.id,
                tenantId,
                providerId,
                externalSubject,
                emailAtLinkTime: normalizedEmail,
                emailAtLinkTimeHash: hashForLookup(normalizedEmail),
            },
        });

        return created;
    });

    logger.info('sso identity link resolved', { component: 'sso', status: 'jit_created' });
    return { status: 'jit_created', userId: newUser.id };
}

/**
 * Extract JIT provisioning config from provider's configJson.
 * Returns safe defaults if not configured.
 */
function extractJitConfig(provider: { configJson: unknown } | null): {
    allowJitProvisioning: boolean;
    jitDefaultRole: string;
} {
    if (!provider) return { allowJitProvisioning: false, jitDefaultRole: 'READER' };
    const config = provider.configJson as Record<string, unknown>;
    const jit = config?._jit as Record<string, unknown> | undefined;
    return {
        allowJitProvisioning: jit?.allowJitProvisioning === true,
        jitDefaultRole: jit?.jitDefaultRole === 'EDITOR' ? 'EDITOR' : 'READER',
    };
}

/**
 * Check if local login is allowed for a user in a specific tenant.
 * Returns false if SSO is enforced AND the user is not a break-glass admin.
 *
 * Break-glass criteria:
 *   1. User has the OWNER or ADMIN role in tenant
 *   2. User has a local passwordHash set
 *   Both conditions must be true.
 */
export async function isLocalLoginAllowed(
    tenantId: string,
    userId: string
): Promise<boolean> {
    // Check if any provider in this tenant enforces SSO
    const enforcedProviders = await prisma.tenantIdentityProvider.findMany({
        where: { tenantId, isEnabled: true, isEnforced: true },
    });

    if (enforcedProviders.length === 0) return true;

    // SSO is enforced — check if user is a break-glass admin
    const membership = await prisma.tenantMembership.findUnique({
        where: { tenantId_userId: { tenantId, userId } },
    });

    if (!membership || !isBreakGlassRole(membership.role)) return false;

    // Admin — check if they have a local password (break-glass)
    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { passwordHash: true },
    });

    return !!user?.passwordHash;
}

/**
 * Pre-login enforcement check for the credentials/local login path.
 * Given an email, resolves all tenant memberships and checks if any
 * has SSO enforced.
 *
 * Returns:
 *   - { allowed: true } — local login permitted
 *   - { allowed: false, tenantSlug, providerName } — must use SSO
 *   - { allowed: true } — break-glass admin
 */
export async function checkSsoEnforcementForEmail(
    email: string
): Promise<{
    allowed: boolean;
    enforced?: {
        tenantSlug: string;
        tenantName: string;
        providerName: string;
        providerId: string;
        providerType: string;
    };
}> {
    const normalizedEmail = email.toLowerCase();

    // Find user
    const user = await prisma.user.findUnique({
        where: { emailHash: hashForLookup(normalizedEmail) },
        select: {
            id: true,
            passwordHash: true,
            tenantMemberships: {
                include: {
                    tenant: { select: { id: true, slug: true, name: true } },
                },
            },
        },
    });

    if (!user) return { allowed: true }; // User doesn't exist yet — let normal auth handle it

    // Check each membership for SSO enforcement
    for (const membership of user.tenantMemberships) {
        const enforcedProvider = await prisma.tenantIdentityProvider.findFirst({
            where: {
                tenantId: membership.tenantId,
                isEnabled: true,
                isEnforced: true,
            },
        });

        if (enforcedProvider) {
            // SSO is enforced in this tenant — check break-glass
            const isBreakGlass = isBreakGlassRole(membership.role) && !!user.passwordHash;

            if (!isBreakGlass) {
                return {
                    allowed: false,
                    enforced: {
                        tenantSlug: membership.tenant.slug,
                        tenantName: membership.tenant.name,
                        providerName: enforcedProvider.name,
                        providerId: enforcedProvider.id,
                        providerType: enforcedProvider.type,
                    },
                };
            }
        }
    }

    return { allowed: true };
}

// ─── Identity Link Admin ────────────────────────────────────────────

/**
 * List all identity links for a user. Requires ADMIN role.
 */
export async function getIdentityLinks(
    ctx: RequestContext,
    userId: string
): Promise<UserIdentityLink[]> {
    if (!ctx.permissions.canAdmin) throw forbidden('Only admins can view identity links');
    return IdentityLinkRepo.findByUserId(userId);
}

/**
 * Remove an identity link for a user. Requires ADMIN role.
 */
export async function unlinkIdentity(
    ctx: RequestContext,
    userId: string,
    providerId: string
): Promise<void> {
    if (!ctx.permissions.canAdmin) throw forbidden('Only admins can manage identity links');
    await IdentityLinkRepo.unlinkIdentity(userId, providerId);
}
