/**
 * WEB BOT AUTH — the outbound REQUEST signature (Phase 2).
 *
 * Pure (`node:crypto` only). Builds the three request headers of the wire
 * format recorded in
 * docs/implementation-notes/2026-11-11-web-bot-auth-decisions.md:
 *
 *   Signature-Agent: "https://<operator origin>/.well-known/http-message-signatures-directory"
 *   Signature-Input: sig1=("@method" "@authority" "@path" "signature-agent");created=<now>;
 *                    expires=<now+60>;keyid="<thumbprint>";alg="ed25519";nonce="<64 bytes>";tag="web-bot-auth"
 *
 * (Parameters in `message-signature.ts`'s fixed order, the directory's too; a
 * verifier reads them by name, so the order differs from the draft's vector
 * without changing what verifies.)
 *   Signature:       sig1=:<Ed25519>:
 *
 * ── The one caller is `bot-fetch.ts` ──
 *
 * `eslint-rules/web-bot-auth-single-seam.js` refuses any other import of this
 * module under `src/`, so every signed request goes through `botFetch`, which
 * is `safeFetch` underneath: signing can never become a way around the SSRF
 * checks.
 *
 * ── The identity is the DEPLOYMENT's (D-L1-5) ──
 *
 * Nothing here takes a context, a tenant or a session. The values signed are
 * the request's method, the vendor's authority and path, and the operator's
 * own directory URL; the nonce is random. A monitored vendor learns that
 * Inflect's crawler called, never which customer monitors it.
 */
import { randomBytes } from 'node:crypto';

import { DIRECTORY_PATH } from './directory';
import type { WebBotAuthKey } from './key';
import { sfString, signMember } from './message-signature';

/** The `tag` parameter every Web Bot Auth request signature carries. */
export const REQUEST_SIGNATURE_TAG = 'web-bot-auth';

/** `expires = created + 60` s: Cloudflare's advice, inside the draft's 24 h ceiling. */
export const REQUEST_SIGNATURE_TTL_SECONDS = 60;

/** 64 random bytes, standard base64: the length the reference library generates and accepts. */
export const REQUEST_NONCE_BYTES = 64;

/** The dictionary label of the one request signature. */
export const REQUEST_SIGNATURE_LABEL = 'sig1';

/**
 * The `Signature-Agent` form sent. The working-group draft says a signer MUST
 * send the Dictionary form (`sig1="https://…"`, covered as
 * `"signature-agent";key="sig1"`); Cloudflare's verifier, as documented on
 * 2026-11-12, refuses it and accepts only the legacy bare String. Inflect
 * sends what the deployed verifier accepts, and records the departure here.
 * Flipping it is a reviewed change, not a value: the Dictionary form needs
 * the `key` component parameter, which `message-signature.ts` does not
 * serialise today, and a conformance case of its own before it ships.
 */
export const SIGNATURE_AGENT_FORM = 'legacy-string' as const;

/** Only bodiless, side-effect-free requests are signed: the bot reads, it never writes. */
export const SIGNABLE_METHODS = ['GET', 'HEAD'] as const;
export type SignableMethod = (typeof SIGNABLE_METHODS)[number];

export interface RequestToSign {
    readonly method: SignableMethod;
    /** The absolute https URL being requested. */
    readonly url: string;
}

export interface SignRequestOptions {
    /** Seconds since the epoch. */
    readonly now: number;
    /** The operator's directory authority (host[:port]), from `APP_URL`. */
    readonly directoryAuthority: string;
    /** Fixed only by conformance records; production draws a fresh one per request. */
    readonly nonce?: string;
}

export interface SignedRequestHeaders {
    readonly 'Signature-Agent': string;
    readonly 'Signature-Input': string;
    readonly Signature: string;
}

export interface SignedRequest {
    readonly headers: SignedRequestHeaders;
    /** The exact bytes signed, for the conformance record and tests. */
    readonly base: string;
}

/** The URL the `Signature-Agent` names: the operator's key directory. */
export function signatureAgentUrl(directoryAuthority: string): string {
    return `https://${directoryAuthority}${DIRECTORY_PATH}`;
}

/** A fresh nonce: 64 random bytes, standard base64. */
export function freshNonce(): string {
    return randomBytes(REQUEST_NONCE_BYTES).toString('base64');
}

/**
 * Sign one request. Every request is signed on its own: each redirect hop,
 * each retry and the robots.txt fetch. A signature is never cached or reused
 * (the draft's "static signatures" anti-pattern).
 */
export function signRequest(request: RequestToSign, key: WebBotAuthKey, opts: SignRequestOptions): SignedRequest {
    if (!(SIGNABLE_METHODS as readonly string[]).includes(request.method)) {
        throw new Error('signRequest: only GET and HEAD requests are signed');
    }
    const url = new URL(request.url);
    if (url.protocol !== 'https:') throw new Error('signRequest: only https requests are signed');
    if (url.username || url.password) throw new Error('signRequest: a URL carrying credentials is never signed');

    const agentValue = sfString(signatureAgentUrl(opts.directoryAuthority));
    const created = Math.floor(opts.now);
    const params = {
        created,
        keyid: key.keyid,
        alg: 'ed25519' as const,
        expires: created + REQUEST_SIGNATURE_TTL_SECONDS,
        nonce: opts.nonce ?? freshNonce(),
        tag: REQUEST_SIGNATURE_TAG,
    };
    // RFC 9421 §2.2: `@authority` is the host, lower case, with the port only
    // when it is not the scheme's default (WHATWG `host` already does both);
    // `@path` is the absolute path, `/` when empty (WHATWG `pathname`).
    const derived = [
        { name: '@method', value: request.method },
        { name: '@authority', value: url.host },
        { name: '@path', value: url.pathname || '/' },
    ];
    // The legacy String form is covered as the plain field: its value is the
    // header value exactly as sent, quotes included (RFC 9421 §2.1).
    const member = signMember(
        REQUEST_SIGNATURE_LABEL,
        [...derived, { name: 'signature-agent', value: agentValue }],
        params,
        key.privateKey,
    );
    return {
        headers: {
            'Signature-Agent': agentValue,
            'Signature-Input': member.signatureInput,
            Signature: member.signature,
        },
        base: member.base,
    };
}
