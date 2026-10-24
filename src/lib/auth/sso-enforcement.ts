/**
 * "Enforce SSO", in one place.
 *
 * The admin form promised that while a workspace enforces single sign-on its
 * people sign in through its identity provider, and only break-glass admins
 * may still use a password. Nothing read the flag, so every way in kept
 * working. This is the rule every gate now asks:
 *
 *   a workspace that enforces SSO is reachable only by a session its OWN
 *   identity provider opened — or by a break-glass member: an OWNER or ADMIN
 *   who has a password and signed in with it.
 *
 * So Google, Microsoft, another workspace's SSO and an ordinary password
 * session are all refused there, while the same person's other workspaces
 * stay reachable. It is applied to the session's claims, so the edge refuses
 * an enforced workspace before any page loads (`applyMembershipClaims`), and
 * again at the DB-backed gates (`getTenantCtx`, `getLegacyCtx`,
 * `getTenantServerContext`). A sign-in that enforcement would leave with no
 * workspace at all is refused up front, with the workspace named, so the
 * person is sent to its SSO rather than to an empty "no workspace" page.
 */
import type { Role } from '@prisma/client';
import prisma from '@/lib/prisma';
import { forbidden } from '@/lib/errors/types';
import { SSO_HANDOFF_PROVIDER_ID } from '@/lib/auth/sso-session';

/** How the session was opened. A token minted before this field existed has none. */
export type SignInMethod = 'credentials' | 'oauth' | 'sso';

export function signInMethodOf(provider: string): SignInMethod {
    if (provider === 'credentials') return 'credentials';
    if (provider === SSO_HANDOFF_PROVIDER_ID) return 'sso';
    return 'oauth';
}

/**
 * The roles that may keep a password way in while SSO is enforced. OWNER is
 * one: break-glass used to count ADMIN alone, so a workspace run by its
 * OWNER could never turn enforcement on.
 */
export const BREAK_GLASS_ROLES: readonly Role[] = ['OWNER', 'ADMIN'];

export function isBreakGlassRole(role: Role): boolean {
    return BREAK_GLASS_ROLES.includes(role);
}

export interface EnforcementSubject {
    tenantId: string;
    /** The session's SSO scope (`ssoTenantId`): which workspace's IdP opened it, if any. */
    ssoTenantId: string | null | undefined;
    signInMethod: SignInMethod | null | undefined;
    /** The membership's built-in role, never a custom role's base. */
    role: Role;
    hasPassword: boolean;
}

/** Whether a session may reach a workspace that enforces SSO. */
export function enforcementAdmits(s: EnforcementSubject): boolean {
    if (s.ssoTenantId != null && s.ssoTenantId === s.tenantId) return true;
    return isBreakGlassRole(s.role) && s.signInMethod === 'credentials' && s.hasPassword;
}

/** Which of these workspaces enforce SSO through an enabled provider. */
export async function tenantsEnforcingSso(tenantIds: readonly string[]): Promise<Set<string>> {
    if (tenantIds.length === 0) return new Set();
    const rows = await prisma.tenantIdentityProvider.findMany({
        where: { tenantId: { in: [...tenantIds] }, isEnabled: true, isEnforced: true },
        select: { tenantId: true },
    });
    return new Set(rows.map((r) => r.tenantId));
}

export const SSO_REQUIRED_REFUSAL =
    "This workspace requires single sign-on. Sign in with your workspace's single sign-on to use it.";

/** The DB-backed gates' check: refuse a session enforcement does not admit. */
export async function assertSsoEnforcementAdmits(
    session: { userId: string; ssoTenantId?: string | null; signInMethod?: SignInMethod | null },
    tenantId: string,
    role: Role,
): Promise<void> {
    if (session.ssoTenantId != null && session.ssoTenantId === tenantId) return;
    const enforced = await tenantsEnforcingSso([tenantId]);
    if (!enforced.has(tenantId)) return;
    let hasPassword = false;
    if (isBreakGlassRole(role) && session.signInMethod === 'credentials') {
        const user = await prisma.user.findUnique({
            where: { id: session.userId },
            select: { passwordHash: true },
        });
        hasPassword = !!user?.passwordHash;
    }
    if (!enforcementAdmits({ tenantId, ssoTenantId: session.ssoTenantId, signInMethod: session.signInMethod, role, hasPassword })) {
        throw forbidden(SSO_REQUIRED_REFUSAL);
    }
}

/**
 * For a sign-in about to complete WITHOUT this workspace's SSO: the slug of a
 * workspace that requires SSO, when enforcement would leave the person with
 * no workspace at all — or `null` when they keep at least one, or had none.
 */
export async function workspaceRequiringSso(
    userId: string,
    signInMethod: SignInMethod,
): Promise<string | null> {
    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
            passwordHash: true,
            tenantMemberships: {
                where: { status: 'ACTIVE', tenant: { deletedAt: null } },
                orderBy: { createdAt: 'asc' },
                select: { tenantId: true, role: true, tenant: { select: { slug: true } } },
            },
        },
    });
    const memberships = user?.tenantMemberships ?? [];
    if (memberships.length === 0) return null;
    const enforced = await tenantsEnforcingSso(memberships.map((m) => m.tenantId));
    const reachable = memberships.some(
        (m) =>
            !enforced.has(m.tenantId) ||
            enforcementAdmits({
                tenantId: m.tenantId,
                ssoTenantId: null,
                signInMethod,
                role: m.role,
                hasPassword: !!user?.passwordHash,
            }),
    );
    if (reachable) return null;
    return memberships.find((m) => enforced.has(m.tenantId))?.tenant.slug ?? null;
}
