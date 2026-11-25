/**
 * Binds a calendar-connect round trip to the browser, the person and the PKCE
 * verifier that started it.
 *
 * ═══ WHAT THIS REPLACES ═══
 *
 * The connect route used to set `cal_oauth_state` = `<uuid>.<tenantSlug>.<provider>`
 * in a plain cookie scoped to `/`, and send no PKCE parameters at all. The
 * callback compared the UUID and trusted the rest. Two gaps:
 *
 *   - NO PKCE. An authorization code intercepted on the way back (a referrer,
 *     a proxy log, a browser extension) could be exchanged by anyone holding
 *     the client secret's deployment, with nothing tying it to this flow.
 *   - UNSIGNED. The tenant and provider were read from a cookie the server had
 *     not signed, so their integrity rested on the cookie jar alone.
 *
 * ═══ THE PATTERN, FROM `src/lib/auth/sso-flow.ts` ═══
 *
 * The SSO start route solved the same problem for OIDC and SAML, and this is
 * its shape: the flow is sealed into an HttpOnly cookie signed with a key
 * derived from `AUTH_SECRET`, scoped to the ONE callback path, and the provider
 * is sent only a random id as `state`. The callback refuses unless the cookie
 * is present, signed by us, unexpired, and names the id the provider returned.
 * The verifier is read from the cookie, never from the URL — a verifier beside
 * its code is no PKCE at all.
 *
 * It is a sibling module rather than a call into `sso-flow.ts` because that
 * module's protocol union, cookie name and cookie paths are the SSO callback's
 * own, and widening them to carry a calendar flow would make a change to SSO
 * sign-in a change to calendar connect and the reverse. The HKDF `info` label
 * differs, so a sealed SSO flow can never verify as a calendar flow.
 *
 * ═══ WHY THE PERSON IS IN THE FLOW ═══
 *
 * The callback stores the token under `ctx.userId` from the SESSION. Without
 * the starter's id in the sealed flow, a browser that changed session between
 * connect and callback (sign out, sign in as somebody else — a shared kiosk)
 * would file the first person's calendar under the second person. The flow
 * names who started it, and the callback refuses anybody else.
 *
 * @module integrations/providers/calendar/oauth-flow
 */
import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'crypto';
import type { NextRequest, NextResponse } from 'next/server';
import { env } from '@/env';
import { createPkcePair, isPkceVerifier } from './token';
import type { CalendarProvider } from './token';

export const CALENDAR_FLOW_COOKIE = 'inflect_cal_flow';

/** The cookie the pre-PKCE connect route set. Cleared on every callback. */
export const LEGACY_CALENDAR_STATE_COOKIE = 'cal_oauth_state';

/** The only path the flow cookie is sent to. */
export const CALENDAR_CALLBACK_PATH = '/api/integrations/calendar/callback';

/** Time allowed at the provider: a sign-in, perhaps with MFA. */
export const CALENDAR_FLOW_TTL_SECONDS = 10 * 60;

/**
 * A path segment we are willing to put in a redirect. Wider than the slug
 * schemas (lowercase words and hyphens) so no existing workspace is refused,
 * narrow enough that nothing in it can change the redirect's path.
 */
const SLUG_SHAPE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

const PROVIDERS: readonly CalendarProvider[] = ['google-calendar', 'outlook-calendar'];

export interface CalendarOAuthFlow {
    id: string;
    tenantSlug: string;
    provider: CalendarProvider;
    /** The member who started the flow; the callback refuses anybody else. */
    userId: string;
    codeVerifier: string;
    exp: number;
}

export type CalendarFlowRefusal =
    | 'ABSENT'
    | 'FORGED'
    | 'MALFORMED'
    | 'EXPIRED'
    | 'STATE_MISMATCH'
    | 'VERIFIER_INVALID';

export type CalendarFlowRead =
    | { ok: true; flow: CalendarOAuthFlow }
    /**
     * `tenantSlug` is set only when the cookie was signed by us, so a refusal
     * may send the person back to their own workspace; an unsigned cookie's
     * slug is never trusted, even for a redirect.
     */
    | { ok: false; reason: CalendarFlowRefusal; tenantSlug: string | null };

function signingKey(): Buffer {
    return Buffer.from(hkdfSync('sha256', env.AUTH_SECRET, '', 'inflect-calendar-oauth-flow-v1', 32));
}

function sign(body: string): string {
    return createHmac('sha256', signingKey()).update(body).digest('base64url');
}

