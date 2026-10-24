/**
 * Binds an SSO round trip to the browser that started it.
 *
 * The OIDC `state` and the SAML `RelayState` used to carry the whole flow —
 * tenant, provider, return path, and for OIDC the PKCE code verifier and the
 * nonce — as unsigned base64 JSON in the URL. A callback accepted whatever
 * came back. So anybody who completed a sign-in at the identity provider
 * could hand the callback URL (or, for SAML, an auto-submitting form) to
 * someone else, and that person's browser would be signed in to the
 * sender's account: login CSRF, which became exploitable the moment an SSO
 * callback produced a real session. And the code verifier rode in the same
 * URL as the code it protects, which is no PKCE at all.
 *
 * Now `/start` seals the flow into an HttpOnly cookie, signed with a key
 * derived from `AUTH_SECRET` and scoped to that protocol's callback, and
 * sends the identity provider only a random flow id. The callback refuses
 * unless the cookie is present, signed by us, unexpired, for its protocol,
 * and names the id the identity provider sent back. The flow's contents are
 * read from the cookie, never from the URL.
 *
 * `/start` also refuses to begin a flow that another site initiated
 * (`isCrossSiteStart`). Otherwise a hostile page could navigate a victim's
 * browser into a flow against an identity provider the attacker controls,
 * which answers at once for the attacker's own account: the binding would
 * then hold, because the victim's own browser started the flow.
 */
import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'crypto';
import type { NextRequest, NextResponse } from 'next/server';
import { env } from '@/env';

export type SsoProtocol = 'oidc' | 'saml';

export const SSO_FLOW_COOKIE = 'inflect_sso_flow';

/** Time allowed at the identity provider: a sign-in, perhaps with MFA. */
export const SSO_FLOW_TTL_SECONDS = 10 * 60;

interface SealedFlow {
    protocol: SsoProtocol;
    id: string;
    exp: number;
    /** The protocol's own encoding of the flow (`encodeState` / `encodeSamlRelayState`). */
    state: string;
}

function signingKey(): Buffer {
    return Buffer.from(hkdfSync('sha256', env.AUTH_SECRET, '', 'inflect-sso-flow-v1', 32));
}

function sign(body: string): string {
    return createHmac('sha256', signingKey()).update(body).digest('base64url');
}

function cookieOptions(protocol: SsoProtocol, maxAge: number) {
    return protocol === 'saml'
        ? {
              // The identity provider POSTs the SAML response from its own
              // origin, and a SameSite=Lax cookie is not sent on a
              // cross-site POST. None requires Secure.
              httpOnly: true,
              secure: true,
              sameSite: 'none' as const,
              path: '/api/auth/sso/saml/callback',
              maxAge,
          }
        : {
              // The OIDC callback is a top-level GET, which Lax admits.
              httpOnly: true,
              secure: env.NODE_ENV === 'production',
              sameSite: 'lax' as const,
              path: '/api/auth/sso/oidc/callback',
              maxAge,
          };
}

/**
 * Seal a flow for the start response. `id` goes to the identity provider as
 * OIDC `state` / SAML `RelayState`; `bind` sets the cookie on the response
 * that redirects there.
 */
export function prepareSsoFlow(
    protocol: SsoProtocol,
    state: string,
): { id: string; bind(res: NextResponse): void } {
    const id = randomBytes(24).toString('base64url');
    const flow: SealedFlow = {
        protocol,
        id,
        exp: Math.floor(Date.now() / 1000) + SSO_FLOW_TTL_SECONDS,
        state,
    };
    const body = Buffer.from(JSON.stringify(flow)).toString('base64url');
    const value = `${body}.${sign(body)}`;
    return {
        id,
        bind(res) {
            res.cookies.set(SSO_FLOW_COOKIE, value, cookieOptions(protocol, SSO_FLOW_TTL_SECONDS));
        },
    };
}

/**
 * The flow this browser started, if it is the one the identity provider
 * answered: the protocol's encoded state, or `null` for a missing, forged,
 * expired, cross-protocol or mismatched flow.
 */
export function readBoundSsoFlow(
    req: Pick<NextRequest, 'cookies'>,
    protocol: SsoProtocol,
    returnedId: string | null,
): string | null {
    const raw = req.cookies.get(SSO_FLOW_COOKIE)?.value;
    if (!raw || !returnedId) return null;
    const [body, mac, ...rest] = raw.split('.');
    if (!body || !mac || rest.length > 0) return null;

    const expected = Buffer.from(sign(body));
    const given = Buffer.from(mac);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;

    let flow: SealedFlow;
    try {
        flow = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    } catch {
        return null;
    }
    if (flow.protocol !== protocol) return null;
    if (typeof flow.exp !== 'number' || flow.exp < Math.floor(Date.now() / 1000)) return null;
    if (typeof flow.id !== 'string' || flow.id !== returnedId) return null;
    return typeof flow.state === 'string' ? flow.state : null;
}

/** Spend the flow: a callback answers once. */
export function clearSsoFlow(res: NextResponse, protocol: SsoProtocol): void {
    res.cookies.set(SSO_FLOW_COOKIE, '', cookieOptions(protocol, 0));
}

/**
 * True when another site started this sign-in.
 *
 * `Sec-Fetch-Site` is set by the browser and cannot be written by a page.
 * Our own login page sends `same-origin`; a typed or bookmarked URL sends
 * `none`. Anything else — including a browser too old to send the header —
 * is refused.
 */
export function isCrossSiteStart(req: Pick<NextRequest, 'headers'>): boolean {
    const site = req.headers.get('sec-fetch-site');
    return site !== 'same-origin' && site !== 'none';
}
