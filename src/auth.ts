/**
 * Auth.js (NextAuth v4) configuration — single consolidated module.
 *
 * GAP-04 — migrated from `next-auth@5.0.0-beta.30` (where the auth
 * config was split into edge-safe `auth.config.ts` + node-only
 * `auth.ts`) to `next-auth@4.24.14` (stable). v4 doesn't need the
 * edge/node split because the middleware uses `getToken()` directly
 * rather than the v5 `auth()` async wrapper.
 *
 * Exports:
 *   - `authOptions` — the canonical config consumed by every server-
 *     side helper that needs the session (`getServerSession(authOptions)`)
 *     and by the catch-all route handler.
 *   - `auth` — back-compat alias for `() => getServerSession(authOptions)`
 *     so the migration doesn't churn the 15 server-component import
 *     sites in a single PR. The alias has the same return shape as
 *     v5's `auth()` (Session | null) but is sync-callable from server
 *     contexts. New code should call `getServerSession(authOptions)`
 *     directly.
 *
 * Architecture preserved from the v5-beta era:
 *   - JWT session strategy (no Session table writes).
 *   - PrismaAdapter for the Account-linking + User row lifecycle.
 *   - Three callbacks: signIn (account linking + invite redemption),
 *     jwt (MFA + session-tracking + token refresh + sessionVersion),
 *     session (selective field exposure to client).
 *   - Module augmentation in `next-auth` (Session.user) and
 *     `next-auth/jwt` (custom token fields) — eliminates the 8
 *     `as`-casts the v5-beta type drift required.
 */

import type { NextAuthOptions, Session } from 'next-auth';
import type { JWT } from 'next-auth/jwt';
import { getServerSession } from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import Google from 'next-auth/providers/google';
// GAP-04 — v5 renamed `azure-ad` → `microsoft-entra-id` to track
// Microsoft's product rename. v4 still ships under the original name.
// Same provider, same OAuth endpoints, same scopes.
import AzureAD from 'next-auth/providers/azure-ad';
import { PrismaAdapter } from '@next-auth/prisma-adapter';
import prisma from '@/lib/prisma';
import { env } from '@/env';
import { authenticateWithPassword } from '@/lib/auth/credentials';
import type { Role } from '@prisma/client';
import { edgeLogger } from '@/lib/observability/edge-logger';
import { hashForLookup } from '@/lib/security/encryption';
import { graphHeaders } from '@/lib/http/graph-headers';
import { SSO_HANDOFF_COOKIE, SSO_HANDOFF_PROVIDER_ID } from '@/lib/auth/sso-session';
import type { SignInMethod } from '@/lib/auth/sso-enforcement';
import {
    pendingAfterMembershipRefresh,
    workspacesAskingForCode,
    workspacesStillAskingForCode,
} from '@/lib/auth/workspace-mfa';
import { SessionRevokedError } from '@/lib/auth/session-revoked';
import { isTenantSystemUserId } from '@/lib/tenant-system-user';

// ─── Type augmentation ──────────────────────────────────────────────
//
// GAP-04 — the v5-beta type instability that drove 8 `as`-casts
// across auth.ts/auth.config.ts/middleware.ts is resolved here by
// declaring both Session.user AND the JWT shape so middleware +
// server-component reads are typed end-to-end.

/**
 * Hard cap on how many membership entries are embedded in the JWT.
 *
 * A user in very many tenants/orgs would otherwise grow the session
 * cookie without bound — the JWT is a fixed-size credential, not a
 * data store. 50 is far above any realistic human workspace count, so
 * this is a safety valve rather than an everyday limit.
 *
 * When the real membership count exceeds this, the JWT carries the
 * first `MAX_JWT_MEMBERSHIPS` entries and `membershipsTruncated` /
 * `orgMembershipsTruncated` is set. The Edge middleware then defers a
 * slug-miss to the authoritative server-side gate (`TenantLayout` /
 * `getTenantCtx`, both DB-backed) instead of treating it as a
 * definitive cross-tenant denial. UI surfaces that need the COMPLETE
 * list (the `/tenants` picker) do their own server-side DB lookup.
 */
export const MAX_JWT_MEMBERSHIPS = 50;

/** One entry per active membership the user holds. */
export interface MembershipEntry {
    slug: string;
    role: Role;
    tenantId: string;
}

/**
 * One entry per active OrgMembership the user holds. Mirrors
 * `MembershipEntry` for the hub-and-spoke organization layer.
 * Threaded through the JWT so middleware can gate `/org/:slug/*`
 * routes against the user's org memberships in O(1) per request
 * with no DB hit — same pattern as the tenant access gate.
 */
export interface OrgMembershipEntry {
    slug: string;
    role: 'ORG_OWNER' | 'ORG_ADMIN' | 'ORG_READER';
    organizationId: string;
}

declare module 'next-auth' {
    interface Session {
        user: {
            id: string;
            email: string;
            name?: string | null;
            image?: string | null;
            tenantId?: string | null;
            role: Role;
            mfaPending?: boolean;
            /** R-1: all active memberships, for the tenant picker and middleware gate. */
            memberships?: MembershipEntry[];
            /** Org-layer memberships, for the org-route middleware gate. */
            orgMemberships?: OrgMembershipEntry[];
            /** Set when single sign-on opened the session: the only tenant it may reach. */
            ssoTenantId?: string | null;
            /** How the session was opened; read by "Enforce SSO" (`src/lib/auth/sso-enforcement.ts`). */
            signInMethod?: SignInMethod | null;
        };
    }

    interface User {
        /** Set by the `sso-handoff` provider: the tenant whose IdP vouched for the user. */
        ssoTenantId?: string;
    }
}

