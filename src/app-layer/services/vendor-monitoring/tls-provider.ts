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
 * private address, ends the grade with nothing graded.
 */
import {
    RedirectNotAllowedError,
    SsrfBlockedError,
    safeFetch,
} from '@/app-layer/automation/webhook-safety';
import { logger } from '@/lib/observability';
import { gradeSecurityHeaders } from './evaluate';
import type { TlsProvider, TlsSignal } from './types';

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
            grade: g.grade,
            checkedAt: new Date(0).toISOString(),
            presentHeaders: g.presentHeaders,
            missingHeaders: g.missingHeaders,
        };
    }
}

const USER_AGENT = 'InflectCompliance-VendorMonitor/1.0';

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

/** Real provider — GET the homepage through the SSRF guard, grade its headers. */
export class HeaderGradeTlsProvider implements TlsProvider {
    readonly name = 'header-grade';

    constructor(private readonly opts: { retryDelayMs?: number } = {}) {}

    async grade(domain: string): Promise<TlsSignal> {
        const now = new Date().toISOString();
        // Unreachable, refused or invalid → ungraded (null), not a failing
        // grade: we don't punish a vendor for a transient network error.
        const ungraded: TlsSignal = { source: this.name, grade: null, checkedAt: now, presentHeaders: [], missingHeaders: [] };

        const start = vendorHomepageUrl(domain);
        if (!start) {
            logger.warn('Vendor monitor skipped a domain that is not a bare host name', { component: 'vendor-monitoring' });
            return ungraded;
        }
        try {
            const headers = await this.fetchHomepageHeaders(start);
            if (!headers) return ungraded;
            const g = gradeSecurityHeaders(headers);
            return {
                source: this.name,
                grade: g.grade,
                checkedAt: now,
                presentHeaders: g.presentHeaders,
                missingHeaders: g.missingHeaders,
            };
        } catch (err) {
            if (err instanceof SsrfBlockedError) {
                // The reason names the cause: an unresolvable name, a private
                // address, a hop to http. Each leaves the vendor ungraded.
                logger.warn('Vendor monitor did not request a URL the SSRF guard refused', {
                    component: 'vendor-monitoring',
                    reason: err.message,
                });
            }
            return ungraded;
        }
    }

    /**
     * The headers of the first 2xx answer, following redirects one checked hop
     * at a time. Null when the homepage cannot be read within the bounds.
     * Throws `SsrfBlockedError` when the start URL or any hop is refused.
     */
    private async fetchHomepageHeaders(startUrl: string): Promise<Record<string, string> | null> {
        const deadline = Date.now() + HOMEPAGE_FETCH_LIMITS.deadlineMs;
        let url = startUrl;
        for (let hop = 0; hop <= HOMEPAGE_FETCH_LIMITS.maxRedirects; hop++) {
            let res: Response | null;
            try {
                res = await this.getWithRetry(url, deadline);
            } catch (err) {
                if (!(err instanceof RedirectNotAllowedError)) throw err;
                if (!err.location) return null;
                // Resolved against the URL that answered, then checked like
                // the first one by the next `safeFetch`.
                url = new URL(err.location, url).href;
                continue;
            }
            if (!res) return null;
            const headers: Record<string, string> = {};
            res.headers.forEach((v, k) => { headers[k] = v; });
            await discardBody(res);
            return headers;
        }
        return null;
    }

    /**
     * One URL, up to `maxAttempts` tries inside the deadline. Returns the 2xx
     * response, or null for any other answer. A redirect and a refused address
     * propagate as `safeFetch` throws them; neither is retried.
     */
    private async getWithRetry(url: string, deadline: number): Promise<Response | null> {
        const retryDelayMs = this.opts.retryDelayMs ?? 1_000;
        for (let attempt = 1; attempt <= HOMEPAGE_FETCH_LIMITS.maxAttempts; attempt++) {
            const remaining = deadline - Date.now();
            if (remaining <= 0) return null;
            let res: Response;
            try {
                res = await safeFetch(url, {
                    method: 'GET',
                    headers: { 'User-Agent': USER_AGENT },
                    signal: AbortSignal.timeout(Math.min(HOMEPAGE_FETCH_LIMITS.requestTimeoutMs, remaining)),
                });
            } catch (err) {
                if (err instanceof SsrfBlockedError || err instanceof RedirectNotAllowedError) throw err;
                // Network failure or timeout: retry while time and attempts remain.
                if (attempt < HOMEPAGE_FETCH_LIMITS.maxAttempts) await sleep(retryDelayMs);
                continue;
            }
            if (res.ok) return res;
            await discardBody(res);
            if (res.status !== 429 && res.status < 500) return null;
            if (attempt < HOMEPAGE_FETCH_LIMITS.maxAttempts) await sleep(retryDelayMs);
        }
        return null;
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

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function simpleHash(s: string): number {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    return Math.abs(h);
}
