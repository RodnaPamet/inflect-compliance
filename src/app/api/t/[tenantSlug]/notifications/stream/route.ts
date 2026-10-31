/**
 * `/api/t/:slug/notifications/stream` — the live channel for the bell while
 * a workspace is open (#4643).
 *
 * The bell lists the OPEN workspace's notifications (owner decision,
 * 2026-10-30). Its live channel must subscribe the same workspace: the
 * session-wide `/api/notifications/stream` subscribes the session's first
 * workspace, so with SSE on it would push that workspace's notifications into
 * another workspace's bell.
 *
 * `getTenantCtx` refuses a caller who is not a member of `:slug`, and the
 * subscription is keyed on that workspace and the caller, so a stream only
 * ever carries the caller's own notifications in the workspace named.
 */
import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { assertCanRead } from '@/app-layer/policies/common';
import { notificationStreamResponse } from '@/lib/notifications/notification-sse';

// Node, not Edge, and never cached: a long-lived stream on the same process
// as the bus publishers. See `/api/notifications/stream`.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
    req: NextRequest,
    { params }: { params: Promise<{ tenantSlug: string }> },
): Promise<Response> {
    const ctx = await getTenantCtx(await params, req);
    assertCanRead(ctx);
    return notificationStreamResponse(ctx, req.signal);
}
