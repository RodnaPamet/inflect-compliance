import type { NextRequest } from 'next/server';

import { env } from '@/env';
import { logger } from '@/lib/observability';

/**
 * The origin this deployment is reachable at from OUTSIDE, for URLs we hand to
 * someone else.
 *
 * WHY THIS EXISTS. Routes used to build these from the request:
 *
 *     const baseUrl = `${req.nextUrl.protocol}//${req.nextUrl.host}`;
 *
 * Behind a reverse proxy that is the app's own bind address, not the public
 * host. In this deployment (Caddy in front of Next) the admin Integrations page
 * rendered its webhook endpoint as
 * `https://0.0.0.0:3000/api/integrations/webhooks/{provider}` while `APP_URL`
 * was set correctly to the real host. An operator copying that into a
 * provider's webhook configuration gets an address that resolves to nothing,
 * and the integration fails silently — the provider has no one to tell.
 *
 * The same defect reached every SCIM `location` URL, which identity providers
 * STORE and call back against, so a bad value there breaks provisioning for as
 * long as the IdP keeps the stale resource URL.
 *
 * WHAT IT DOES. `APP_URL` is authoritative when set: it is the operator's
 * statement of where this deployment actually lives, and it is the only source
 * a proxy cannot distort. The request origin is a development fallback only.
 *
 * WHY NOT TRUST `X-Forwarded-Host`. It would work behind a correctly
 * configured proxy, but it is attacker-controlled on any request that reaches
 * the app directly, and these strings are handed to operators to paste into
 * third-party systems and returned to IdPs as canonical resource locations.
 * A spoofed host there is a redirect/phishing primitive with a long tail. The
 * configured value has no such failure mode.
 */
export function publicBaseUrl(req: Pick<NextRequest, 'nextUrl'>): string {
    const configured = env.APP_URL?.trim();
    if (configured) {
        // Trailing slashes would double up against the paths callers append.
        return configured.replace(/\/+$/, '');
    }

    if (env.NODE_ENV === 'production') {
        // Not fatal — refusing to serve the page would be a worse failure than
        // showing a host the operator can recognise as wrong. But it is never
        // correct in production, so it should be findable in the logs rather
        // than only in a support ticket about a webhook that never fired.
        logger.warn(
            'APP_URL is unset in production; falling back to the request origin ' +
                'for an externally-published URL. Behind a proxy this yields the ' +
                "app's internal bind address, which is not reachable.",
            { origin: req.nextUrl.origin },
        );
    }

    return req.nextUrl.origin;
}