declare module 'next-auth/jwt' {
    interface JWT {
        userId?: string;
        sessionVersion?: number;
        sessionVersionCheckedAt?: number;
        tenantId?: string | null;
        tenantSlug?: string | null;
        role?: Role;
        mfaPending?: boolean;
        /**
         * The session's OTHER workspaces whose MFA policy still wants a code
         * from it: the edge holds each one's paths until its own challenge is
         * passed (`src/lib/auth/workspace-mfa.ts`). The primary workspace is
         * `mfaPending`, which holds the whole session.
         */
        mfaPendingTenantIds?: string[];
        mfaFailClosed?: boolean;
        /** Active tenant memberships, capped at MAX_JWT_MEMBERSHIPS. */
        memberships?: MembershipEntry[];
        /** Active org memberships, capped at MAX_JWT_MEMBERSHIPS. */
        orgMemberships?: OrgMembershipEntry[];
        /** True when `memberships` is a capped subset of the real set. */
        membershipsTruncated?: boolean;
        /** True when `orgMemberships` is a capped subset of the real set. */
        orgMembershipsTruncated?: boolean;
        /** Provider name when the user signed in via OAuth. */
        provider?: string;
        /**
         * Set when single sign-on opened the session: the tenant whose
         * identity provider vouched for the user, and the only tenant the
         * session may reach. See `src/lib/auth/sso-session.ts`.
         */
        ssoTenantId?: string | null;
        /**
         * How the session was opened. "Enforce SSO" admits a break-glass
         * member only on a password sign-in (`src/lib/auth/sso-enforcement.ts`).
         * Absent on a token minted before this field existed, which reads as
         * no password sign-in.
         */
        signInMethod?: SignInMethod;
        /** EI-1/EI-3 — telemetry flag: the groups claim overflowed (>200 groups)
         *  and was resolved via a Microsoft Graph `/me/memberOf` fetch instead.
         *  The resolved group list itself is consumed in-callback by EI-3's role
         *  sync and is deliberately NOT persisted on the token — an unbounded
         *  array of group GUIDs would bloat the JWT cookie (worst for the very
         *  overage population this flag marks) with no downstream reader. */
        aadGroupsOverage?: boolean;
        accessToken?: string;
        refreshToken?: string;
        expiresAt?: number;
        /** Operational session row id (Epic C.3). */
        userSessionId?: string;
        /** Soft-error flag — surfaces `RefreshTokenError` / `MfaDependencyFailure` / `EntraGroupGateDenied`. A revoked session is not flagged: the `jwt` callback throws `SessionRevokedError`. */
        error?: string;
    }
}

/**
 * Load the user's tenant + org membership claims into the JWT from the
 * database.
 *
 * Runs at sign-in, on an explicit session update (trigger === 'update'),
 * and on the jwt callback's throttled 5-minute check. The Edge
 * tenant-access gate authorizes slugs straight from these claims with NO
 * DB hit, so a membership the user gains AFTER sign-in — a freshly-created
 * tenant, an accepted invite, org auto-provisioning — is invisible to the
 * gate until these claims are refreshed.
 *
 * The update trigger alone was not enough, and the reason is structural
 * rather than an oversight: provoking it requires a client-side call, the
 * app mounts no `<SessionProvider>`, and the one place that needs an
 * IMMEDIATE refresh (`NewTenantForm`, which navigates into the tenant it
 * just created) hand-rolls the POST to `/api/auth/session`. That covers a
 * user acting on their own behalf and nothing else — a membership granted
 * BY someone else arrives in a request the affected user never makes. The
 * periodic call is what closes that gap; the update trigger remains as the
 * low-latency path for the create-then-navigate flow.
 *
 * This is the single source of truth for those claims; all three callers
 * use it so they can never drift. It also refreshes the display name and
 * photo, for the same reason and on the same cadence.
 *
 * `fallbackUserId` is consulted only when the email→User lookup misses
 * (a defensive sign-in edge case before the adapter commits the row);
 * on an update the user always exists so the lookup succeeds.
 */
export async function applyMembershipClaims(
    token: JWT,
    fallbackUserId?: string,
): Promise<void> {
    const dbUser = await prisma.user.findUnique({
        where: { emailHash: hashForLookup(token.email!) },
        include: {
            tenantMemberships: {
                // Exclude soft-deleted (org-removed) tenants so they
                // never enter the JWT fast-path / tenant switcher.
                where: { status: 'ACTIVE', tenant: { deletedAt: null } },
                orderBy: { createdAt: 'asc' },
                include: { tenant: { select: { slug: true, id: true } } },
            },
            orgMemberships: {
                orderBy: { createdAt: 'asc' },
                include: { organization: { select: { slug: true, id: true } } },
            },
        },
    });

    if (dbUser) {
        token.userId = dbUser.id;
        token.sessionVersion = dbUser.sessionVersion;

        // The display name and photo, re-read with the claims, so a change made
        // on the profile page reaches the top bar and the profile form on the
        // next refresh rather than at the next sign-in (#4644). The row is the
        // source of truth: the OAuth adapter never updates it after the first
        // sign-in, so it holds the person's own edits. A removed photo is a
        // NULL `image`, and must clear the token's picture too.
        token.name = dbUser.name ?? null;
        token.picture = dbUser.image ?? null;

        // A session opened by single sign-on is scoped to the tenant whose
        // identity provider vouched for the user: its claims name that
        // tenant's membership alone and no organization, so the edge gate
        // refuses everything else. See `src/lib/auth/sso-session.ts`.
        const ssoScope = token.ssoTenantId;
        const scopedRows = dbUser.tenantMemberships.filter(
            (m) => ssoScope == null || m.tenantId === ssoScope,
        );
        const orgRows = ssoScope == null ? dbUser.orgMemberships : [];

        // A workspace that enforces SSO is reachable only by its own SSO, or
        // by a break-glass member signed in with a password — so a session
        // it does not admit carries no claim to it, and the edge refuses it.
        const { enforcementAdmits, tenantsEnforcingSso } = await import('@/lib/auth/sso-enforcement');
        const enforcing = await tenantsEnforcingSso(scopedRows.map((m) => m.tenantId));
        const tenantRows = scopedRows.filter(
            (m) =>
                !enforcing.has(m.tenantId) ||
                enforcementAdmits({
                    tenantId: m.tenantId,
                    ssoTenantId: ssoScope,
                    signInMethod: token.signInMethod,
                    role: m.role,
                    hasPassword: !!dbUser.passwordHash,
                }),
        );

        // Active tenant memberships, capped at MAX_JWT_MEMBERSHIPS so the
        // cookie stays bounded; `membershipsTruncated` flags the rare
        // over-cap case for the middleware gate.
        token.memberships = tenantRows
            .slice(0, MAX_JWT_MEMBERSHIPS)
            .map((m) => ({
                slug: m.tenant.slug,
                role: m.role,
                tenantId: m.tenantId,
            }));
        token.membershipsTruncated =
            tenantRows.length > MAX_JWT_MEMBERSHIPS;

        // Same pattern (and cap) for the org layer so the middleware can
        // gate `/org/:slug/*` with no DB hit.
        token.orgMemberships = orgRows
            .slice(0, MAX_JWT_MEMBERSHIPS)
            .map((m) => ({
                slug: m.organization.slug,
                role: m.role,
                organizationId: m.organizationId,
            }));
        token.orgMembershipsTruncated =
            orgRows.length > MAX_JWT_MEMBERSHIPS;

        // Backward-compat: keep tenantId/tenantSlug/role as the "primary"
        // membership (oldest by createdAt).
        const primary = token.memberships[0];
        if (primary) {
            token.tenantId = primary.tenantId;
            token.tenantSlug = primary.slug;
            token.role = primary.role;
        } else {
            token.tenantId = null;
            token.tenantSlug = null;
            token.role = 'READER';
        }
    } else {
        token.userId = fallbackUserId ?? token.userId;
        token.role = 'READER';
        token.sessionVersion = 0;
        token.memberships = [];
        token.orgMemberships = [];
        token.membershipsTruncated = false;
        token.orgMembershipsTruncated = false;
    }
}

