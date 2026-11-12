/**
 * Public TLS / security-header grade providers.
 *
 * The light, free external signal: fetch the vendor's homepage over HTTPS and
 * grade which security headers it serves (HSTS, CSP, X-Frame-Options, …) —
 * an SSL-Labs-style public grade at zero cost, no API key. NOT a paid
 * SecurityScorecard/BitSight rating (future connector).
 *
 * ── The vendor domain is tenant-entered, so every request is `safeFetch` ──
 *
 * Anybody who can edit a vendor can type its domain, and the daily sweep
 * requests it from inside the deployment. This provider used to fetch it
 * through `fetchWithRetry`, the plain global `fetch` with retries, so a
 * domain of `169.254.169.254`, `localhost:6379` or a public name resolving
 * into private space was requested like any other. Every request now goes
 * through `safeFetch`, which requires https, refuses private, loopback,
 * link-local and metadata addresses, resolves the name and re-checks every
 * address, and pins the connection to the addresses it checked.
 *
 * ── Redirects are followed one hop at a time, each hop checked again ──
 *
 * `safeFetch` refuses a redirect, because its other callers POST signed bodies
 * and must not send them anywhere nobody configured. A homepage is different:
 * `acme.com` answering 301 to `www.acme.com` is normal, and refusing it would
 * leave most vendors ungraded. So this provider follows the redirect itself,
 * and only by calling `safeFetch` again on the new URL. The redirect target
 * gets the same checks as the first URL. The request is a GET with no body
 * and no credential, so a public hop leaks nothing. A hop to http, or to a
 * private address, ends the grade with nothing graded, as `BLOCKED`.
 *
 * ── Every request is the deployment's bot, through `botFetch` ──
 *
 * Since Web Bot Auth Phase 2 the provider never calls `safeFetch` directly:
 * `botFetch` is `safeFetch` plus the bot's honest User-Agent and, when the
 * deployment has a key, an HTTP Message Signature (each hop and each retry
 * signed on its own). No key, no signature, and the request is the unsigned
 * one it always was.
 *
 * ── robots.txt is honoured before the homepage is requested ──
 *
 * Once per origin per grade (the start origin, and the origin of any redirect
 * target), `https://<origin>/robots.txt` is read through the same seam and
 * judged for the bot's product token (RFC 9309, `src/lib/web-bot-auth/robots.ts`).
 * A disallowed path is REFUSED with reason ROBOTS and the homepage is never
 * requested. A robots.txt that is missing or "unavailable" (a 4xx) restricts
 * nothing; one that is "unreachable" (a 5xx or a network failure) means
 * complete disallow (RFC 9309 §2.3.1.4), so nothing is requested and the
 * grade is UNREACHABLE.
 *
 * ── A fetch that does not grade says why ──
 *
 * Every signal carries an outcome (`TlsFetchOutcome`): GRADED, REFUSED,
 * UNREACHABLE or BLOCKED. The sweep keeps the last grade on anything but
 * GRADED and records the outcome, so a site that starts refusing the monitor
 * shows as a stale grade rather than an unchanged one.
 */
import { RedirectNotAllowedError, SsrfBlockedError } from '@/app-layer/automation/webhook-safety';
import { logger } from '@/lib/observability';
import { botFetch, botFetchSigns, VENDOR_MONITOR_BOT_TOKEN } from '@/lib/web-bot-auth/bot-fetch';
import { ROBOTS_MAX_BYTES, robotsAllows } from '@/lib/web-bot-auth/robots';
import { gradeSecurityHeaders } from './evaluate';
import type { TlsFetchOutcome, TlsProvider, TlsRefusalReason, TlsSignal } from './types';

/**
 * Deterministic stub — grades from the domain hash, no network. A given
 * domain always yields the same grade across runs.
 */
export class TestModeTlsProvider implements TlsProvider {
    readonly name = 'stub';

    async grade(domain: string): Promise<TlsSignal> {
        const hash = simpleHash(domain);
        // Synthesize a header set from the hash so grades span A..F stably.
        const all = ['strict-transport-security', 'content-security-policy', 'x-frame-options', 'x-content-type-options', 'referrer-policy', 'permissions-policy'];
        const present = all.filter((_, i) => ((hash >> i) & 1) === 1);
        const headers: Record<string, string> = {};
        for (const h of present) headers[h] = 'stub';
        const g = gradeSecurityHeaders(headers);
        return {
            source: this.name,
            outcome: 'GRADED',
            grade: g.grade,
            checkedAt: new Date(0).toISOString(),
            presentHeaders: g.presentHeaders,
            missingHeaders: g.missingHeaders,
        };
    }
}

