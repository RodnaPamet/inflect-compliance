/**
 * Tenant Invite Usecases — Token-Redemption Path to Membership
 *
 * Epic 1, PR 3. Every new TenantMembership row now comes through
 * redeemInvite — email-bound, time-limited, atomically consumed, and
 * audit-chained. The old "existing user → direct ACTIVE membership"
 * shortcut in tenant-admin.ts is gone.
 *
 * Canonical invite lifecycle:
 *   1. ADMIN calls createInviteToken → TenantInvite row + url.
 *   2. System emails the url to the invitee.
 *   3. Invitee loads /invite/[token] → previewInviteByToken (no side effect).
 *   4. Invitee signs in → redeemInvite is called → membership created.
 *   5. Admin may call revokeInvite at any time before step 4.
 *
 * @module usecases/tenant-invites
 */
import { randomBytes } from 'crypto';
import type { Role, TenantInvite } from '@prisma/client';
import { RequestContext } from '../types';
import {
    assertCanManageMembers,
    assertCanViewAdminSettings,
} from '../policies/admin.policies';
import { logEvent } from '../events/audit';
import { appendAuditEntry } from '@/lib/audit';
import { runInTenantContext } from '@/lib/db-context';
import { notFound, badRequest, forbidden, gone, internal } from '@/lib/errors/types';
import { prisma } from '@/lib/prisma';
import { hashForLookup } from '@/lib/security/encryption';
import { isAssignableTenantRole, unassignableRoleMessage } from '@/lib/roles';
import { recordInviteSent, recordInviteRedeemed } from '@/lib/observability/business-metrics';

// ─── Constants ──────────────────────────────────────────────────────

/**
 * Invite token time-to-live.
 *
 * TODO(future): make configurable via TenantSecuritySettings.inviteMaxAgeDays
 * once that column lands — the current schema has no such column.
 * For now 7 days is a safe default: short enough to limit exposure
 * from a leaked link, long enough for a recipient who checks email weekly.
 */
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// ─── createInviteToken ───────────────────────────────────────────────

export interface CreateInviteResult {
    invite: TenantInvite;
    url: string;
}

/**
 * Mint a new TenantInvite row and return the invite + a relative URL.
 *
 * Security invariants:
 *   - Requires admin.members permission (assertCanManageMembers).
 *   - OWNER invites additionally require ctx.appPermissions.admin.owner_management.
 *   - Rejects if the email already has an ACTIVE membership.
 *   - Upserts on (tenantId, email) unique key, refreshing token + expiry.
 *
 * @returns invite row + relative URL (caller prepends origin for email).
 */
export async function createInviteToken(
    ctx: RequestContext,
    input: { email: string; role: Role },
): Promise<CreateInviteResult> {
    assertCanManageMembers(ctx);

    // An invite is a deferred membership write, so it takes the writers' list:
    // AI_ADMIN is refused until deploy 2 of #3699.
    if (!isAssignableTenantRole(input.role)) {
        throw badRequest(unassignableRoleMessage(input.role));
    }

    if (input.role === 'OWNER') {
        if (!ctx.appPermissions.admin.owner_management) {
            throw forbidden('Only OWNERs can invite other OWNERs');
        }
    }

    const normalizedEmail = input.email.toLowerCase().trim();
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS);

    const invite = await runInTenantContext(ctx, async (db) => {
        // Guard: reject if there's already an ACTIVE membership for this email.
        const existingUser = await db.user.findUnique({
            where: { emailHash: hashForLookup(normalizedEmail) },
            select: { id: true },
        });
        if (existingUser) {
            const existing = await db.tenantMembership.findUnique({
                where: {
                    tenantId_userId: {
                        tenantId: ctx.tenantId,
                        userId: existingUser.id,
                    },
                },
                select: { status: true },
            });
            if (existing?.status === 'ACTIVE') {
                throw badRequest('User is already a member of this tenant');
            }
        }

        // Upsert — the @@unique([tenantId, email]) index handles dedup.
        const inv = await db.tenantInvite.upsert({
            where: {
                tenantId_email: {
                    tenantId: ctx.tenantId,
                    email: normalizedEmail,
                },
            },
            create: {
                tenantId: ctx.tenantId,
                email: normalizedEmail,
                role: input.role,
                token,
                invitedById: ctx.userId,
                expiresAt,
            },
            update: {
                role: input.role,
                token,
                invitedById: ctx.userId,
                expiresAt,
                revokedAt: null,
                acceptedAt: null,
            },
        });

        await logEvent(db, ctx, {
            action: 'MEMBER_INVITED',
            entityType: 'TenantInvite',
            entityId: inv.id,
            details: `Invited ${normalizedEmail} as ${input.role}`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'TenantInvite',
                operation: 'created',
                after: {
                    email: normalizedEmail,
                    role: input.role,
                    expiresAt: expiresAt.toISOString(),
                },
                summary: `Invited ${normalizedEmail} as ${input.role}`,
            },
        });

        return inv;
    });

    recordInviteSent();
    return { invite, url: `/invite/${invite.token}` };
}

