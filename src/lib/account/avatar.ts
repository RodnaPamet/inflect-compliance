/**
 * Account avatar — upload, removal, and read-back of a user's own
 * profile photo. Avatar roadmap P3.
 *
 * Account-level (session-scoped), NOT tenant-scoped: a user's avatar
 * is theirs across every tenant, so this lives beside the other
 * account-level helpers rather than in `app-layer/usecases` (which
 * are all tenant-RLS-bound).
 *
 * The image is resized + EXIF-stripped + webp-encoded **client-side**
 * — a `<canvas>` round-trip in `<AvatarUploadField>` — before upload.
 * So this layer never runs image processing: it validates the bytes
 * (a magic-number sniff + a hard size cap, defence-in-depth against a
 * client that bypasses the canvas) and persists them through the
 * storage abstraction. The canvas round-trip also strips EXIF before
 * the image ever leaves the browser, so GPS/camera metadata never
 * reaches the server at all.
 */
import type { Readable } from 'node:stream';

import prisma from '@/lib/prisma';
import { getStorageProvider } from '@/lib/storage';
import { badRequest } from '@/lib/errors/types';

/**
 * Hard upload cap. A 256×256 webp off the client canvas is ~5–25KB;
 * 512KB is a generous safety net for the honest path that still
 * bounds what a canvas-bypassing client can store.
 */
export const AVATAR_MAX_BYTES = 512 * 1024;

/** Deterministic storage key — one avatar per user, always webp. */
export function avatarStorageKey(userId: string): string {
    return `avatars/${userId}.webp`;
}

/** The stable in-app URL written to `User.image` for an uploaded avatar. */
export function avatarServeUrl(userId: string): string {
    return `/api/account/avatar/${userId}`;
}

/** True when `buf` begins with the RIFF/WEBP magic number. */
export function isWebp(buf: Buffer): boolean {
    return (
        buf.length >= 12 &&
        buf.toString('ascii', 0, 4) === 'RIFF' &&
        buf.toString('ascii', 8, 12) === 'WEBP'
    );
}

/**
 * Persist the caller's own processed avatar and point `User.image` at
 * the serve route. `userId` is always the authenticated session user
 * — the route layer never lets one user write another's avatar.
 */
export async function uploadOwnAvatar(
    userId: string,
    buf: Buffer,
): Promise<{ imageUrl: string }> {
    if (buf.length === 0) {
        throw badRequest('Avatar upload was empty.');
    }
    if (buf.length > AVATAR_MAX_BYTES) {
        throw badRequest(
            'Processed avatar is too large — re-select a smaller image.',
        );
    }
    if (!isWebp(buf)) {
        // The client canvas emits webp; anything else means the
        // canvas step was bypassed. Reject rather than store
        // unprocessed (possibly EXIF-bearing) bytes.
        throw badRequest('Avatar must be a WebP image.');
    }

    await getStorageProvider().write(avatarStorageKey(userId), buf, {
        mimeType: 'image/webp',
        maxSizeBytes: AVATAR_MAX_BYTES,
    });

    const imageUrl = avatarServeUrl(userId);
    await prisma.user.update({
        where: { id: userId },
        data: { image: imageUrl },
    });
    return { imageUrl };
}

/**
 * Remove the caller's uploaded avatar. `User.image` is cleared to
 * null — the surfaces fall back to initials, and a later OAuth
 * sign-in will re-populate the provider image if there is one.
 */
export async function removeOwnAvatar(userId: string): Promise<void> {
    // The storage delete is best-effort: the object may already be
    // gone. Clearing `User.image` is the operation that matters.
    await getStorageProvider()
        .delete(avatarStorageKey(userId))
        .catch(() => undefined);
    await prisma.user.update({
        where: { id: userId },
        data: { image: null },
    });
}

/**
 * May `viewerUserId` read `subjectUserId`'s avatar? (#2104)
 *
 * The audience is the subject's colleagues: a caller may read an
 * avatar when there is at least one tenant in which BOTH of them hold
 * an ACTIVE membership — plus, always, their own. Before #2104 the
 * serve route checked authentication only, so any signed-in account,
 * including one with zero memberships, could read any user's avatar
 * and use 200-versus-404 as an account-existence oracle.
 *
 * ACTIVE on both sides, matching `applyMembershipClaims` in
 * `src/auth.ts` (`{ status: 'ACTIVE', tenant: { deletedAt: null } }`)
 * — the same predicate that decides whether the caller can reach the
 * tenant's pages at all. INVITED is not yet a colleague; DEACTIVATED
 * and REMOVED no longer are. A soft-deleted tenant grants nothing,
 * because nobody can enter it.
 *
 * Known consequence: `/admin/members` lists ACTIVE + INVITED +
 * DEACTIVATED rows, so the latter two render as initials rather than
 * their uploaded photo. That is the subject side of this rule, and
 * loosening it is a deliberate product call — see
 * `docs/implementation-notes/2026-08-22-avatar-shared-tenant-audience.md`
 * before changing it to make one page prettier.
 *
 * ONE round trip, at most one row. The subject's ACTIVE memberships
 * are the driving scan (`TenantMembership_userId_status_idx`) and the
 * viewer's side is a correlated EXISTS over the same table, so
 * neither membership set is materialised in the app and there is no
 * per-tenant loop:
 *
 *   SELECT id FROM "TenantMembership" m
 *   WHERE m."userId" = $subject AND m.status = 'ACTIVE'
 *     AND EXISTS (SELECT 1 FROM "Tenant" t
 *                  WHERE t.id = m."tenantId" AND t."deletedAt" IS NULL
 *                    AND EXISTS (SELECT 1 FROM "TenantMembership" v
 *                                 WHERE v."tenantId" = t.id
 *                                   AND v."userId" = $viewer
 *                                   AND v.status = 'ACTIVE'))
 *   LIMIT 1;
 *
 * Deliberately asked of the DATABASE rather than of the caller's JWT
 * membership claims. Those are a bounded fast path — capped at
 * `MAX_JWT_MEMBERSHIPS` and refreshed only at sign-in — so reading
 * them here would hand a 404 to a colleague sitting past the cap.
 */
export async function canViewAvatar(
    viewerUserId: string,
    subjectUserId: string,
): Promise<boolean> {
    // Own avatar. The chrome renders it on every page, so answering
    // this one without a round trip is the case that matters for cost.
    if (viewerUserId === subjectUserId) return true;

    const shared = await prisma.tenantMembership.findFirst({
        where: {
            userId: subjectUserId,
            status: 'ACTIVE',
            tenant: {
                deletedAt: null,
                memberships: {
                    some: { userId: viewerUserId, status: 'ACTIVE' },
                },
            },
        },
        select: { id: true },
    });
    return shared !== null;
}

/**
 * Resolve a stored avatar to a readable stream for the serve route,
 * or `null` when the user has no uploaded avatar. The `head` probe
 * turns a missing object into a clean `null` (→ 404) instead of an
 * async stream error.
 */
export async function getAvatarStream(
    userId: string,
): Promise<Readable | null> {
    const provider = getStorageProvider();
    const key = avatarStorageKey(userId);
    try {
        await provider.head(key);
    } catch {
        return null;
    }
    return provider.readStream(key);
}