/** The bounds of one grade. Exported so the tests assert against them. */
export const HOMEPAGE_FETCH_LIMITS = {
    /** One request, DNS check included. */
    requestTimeoutMs: 8_000,
    /** The whole grade: every hop and every retry. */
    deadlineMs: 20_000,
    /** Redirects followed before giving up. */
    maxRedirects: 5,
    /** Attempts per URL; only a network failure, 429 or 5xx is retried. */
    maxAttempts: 2,
} as const;

/**
 * The homepage URL for a vendor domain, or null when the value is not a bare
 * host name. A credential, a port, a path, a query or a fragment is refused
 * rather than passed on: the field asks for a domain, and each of those turns
 * the monitor into a request the tenant shapes.
 */
export function vendorHomepageUrl(domain: string): string | null {
    const host = domain.trim().toLowerCase();
    if (!host || /[\s/\\?#@:%]/.test(host)) return null;
    let url: URL;
    try {
        url = new URL(`https://${host}/`);
    } catch {
        return null;
    }
    if (url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash) {
        return null;
    }
    return url.href;
}

/**
 * A recognised bot-challenge response, read from the headers alone (the body
 * is never read). Each entry is a header the vendor documents as marking a
 * challenge, whatever status it rides on: Cloudflare sends a challenge as a
 * 403 or 503 with `cf-mitigated: challenge`, and AWS WAF answers a challenge
 * with a 202 and a CAPTCHA with a 405, each with `x-amzn-waf-action`. A 202
 * challenge page would otherwise be graded as the vendor's homepage, and a
 * 503 one retried and reported as an outage.
 */
export function recognisedChallenge(headers: Headers): string | null {
    if (headers.get('cf-mitigated')?.trim().toLowerCase() === 'challenge') return 'cloudflare';
    const waf = headers.get('x-amzn-waf-action')?.trim().toLowerCase();
    if (waf === 'challenge' || waf === 'captcha') return 'aws-waf';
    return null;
}

/** A fetch that ended without a page to grade. */
interface Ungraded {
    outcome: Exclude<TlsFetchOutcome, 'GRADED'>;
    /** For the log line only: an HTTP status, a challenge vendor, a cause. */
    detail: string;
    /** Why a REFUSED fetch was refused, when the reason is the site's stated policy. */
    reason?: TlsRefusalReason;
}

type HomepageRead = { headers: Record<string, string> } | Ungraded;
type AttemptResult = { res: Response } | Ungraded;

/** Real provider — GET the homepage through the SSRF guard, grade its headers. */
export class HeaderGradeTlsProvider implements TlsProvider {
    readonly name = 'header-grade';

    constructor(private readonly opts: { retryDelayMs?: number } = {}) {}

    async grade(domain: string): Promise<TlsSignal> {
        const now = new Date().toISOString();
        // A fetch that does not grade is never a failing grade: we don't
        // punish a vendor for a refusal or an outage. It is reported as what
        // it was, so the sweep can mark the last grade stale.
        const ungraded = (u: Ungraded): TlsSignal => {
            logger.info('Vendor monitor could not grade a homepage', {
                component: 'vendor-monitoring',
                outcome: u.outcome,
                detail: u.detail,
            });
            return {
                source: this.name,
                outcome: u.outcome,
                ...(u.reason ? { refusalReason: u.reason } : {}),
                signed: botFetchSigns(),
                grade: null,
                checkedAt: now,
                presentHeaders: [],
                missingHeaders: [],
            };
        };

        const start = vendorHomepageUrl(domain);
        if (!start) {
            logger.warn('Vendor monitor skipped a domain that is not a bare host name', { component: 'vendor-monitoring' });
            return ungraded({ outcome: 'BLOCKED', detail: 'not a bare host name' });
        }
        let read: HomepageRead;
        try {
            read = await this.fetchHomepageHeaders(start);
        } catch (err) {
            if (err instanceof SsrfBlockedError) {
                // The reason names the cause: a private address, a hop to
                // http, or a name that did not resolve. Only the last is not
                // the guard's decision about the destination.
                logger.warn('Vendor monitor did not request a URL the SSRF guard refused', {
                    component: 'vendor-monitoring',
                    reason: err.message,
                });
                return ungraded(
                    err.kind === 'UNRESOLVED'
                        ? { outcome: 'UNREACHABLE', detail: 'name did not resolve' }
                        : { outcome: 'BLOCKED', detail: 'ssrf guard refused' },
                );
            }
            return ungraded({ outcome: 'UNREACHABLE', detail: 'unexpected error' });
        }
        if (!('headers' in read)) return ungraded(read);
        const g = gradeSecurityHeaders(read.headers);
        return {
            source: this.name,
            outcome: 'GRADED',
            signed: botFetchSigns(),
            grade: g.grade,
            checkedAt: now,
            presentHeaders: g.presentHeaders,
            missingHeaders: g.missingHeaders,
        };
    }

    /**
     * The headers of the first 2xx answer, following redirects one checked hop
     * at a time, or what stopped the read. Throws `SsrfBlockedError` when the
     * start URL or any hop is refused.
     */
    private async fetchHomepageHeaders(startUrl: string): Promise<HomepageRead> {
        const deadline = Date.now() + HOMEPAGE_FETCH_LIMITS.deadlineMs;
        const robotsRead = new Set<string>();
        let url = startUrl;
        for (let hop = 0; hop <= HOMEPAGE_FETCH_LIMITS.maxRedirects; hop++) {
            const target = new URL(url);
            if (!robotsRead.has(target.origin)) {
                robotsRead.add(target.origin);
                const refusal = await this.robotsRefusal(target, deadline);
                if (refusal) return refusal;
            }
            let attempt: AttemptResult;
            try {
                attempt = await this.getWithRetry(url, deadline);
            } catch (err) {
                if (!(err instanceof RedirectNotAllowedError)) throw err;
                if (!err.location) return { outcome: 'UNREACHABLE', detail: `${err.status} redirect without a location` };
                // Resolved against the URL that answered, then checked like
                // the first one by the next `safeFetch`.
                url = new URL(err.location, url).href;
                continue;
            }
            if (!('res' in attempt)) return attempt;
            const headers: Record<string, string> = {};
            attempt.res.headers.forEach((v, k) => { headers[k] = v; });
            await discardBody(attempt.res);
            return { headers };
        }
        return { outcome: 'UNREACHABLE', detail: 'redirect limit reached' };
    }

    /**
     * What the origin's robots.txt says about requesting `target`, or null when
     * it may be requested. One request (plus redirect hops), never retried: a
     * robots.txt that cannot be read today is read again tomorrow. Throws
     * `SsrfBlockedError` when the robots URL or a hop is refused.
     */
    private async robotsRefusal(target: URL, deadline: number): Promise<Ungraded | null> {
        let robotsUrl = `${target.origin}/robots.txt`;
        for (let hop = 0; hop <= HOMEPAGE_FETCH_LIMITS.maxRedirects; hop++) {
            const remaining = deadline - Date.now();
            if (remaining <= 0) return { outcome: 'UNREACHABLE', detail: 'deadline reached before robots.txt' };
            let res: Response;
            try {
                res = await botFetch(robotsUrl, {
                    signal: AbortSignal.timeout(Math.min(HOMEPAGE_FETCH_LIMITS.requestTimeoutMs, remaining)),
                });
            } catch (err) {
                if (err instanceof SsrfBlockedError) throw err;
                if (err instanceof RedirectNotAllowedError) {
                    // RFC 9309 §2.3.1.2: a redirect without a target leaves
                    // robots.txt "unavailable", which restricts nothing.
                    if (!err.location) return null;
                    robotsUrl = new URL(err.location, robotsUrl).href;
                    continue;
                }
                // §2.3.1.4: unreachable means complete disallow.
                return { outcome: 'UNREACHABLE', detail: 'robots.txt network failure or timeout' };
            }
            const challenge = recognisedChallenge(res.headers);
            if (challenge) {
                await discardBody(res);
                return { outcome: 'REFUSED', detail: `robots.txt ${res.status} ${challenge} challenge` };
            }
            if (res.ok) {
                const text = await readTextCapped(res, ROBOTS_MAX_BYTES);
                const path = `${target.pathname}${target.search}`;
                return robotsAllows(text, VENDOR_MONITOR_BOT_TOKEN, path)
                    ? null
                    : { outcome: 'REFUSED', detail: 'robots.txt disallows the monitor', reason: 'ROBOTS' };
            }
            await discardBody(res);
            if (res.status === 429) return { outcome: 'REFUSED', detail: 'robots.txt 429' };
            if (res.status >= 500) return { outcome: 'UNREACHABLE', detail: `robots.txt ${res.status}` };
            // §2.3.1.3: any other 4xx is "unavailable" and restricts nothing.
            return null;
        }
        // §2.3.1.2: past the redirect limit robots.txt MAY be treated as unavailable.
        return null;
    }

    /**
     * One URL, up to `maxAttempts` tries inside the deadline. Returns the 2xx
     * response, or what the last try came to. A redirect and a refused address
     * propagate as `safeFetch` throws them; neither is retried. Only a network
     * failure, a 429 and a 5xx are retried; a challenge never is.
     */
    private async getWithRetry(url: string, deadline: number): Promise<AttemptResult> {
        const retryDelayMs = this.opts.retryDelayMs ?? 1_000;
        let last: Ungraded = { outcome: 'UNREACHABLE', detail: 'deadline reached' };
        for (let attempt = 1; attempt <= HOMEPAGE_FETCH_LIMITS.maxAttempts; attempt++) {
            const remaining = deadline - Date.now();
            if (remaining <= 0) return last;
            let res: Response;
            try {
                res = await botFetch(url, {
                    signal: AbortSignal.timeout(Math.min(HOMEPAGE_FETCH_LIMITS.requestTimeoutMs, remaining)),
                });
            } catch (err) {
                if (err instanceof SsrfBlockedError || err instanceof RedirectNotAllowedError) throw err;
                // Network failure or timeout: retry while time and attempts remain.
                last = { outcome: 'UNREACHABLE', detail: 'network failure or timeout' };
                if (attempt < HOMEPAGE_FETCH_LIMITS.maxAttempts) await sleep(retryDelayMs);
                continue;
            }
            // Before `ok`: a challenge can ride on a 2xx, and must never be
            // graded as the homepage or retried as an outage.
            const challenge = recognisedChallenge(res.headers);
            if (challenge) {
                await discardBody(res);
                return { outcome: 'REFUSED', detail: `${res.status} ${challenge} challenge` };
            }
            if (res.ok) return { res };
            await discardBody(res);
            if (res.status !== 429 && res.status < 500) return { outcome: 'REFUSED', detail: String(res.status) };
            last = { outcome: res.status === 429 ? 'REFUSED' : 'UNREACHABLE', detail: String(res.status) };
            if (attempt < HOMEPAGE_FETCH_LIMITS.maxAttempts) await sleep(retryDelayMs);
        }
        return last;
    }
}

export function getTlsProvider(providerName?: string): TlsProvider {
    if (providerName === 'header-grade') return new HeaderGradeTlsProvider();
    return new TestModeTlsProvider();
}

/** Only the headers are graded; the body is never read, so release it. */
async function discardBody(res: Response): Promise<void> {
    try {
        await res.body?.cancel();
    } catch {
        // Already consumed or closed: nothing to release.
    }
}

/**
 * The body as text, reading at most `maxBytes` and cancelling the stream
 * there: a robots.txt larger than RFC 9309's floor is judged on its first
 * 500 KiB, and nothing larger is ever buffered.
 */
async function readTextCapped(res: Response, maxBytes: number): Promise<string> {
    if (!res.body) return '';
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
        while (total < maxBytes) {
            const { done, value } = await reader.read();
            if (done) break;
            const take = value.subarray(0, maxBytes - total);
            chunks.push(take);
            total += take.length;
        }
    } catch {
        // A body cut off mid-read is judged on what arrived.
    } finally {
        try {
            await reader.cancel();
        } catch {
            // Already closed.
        }
    }
    const all = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) {
        all.set(c, at);
        at += c.length;
    }
    return new TextDecoder('utf-8', { fatal: false }).decode(all);
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function simpleHash(s: string): number {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    return Math.abs(h);
}