// ─── revokeInvite ────────────────────────────────────────────────────

/**
 * Revoke a pending invite by setting revokedAt.
 *
 * 404 if the invite does not exist, belongs to another tenant, or is
 * already accepted/revoked.
 */
export async function revokeInvite(
    ctx: RequestContext,
    input: { inviteId: string },
): Promise<void> {
    assertCanManageMembers(ctx);

    await runInTenantContext(ctx, async (db) => {
        const invite = await db.tenantInvite.findFirst({
            where: {
                id: input.inviteId,
                tenantId: ctx.tenantId,
                acceptedAt: null,
                revokedAt: null,
            },
        });

        if (!invite) throw notFound('Invite not found or already accepted/revoked.');

        const revoked = await db.tenantInvite.update({
            where: { id: input.inviteId },
            data: { revokedAt: new Date() },
        });

        await logEvent(db, ctx, {
            action: 'MEMBER_INVITE_REVOKED',
            entityType: 'TenantInvite',
            entityId: revoked.id,
            details: `Revoked invite for ${invite.email}`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'TenantInvite',
                operation: 'deleted',
                summary: `Revoked invite for ${invite.email}`,
            },
        });
    });
}

// ─── listPendingInvites ──────────────────────────────────────────────

/**
 * List pending (non-expired, non-revoked, non-accepted) invites for
 * the calling tenant.
 */
export async function listPendingInvites(ctx: RequestContext) {
    assertCanViewAdminSettings(ctx);

    return runInTenantContext(ctx, (db) =>
        db.tenantInvite.findMany({
            where: {
                tenantId: ctx.tenantId,
                acceptedAt: null,
                revokedAt: null,
                expiresAt: { gt: new Date() },
            },
            include: {
                invitedBy: { select: { id: true, name: true } },
            },
            orderBy: { createdAt: 'desc' },
        })
    );
}

// ─── previewInviteByToken ────────────────────────────────────────────

export interface InvitePreview {
    tenantName: string;
    tenantSlug: string;
    role: Role;
    expiresAt: Date;
    /** True iff the signed-in user's email matches the invite email. */
    matchesSession: boolean;
}

/**
 * Public preview of an invite by raw token.
 *
 * Returns null for expired / revoked / accepted / not-found invites
 * so the caller can surface a 410 / 404 without exposing internals.
 * No audit entry — preview is idempotent + side-effect-free.
 *
 * @param token       The raw base64url invite token from the URL.
 * @param sessionEmail Email of the currently signed-in user, or null.
 */
export async function previewInviteByToken(
    token: string,
    sessionEmail: string | null,
): Promise<InvitePreview | null> {
    const invite = await prisma.tenantInvite.findUnique({
        where: { token },
        include: {
            tenant: { select: { name: true, slug: true } },
        },
    });

    if (!invite) return null;
    if (invite.revokedAt) return null;
    if (invite.acceptedAt) return null;
    if (invite.expiresAt < new Date()) return null;

    const matchesSession =
        sessionEmail !== null &&
        invite.email.toLowerCase().trim() === sessionEmail.toLowerCase().trim();

    return {
        tenantName: invite.tenant.name,
        tenantSlug: invite.tenant.slug,
        role: invite.role,
        expiresAt: invite.expiresAt,
        matchesSession,
    };
}

// ─── redeemInvite ────────────────────────────────────────────────────

export interface RedeemResult {
    tenantId: string;
    slug: string;
    role: Role;
}

/**
 * Atomically consume an invite and create (or reactivate) the membership.
 *
 * Security contract:
 *   - Uses `$transaction` with an `updateMany` predicate that acts as a
 *     SELECT-FOR-UPDATE-style atomic claim. Exactly one concurrent caller
 *     wins; the rest get a 410 Gone.
 *   - Email binding is strict (case-insensitive): if the redeemer's
 *     email does not match the invite, the invite is burnt (prevents
 *     token forwarding) and a 403 is thrown. The inviter must re-invite.
 *   - Runs outside any tenant RLS context (the caller is not yet a
 *     tenant member). Uses the default Prisma client with superuser
 *     credentials so RLS is bypassed for this write.
 *   - The audit entry is emitted AFTER the outer $transaction commits,
 *     because appendAuditEntry opens its own advisory-locked $transaction
 *     and must not be called from inside another $transaction.
 *
 * @param input.token      Raw token from the URL.
 * @param input.userId     The signed-in user's ID.
 * @param input.userEmail  The signed-in user's email (for binding check).
 */