// ─── Providers ──────────────────────────────────────────────────────
//
// Edge-safe providers (Google, MicrosoftEntraID) used to live in a
// separate `auth.config.ts` because v5's middleware-side `auth()`
// wrapper bundled the full config into the Edge runtime. v4's
// middleware uses `getToken()` directly, which only verifies the JWT
// cookie — providers are never bundled into the Edge bundle. So the
// split is no longer required.

/**
 * Resolve a usable email address from Microsoft Entra ID-token claims.
 *
 * The desired onboarding flow is: an admin adds `…@partner.example` as a B2B guest
 * in our Entra tenant + sends an in-app invite, then the guest signs in with
 * Microsoft and is provisioned immediately (see redeemPendingInvitesByEmail).
 * For that email-match to fire, the sign-in must surface the guest's REAL
 * address so it equals the invite email. Entra is inconsistent here:
 *   - `email` — present when a mail attribute / optional claim exists, but
 *     frequently ABSENT for B2B guests. (Typed `string` by the provider, but
 *     genuinely optional at runtime.)
 *   - `preferred_username` — the guest's sign-in name, normally their real
 *     external email (`jane.doe@partner.example`). Safe fallback.
 *   - `upn` — the mangled `..._partner.example#EXT#@ourtenant.onmicrosoft.com` form;
 *     NEVER use it for matching (it would never equal the invite email).
 *
 * Returns the first `@`-shaped string claim, or null.
 */
export function resolveEntraEmail(...claims: unknown[]): string | null {
    for (const c of claims) {
        if (typeof c === 'string') {
            const v = c.trim();
            if (v.includes('@')) return v;
        }
    }
    return null;
}

