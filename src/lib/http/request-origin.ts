import type { NextRequest } from 'next/server';
import { env } from '@/env';

/**
 * Resolve the PUBLIC origin (`scheme://host`) for building absolute
 * redirect URLs from a Node-runtime route handler.
 *
 * Behind the production reverse proxy (Caddy), `req.nextUrl.origin`
 * resolves to the app's INTERNAL bind address (e.g.
 * `https://0.0.0.0:3000`) — a browser that follows such a redirect
 * lands on an unreachable URL. The Edge middleware doesn't hit this
 * because Next rebuilds its request URL from the forwarded host; Node
 * route handlers must reconstruct the public origin explicitly.
 *
 * Resolution order:
 *   1. `X-Forwarded-Host` (+ `X-Forwarded-Proto`) — what the client
 *      actually requested, set by the proxy. Same signal the Edge
 *      middleware uses.
 *   2. The configured public URL (`NEXTAUTH_URL` / `AUTH_URL`).
 *   3. `req.nextUrl.origin` — last resort (dev / no proxy).
 *
 * Only for a redirect the SAME browser follows. A URL that leaves the
 * request — an emailed invite link, a string an operator pastes elsewhere —
 * is built with `publicBaseUrl` (`./public-base-url.ts`), which never reads
 * `X-Forwarded-Host`: a caller who reaches the app without the proxy sets
 * that header to whatever it likes (#5316).
 */
export function resolvePublicOrigin(req: NextRequest): string {
    const fwdHost = req.headers.get('x-forwarded-host');
    if (fwdHost) {
        // Both headers may be comma-separated lists when chained through
        // multiple proxies — the first entry is the original client value.
        const host = fwdHost.split(',')[0]!.trim();
        const proto =
            (req.headers.get('x-forwarded-proto') ?? 'https')
                .split(',')[0]!
                .trim() || 'https';
        if (host) return `${proto}://${host}`;
    }

    const configured = env.NEXTAUTH_URL || env.AUTH_URL;
    if (configured) {
        try {
            return new URL(configured).origin;
        } catch {
            /* malformed env — fall through to the request origin */
        }
    }

    return req.nextUrl.origin;
}
