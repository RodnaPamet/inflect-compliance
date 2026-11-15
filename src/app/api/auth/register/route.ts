/**
 * POST /api/auth/register  body: { action: 'register', email, password, name, orgName? }
 *
 * With `orgName`: a new workspace, and the account as its Owner. Without it:
 * an account only, for the pending invitation in the request's
 * `inflect_invite_token` cookie, which must have been sent to the same email
 * (#4689). Accepting an invite by password used to need a throwaway
 * workspace; the sign-in that follows redeems the invitation as usual.
 *
 * Every refusal carries a code from `REGISTER_REFUSALS` beside its English
 * sentence, so the sign-in page can say it in the user's language (#4686).
 *
 * Register is the ONLY credentials flow still served by this route.
 * Login was served here historically via `action: 'login'` before the
 * NextAuth Credentials provider became production-grade; that path was
 * removed on 2026-04-22 to avoid having two concurrent login surfaces
 * with subtly different rate-limit / audit / email-verification
 * semantics. All production login now flows through NextAuth
 * `/api/auth/callback/credentials`.
 */
import { cookies } from 'next/headers';
import { Prisma, type Role } from '@prisma/client';
import prisma from '@/lib/prisma';
import { previewInviteByToken } from '@/app-layer/usecases/tenant-invites';
import type { RegisterRefusal } from '@/lib/auth/register-refusals';
import { issueEmailVerification } from '@/lib/auth/email-verification';
import { hashPassword, validatePasswordPolicy } from '@/lib/auth/passwords';
import { checkPasswordAgainstHIBP } from '@/lib/security/password-check';
import { hashForLookup } from '@/lib/security/encryption';
import { generateAndWrapDek } from '@/lib/security/tenant-keys';
import { withValidatedBody } from '@/lib/validation/route';
import { AuthActionSchema } from '@/lib/schemas';
import { env } from '@/env';
import { withApiErrorHandling } from '@/lib/errors/api';
import { TENANT_CREATE_LIMIT } from '@/lib/security/rate-limit';
import { logger } from '@/lib/observability/logger';
import { jsonResponse } from '@/lib/api-response';
import { recordTenantCreated, recordUserSignup } from '@/lib/observability/business-metrics';

// NOTE for whoever owns signup policy: this route has NO AUTH_TEST_MODE
// gate. CLAUDE.md and the OpenAPI description both once said it had one;
// both now say it does not (#5132). The provider side is
// unambiguous — src/auth.ts:342-349 states the credentials provider is
// "always registered" — so a self-registered production account is
// usable. Whether public signup should be open is a product decision and
// is deliberately NOT changed here; this file only fixes the things that
// are wrong either way.
//
// The local try/catch that used to wrap this is gone. It caught every
// failure and returned `error.message` verbatim with status 500, which
// DEFEATED withApiErrorHandling's toApiErrorResponse shaping — so raw
// Prisma text, constraint and column names, the invocation site and an
// absolute server path went to an unauthenticated caller. Its comment
// justified it as "a final safety net so a DB error returns JSON instead
// of an HTML 500 page", which is exactly what the wrapper already does,
// minus the disclosure.
//
// TENANT_CREATE_LIMIT (5/hour) is the preset the repo already wrote for
// this threat — it was wired only to the platform-key-GATED
// /api/admin/tenants, while this strictly weaker-gated route inherited
// the generic API_MUTATION_LIMIT (60/min). Each accepted request
// permanently creates a Tenant + wrapped per-tenant DEK + User +
// TenantMembership, runs bcrypt cost 12, makes an outbound HIBP call,
// and sends mail to an attacker-chosen recipient from our sending
// domain. 3,600/hour from one IP was the ceiling.
export const POST = withApiErrorHandling(
    withValidatedBody(AuthActionSchema, async (_req, _ctx, body) => {
        // Zod's discriminated union already rejects anything but
        // `register`, so there are no else branches to guard.
        return await handleRegister(body);
    }),
    { rateLimit: { config: TENANT_CREATE_LIMIT, scope: 'self-service-register' } },
);

const POLICY_REFUSAL = {
    empty: 'PASSWORD_EMPTY',
    too_short: 'PASSWORD_TOO_SHORT',
    too_long: 'PASSWORD_TOO_LONG',
} as const satisfies Record<string, RegisterRefusal>;