const providers: NextAuthOptions['providers'] = [
    Google({
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        authorization: {
            params: {
                access_type: 'offline',
                prompt: 'consent',
                scope: 'openid email profile',
            },
        },
    }),
    AzureAD({
        // Pin the provider id to `microsoft-entra-id`. The v4 package
        // `next-auth/providers/azure-ad` defaults its id to `azure-ad`,
        // but the rest of the app keys off `microsoft-entra-id` — the
        // login button (`signIn('microsoft-entra-id')`), the
        // token-refresh switch in `src/lib/auth/refresh.ts`, and the
        // security-event method union. Without this override the
        // Microsoft button hits an unregistered provider and the
        // refresh path never matches. Callback URL is therefore
        // `/api/auth/callback/microsoft-entra-id`.
        id: 'microsoft-entra-id',
        name: 'Microsoft',
        clientId: env.MICROSOFT_CLIENT_ID,
        clientSecret: env.MICROSOFT_CLIENT_SECRET,
        tenantId: env.MICROSOFT_TENANT_ID,
        authorization: {
            params: {
                // EI-1 — `GroupMember.Read.All` lets the >200-group overage path
                // call Graph `/me/memberOf` with the issued access token. The
                // `groups` ID-token claim itself is governed by the tenant's App
                // Registration Token Configuration (set by the tenant admin),
                // not by this scope.
                scope: 'openid email profile offline_access https://graph.microsoft.com/GroupMember.Read.All',
            },
        },
        // Custom profile mapping — identical to the provider default EXCEPT the
        // email is resolved via resolveEntraEmail() so B2B guests (who often
        // arrive without an `email` claim) still land their real address. The
        // profile-photo fetch is preserved verbatim so existing Entra users
        // keep their avatar.
        async profile(profile, tokens) {
            let image: string | null = null;
            try {
                const response = await fetch(
                    'https://graph.microsoft.com/v1.0/me/photos/48x48/$value',
                    // No `Accept` on purpose — `$value` is binary (#3458).
                    { headers: graphHeaders(tokens.access_token as string) },
                );
                if (response.ok && typeof Buffer !== 'undefined') {
                    const pictureBuffer = await response.arrayBuffer();
                    const pictureBase64 = Buffer.from(pictureBuffer).toString('base64');
                    image = `data:image/jpeg;base64,${pictureBase64}`;
                }
            } catch {
                // Photo is best-effort; InitialsAvatar covers the null case.
            }
            return {
                id: profile.sub,
                name: profile.name,
                email: resolveEntraEmail(profile.email, profile.preferred_username),
                image,
            };
        },
    }),
    // Credentials — production-grade email+password auth.
    //
    // The hardened path lives in `src/lib/auth/credentials.ts`
    // (account-enumeration-safe, timing-equalised, email-verification-
    // gate-ready, silent-rehash-on-verify). The provider is always
    // registered; whether the login UI shows the email/password *form*
    // is a separate decision made in `src/app/login/page.tsx` based on
    // `getProviders()`.
    Credentials({
        id: 'credentials',
        name: 'Email and password',
        credentials: {
            email: { label: 'Email', type: 'email' },
            password: { label: 'Password', type: 'password' },
        },
        async authorize(credentials) {
            const result = await authenticateWithPassword({
                email: (credentials?.email as string | undefined) ?? '',
                password: (credentials?.password as string | undefined) ?? '',
            });
            // NextAuth surfaces any non-null return as a successful sign-in
            // and dispatches the `signIn` + `jwt` callbacks. Returning null
            // collapses every failure reason into the same client-facing
            // `CredentialsSignin` error — the account-enumeration-safe shape.
            if (!result.ok) return null;
            return {
                id: result.userId,
                email: result.email,
                name: result.name,
            };
        },
    }),
    // Single sign-on hand-off. The OIDC and SAML callbacks verify the
    // identity provider's answer and leave a single-use hand-off in a cookie
    // scoped to this provider's callback; the completion page
    // (`/login/sso-complete`) asks NextAuth to sign in here, and this redeems
    // it. From then on it is an ordinary NextAuth sign-in: the same cookie,
    // claims, MFA policy and session row as every other provider. It takes no
    // credentials from the request body — only the cookie, so a hand-off
    // cannot be completed in another browser. See `src/lib/auth/sso-handoff.ts`.
    Credentials({
        id: SSO_HANDOFF_PROVIDER_ID,
        name: 'Single sign-on',
        credentials: {},
        async authorize() {
            const { redeemSsoHandoff } = await import('@/lib/auth/sso-handoff');
            const handoff = await redeemSsoHandoff(await readSsoHandoffCookie());
            if (!handoff) return null;
            // Re-read at redemption: the membership may have been ended in the
            // seconds since the callback checked it.
            const membership = await prisma.tenantMembership.findUnique({
                where: { tenantId_userId: { tenantId: handoff.tenantId, userId: handoff.userId } },
                select: { status: true, user: { select: { id: true, email: true, name: true } } },
            });
            if (!membership || membership.status !== 'ACTIVE' || !membership.user.email) return null;
            return {
                id: membership.user.id,
                email: membership.user.email,
                name: membership.user.name,
                ssoTenantId: handoff.tenantId,
            };
        },
    }),
];

// ─── Invite-redemption helpers ──────────────────────────────────────
//
// Sign-in alone grants AUTHENTICATION; tenant membership is created
// ONLY via redemption of a token-bound invite (Epic 1, GAP-01 closure).

async function ensureTenantMembershipFromInvite(
    userId: string,
    userEmail: string,
    inviteToken: string | null,
): Promise<void> {
    if (!inviteToken) return; // the common case
    try {
        const { redeemInvite } = await import('@/app-layer/usecases/tenant-invites');
        await redeemInvite({ token: inviteToken, userId, userEmail });
    } catch (err) {
        // Surface via logger; do NOT fail the sign-in. The user is
        // authenticated; they'll land on /no-tenant where they can
        // see a "this invite is invalid" hint on their next visit.
        edgeLogger.warn('signIn: invite redemption failed', {
            component: 'auth',
            userId,
            error: err instanceof Error ? err.message : String(err),
        });
    }
}

/**
 * Verified-email invite provisioning (email-delivery-independent path).
 *
 * The admin "add member" flow creates a pending TenantInvite for an
 * email + role. Historically the invitee could only join by clicking
 * the emailed /invite/:token link — so an undelivered email (SMTP drop,
 * spam quarantine) meant no access. This redeems ANY pending invite
 * whose email matches the just-signed-in user's OAuth-verified email,
 * so "add the role, they sign in, they're in" works without the email.
 *
 * OAuth-only by construction: the caller gates this to
 * `account.provider !== 'credentials'` and the signIn callback already
 * rejects `email_verified === false`, so the email is IdP-verified.
 * Best-effort — a failure logs and never blocks sign-in.
 */
async function ensureTenantMembershipsFromPendingInvites(
    userId: string,
    userEmail: string,
): Promise<void> {
    try {
        const { redeemPendingInvitesByEmail } = await import(
            '@/app-layer/usecases/tenant-invites'
        );
        await redeemPendingInvitesByEmail({ userId, userEmail });
    } catch (err) {
        edgeLogger.warn('signIn: pending-invite-by-email provisioning failed', {
            component: 'auth',
            userId,
            error: err instanceof Error ? err.message : String(err),
        });
    }
}

/**
 * Epic D — same shape as ensureTenantMembershipFromInvite but for
 * org invites. Reads the `inflect_org_invite_token` cookie set by
 * /api/org/invite/:token/start-signin, then calls redeemOrgInvite.
 * Best-effort; a failure logs and falls through (the user is still
 * authenticated, they'll land on the appropriate "no access" page).
 */
