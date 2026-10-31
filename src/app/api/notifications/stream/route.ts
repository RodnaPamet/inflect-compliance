/**
 * 2026-05-27 — Server-Sent Events endpoint for the notification
 * bell (PR-C of the notification streaming + alerts roadmap).
 *
 * Replaces the 60s REST poll in `notifications-bell.tsx`. The
 * client opens this route via `new EventSource('/api/notifications/stream')`
 * and receives one `data:` line per new notification — emitted by
 * the in-process bus at `src/lib/notifications/notification-bus.ts`.
 *
 * Server-Sent Events vs WebSocket:
 *   - SSE is one-way (server → client). The notification bell
 *     never sends events back; the existing REST endpoints
 *     (`PATCH /api/notifications/:id`) handle mark-read.
 *   - SSE works over plain HTTPS, no upgrade handshake. Survives
 *     corporate proxies, CDNs, and HTTP/2 multiplexing without
 *     the WebSocket-specific upgrade dance.
 *   - SSE has automatic reconnect built into the browser
 *     EventSource API. The client picks back up after a network
 *     blip without bespoke retry logic.
 *
 * Heartbeat:
 *   The browser, proxies, and load balancers all close idle
 *   connections. A 25-second comment line (`: hb\n\n`) keeps the
 *   connection warm without producing a user-visible event.
 *
 * Single-process:
 *   The bus is module-level — events published on one Node
 *   process don't fan out to subscribers on another. The 60s
 *   polling fallback in the bell covers cross-pod gaps. When
 *   multi-pod fanout becomes load-bearing, swap the bus to
 *   Redis pub/sub.
 */

import { NextRequest } from 'next/server';
import { getLegacyCtx } from '@/app-layer/context';
import { notificationStreamResponse } from '@/lib/notifications/notification-sse';

// Use Node runtime (not Edge) so the long-lived ReadableStream
// + setInterval heartbeat stay on the same process as the
// notification-bus publishers. Edge Functions terminate after
// ~15s of idle connection time on most providers.
export const runtime = 'nodejs';

// Disable Next.js's default response caching for SSE.
export const dynamic = 'force-dynamic';

/**
 * The session's own workspace — the bell in the org chrome, which has no open
 * workspace. Inside a workspace the bell uses
 * `/api/t/:slug/notifications/stream` instead (#4643). The stream itself is
 * `notificationStreamResponse`, shared by both.
 */
export async function GET(req: NextRequest): Promise<Response> {
    // Auth: same `getLegacyCtx` guard the REST list route uses.
    // Throws on unauthenticated; middleware-level guards already
    // handle the 401 surface for the route prefix.
    const ctx = await getLegacyCtx(req);
    return notificationStreamResponse(ctx, req.signal);
}
