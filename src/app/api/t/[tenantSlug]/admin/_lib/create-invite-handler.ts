/**
 * Shared body of the two tenant invite-creation routes.
 *
 * `POST /admin/members` (the members page's "Invite Member" form) and
 * `POST /admin/invites` both mint a TenantInvite. They used to be two
 * implementations, and they drifted: only the invites route emailed the
 * acceptance link and charged the per-tenant invite budget, while the
 * members route — the one the page calls — did neither, so the page
 * announced an email nobody sent. Two URLs, one implementation now.
 *
 * Each route keeps its own `requirePermission('admin.members', …)` and its
 * own Zod schema, because the permission and role-enum guardrails read
 * both in the route file. The route hands its parse to this handler, which
 * runs it AFTER the rate limit — the order the invites route always had.
 *
 * The leading underscore in `_lib` keeps Next.js from treating this
 * directory as a routable segment.
 */
import { NextRequest, NextResponse } from 'next/server';
import { createInviteToken } from '@/app-layer/usecases/tenant-invites';
import type { RequestContext } from '@/app-layer/types';
import { TENANT_INVITE_CREATE_LIMIT } from '@/lib/security/rate-limit';
import { enforceRateLimit, getClientIp, isRateLimitBypassed } from '@/lib/security/rate-limit-middleware';
import { jsonResponse } from '@/lib/api-response';
import { resolvePublicOrigin } from '@/lib/http/request-origin';
import { sendInviteEmail } from '@/lib/email/invite-email';

type CreateInviteInput = Parameters<typeof createInviteToken>[1];

const TENANT_ROLE_LABEL: Record<string, string> = {
    OWNER: 'Owner',
    ADMIN: 'Admin',
    EDITOR: 'Editor',
    AUDITOR: 'Auditor',
    READER: 'Reader',
};

/**
 * Create the invite, email the acceptance link, and answer
 * `201 { invite, url, emailSent }`.
 *
 * `emailSent` is true only when a configured transport accepted the
 * message. It is false on a mailer failure AND when no mailer is
 * configured (a self-hosted deployment without SMTP), so the caller can
 * tell the admin to share `url` themselves.
 */
export async function createInvitePostHandler(
    req: NextRequest,
    ctx: RequestContext,
    parse: (body: unknown) => CreateInviteInput,
): Promise<NextResponse> {
    // Rate-limit: 20/hr per (tenantId, IP). Keyed on tenant so a
    // multi-IP attacker with one compromised ADMIN session still burns
    // the shared tenant budget — and shared by both routes, since each
    // invite now sends an email.
    if (!isRateLimitBypassed()) {
        const enforcement = enforceRateLimit(req, {
            scope: `invite-create:${ctx.tenantId}`,
            config: TENANT_INVITE_CREATE_LIMIT,
            ip: getClientIp(req),
            userId: ctx.userId,
        });
        if (enforcement.response) return enforcement.response;
    }

    const input = parse(await req.json());
    const result = await createInviteToken(ctx, input);

    // Email the acceptance link to the recipient. Best-effort: the
    // invite is already committed, so a mailer failure never fails
    // creation — `url` is the copy-paste fallback and `emailSent`
    // tells the admin whether it went out.
    const { sent } = await sendInviteEmail({
        to: result.invite.email,
        acceptUrl: resolvePublicOrigin(req) + result.url,
        kind: 'workspace',
        spaceName: ctx.tenantSlug ?? 'your workspace',
        roleLabel: TENANT_ROLE_LABEL[input.role] ?? input.role,
        expiresAt: result.invite.expiresAt,
    });

    return jsonResponse(
        { invite: result.invite, url: result.url, emailSent: sent },
        { status: 201 },
    );
}