async function ensureOrgMembershipFromInvite(
    userId: string,
    userEmail: string,
    orgInviteToken: string | null,
): Promise<void> {
    if (!orgInviteToken) return;
    try {
        const { redeemOrgInvite } = await import('@/app-layer/usecases/org-invites');
        await redeemOrgInvite({ token: orgInviteToken, userId, userEmail });
    } catch (err) {
        edgeLogger.warn('signIn: org invite redemption failed', {
            component: 'auth',
            userId,
            error: err instanceof Error ? err.message : String(err),
        });
    }
}

async function readSsoHandoffCookie(): Promise<string | null> {
    try {
        const { cookies } = await import('next/headers');
        const cookieStore = await cookies();
        return cookieStore.get(SSO_HANDOFF_COOKIE)?.value ?? null;
    } catch {
        return null;
    }
}

async function readInviteTokenFromCookies(): Promise<{
    tenantToken: string | null;
    orgToken: string | null;
}> {
    try {
        // GAP-05 — Next 15 made `cookies()` async (Promise<ReadonlyCookies>).
        const { cookies } = await import('next/headers');
        const cookieStore = await cookies();
        return {
            tenantToken: cookieStore.get('inflect_invite_token')?.value ?? null,
            orgToken: cookieStore.get('inflect_org_invite_token')?.value ?? null,
        };
    } catch {
        return { tenantToken: null, orgToken: null };
    }
}

// ─── NextAuthOptions ────────────────────────────────────────────────

/** The workspaces a token's claims name. */
function membershipTenantIds(token: JWT): Set<string> {
    return new Set((token.memberships ?? []).map((m) => m.tenantId));
}

/**
 * Bring `mfaPendingTenantIds` in line with re-read memberships: a workspace
 * the session left drops out, and one it gained since sign-in is asked whether
 * it wants a code, as sign-in would have asked (`pendingAfterMembershipRefresh`).
 * A failed read leaves the set as it was.
 */
async function refreshPendingMfaWorkspaces(token: JWT, before: ReadonlySet<string>): Promise<void> {
    if (!token.userId) return;
    try {
        token.mfaPendingTenantIds = await pendingAfterMembershipRefresh(token.userId, {
            pending: token.mfaPendingTenantIds ?? [],
            // A token minted before the set existed has never asked its other
            // workspaces: every one of them counts as gained.
            before: token.mfaPendingTenantIds === undefined ? new Set<string>() : before,
            after: (token.memberships ?? []).map((m) => m.tenantId),
            primaryTenantId: token.tenantId,
        });
    } catch {
        // Unchanged.
    }
}

