/**
 * Binds a Microsoft admin-consent round trip to the browser, the workspace and
 * the administrator who started it.
 *
 * ═══ WHAT THIS REPLACES ═══
 *
 * The consent route used to set `cal_admin_state` = `<uuid>.<tenantSlug>` in a
 * plain cookie scoped to `/`, and the callback compared the UUID and trusted
 * the slug. The slug's integrity rested on the cookie jar alone, the cookie was
 * sent with every request to the app for ten minutes, and nothing tied the
 * callback to the administrator who had started it: whoever was signed in when
 * Entra answered was recorded as the grant's author.
 *
 * ═══ THE PATTERN, FROM `oauth-flow.ts` (AND `sso-flow.ts` BEFORE IT) ═══
 *
 * The flow is sealed into an HttpOnly cookie signed with a key derived from
 * `AUTH_SECRET`, scoped to the ONE callback path, and Entra is sent only a
 * random id as `state`. The callback refuses unless the cookie is present,
 * signed by us, unexpired, and names the id Entra returned.
 *
 * Its own module, cookie, path and HKDF label — not a mode of the personal
 * connect flow. The two callbacks answer different authorities (one person's
 * calendar; a grant for the whole organisation), and a flow sealed for one
 * must never verify at the other. The label also differs from SSO's.
 *
 * There is no PKCE here: `/adminconsent` returns no authorization code, so
 * there is nothing for a verifier to protect.
 *
 * @module integrations/providers/calendar/admin-consent-flow
 */
import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'crypto';
import type { NextRequest, NextResponse } from 'next/server';
import { env } from '@/env';

export const CALENDAR_ADMIN_FLOW_COOKIE = 'inflect_cal_admin_flow';

/** The cookie the pre-#5937-step-3 consent route set, scoped to `/`. Cleared on every callback. */
export const LEGACY_CALENDAR_ADMIN_STATE_COOKIE = 'cal_admin_state';

/** The only path the flow cookie is sent to: where Entra returns. */
export const CALENDAR_ADMIN_CALLBACK_PATH = '/api/integrations/calendar/admin-callback';

/** Time allowed at Entra: an administrator's sign-in, perhaps with MFA. */
export const CALENDAR_ADMIN_FLOW_TTL_SECONDS = 10 * 60;

/** The HKDF label. Distinct from the personal connect flow's and SSO's. */
const FLOW_KEY_LABEL = 'inflect-calendar-admin-consent-flow-v1';

/** As `oauth-flow.ts`: nothing in an accepted slug can change a redirect's path. */
const SLUG_SHAPE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export interface CalendarAdminConsentFlow {
    id: string;
    tenantSlug: string;
    /** The administrator who started the flow; the callback refuses anybody else. */
    userId: string;
    exp: number;
}

export type CalendarAdminFlowRefusal = 'ABSENT' | 'FORGED' | 'MALFORMED' | 'EXPIRED' | 'STATE_MISMATCH';

export type CalendarAdminFlowRead =
    | { ok: true; flow: CalendarAdminConsentFlow }
    /**
     * `tenantSlug` is set only when the cookie was signed by us, so a refusal
     * may send the administrator back to their own workspace; an unsigned
     * cookie's slug is never trusted, even for a redirect.
     */
    | { ok: false; reason: CalendarAdminFlowRefusal; tenantSlug: string | null };

function signingKey(): Buffer {
    return Buffer.from(hkdfSync('sha256', env.AUTH_SECRET, '', FLOW_KEY_LABEL, 32));
}

function sign(body: string): string {
    return createHmac('sha256', signingKey()).update(body).digest('base64url');
}

function cookieOptions(maxAge: number) {
    return {
        // Entra's redirect back is a top-level GET, which Lax admits.
        httpOnly: true,
        secure: env.NODE_ENV === 'production',
        sameSite: 'lax' as const,
        path: CALENDAR_ADMIN_CALLBACK_PATH,
        maxAge,
    };
}

/**
 * Start a flow. `state` goes on the `/adminconsent` URL; `bind` sets the
 * sealed cookie on the response that hands that URL to the browser.
 */
