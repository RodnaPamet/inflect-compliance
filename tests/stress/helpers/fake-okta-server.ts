/**
 * A real `node:http` server that behaves like Okta behaving badly.
 *
 * Okta is the only provider whose base URL is config-driven (`config.orgUrl`),
 * so it is the only one reachable at `127.0.0.1`. Entra, Google, BambooHR and
 * SharePoint hardcode their bases as module constants. That is sufficient: the
 * hardening under test lives in the two SHARED modules (`bounded-fetch`,
 * `http-resilience`), not per provider.
 *
 * ## Why a real socket rather than a stubbed fetch
 *
 * A stub proves the awaited promise settles at the deadline. Only a socket
 * proves the abort actually releases the connection — and "one hung provider
 * holds a worker slot" is the failure this whole area exists to prevent, so the
 * release is the interesting half. `observedDisconnects` and `inFlight` exist
 * for exactly that assertion.
 *
 * ## Modes
 *
 * `hang` accepts the connection and never answers. That is deliberately worse
 * than a refusal: a refusal errors immediately and needs no deadline, while a
 * black hole is what actually consumes a worker.
 *
 * @see tests/stress/README.md
 */
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

export type FakeMode =
    | { kind: 'ok' }
    | { kind: 'hang' }
    | { kind: 'throttle'; retryAfter: string }
    | { kind: 'unauth' }
    | { kind: 'notFound' };

export interface FakeOktaOptions {
    /** Total users to serve across all pages. */
    userCount?: number;
    /** Users per page. Okta's real default in this repo's client is 200. */
    pageSize?: number;
}

/** Okta paginates with RFC-5988 `Link: <url>; rel="next"` — matched by parseNextLink. */
function linkHeader(nextUrl: string): string {
    return `<${nextUrl}>; rel="next"`;
}

export class FakeOktaServer {
    private server: http.Server | null = null;
    private mode: FakeMode = { kind: 'ok' };
    private readonly hung = new Set<http.ServerResponse>();

    /** Requests received, per pathname. */
    readonly counts = new Map<string, number>();
    /** Peak simultaneous in-flight requests — the occupancy signal. */
    highWaterInFlight = 0;
    /** Client-side aborts the server actually observed. */
    observedDisconnects = 0;

    private inFlightCount = 0;
    private remainingBadResponses = Infinity;
    private userCount: number;
    private pageSize: number;
    /** Every `Link: rel=next` URL this server has handed out. */
    readonly servedNextLinks: string[] = [];

    constructor(opts: FakeOktaOptions = {}) {
        this.userCount = opts.userCount ?? 1;
        this.pageSize = opts.pageSize ?? 200;
    }

    get inFlight(): number {
        return this.inFlightCount;
    }

    setMode(mode: FakeMode): void {
        this.mode = mode;
        this.remainingBadResponses = Infinity;
    }

    /**
     * Behave badly for exactly `n` requests, then serve normally.
     *
     * Needed for the absorb-and-retry case: asserting that a throttle within
     * budget is waited out AND retried requires the retry to succeed. Doing this
     * with a timer racing the request was the first attempt and was both flaky
     * and unreadable.
     */
    setModeForNext(mode: FakeMode, n: number): void {
        this.mode = mode;
        this.remainingBadResponses = n;
    }

    count(pathname: string): number {
        return this.counts.get(pathname) ?? 0;
    }

    totalRequests(): number {
        let n = 0;
        for (const v of this.counts.values()) n += v;
        return n;
    }

    /** The `orgUrl` to put in the connection's configJson. */
    get orgUrl(): string {
        const addr = this.server?.address() as AddressInfo | null;
        if (!addr) throw new Error('FakeOktaServer.orgUrl read before start()');
        return `http://127.0.0.1:${addr.port}`;
    }

    async start(): Promise<void> {
        this.server = http.createServer((req, res) => this.handle(req, res));
        await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    }

    async stop(): Promise<void> {
        if (!this.server) return;
        // Release anything still parked in `hang`, then hard-close so a held
        // keep-alive socket cannot outlive the suite and hang Jest's teardown.
        for (const res of this.hung) {
            try {
                res.destroy();
            } catch {
                /* already gone */
            }
        }
        this.hung.clear();
        this.server.closeAllConnections?.();
        await new Promise<void>((resolve) => this.server!.close(() => resolve()));
        this.server = null;
    }

    private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
        const url = new URL(req.url ?? '/', this.orgUrl);
        const pathname = url.pathname;
        this.counts.set(pathname, (this.counts.get(pathname) ?? 0) + 1);
        this.inFlightCount += 1;
        if (this.inFlightCount > this.highWaterInFlight) {
            this.highWaterInFlight = this.inFlightCount;
        }

        const settle = () => {
            this.inFlightCount -= 1;
        };

        // The per-user enrichment endpoints. Always benign: their failures are
        // swallowed by a bare `catch {}` in the provider, so returning anything
        // interesting here would prove nothing.
        if (pathname.includes('/factors') || pathname.includes('/roles')) {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end('[]');
            settle();
            return;
        }

        // A finite bad-response budget: once spent, fall through to `ok`.
        const effective: FakeMode =
            this.remainingBadResponses > 0 ? this.mode : { kind: 'ok' };
        if (this.mode.kind !== 'ok' && this.remainingBadResponses !== Infinity) {
            this.remainingBadResponses -= 1;
        }

        switch (effective.kind) {
            case 'hang': {
                // Accept and never answer. Track the abort so a test can assert
                // the deadline actually released the socket.
                this.hung.add(res);
                req.on('aborted', () => {
                    this.observedDisconnects += 1;
                });
                res.on('close', () => {
                    if (!res.writableEnded) this.observedDisconnects += 1;
                    this.hung.delete(res);
                    settle();
                });
                return;
            }
            case 'throttle': {
                res.writeHead(429, {
                    'retry-after': effective.retryAfter,
                    'content-type': 'application/json',
                });
                res.end('{"errorCode":"E0000047"}');
                settle();
                return;
            }
            case 'unauth': {
                res.writeHead(401, { 'content-type': 'application/json' });
                res.end('{"errorCode":"E0000011"}');
                settle();
                return;
            }
            case 'notFound': {
                res.writeHead(404, { 'content-type': 'application/json' });
                res.end('{"errorCode":"E0000007"}');
                settle();
                return;
            }
            case 'ok':
            default:
                break;
        }

        const after = Number(url.searchParams.get('after') ?? '0') || 0;
        const limit = Math.min(Number(url.searchParams.get('limit') ?? this.pageSize) || this.pageSize, this.pageSize);
        const slice: unknown[] = [];
        for (let i = after; i < Math.min(after + limit, this.userCount); i++) {
            slice.push({
                id: `u${i}`,
                status: 'ACTIVE',
                profile: { email: `user${i}@acme.test`, login: `user${i}@acme.test`, displayName: `User ${i}` },
                lastLogin: new Date().toISOString(),
            });
        }

        const nextAfter = after + limit;
        const headers: Record<string, string> = { 'content-type': 'application/json' };
        if (nextAfter < this.userCount) {
            const next = `${this.orgUrl}/api/v1/users?limit=${limit}&after=${nextAfter}`;
            headers.link = linkHeader(next);
            this.servedNextLinks.push(next);
        }
        res.writeHead(200, headers);
        res.end(JSON.stringify(slice));
        settle();
    }
}