function cookieOptions(maxAge: number) {
    return {
        // The provider's redirect back is a top-level GET, which Lax admits.
        httpOnly: true,
        secure: env.NODE_ENV === 'production',
        sameSite: 'lax' as const,
        path: CALENDAR_CALLBACK_PATH,
        maxAge,
    };
}

/**
 * Start a flow. `state` and `codeChallenge` go on the authorize URL; `bind`
 * sets the sealed cookie on the response that hands that URL to the browser.
 */
export function prepareCalendarOAuthFlow(input: {
    tenantSlug: string;
    provider: CalendarProvider;
    userId: string;
}, now: () => number = Date.now): { state: string; codeChallenge: string; bind(res: NextResponse): void } {
    if (!SLUG_SHAPE.test(input.tenantSlug)) throw new Error('calendar flow: invalid tenant slug');
    const { codeVerifier, codeChallenge } = createPkcePair();
    const flow: CalendarOAuthFlow = {
        id: randomBytes(24).toString('base64url'),
        tenantSlug: input.tenantSlug,
        provider: input.provider,
        userId: input.userId,
        codeVerifier,
        exp: Math.floor(now() / 1000) + CALENDAR_FLOW_TTL_SECONDS,
    };
    const body = Buffer.from(JSON.stringify(flow)).toString('base64url');
    const value = `${body}.${sign(body)}`;
    return {
        state: flow.id,
        codeChallenge,
        bind(res) {
            res.cookies.set(CALENDAR_FLOW_COOKIE, value, cookieOptions(CALENDAR_FLOW_TTL_SECONDS));
        },
    };
}

/**
 * The flow this browser started, if it is the one the provider answered.
 *
 * Order matters: the signature is checked before anything in the body is
 * believed, including the slug a refusal redirects to.
 */
export function readCalendarOAuthFlow(
    req: Pick<NextRequest, 'cookies'>,
    returnedState: string | null,
    now: () => number = Date.now,
): CalendarFlowRead {
    const raw = req.cookies.get(CALENDAR_FLOW_COOKIE)?.value;
    if (!raw) return { ok: false, reason: 'ABSENT', tenantSlug: null };

    const [body, mac, ...rest] = raw.split('.');
    if (!body || !mac || rest.length > 0) return { ok: false, reason: 'MALFORMED', tenantSlug: null };

    const expected = Buffer.from(sign(body));
    const given = Buffer.from(mac);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
        return { ok: false, reason: 'FORGED', tenantSlug: null };
    }

    let parsed: Partial<CalendarOAuthFlow>;
    try {
        parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    } catch {
        return { ok: false, reason: 'MALFORMED', tenantSlug: null };
    }
    const slug = typeof parsed.tenantSlug === 'string' && SLUG_SHAPE.test(parsed.tenantSlug)
        ? parsed.tenantSlug
        : null;
    if (
        !slug ||
        typeof parsed.id !== 'string' ||
        typeof parsed.userId !== 'string' ||
        !parsed.userId ||
        typeof parsed.exp !== 'number' ||
        !PROVIDERS.includes(parsed.provider as CalendarProvider)
    ) {
        return { ok: false, reason: 'MALFORMED', tenantSlug: slug };
    }
    if (parsed.exp < Math.floor(now() / 1000)) return { ok: false, reason: 'EXPIRED', tenantSlug: slug };

    const idOk =
        typeof returnedState === 'string' &&
        returnedState.length === parsed.id.length &&
        timingSafeEqual(Buffer.from(returnedState), Buffer.from(parsed.id));
    if (!idOk) return { ok: false, reason: 'STATE_MISMATCH', tenantSlug: slug };

    if (!isPkceVerifier(parsed.codeVerifier)) return { ok: false, reason: 'VERIFIER_INVALID', tenantSlug: slug };

    return { ok: true, flow: parsed as CalendarOAuthFlow };
}

/** Spend the flow: a callback answers once, whatever it answers. */
export function clearCalendarOAuthFlow(res: NextResponse): void {
    res.cookies.set(CALENDAR_FLOW_COOKIE, '', cookieOptions(0));
    // A flow started before this module existed: its cookie was scoped to `/`.
    // A bare `cookies.delete(name)` names no path, so the browser would scope
    // the expiry to this callback's directory and keep the one at `/`.
    res.cookies.set(LEGACY_CALENDAR_STATE_COOKIE, '', { path: '/', maxAge: 0 });
}