export function prepareCalendarAdminConsentFlow(
    input: { tenantSlug: string; userId: string },
    now: () => number = Date.now,
): { state: string; bind(res: NextResponse): void } {
    if (!SLUG_SHAPE.test(input.tenantSlug)) throw new Error('calendar admin consent flow: invalid tenant slug');
    if (!input.userId) throw new Error('calendar admin consent flow: no administrator');
    const flow: CalendarAdminConsentFlow = {
        id: randomBytes(24).toString('base64url'),
        tenantSlug: input.tenantSlug,
        userId: input.userId,
        exp: Math.floor(now() / 1000) + CALENDAR_ADMIN_FLOW_TTL_SECONDS,
    };
    const body = Buffer.from(JSON.stringify(flow)).toString('base64url');
    const value = `${body}.${sign(body)}`;
    return {
        state: flow.id,
        bind(res) {
            res.cookies.set(CALENDAR_ADMIN_FLOW_COOKIE, value, cookieOptions(CALENDAR_ADMIN_FLOW_TTL_SECONDS));
            // A flow started on the previous build left this behind, at `/`.
            clearLegacyStateCookie(res);
        },
    };
}

/**
 * The flow this browser started, if it is the one Entra answered.
 *
 * The signature is checked before anything in the body is believed, including
 * the slug a refusal redirects to.
 */
export function readCalendarAdminConsentFlow(
    req: Pick<NextRequest, 'cookies'>,
    returnedState: string | null,
    now: () => number = Date.now,
): CalendarAdminFlowRead {
    const raw = req.cookies.get(CALENDAR_ADMIN_FLOW_COOKIE)?.value;
    if (!raw) return { ok: false, reason: 'ABSENT', tenantSlug: null };

    const [body, mac, ...rest] = raw.split('.');
    if (!body || !mac || rest.length > 0) return { ok: false, reason: 'MALFORMED', tenantSlug: null };

    const expected = Buffer.from(sign(body));
    const given = Buffer.from(mac);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
        return { ok: false, reason: 'FORGED', tenantSlug: null };
    }

    let parsed: Partial<CalendarAdminConsentFlow>;
    try {
        parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    } catch {
        return { ok: false, reason: 'MALFORMED', tenantSlug: null };
    }
    const slug =
        typeof parsed.tenantSlug === 'string' && SLUG_SHAPE.test(parsed.tenantSlug) ? parsed.tenantSlug : null;
    if (
        !slug ||
        typeof parsed.id !== 'string' ||
        !parsed.id ||
        typeof parsed.userId !== 'string' ||
        !parsed.userId ||
        typeof parsed.exp !== 'number'
    ) {
        return { ok: false, reason: 'MALFORMED', tenantSlug: slug };
    }
    if (parsed.exp < Math.floor(now() / 1000)) return { ok: false, reason: 'EXPIRED', tenantSlug: slug };

    const idOk =
        typeof returnedState === 'string' &&
        returnedState.length === parsed.id.length &&
        timingSafeEqual(Buffer.from(returnedState), Buffer.from(parsed.id));
    if (!idOk) return { ok: false, reason: 'STATE_MISMATCH', tenantSlug: slug };

    return {
        ok: true,
        flow: { id: parsed.id, tenantSlug: slug, userId: parsed.userId, exp: parsed.exp },
    };
}

/** Spend the flow: the callback answers once, whatever it answers. */
export function clearCalendarAdminConsentFlow(res: NextResponse): void {
    res.cookies.set(CALENDAR_ADMIN_FLOW_COOKIE, '', cookieOptions(0));
    clearLegacyStateCookie(res);
}

/**
 * The legacy cookie lived at `/`. A bare `cookies.delete(name)` names no path,
 * so the browser would scope the expiry to the responding route's directory
 * and keep the cookie at `/`; the path is stated.
 */
function clearLegacyStateCookie(res: NextResponse): void {
    res.cookies.set(LEGACY_CALENDAR_ADMIN_STATE_COOKIE, '', { path: '/', maxAge: 0 });
}