export const authOptions: NextAuthOptions = {
    adapter: PrismaAdapter(prisma) as NextAuthOptions['adapter'],
    providers,
    pages: {
        signIn: '/login',
        error: '/login',
    },
    session: { strategy: 'jwt' },
    secret: env.AUTH_SECRET,
    // NextAuth's own errors, through the structured logger rather than
    // `console.error` with the whole metadata object. A revoked session is not
    // a fault: the `jwt` callback throws `SessionRevokedError` on purpose, and
    // NextAuth reports every throw there as JWT_SESSION_ERROR.
    logger: {
        error(code, metadata) {
            if (metadata instanceof SessionRevokedError) {
                edgeLogger.info('session refused', { component: 'auth', reason: metadata.reason });
                return;
            }
            edgeLogger.error(`next-auth ${code}`, {
                component: 'auth',
                error: metadata instanceof Error ? metadata.message : String(code),
            });
        },
    },
    callbacks: {
        /**
         * signIn — runs on EVERY sign-in attempt. Two responsibilities:
         *
         *   1. Account linking: if the OAuth email matches a User row
         *      created by a different provider, link the new OAuth
         *      `Account` to the existing User rather than creating a
         *      duplicate.
         *
         *   2. Invite redemption: if an `inflect_invite_token` cookie
         *      (tenant invite) or `inflect_org_invite_token` cookie
         *      (org invite, Epic D) is present, redeem it to create
         *      the corresponding TenantMembership / OrgMembership.
         *
         * Sign-in alone grants AUTHENTICATION, not tenant or org
         * membership. There is NO auto-join behaviour — see
         * `tests/guardrails/no-auto-join.test.ts`.
         */
        async signIn({ user, account, profile }) {
            if (!account) return true;

            // An SSO hand-off links no account and redeems no invite. The
            // email it carries was asserted by one tenant's identity
            // provider, which that tenant's admin configures — it proves
            // nothing about the address anywhere else, so it must not join
            // the person to another tenant or org. The session it opens is
            // scoped to that tenant in the `jwt` callback.
            if (account.provider === SSO_HANDOFF_PROVIDER_ID) return true;

            // "Enforce SSO": a sign-in that enforcement would leave with no
            // workspace is sent to that workspace's SSO instead of an empty
            // "no workspace" page (src/lib/auth/sso-enforcement.ts). Asked
            // after any invite this sign-in redeems, which can add one.
            const ssoRequired = async (userId: string | undefined): Promise<string | true> => {
                if (!userId) return true;
                const { signInMethodOf, workspaceRequiringSso } = await import('@/lib/auth/sso-enforcement');
                const slug = await workspaceRequiringSso(userId, signInMethodOf(account.provider));
                // The workspace rides inside the code: for a password sign-in,
                // next-auth's client drops the URL and keeps only `error`.
                return slug
                    ? `/login?${new URLSearchParams({ error: `sso_required:${slug}` }).toString()}`
                    : true;
            };

            // R-3: defensive email-verified check for OAuth.
            if (
                account.provider !== 'credentials' &&
                profile &&
                'email_verified' in profile &&
                profile.email_verified === false
            ) {
                edgeLogger.warn('signIn rejected: provider reported email_verified=false', {
                    component: 'auth',
                    provider: account.provider,
                    email: user.email ?? undefined,
                });
                return false;
            }

            const inviteTokens = await readInviteTokenFromCookies();

            // 1. Account linking for OAuth (not credentials).
            if (account.provider !== 'credentials' && user.email) {
                const existingUser = await prisma.user.findUnique({
                    where: { emailHash: hashForLookup(user.email) },
                });

                if (existingUser && user.id !== existingUser.id) {
                    const existingAccount = await prisma.account.findUnique({
                        where: {
                            provider_providerAccountId: {
                                provider: account.provider,
                                providerAccountId: account.providerAccountId,
                            },
                        },
                    });

                    if (!existingAccount) {
                        await prisma.account.create({
                            data: {
                                userId: existingUser.id,
                                type: account.type,
                                provider: account.provider,
                                providerAccountId: account.providerAccountId,
                                refresh_token: (account.refresh_token as string) ?? null,
                                access_token: (account.access_token as string) ?? null,
                                expires_at: (account.expires_at as number) ?? null,
                                token_type: (account.token_type as string) ?? null,
                                scope: (account.scope as string) ?? null,
                                id_token: (account.id_token as string) ?? null,
                                session_state: (account.session_state as string) ?? null,
                            },
                        });
                    }
                    await ensureTenantMembershipFromInvite(
                        existingUser.id,
                        user.email,
                        inviteTokens.tenantToken,
                    );
                    await ensureOrgMembershipFromInvite(
                        existingUser.id,
                        user.email,
                        inviteTokens.orgToken,
                    );
                    // Email-verified provisioning: redeem any pending invite
                    // for this email even without the emailed token link.
                    await ensureTenantMembershipsFromPendingInvites(
                        existingUser.id,
                        user.email,
                    );
                    return ssoRequired(existingUser.id);
                }
            }

            // 2. Invite redemption (no auto-join).
            if (user.id && user.email) {
                await ensureTenantMembershipFromInvite(
                    user.id,
                    user.email,
                    inviteTokens.tenantToken,
                );
                await ensureOrgMembershipFromInvite(
                    user.id,
                    user.email,
                    inviteTokens.orgToken,
                );
                // Email-verified provisioning (OAuth only — the credentials
                // provider's email is not IdP-verified). Redeems any pending
                // invite matching the verified email; no invite ⇒ no-op.
                if (account.provider !== 'credentials') {
                    await ensureTenantMembershipsFromPendingInvites(
                        user.id,
                        user.email,
                    );
                }
            }
            // TODO(business-metrics): recordUserSignup({ signupSource }) on the
            // genuinely-NEW OAuth user path. Deferred — the PrismaAdapter creates
            // the User row before this callback runs, so new-vs-returning is not
            // distinguishable here, and the clean `events.createUser` signal does
            // not carry `account.provider` (needed for the oauth_google/
            // oauth_microsoft/saml signupSource label). Emitting unconditionally
            // would wrongly count every sign-in. Needs a dedicated first-login
            // detector (e.g. a User.firstSignedInAt sentinel set in createUser +
            // read here) — a schema/behaviour change out of scope for this PR.
            return ssoRequired(user.id);
        },

        /**
         * jwt — enrich the token with custom fields, handle OAuth
         * token refresh, and gate MFA + sessionVersion + Epic C.3
         * session tracking.
         */
        async jwt({ token, user, account, profile, trigger }) {
            // Initial sign in.
            if (account && user) {
                // A tenant's SYSTEM user is a foreign-key target for job
                // writes, never a person (#4400). The database already refuses
                // every row a sign-in would need for it; this is the second
                // line, ahead of every claim.
                if (isTenantSystemUserId(user.id)) {
                    throw new Error('A tenant system user cannot sign in');
                }
                // Before the claims, which it scopes. Fail closed: a hand-off
                // that somehow named no tenant opens no session.
                if (account.provider === SSO_HANDOFF_PROVIDER_ID) {
                    if (!user.ssoTenantId) {
                        throw new Error('SSO hand-off named no tenant');
                    }
                    token.ssoTenantId = user.ssoTenantId;
                }
                // Before the claims too: "Enforce SSO" reads it.
                const { signInMethodOf } = await import('@/lib/auth/sso-enforcement');
                token.signInMethod = signInMethodOf(account.provider);
                await applyMembershipClaims(token, user.id);

                if (account.provider !== 'credentials') {
                    token.provider = account.provider;
                    token.accessToken = (account.access_token as string) ?? undefined;
                    token.refreshToken = (account.refresh_token as string) ?? undefined;
                    token.expiresAt = (account.expires_at as number) ?? undefined;
                }

                // ── EI-1 — extract AAD security-group membership from the ID
                //    token so the Epic EI-2 mapper has the raw group list. The
                //    `groups` claim is omitted for users in > ~200 groups
                //    (Entra sets `_claim_names.groups` instead) — fall back to
                //    a Graph `/me/memberOf` fetch in that overage case. A Graph
                //    failure resolves to [] and never blocks sign-in.
                if (account.provider === 'microsoft-entra-id') {
                    const { resolveEntraGroupClaims } = await import(
                        '@/lib/auth/entra-group-claims'
                    );
                    const { groups, overage } = await resolveEntraGroupClaims({
                        profile,
                        accessToken: account.access_token as string | undefined,
                    });
                    // The resolved `groups` are consumed in-callback by EI-3's
                    // role sync (below) — NOT persisted on the token: an
                    // unbounded array of group GUIDs would bloat the JWT cookie
                    // for the overage population with no downstream reader. Only
                    // the bounded overage flag rides along.
                    token.aadGroupsOverage = overage;

                    // ── EI-3 — sync the active-tenant membership role from the
                    //    tenant's group → role mappings, and enforce the group
                    //    gate. Scoped to the primary tenant (the session's
                    //    active tenant). A failure here must never block
                    //    sign-in, so it's best-effort.
                    if (token.tenantId && token.userId) {
                        try {
                            const { syncEntraMembershipRole, applyEntraSyncToToken } =
                                await import('@/lib/auth/entra-group-sync');
                            const activeTenantId = token.tenantId;
                            const tid = (profile as { tid?: unknown } | undefined)?.tid;
                            const result = await syncEntraMembershipRole({
                                userId: token.userId,
                                tenantId: activeTenantId,
                                aadGroups: groups,
                                // Mappings apply only to the workspace's own
                                // Microsoft directory (src/lib/auth/entra-group-sync.ts).
                                signInDirectoryId: typeof tid === 'string' ? tid : null,
                            });
                            applyEntraSyncToToken(token, activeTenantId, result);
                        } catch (err) {
                            edgeLogger.error('Entra group role-sync failed', {
                                component: 'entra',
                                error: err instanceof Error ? err.message : String(err),
                            });
                        }
                    }
                }

                // ── MFA enforcement ──
                token.mfaPending = false;
                const activeTenantId = token.tenantId ?? null;
                if (activeTenantId) {
                    try {
                        const secSettings = await prisma.tenantSecuritySettings.findUnique({
                            where: { tenantId: activeTenantId },
                        });
                        const policy = secSettings?.mfaPolicy ?? 'DISABLED';
                        const failClosed = secSettings?.mfaFailClosed ?? false;
                        token.mfaFailClosed = failClosed;

                        if (policy === 'REQUIRED' || policy === 'OPTIONAL') {
                            const enrollment = await prisma.userMfaEnrollment.findUnique({
                                where: {
                                    userId_tenantId_type: {
                                        userId: token.userId!,
                                        tenantId: activeTenantId,
                                        type: 'TOTP',
                                    },
                                },
                            });

                            if (policy === 'REQUIRED') {
                                token.mfaPending = true;
                            } else if (policy === 'OPTIONAL' && enrollment?.isVerified) {
                                token.mfaPending = true;
                            }
                        }
                    } catch {
                        if (token.mfaFailClosed) {
                            token.mfaPending = true;
                            token.error = 'MfaDependencyFailure';
                        }
                    }
                }

                // ── MFA for every OTHER workspace the session can reach ──
                // The block above asks only the primary workspace, the oldest
                // membership. A workspace that requires MFA but was joined
                // later was never asked, so its members got in on a password
                // alone (src/lib/auth/workspace-mfa.ts).
                token.mfaPendingTenantIds = [];
                const otherTenantIds = (token.memberships ?? [])
                    .map((m) => m.tenantId)
                    .filter((id) => id !== activeTenantId);
                if (otherTenantIds.length > 0 && token.userId) {
                    try {
                        token.mfaPendingTenantIds = await workspacesAskingForCode(token.userId, otherTenantIds);
                    } catch {
                        // Fails open, as the primary workspace does unless it
                        // is set to fail closed.
                    }
                }

                // ── Epic C.3 — record operational session row ──
                try {
                    const { recordNewSession } = await import(
                        '@/lib/security/session-tracker'
                    );
                    const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
                    const recorded = await recordNewSession({
                        userId: token.userId!,
                        tenantId: token.tenantId ?? null,
                        expiresAt: new Date(Date.now() + THIRTY_DAYS_MS),
                    });
                    token.userSessionId = recorded.sessionId;
                } catch {
                    // Already swallowed in the helper.
                }

                return token;
            }

            // ── Subsequent requests ──

            // Explicit client-side session refresh (`useSession().update()`).
            // Re-reads the membership claims so a tenant the user gained
            // after sign-in — e.g. one they just created (OWNER) or were
            // invited / auto-provisioned into — becomes visible to the Edge
            // gate immediately, with no full re-login. Falls through to the
            // session-revocation + OAuth-refresh checks below.
            if (trigger === 'update' && token.email) {
                const before = membershipTenantIds(token);
                await applyMembershipClaims(token);
                await refreshPendingMfaWorkspaces(token, before);
            }

            // Epic C.3 — verify session row still exists + isn't revoked.
            // A revoked (or expired) row THROWS, outside the try: NextAuth then
            // treats the session as invalid and every server gate sees none
            // (src/lib/auth/session-revoked.ts). Returning the token with an
            // `error` flag, as this did, kept every claim and refused nothing.
            if (typeof token.userSessionId === 'string' && token.userSessionId) {
                let revoked = false;
                try {
                    const { verifyAndTouchSession } = await import(
                        '@/lib/security/session-tracker'
                    );
                    const result = await verifyAndTouchSession(
                        token.userSessionId,
                    );
                    revoked = result.revoked;
                } catch {
                    // Helper already logs; fail-open on telemetry-side
                    // failures so a transient DB blip doesn't sign every
                    // user out.
                }
                if (revoked) throw new SessionRevokedError('session_revoked');
            }

            // OAuth access-token refresh intentionally NOT done here.
            //
            // The provider access token is used ONLY at sign-in (Entra group
            // claims); it is never exposed to the session (see the session
            // callback — "NEVER include accessToken") and nothing makes
            // outbound Google/Microsoft API calls with it afterwards. The
            // `jwt` callback runs on every `getServerSession` read but, in the
            // App Router, that path does NOT persist the re-signed cookie — so
            // a proactive refresh here re-ran on EVERY request (a Google token
            // HTTP round-trip + an Account row write per request) while never
            // updating the cookie expiry it checked. Since the token is unused,
            // the refresh was pure overhead and is removed. If a feature ever
            // needs the live provider token, refresh it on-demand from the
            // stored Account.refresh_token at the point of use (not per request).

            // MFA challenge completion check.
            if (token.mfaPending === true && token.userId && token.tenantId) {
                try {
                    const enrollment = await prisma.userMfaEnrollment.findUnique({
                        where: {
                            userId_tenantId_type: {
                                userId: token.userId,
                                tenantId: token.tenantId,
                                type: 'TOTP',
                            },
                        },
                        select: { lastChallengeAt: true, isVerified: true },
                    });

                    if (enrollment?.lastChallengeAt) {
                        const tokenIat = (token.iat as number | undefined) ?? 0;
                        const challengeTime = Math.floor(enrollment.lastChallengeAt.getTime() / 1000);
                        if (challengeTime >= tokenIat) {
                            token.mfaPending = false;
                        }
                    }
                } catch {
                    if (token.mfaFailClosed) {
                        token.error = 'MfaDependencyFailure';
                    } else {
                        token.mfaPending = false;
                    }
                }
            }

            // The same check for the session's other pending workspaces: each
            // leaves the set once its own challenge was passed since this token
            // was issued. A read failure leaves them pending; the person can
            // still pass the challenge.
            if (token.mfaPendingTenantIds?.length && token.userId) {
                try {
                    token.mfaPendingTenantIds = await workspacesStillAskingForCode(
                        token.userId,
                        token.mfaPendingTenantIds,
                        (token.iat as number | undefined) ?? 0,
                    );
                } catch {
                    // Stays pending.
                }
            }

            // Throttled revocation check AND membership-claims refresh
            // (5-minute interval, one shared timestamp).
            //
            // The refresh is here because it is the only place it can be.
            // Membership claims are minted at sign-in and re-minted on
            // `trigger: 'update'`, and that update can only be provoked by the
            // client — but the app deliberately mounts no `<SessionProvider>`,
            // so `useSession().update()` is unavailable and only one form in
            // the product (`NewTenantForm`) hand-rolls the equivalent POST to
            // `/api/auth/session`. Every other way a membership appears —
            // org auto-provisioning, an accepted invite, an admin adding you to
            // a tenant — happens in a request the affected user is not making,
            // so no client-side refresh can ever reach it. Before this, those
            // memberships were invisible to the Edge gate and to the workspace
            // switcher until a full re-login, with nothing on screen to say so:
            // the org page rendered (it is DB-gated server-side) while the
            // switcher, which reads only the token, said the user belonged to
            // no organizations.
            //
            // Revocation is checked BEFORE the refresh, because the refresh
            // overwrites `token.sessionVersion` with the value it is compared
            // against — reversing them would make every revocation a no-op.
            if (typeof token.sessionVersion === 'number' && token.userId) {
                const SESSION_CHECK_INTERVAL = 300; // seconds
                const now = Math.floor(Date.now() / 1000);
                const lastChecked = token.sessionVersionCheckedAt ?? 0;
                if (now - lastChecked >= SESSION_CHECK_INTERVAL) {
                    let versionBumped = false;
                    try {
                        const currentUser = await prisma.user.findUnique({
                            where: { id: token.userId },
                            select: { sessionVersion: true },
                        });
                        versionBumped = Boolean(
                            currentUser && currentUser.sessionVersion > token.sessionVersion,
                        );
                    } catch {
                        // Fail open on telemetry-side failures.
                    }
                    // Outside the try, for the same reason as the row check above.
                    if (versionBumped) throw new SessionRevokedError('session_version_bumped');
                    try {
                        // Claims re-read from the database on the same cadence.
                        // This also SHRINKS the token when a membership is
                        // revoked: previously a removed membership stayed in the
                        // JWT until re-login, so the Edge gate kept authorizing
                        // the slug (the authoritative server-side gate refused
                        // it, so this was stale defence-in-depth rather than a
                        // breach — but the gate was answering from a token that
                        // no longer described reality).
                        if (token.email) {
                            const before = membershipTenantIds(token);
                            await applyMembershipClaims(token);
                            await refreshPendingMfaWorkspaces(token, before);
                        }
                        // Stamped LAST so a failed read retries on the next
                        // request instead of being skipped for five minutes.
                        token.sessionVersionCheckedAt = now;
                    } catch {
                        // Fail open on telemetry-side failures.
                    }
                }
            }

            return token;
        },

        /**
         * session — expose ONLY safe fields to the client.
         * NEVER include accessToken or refreshToken.
         */
        async session({ session, token }) {
            if (token) {
                session.user.id = token.userId ?? token.sub!;
                session.user.tenantId = token.tenantId ?? null;
                session.user.role = token.role ?? 'READER';
                session.user.mfaPending = token.mfaPending ?? false;
                session.user.memberships = token.memberships ?? [];
                session.user.orgMemberships = token.orgMemberships ?? [];
                session.user.ssoTenantId = token.ssoTenantId ?? null;
                session.user.signInMethod = token.signInMethod ?? null;
            }
            return session;
        },
    },
};