export async function redeemInvite(input: {
    token: string;
    userId: string;
    userEmail: string;
}): Promise<RedeemResult> {
    // Step 1 runs standalone so that email-mismatch (step 3) BURNS the
    // invite — the throw in step 3 must NOT roll back the claim. If we
    // put everything in a single $transaction, Prisma would undo the
    // acceptedAt write on throw, and a token leak could be recycled.

    // ── Step 1: atomic claim (standalone commit) ─────────────────────
    // updateMany with the liveness predicates is the "test-and-set":
    // the first caller whose WHERE matches wins count=1; subsequent
    // callers (same token, concurrent) see acceptedAt already set
    // and get count=0.
    const claim = await prisma.tenantInvite.updateMany({
        where: {
            token: input.token,
            acceptedAt: null,
            revokedAt: null,
            expiresAt: { gt: new Date() },
        },
        data: { acceptedAt: new Date() },
    });

    if (claim.count !== 1) {
        // Look up why for a precise error message.
        const inv = await prisma.tenantInvite.findUnique({
            where: { token: input.token },
            select: { acceptedAt: true, revokedAt: true, expiresAt: true },
        });
        if (!inv) throw notFound('Invite not found');
        if (inv.revokedAt) throw gone('Invite has been revoked');
        if (inv.expiresAt < new Date()) throw gone('Invite has expired');
        if (inv.acceptedAt) throw gone('Invite has already been redeemed');
        throw internal('Invite redemption race condition');
    }

    // ── Step 2: re-fetch to get all needed fields ─────────────────
    const invite = await prisma.tenantInvite.findUnique({
        where: { token: input.token },
        select: {
            id: true,
            tenantId: true,
            email: true,
            role: true,
            invitedById: true,
            createdAt: true,
        },
    });
    if (!invite) throw internal('Invariant: invite disappeared mid-redemption');

    // ── Step 3: email binding ─────────────────────────────────────
    // If the redeemer's email doesn't match the invite email, the
    // invite IS NOW BURNT (acceptedAt committed in Step 1). Leave it
    // so a leaked token cannot be recycled by the real invitee or
    // anyone else. The inviter must issue a fresh invite.
    if (
        invite.email.toLowerCase().trim() !==
        input.userEmail.toLowerCase().trim()
    ) {
        throw forbidden(
            'Invite email does not match signed-in user. ' +
                'Ask your admin to send a new invite to your email address.',
        );
    }

    // ── Step 4 onwards: create the membership + audit + metric. The
    //   invite is already claimed (acceptedAt committed in Step 1); a
    //   failure here leaves it burnt, which is the safe failure mode.
    return finalizeInviteRedemption(invite, input.userId);
}

// ─── finalizeInviteRedemption (shared tail) ──────────────────────────

/**
 * Turn an already-CLAIMED invite (acceptedAt committed by the caller)
 * into an ACTIVE membership, audit it, record the metric, and return
 * the redirect data. Shared by both redemption entry points:
 *   - redeemInvite (token-bound, from the /invite/:token flow), and
 *   - redeemPendingInvitesByEmail (verified-email-bound, at sign-in).
 *
 * The caller is responsible for the atomic claim (Step 1) and any
 * binding check (email match). By the time we're here, the grant is
 * authorised — this just materialises it.
 *
 * The membership upsert + slug lookup run in one $transaction; the
 * audit call runs AFTER it commits because appendAuditEntry opens its
 * own advisory-locked $transaction and must not nest.
 */
