/**
 * THE SCANNER'S ONLY WAY OUT — a GET-only reader, and one OAuth token exchange.
 *
 * Read-only is a property of this module's SHAPE, not of the sources' good
 * behaviour. `ReadOnlyHttp` has one verb, `getJson`, and no method parameter,
 * so a source holding it has no way to spell a write. The OAuth client
 * credentials exchange is a POST by protocol; it is the only other request a
 * source can make, it lives behind its own interface (`TokenExchange`), and it
 * changes nothing in the estate — it asks the source's identity provider for a
 * token to READ with.
 *
 * Every request is held to four rules, each of which ends the source's read
 * with the contract's reason rather than an exception the runner has to guess
 * about:
 *
 *   • ORIGIN. The URL must be https and on the origin the caller names. A
 *     server-supplied next link that points anywhere else is not followed —
 *     the request carries the estate's credential — and the read is
 *     PAGINATION_TORN. Redirects are refused for the same reason.
 *   • TIME BOX. One deadline per source, shared by every request it makes:
 *     past it, TIME_BOX.
 *   • BYTE CAP. Per response and per source. A body is read through a stream
 *     that is CANCELLED at the cap, never read whole and measured afterwards.
 *     `Content-Length` is a free early refusal, not the check.
 *   • STATUS. 401/403 is AUTH_FAILED, 429 RATE_LIMITED, anything else that is
 *     not 2xx UNREACHABLE, and a body that is not JSON PAGINATION_TORN.
 *
 * Nothing here logs. A URL can carry a cursor and a header carries the
 * credential; neither belongs in a log line, so the callers log kinds and
 * counts and nothing else.
 */
import { SourceReadError, type IncompleteReason } from './source';

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** What the reader and the token exchange share for one source: the wire, the clock, the deadline. */
export interface Transport {
    readonly fetchImpl: FetchLike;
    /** Epoch ms after which no further request is started. */
    readonly deadline: number;
    readonly now: () => number;
}

export interface ReadOnlyHttp {
    /** GET a JSON document from `url`, which must be on `origin`. */
    getJson(
        url: string,
        opts: { readonly origin: string; readonly headers: Readonly<Record<string, string>> },
    ): Promise<{ readonly body: unknown; readonly headers: Headers }>;
}

export interface TokenExchange {
    /**
     * The OAuth 2.0 client-credentials grant against `tokenUrl`, which must be on
     * `origin`. Returns the access token, or throws `SourceReadError`. The token
     * is held by the caller in memory for the length of one source read.
     */
    clientCredentials(req: {
        readonly tokenUrl: string;
        readonly origin: string;
        readonly clientId: string;
        readonly clientSecret: string;
        readonly scope: string;
    }): Promise<string>;
}

/** One response body, in bytes. A listing page is far smaller. */
export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
/** Every response one source reads, together. */
export const MAX_SOURCE_BYTES = 64 * 1024 * 1024;

/** Whether `url` parses, is https, carries no userinfo, and is on `origin`. */
export function isOnOrigin(url: string, origin: string): boolean {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return false;
    }
    return parsed.protocol === 'https:' && parsed.username === '' && parsed.password === '' && parsed.origin === origin;
}

/** An https origin with no path, query or userinfo, or null. What a source's configured URL must reduce to. */
export function httpsOrigin(url: string): string | null {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return null;
    }
    if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') return null;
    if ((parsed.pathname !== '/' && parsed.pathname !== '') || parsed.search !== '' || parsed.hash !== '') return null;
    return parsed.origin;
}

function classifyThrow(err: unknown): SourceReadError {
    if (err instanceof SourceReadError) return err;
    const name = err instanceof Error ? err.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') return new SourceReadError('TIME_BOX', 'the read ran past its time box');
    return new SourceReadError('UNREACHABLE', 'the request did not complete');
}

function reasonForStatus(status: number): IncompleteReason {
    if (status === 401 || status === 403) return 'AUTH_FAILED';
    if (status === 429) return 'RATE_LIMITED';
    return 'UNREACHABLE';
}