// ─── Server-side session helper ─────────────────────────────────────
//
// Back-compat alias for v5's `auth()` so the 15+ server-component
// import sites don't all need to update in this PR. The name + return
// shape match v5: `Session | null`. Internally it calls v4's
// `getServerSession(authOptions)`.
//
// New code should call `getServerSession(authOptions)` directly to
// make the dependency explicit at each call site.

export async function auth(): Promise<Session | null> {
    return getServerSession(authOptions);
}

// Re-export `getServerSession` for ergonomics.
export { getServerSession };

// ─── Server-side signOut shim ───────────────────────────────────────
//
// v5 exported a server-side `signOut()` from the NextAuth() return.
// v4 does not — sign-out is a client-side `next-auth/react` flow OR a
// direct DELETE of the session cookie. The two server components that
// call `signOut()` (no-tenant page, tenant-picker page) use it to log
// the user out before showing a "you don't have access" UI. We
// preserve that behavior by providing a thin server-side helper that
// redirects to the canonical NextAuth signout page.
//
// Returns a redirect Response that the page should `return`.
export async function signOut(options?: {
    redirectTo?: string;
}): Promise<void> {
    const { redirect } = await import('next/navigation');
    const target = options?.redirectTo ?? '/login';
    // NextAuth's signout endpoint clears the cookie and then redirects
    // to `callbackUrl`. Hitting it from a server component this way
    // matches the v5 behavior — the user lands at `target` with no
    // active session. `redirect()` throws and never returns.
    redirect(`/api/auth/signout?callbackUrl=${encodeURIComponent(target)}`);
}