async function finalizeInviteRedemption(
    invite: {
        tenantId: string;
        role: Role;
        invitedById: string | null;
        createdAt: Date;
    },
    userId: string,
): Promise<RedeemResult> {
    // The read-side half of `createInviteToken`'s refusal: an invite row
    // carrying a role no writer may write yet (#3699 deploy 1 — one written
    // around the usecase, or left by a newer release that was rolled back)
    // materialises no membership. The caller has already claimed it, so it
    // stays burnt — the safe failure mode this tail already documents.
    if (!isAssignableTenantRole(invite.role)) {
        throw badRequest(unassignableRoleMessage(invite.role));
    }

    const txResult = await prisma.$transaction(async (tx) => {
        const membership = await tx.tenantMembership.upsert({
            where: {
                tenantId_userId: {
                    tenantId: invite.tenantId,
                    userId,
                },
            },
            create: {
                tenantId: invite.tenantId,
                userId,
                role: invite.role,
                status: 'ACTIVE',
                invitedByUserId: invite.invitedById,
                invitedAt: new Date(),
            },
            update: {
                role: invite.role,
                status: 'ACTIVE',
                deactivatedAt: null,
                invitedByUserId: invite.invitedById,
                invitedAt: new Date(),
            },
        });

        const tenant = await tx.tenant.findUnique({
            where: { id: invite.tenantId },
            select: { slug: true },
        });
        if (!tenant) throw internal('Invariant: tenant disappeared mid-redemption');

        return {
            membershipId: membership.id,
            tenantId: invite.tenantId,
            userId,
            role: invite.role as Role,
            slug: tenant.slug,
        };
    });

    await appendAuditEntry({
        tenantId: txResult.tenantId,
        userId: txResult.userId,
        actorType: 'USER',
        entity: 'TenantMembership',
        entityId: txResult.membershipId,
        action: 'MEMBER_INVITE_ACCEPTED',
        detailsJson: {
            category: 'entity_lifecycle',
            entityName: 'TenantMembership',
            operation: 'created',
            after: { status: 'ACTIVE', role: txResult.role },
            summary: `Accepted invite as ${txResult.role}`,
        },
    });

    recordInviteRedeemed({
        timeToAcceptMs: Date.now() - new Date(invite.createdAt).getTime(),
    });

    return {
        tenantId: txResult.tenantId,
        slug: txResult.slug,
        role: txResult.role,
    };
}

// ─── redeemPendingInvitesByEmail ─────────────────────────────────────

/**
 * Sign-in-time membership provisioning by VERIFIED-EMAIL match.
 *
 * The delivered-email link (redeemInvite) is only one way to consume an
 * invite. Email delivery is unreliable (SMTP drops, spam quarantine), so
 * an admin who "adds a member" and the invitee who simply signs in with
 * that same email should Just Work — the pending TenantInvite is the
 * standing authorisation; a verified-email login is proof of possession
 * of the address, exactly as the token URL is proof of possession of the
 * link. This is the same model Vanta / Linear / GitHub use.
 *
 * Security contract — this is NOT auto-join (GAP-01):
 *   - Only redeems invites that an admin EXPLICITLY created for this
 *     exact email + role (createInviteToken). No invite ⇒ no membership.
 *   - The CALLER (auth signIn callback) guarantees the email is verified
 *     by the OAuth IdP and rejects `email_verified === false`. Do NOT
 *     call this for the credentials provider, whose email is unverified.
 *   - Each invite is claimed atomically (updateMany with the same
 *     liveness predicates as redeemInvite) so a concurrent link-click +
 *     login can't double-redeem; the loser simply skips.
 *   - Idempotent: a user already ACTIVE for a tenant re-runs the upsert
 *     harmlessly (and only if a fresh pending invite exists for them).
 *
 * Redeems ALL pending invites for the email — a user invited to several
 * tenants gets every membership on first login. Best-effort per invite:
 * one failure logs (via the thrown error to the caller) without blocking
 * the rest — callers wrap in try/catch and never fail sign-in.
 *
 * @returns the list of memberships created/reactivated (may be empty).
 */
export async function redeemPendingInvitesByEmail(input: {
    userId: string;
    userEmail: string;
}): Promise<RedeemResult[]> {
    const normalizedEmail = input.userEmail.toLowerCase().trim();
    if (!normalizedEmail) return [];

    const now = new Date();
    const pending = await prisma.tenantInvite.findMany({
        where: {
            email: normalizedEmail,
            acceptedAt: null,
            revokedAt: null,
            expiresAt: { gt: now },
        },
        select: {
            id: true,
            tenantId: true,
            role: true,
            invitedById: true,
            createdAt: true,
        },
        // Bounded: an email realistically has a handful of pending
        // invites. Cap defensively so a pathological fan-out can't turn
        // one sign-in into an unbounded write loop.
        take: 50,
    });

    const redeemed: RedeemResult[] = [];
    for (const invite of pending) {
        // Skipped BEFORE the claim, so it neither burns the invite nor stops
        // the loop: a role no writer may write yet (#3699) materialises no
        // membership, and the invite is left for a release that can.
        if (!isAssignableTenantRole(invite.role)) continue;

        // Atomic claim by id — the winner sets acceptedAt; a racing
        // token-URL redemption of the same invite makes this count=0.
        const claim = await prisma.tenantInvite.updateMany({
            where: {
                id: invite.id,
                acceptedAt: null,
                revokedAt: null,
                expiresAt: { gt: new Date() },
            },
            data: { acceptedAt: new Date() },
        });
        if (claim.count !== 1) continue;

        redeemed.push(await finalizeInviteRedemption(invite, input.userId));
    }

    return redeemed;
}