/**
 * The unique violation a racing duplicate registration loses on: the
 * user's `emailHash` (GAP-21), the column the `existing` check reads.
 */
function isEmailHashUniqueViolation(err: unknown): boolean {
    if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') return false;
    // The pg driver adapter names the index and its fields; the classic
    // engine names the columns in `target`. Anything else is not recognised
    // and stays a 500, rather than being reported as a clash it may not be.
    const meta = err.meta as
        | { target?: unknown; driverAdapterError?: { cause?: { constraint?: { index?: unknown; fields?: unknown } } } }
        | undefined;
    const constraint = meta?.driverAdapterError?.cause?.constraint;
    const names: unknown[] = [
        constraint?.index,
        ...(Array.isArray(constraint?.fields) ? constraint.fields : []),
        ...(Array.isArray(meta?.target) ? meta.target : [meta?.target]),
    ];
    return names.some((n) => typeof n === 'string' && n.includes('emailHash'));
}

/** Every refusal carries its code beside the English sentence (#4686). */
function refuse(code: RegisterRefusal, error: string, status = 400) {
    return jsonResponse({ error, code }, { status });
}

async function handleRegister(body: { email: string; password: string; name: string; orgName?: string }) {
    const { email: rawEmail, password, name } = body;
    const orgName = body.orgName?.trim() || null;
    if (!rawEmail || !password || !name) {
        return refuse('REGISTER_FIELDS_MISSING', 'Missing required fields');
    }

    // Enforce password policy at the set-password boundary. Login
    // does NOT re-validate (see src/lib/auth/passwords.ts) so pre-policy
    // users aren't locked out by a later rule bump.
    const policy = validatePasswordPolicy(password);
    if (!policy.ok) {
        return refuse(
            POLICY_REFUSAL[policy.reason],
            policy.reason === 'too_short'
                ? 'Password must be at least 8 characters'
                : policy.reason === 'too_long'
                  ? 'Password is too long'
                  : 'Password is required',
        );
    }

    // Breached-password screening (Epic A.3). Fails open on network
    // errors — a HIBP outage must not brick signup. The function never
    // logs the password or its hash.
    const hibp = await checkPasswordAgainstHIBP(password);
    if (hibp.breached) {
        return refuse(
            'PASSWORD_BREACHED',
            'This password appears in known data breaches. Please choose a different password.',
        );
    }

    const email = String(rawEmail).trim().toLowerCase();

    // GAP-21: identity is anchored on `emailHash` (deterministic
    // HMAC of the normalised email). Checking by hash is what the
    // unique constraint enforces, so a duplicate signup races
    // through the same gate as the DB.
    const existing = await prisma.user.findUnique({
        where: { emailHash: hashForLookup(email) },
    });
    if (existing) {
        return refuse('EMAIL_ALREADY_REGISTERED', 'Email already registered', 409);
    }

    // No workspace name: an account only, and only for a live invitation
    // sent to this email (#4689). Without that, an unnamed registration
    // would make an account that belongs nowhere, so it is refused. The
    // email check runs here rather than at redemption, which burns the
    // invitation on a mismatch.
    if (!orgName) {
        const token = (await cookies()).get('inflect_invite_token')?.value;
        if (!token) {
            return refuse('WORKSPACE_NAME_REQUIRED', 'A workspace name is required.');
        }
        const invite = await previewInviteByToken(token, email);
        if (!invite) {
            return refuse('INVITE_UNAVAILABLE', 'The invitation for this account is no longer available.');
        }
        if (!invite.matchesSession) {
            return refuse('INVITE_EMAIL_MISMATCH', 'Register with the email address the invitation was sent to.');
        }
        const invitedPasswordHash = await hashPassword(password);
        let user: { id: string; email: string; name: string | null };
        try {
            user = await prisma.user.create({
                data: { email, emailHash: hashForLookup(email), passwordHash: invitedPasswordHash, name },
            });
        } catch (err) {
            // A racing duplicate passed the `existing` check above (#5303).
            if (isEmailHashUniqueViolation(err)) {
                return refuse('EMAIL_ALREADY_REGISTERED', 'Email already registered', 409);
            }
            throw err;
        }
        recordUserSignup({ signupSource: 'credentials' });
        await issueEmailVerification(email, { userId: user.id }).catch(() => undefined);
        return jsonResponse({
            user: { id: user.id, email: user.email, name: user.name, role: null },
            // The sign-in that follows redeems the invitation; no workspace
            // is created here.
            tenant: null,
            emailVerificationRequired: env.AUTH_REQUIRE_EMAIL_VERIFICATION === '1',
        });
    }

    // Tenant, user and OWNER membership are ONE transaction (#5303). They
    // used to be three statements, tenant first: a racing duplicate
    // registration (a double-submitted form) passed the `existing` check
    // above, lost on the user's `emailHash` unique, and left its tenant —
    // with a wrapped DEK and no member at all — behind for good, as did any
    // other failure after the tenant insert. Now the loser rolls back whole
    // and is told the email is registered. The DEK is wrapped as
    // `createTenantWithDek` wraps it (Epic B.2), inside the transaction, as
    // `createTenantUnderOrg` does; its first use unwraps it.
    const slug = orgName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') + '-' + Date.now().toString(36);
    // Hashed before the transaction opens: a slow hash must not hold it.
    const passwordHash = await hashPassword(password);
    let created: {
        tenant: { id: string; name: string; slug: string };
        user: { id: string; email: string; name: string | null };
        membership: { role: Role };
    };
    try {
        created = await prisma.$transaction(async (tx) => {
            const { wrapped } = generateAndWrapDek();
            const tenant = await tx.tenant.create({
                data: { name: orgName, slug, encryptedDek: wrapped },
                select: { id: true, name: true, slug: true },
            });

            // Create user (no role/tenantId — membership is sole authority)
            const user = await tx.user.create({
                data: {
                    email,
                    emailHash: hashForLookup(email),
                    passwordHash,
                    name,
                },
            });

            // Create TenantMembership (sole source of role + tenant binding)
            const membership = await tx.tenantMembership.create({
                data: {
                    tenantId: tenant.id,
                    userId: user.id,
                    // OWNER, not ADMIN. OWNER is strictly superior: it alone carries
                    // admin.tenant_lifecycle (delete tenant, rotate DEK, transfer
                    // ownership) and admin.owner_management (invite/remove OWNERs).
                    // Creating the tenant's first member as ADMIN left every
                    // self-service tenant with ZERO owners, so those two capability
                    // sets were permanently unreachable for it — it could never
                    // delete itself, rotate its own key, or hand ownership on.
                    // createTenantWithOwner (the platform-admin path) has always
                    // made this member an OWNER; this path had drifted.
                    role: 'OWNER',
                },
            });
            return { tenant, user, membership };
        });
    } catch (err) {
        if (isEmailHashUniqueViolation(err)) {
            return refuse('EMAIL_ALREADY_REGISTERED', 'Email already registered', 409);
        }
        throw err;
    }
    const { tenant, user, membership } = created;

    // Business KPIs — credentials self-service signup creates BOTH a
    // tenant (always FREE on this path) and its first user.
    recordTenantCreated({ plan: 'FREE', signupSource: 'credentials' });
    recordUserSignup({ signupSource: 'credentials' });

    // Fire the verification email. Non-blocking in intent — the issue
    // path writes the token row in a transaction and then attempts to
    // send the email; mailer failures are swallowed inside
    // issueEmailVerification so the register response is not held up
    // by SMTP latency or outages.
    await issueEmailVerification(email, { userId: user.id }).catch(() => undefined);

    // The legacy `token` cookie that used to be minted here is gone. It
    // was a second session credential that bypassed every revocation
    // mechanism the real one has — see the note in src/lib/auth.ts. The
    // client has always called signIn('credentials', …) immediately after
    // this response (src/app/login/page.tsx), so nothing depended on it.
    const response = jsonResponse({
        user: { id: user.id, email: user.email, name: user.name, role: membership.role },
        // GAP-23: slug exposed alongside id/name so callers (notably
        // E2E test fixtures via `createIsolatedTenant`) can navigate
        // to `/t/<slug>/...` without having to look the slug up
        // post-registration. Slug is a public routing identifier,
        // not sensitive — it appears in every authenticated URL.
        tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug },
        emailVerificationRequired: env.AUTH_REQUIRE_EMAIL_VERIFICATION === '1',
    });

    return response;
}
