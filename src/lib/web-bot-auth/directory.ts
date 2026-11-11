/**
 * WEB BOT AUTH — the HTTP Message Signatures key directory (Phase 1).
 *
 * Pure. Builds the JWKS body and the response signatures for
 * `GET /.well-known/http-message-signatures-directory`; the route
 * (`src/app/.well-known/http-message-signatures-directory/route.ts`) only
 * reads the configuration and hands it here.
 *
 * Wire format, as recorded in docs/implementation-notes/2026-11-11-web-bot-auth-key-directory.md:
 *   - body: a JSON Web Key Set, `{"keys":[…]}`, each key an Ed25519 OKP JWK;
 *   - media type `application/http-message-signatures-directory+json`;
 *   - one signature PER published key, each covering `"@authority";req` with
 *     `tag="http-message-signatures-directory"`, so a verifier that fetched the
 *     directory from an authority can tell the key holder publishes there.
 *
 * The authority signed is the CONFIGURED one (`APP_URL`), never the request's
 * `Host`: reflecting the Host header would hand anybody who can reach the app
 * under another name a signature binding our keys to that name.
 */
import type { WebBotAuthKey } from './key';
import { joinMembers, signMember, type SignedMember } from './message-signature';

export const DIRECTORY_PATH = '/.well-known/http-message-signatures-directory';
export const DIRECTORY_MEDIA_TYPE = 'application/http-message-signatures-directory+json';
export const DIRECTORY_SIGNATURE_TAG = 'http-message-signatures-directory';

/**
 * How long a directory signature is valid, and how long a cache may keep the
 * response. The cache lifetime MUST be shorter than the signature's, or a
 * cached copy is served with a signature that has already expired.
 */
export const DIRECTORY_SIGNATURE_TTL_SECONDS = 3600;
export const DIRECTORY_CACHE_MAX_AGE_SECONDS = 300;

/** The directory's keys, current first. The previous key is published only during a rotation's grace. */
export interface DirectoryKeys {
    readonly current: WebBotAuthKey;
    readonly previous?: WebBotAuthKey;
}

/**
 * The authority (RFC 9421 §2.2.3: host, plus port only when not the scheme's
 * default, lower case) of a bare https origin; `null` for anything else — a
 * path, a query, credentials, plain http. Absent ⇒ no directory is served.
 */
export function directoryAuthorityFrom(origin: string | undefined | null): string | null {
    if (!origin) return null;
    let url: URL;
    try {
        url = new URL(origin.trim());
    } catch {
        return null;
    }
    if (url.protocol !== 'https:') return null;
    if (url.username || url.password || url.search || url.hash) return null;
    if (url.pathname !== '/' && url.pathname !== '') return null;
    // WHATWG URL already lower-cases the host and drops the default port 443.
    return url.host;
}

function publishedKeys(keys: DirectoryKeys): WebBotAuthKey[] {
    const out = [keys.current];
    if (keys.previous && keys.previous.keyid !== keys.current.keyid) out.push(keys.previous);
    return out;
}

/** The JWKS body: required members only, current key first. */
export function directoryBody(keys: DirectoryKeys): string {
    return JSON.stringify({
        keys: publishedKeys(keys).map((k) => ({ kty: k.publicJwk.kty, crv: k.publicJwk.crv, x: k.publicJwk.x })),
    });
}

export interface SignedDirectory {
    readonly body: string;
    readonly headers: {
        readonly 'Content-Type': string;
        readonly 'Cache-Control': string;
        readonly 'Signature-Input': string;
        readonly Signature: string;
    };
    /** Per-key members, for conformance records and tests. */
    readonly members: readonly SignedMember[];
}

/** Sign the directory response for `authority` at `now` (seconds since the epoch). */
export function signedDirectoryResponse(
    keys: DirectoryKeys,
    authority: string,
    now: number,
): SignedDirectory {
    const created = Math.floor(now);
    const members = publishedKeys(keys).map((key, i) =>
        signMember(
            `binding${i}`,
            [{ name: '@authority', req: true, value: authority }],
            {
                created,
                expires: created + DIRECTORY_SIGNATURE_TTL_SECONDS,
                keyid: key.keyid,
                alg: 'ed25519',
                tag: DIRECTORY_SIGNATURE_TAG,
            },
            key.privateKey,
        ),
    );
    const joined = joinMembers(members);
    return {
        body: directoryBody(keys),
        headers: {
            'Content-Type': DIRECTORY_MEDIA_TYPE,
            'Cache-Control': `public, max-age=${DIRECTORY_CACHE_MAX_AGE_SECONDS}`,
            'Signature-Input': joined.signatureInput,
            Signature: joined.signature,
        },
        members,
    };
}