/** Read a body through a stream that is cancelled at `cap`; `onBytes` charges the per-source budget. */
async function readCapped(res: Response, cap: number, onBytes: (n: number) => void): Promise<string> {
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > cap) {
        await res.body?.cancel();
        throw new SourceReadError('BYTE_CAP', 'the response declared more bytes than the cap');
    }
    if (!res.body) return '';
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        try {
            onBytes(value.byteLength);
            if (total > cap) throw new SourceReadError('BYTE_CAP', 'the response exceeded the byte cap');
        } catch (err) {
            await reader.cancel();
            throw err;
        }
        chunks.push(value);
    }
    return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

function parseJson(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        throw new SourceReadError('PAGINATION_TORN', 'a page was not JSON');
    }
}

/** The per-source byte budget, shared by the reader and the token exchange. */
function budget(limit: number): (n: number) => void {
    let spent = 0;
    return (n) => {
        spent += n;
        if (spent > limit) throw new SourceReadError('BYTE_CAP', 'the source exceeded its byte budget');
    };
}

function remaining(t: Transport): number {
    const ms = t.deadline - t.now();
    if (ms <= 0) throw new SourceReadError('TIME_BOX', 'the source used its time box');
    return ms;
}

export function createSourceWire(
    t: Transport,
    caps: { readonly response?: number; readonly source?: number } = {},
): { readonly http: ReadOnlyHttp; readonly tokens: TokenExchange } {
    const responseCap = caps.response ?? MAX_RESPONSE_BYTES;
    const charge = budget(caps.source ?? MAX_SOURCE_BYTES);

    const http: ReadOnlyHttp = {
        async getJson(url, { origin, headers }) {
            if (!isOnOrigin(url, origin)) {
                throw new SourceReadError('PAGINATION_TORN', 'refused a link off the configured origin');
            }
            try {
                const res = await t.fetchImpl(url, {
                    method: 'GET',
                    headers: { Accept: 'application/json', ...headers },
                    redirect: 'error',
                    signal: AbortSignal.timeout(remaining(t)),
                });
                if (!res.ok) {
                    await res.body?.cancel();
                    throw new SourceReadError(reasonForStatus(res.status), `the source answered HTTP ${res.status}`);
                }
                return { body: parseJson(await readCapped(res, responseCap, charge)), headers: res.headers };
            } catch (err) {
                throw classifyThrow(err);
            }
        },
    };

    const tokens: TokenExchange = {
        async clientCredentials({ tokenUrl, origin, clientId, clientSecret, scope }) {
            if (!isOnOrigin(tokenUrl, origin)) {
                throw new SourceReadError('AUTH_FAILED', 'the token endpoint is not on its configured origin');
            }
            const form = new URLSearchParams({
                grant_type: 'client_credentials',
                client_id: clientId,
                client_secret: clientSecret,
                scope,
            });
            try {
                const res = await t.fetchImpl(tokenUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
                    body: form.toString(),
                    redirect: 'error',
                    signal: AbortSignal.timeout(remaining(t)),
                });
                if (!res.ok) {
                    await res.body?.cancel();
                    // Any refusal of the exchange is a credential the source could not use.
                    const reason = res.status === 429 ? 'RATE_LIMITED' : res.status >= 500 ? 'UNREACHABLE' : 'AUTH_FAILED';
                    throw new SourceReadError(reason, `the token endpoint answered HTTP ${res.status}`);
                }
                const body = parseJson(await readCapped(res, 64 * 1024, charge)) as { access_token?: unknown };
                if (typeof body.access_token !== 'string' || body.access_token === '') {
                    throw new SourceReadError('AUTH_FAILED', 'the token endpoint returned no access token');
                }
                return body.access_token;
            } catch (err) {
                throw classifyThrow(err);
            }
        },
    };

    return { http, tokens };
}

/**
 * The next-page URL from an RFC 8288 `Link` header (`<url>; rel="next"`), or
 * null. Okta pages this way. The caller still holds the URL to its origin:
 * `getJson` refuses one that leaves it.
 */
export function nextLinkFrom(link: string | null): string | null {
    if (!link) return null;
    for (const part of link.split(',')) {
        const m = /<([^>]+)>\s*;\s*rel\s*=\s*"?next"?/i.exec(part);
        if (m) return m[1];
    }
    return null;
}
