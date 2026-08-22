/**
 * GET /api/account/avatar/[userId] — serve a user's uploaded avatar.
 *
 * Avatar roadmap P3. `User.image` for an uploaded avatar points here,
 * so this is the stable, provider-agnostic URL every avatar surface
 * renders (member list, people-picker, chrome). It streams the stored
 * webp from whichever storage backend is configured — no presigned-URL
 * expiry to leak into the DB.
 *
 * Auth — authentication is NOT the gate (#2104). The audience is the
 * subject's colleagues: the caller must hold an ACTIVE membership in
 * a tenant where the subject holds one too, and their own avatar
 * always resolves. `canViewAvatar` owns the decision; this route owns
 * the SHAPE of a refusal, which is the other half of the fix.
 *
 * A caller outside the audience gets the byte-identical `notFound`
 * that a user with no stored avatar gets. Not a 403: a 403 would
 * confirm the account exists, which is the enumeration oracle the
 * gate is here to close, and on a compliance product "is this person
 * a customer" is itself information. `<InitialsAvatar>` reads either
 * 404 through its `onError` path and falls back to initials, so the
 * two are indistinguishable to the UI as well.
 *
 * Wrapped in `withApiErrorHandling`: on the success path the image
 * streams through (the wrapper just appends correlation headers); a
 * thrown auth/not-found error becomes a JSON 4xx, which an `<img>`
 * treats as a load failure → initials fallback.
 */
import { Readable } from 'node:stream';
import type { NextRequest } from 'next/server';
import { getServerSession } from 'next-auth';

import { authOptions } from '@/auth';
import { withApiErrorHandling } from '@/lib/errors/api';
import { unauthorized, notFound } from '@/lib/errors/types';
import { canViewAvatar, getAvatarStream } from '@/lib/account/avatar';

/**
 * The ONE not-found message this route may throw. Both the
 * not-permitted and the genuinely-absent branch use it, so the two
 * responses are byte-identical; giving either its own wording would
 * re-open the oracle in the response body instead of the status code.
 */
const AVATAR_NOT_FOUND = 'Avatar not found.';

export const GET = withApiErrorHandling(
    async (
        _req: NextRequest,
        { params }: { params: Promise<{ userId: string }> },
    ): Promise<Response> => {
        const session = await getServerSession(authOptions);
        const viewerUserId = session?.user?.id;
        if (!viewerUserId) throw unauthorized();

        const { userId } = await params;

        // Authorize BEFORE touching storage: an unauthorized caller
        // must not be able to time a `head` probe against a key they
        // may not read.
        if (!(await canViewAvatar(viewerUserId, userId))) {
            throw notFound(AVATAR_NOT_FOUND);
        }

        const stream = await getAvatarStream(userId);
        if (!stream) throw notFound(AVATAR_NOT_FOUND);

        return new Response(
            Readable.toWeb(stream) as unknown as ReadableStream,
            {
                status: 200,
                headers: {
                    'Content-Type': 'image/webp',
                    // `private` keeps shared caches out of it; the
                    // audience gate above is what decides who may ask.
                    // Short TTL so a changed avatar propagates within
                    // minutes.
                    'Cache-Control': 'private, max-age=300',
                },
            },
        );
    },
);
