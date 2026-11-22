/**
 * POST   /api/account/avatar — upload the caller's own avatar.
 * DELETE /api/account/avatar — remove the caller's own avatar.
 *
 * Self-service (avatar roadmap P3): both act ONLY on the
 * authenticated session user — there is no userId parameter, so one
 * user can never write another's avatar. Account-level, not
 * tenant-scoped; no `requirePermission` (mirrors `/api/auth/change-password`).
 * A session opened by one workspace's single sign-on may change it only
 * while the account belongs to nothing else (`assertAccountWideWriteInScope`).
 *
 * The image arrives already resized + EXIF-stripped + webp-encoded by
 * the client `<canvas>` round-trip; `uploadOwnAvatar` validates the
 * bytes and persists them.
 */
import type { NextRequest } from 'next/server';
import { getServerSession } from 'next-auth';

import { authOptions } from '@/auth';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { unauthorized, badRequest } from '@/lib/errors/types';
import {
    uploadOwnAvatar,
    removeOwnAvatar,
    AVATAR_MAX_BYTES,
} from '@/lib/account/avatar';
import { assertAccountWideWriteInScope } from '@/lib/account/sso-scope';

/**
 * Room for the multipart envelope around the one file part: the boundary
 * lines, the part headers and the filename. Generous on purpose: the cap is
 * there to stop a multi-hundred-MB body, not to measure the envelope.
 */
const MULTIPART_OVERHEAD_BYTES = 16 * 1024;
const AVATAR_BODY_CAP = AVATAR_MAX_BYTES + MULTIPART_OVERHEAD_BYTES;

const TOO_LARGE = 'Processed avatar is too large — re-select a smaller image.';

/**
 * Read the request body through a byte cap that ABORTS at the cap (#5303).
 * `req.formData()` buffers the whole body before anything can measure it,
 * so a size check on the parsed file refused an oversized upload only after
 * it had been held in memory. A declared `content-length` over the cap is
 * refused before a byte is read; one that is absent or understated is
 * caught while streaming.
 */
async function readCappedBody(req: NextRequest, cap: number): Promise<Uint8Array<ArrayBuffer>> {
    const declared = Number(req.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > cap) throw badRequest(TOO_LARGE);
    const reader = req.body?.getReader();
    if (!reader) return new Uint8Array(0);
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > cap) {
            await reader.cancel().catch(() => undefined);
            throw badRequest(TOO_LARGE);
        }
        chunks.push(value);
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return out;
}

export const POST = withApiErrorHandling(async (req: NextRequest) => {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) throw unauthorized();
    await assertAccountWideWriteInScope({ userId: session.user.id, ssoTenantId: session.user.ssoTenantId });

    // The body is capped while it is read; only then is it parsed as a form.
    const body = await readCappedBody(req, AVATAR_BODY_CAP);
    let formData: FormData;
    try {
        formData = await new Response(body, {
            headers: { 'content-type': req.headers.get('content-type') ?? '' },
        }).formData();
    } catch {
        throw badRequest('Missing avatar file in form data.');
    }
    const file = formData.get('file');
    if (!(file instanceof File)) {
        throw badRequest('Missing avatar file in form data.');
    }
    // The envelope allowance above lets a file slightly over the limit
    // through the body cap; the file itself is held to the limit here.
    if (file.size > AVATAR_MAX_BYTES) {
        throw badRequest(TOO_LARGE);
    }

    const buf = Buffer.from(await file.arrayBuffer());
    const result = await uploadOwnAvatar(session.user.id, buf);
    return jsonResponse(result, { status: 200 });
});

export const DELETE = withApiErrorHandling(async () => {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) throw unauthorized();
    await assertAccountWideWriteInScope({ userId: session.user.id, ssoTenantId: session.user.ssoTenantId });

    await removeOwnAvatar(session.user.id);
    return jsonResponse({ success: true });
});
