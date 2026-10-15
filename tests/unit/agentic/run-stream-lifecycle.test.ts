/**
 * THE RUN STREAM TERMINATES CLEANLY — on completion, abort, disconnect and the
 * wall-clock cap (#3472).
 *
 * The acceptance bullet of plan point 08 that had no test. Everything else it
 * asks for was covered: `workflow-run-steps-feed-is-bounded` walks a whole run
 * in pages and compares the union against a direct read, and proves tenant
 * isolation with the row's existence asserted first.
 *
 * ── WHAT WAS ACTUALLY UNTESTED, AND WHY IT MATTERED ─────────────────────────
 *
 * The route carries four `end` reasons and an abort listener, and nothing
 * exercised any of them. Two test files mention it and both read it as SOURCE
 * TEXT — the route census, and the prompt-logging sweep. Neither imports it.
 * `open-run-streams.test.ts` covers the shutdown REGISTRY thoroughly, which is
 * the Epic E drain this point REUSES rather than the route's own lifecycle.
 *
 * So the three states an operator meets — a run that completes under an open
 * stream, a run that goes terminal while one is held, and a client that goes
 * away — were implemented and undemonstrated. That is the shape where a
 * control reports itself working: correct as far as reading can tell, and a
 * refactor of the `cleanup`/`end` pairing breaks it in silence.
 *
 * ── WHY THE PERMISSION WRAPPER IS STUBBED AND THE FEED IS NOT MOCKED AWAY ───
 *
 * `requirePermission` reaches `getTenantCtx`, which reaches auth and Prisma;
 * this file is about the stream's lifecycle, and the gate has its own coverage
 * in `api-permission-coverage`. `getRunStepFeed` IS stubbed, but as a
 * controllable sequence rather than a constant — the transitions (`live` then
 * terminal, drained then not) are the inputs the arms branch on, so a constant
 * would reach exactly one of them.
 */
import { TextDecoder } from 'node:util';

const feed = jest.fn();
jest.mock('@/app-layer/usecases/workflow-run-steps', () => ({
    ...jest.requireActual('@/app-layer/usecases/workflow-run-steps'),
    getRunStepFeed: (...a: unknown[]) => feed(...a),
}));

/**
 * The gate, passed through with a fixed context.
 *
 * `requirePermission` is the real enforcement and is asserted by
 * `route-permissions` and `api-permission-coverage`; reproducing it here would
 * test the middleware, and stubbing it is what lets this file reach the stream
 * at all.
 */
jest.mock('@/lib/security/permission-middleware', () => ({
    requirePermission: (
        _key: string,
        handler: (req: unknown, args: unknown, ctx: unknown) => unknown,
    ) => (req: unknown, args: unknown) =>
        handler(req, args, {
            tenantId: 'tenant-1',
            tenantSlug: 'acme',
            userId: 'user-1',
            requestId: 'req-1',
            role: 'OWNER',
        }),
}));

import { GET } from '@/app/api/t/[tenantSlug]/agent-runs/[id]/stream/route';
import {
    openRunStreamCount,
    closeOpenRunStreams,
    _resetOpenRunStreamsForTesting,
} from '@/lib/agentic/open-run-streams';

const decoder = new TextDecoder();

/** One page of the feed. `live` and `hasMore` are what the arms branch on. */
function page(over: Record<string, unknown> = {}) {
    return {
        runId: 'run-1',
        status: 'RUNNING',
        stepCount: 1,
        live: true,
        cursor: 0,
        hasMore: false,
        steps: [],
        ...over,
    };
}

/** A request whose abort signal the test controls. */
function request(): { req: unknown; abort: () => void } {
    const controller = new AbortController();
    return {
        req: {
            nextUrl: { searchParams: new URLSearchParams() },
            signal: controller.signal,
        },
        abort: () => controller.abort(),
    };
}

const ARGS = { params: Promise.resolve({ tenantSlug: 'acme', id: 'run-1' }) };

/**
 * Read everything the stream has produced SO FAR, without waiting for close.
 *
 * `reader.read()` on an open stream blocks, so each read races a macrotask
 * that resolves to a sentinel — which is why the suite runs on real timers for
 * the reads and fake ones for the clock. Returns the decoded text.
 */
async function drain(body: ReadableStream<Uint8Array>): Promise<string> {
    const reader = body.getReader();
    let out = '';
    for (;;) {
        const next = await Promise.race([
            reader.read(),
            new Promise<'idle'>((r) => { setImmediate(() => r('idle')); }),
        ]);
        if (next === 'idle') break;
        if (next.done) break;
        out += decoder.decode(next.value);
    }
    void reader.cancel().catch(() => {});
    return out;
}

const eventsIn = (text: string): string[] =>
    [...text.matchAll(/^event: (\w+)$/gm)].map((m) => m[1]);
const endReason = (text: string): string | undefined => {
    const m = /event: end\ndata: (\{.*\})/.exec(text);
    return m ? (JSON.parse(m[1]) as { reason?: string }).reason : undefined;
};

beforeEach(() => {
    feed.mockReset();
    // The registry is process-global. RESET rather than swept: a sweep would
    // CLOSE a leftover stream, and a close that threw in one case would take
    // the next one down with it.
    _resetOpenRunStreamsForTesting();
});

afterEach(() => {
    // CLOSED, then forgotten — and the order is the whole point. Several cases
    // deliberately leave a stream OPEN, and an open stream holds a 2s poll, a
    // 25s heartbeat and a 15-MINUTE deadline on real timers. Forgetting it
    // leaves those handles alive and jest cannot exit: the first draft of this
    // file hung the worker for exactly that reason.
    //
    // `closeOpenRunStreams` runs each `cleanup`, which clears all three timers
    // and closes the controller. It catches a throwing close and reports it, so
    // one bad stream cannot take the next case down.
    closeOpenRunStreams();
    _resetOpenRunStreamsForTesting();
    jest.useRealTimers();
});

describe('a run that is already finished', () => {
    it('ends with `complete` on the FIRST read, opening no poll', async () => {
        // The cheapest arm and the one a replay hits: a terminal run with
        // nothing left to page closes immediately, so a canvas opening a
        // finished run pays one round trip rather than a 15-minute tail.
        feed.mockResolvedValue(page({ live: false, hasMore: false, status: 'COMPLETED' }));
        const { req } = request();
        const res = (await GET(req as never, ARGS as never)) as Response;

        expect(res.status).toBe(200);
        expect(res.headers.get('Content-Type')).toContain('text/event-stream');
        const text = await drain(res.body as ReadableStream<Uint8Array>);

        expect(eventsIn(text)).toEqual(['open', 'end']);
        expect(endReason(text)).toBe('complete');
        // ONE read. A second would mean the snapshot was re-queried, which the
        // route's own comment says it never does.
        expect(feed).toHaveBeenCalledTimes(1);
        // AND THE REGISTRY IS EMPTY AGAIN — `cleanup` untracked itself, so a
        // later SIGTERM does not try to close a stream that is already gone.
        expect(openRunStreamCount()).toBe(0);
    });

    it('does NOT end while steps remain to page, even on a terminal run', async () => {
        // `!live && !hasMore` — both, in that order. A run that completed with
        // a page outstanding still has the steps that say HOW it finished, and
        // closing on status alone would drop exactly those.
        feed.mockResolvedValue(page({ live: false, hasMore: true, status: 'COMPLETED' }));
        const { req } = request();
        const res = (await GET(req as never, ARGS as never)) as Response;
        const text = await drain(res.body as ReadableStream<Uint8Array>);

        expect(eventsIn(text)).toEqual(['open']);
        expect(endReason(text)).toBeUndefined();
        expect(openRunStreamCount()).toBe(1);
    });
});

describe('a live run that goes terminal while the stream is held', () => {
    it('delivers the last steps and THEN ends with `complete`', async () => {
        jest.useFakeTimers();
        // First read: live, nothing yet. Second (the poll): drained and
        // terminal, carrying the final step.
        feed
            .mockResolvedValueOnce(page({ live: true, hasMore: false }))
            .mockResolvedValueOnce(
                page({
                    live: false,
                    hasMore: false,
                    status: 'COMPLETED',
                    cursor: 1,
                    steps: [{ id: 's1', seq: 1, kind: 'SYNTHESIS' }],
                }),
            );

        const { req } = request();
        const res = (await GET(req as never, ARGS as never)) as Response;
        // The poll interval, then let the awaited feed settle.
        await jest.advanceTimersByTimeAsync(2_000);
        jest.useRealTimers();
        const text = await drain(res.body as ReadableStream<Uint8Array>);

        // THE STEP BEFORE THE END. A route that ended first would close a
        // stream whose last event the client never saw.
        expect(eventsIn(text)).toEqual(['open', 'step', 'end']);
        expect(endReason(text)).toBe('complete');
        expect(openRunStreamCount()).toBe(0);
    });

    it('ends with `error` when the run becomes unreadable mid-stream', async () => {
        jest.useFakeTimers();
        feed
            .mockResolvedValueOnce(page({ live: true }))
            .mockRejectedValueOnce(new Error('relation does not exist'));

        const { req } = request();
        const res = (await GET(req as never, ARGS as never)) as Response;
        await jest.advanceTimersByTimeAsync(2_000);
        jest.useRealTimers();
        const text = await drain(res.body as ReadableStream<Uint8Array>);

        // A DISTINCT REASON, not `complete`. A client told "complete" for a run
        // that was deleted under it would stop asking and show a partial
        // timeline as finished.
        expect(endReason(text)).toBe('error');
        expect(openRunStreamCount()).toBe(0);
    });

    it('queries nothing further after a failure, and CLEARS ITS TIMERS', async () => {
        /*
            TWO CLAIMS, and the first draft of this case made only one of them
            while its name implied both — found by mutating `clearInterval` away
            and watching the case PASS.

            The call count is held down by `closed`, which the poll callback
            checks on entry. So "queries nothing further" is true even with
            every timer still running: the interval fires, returns immediately,
            and the database is never touched. That is the behaviour that
            matters for the database and it was genuinely covered.

            What the count cannot see is the HANDLE. An uncleared interval,
            heartbeat or deadline keeps the process alive — for the 15 minutes
            of the deadline — and in a server that is a leak per abandoned
            stream. It showed up only as a hung jest worker, which is a timeout
            rather than a named failure.

            `jest.getTimerCount()` is the discriminator, so both claims are now
            assertions.
        */
        jest.useFakeTimers();
        feed
            .mockResolvedValueOnce(page({ live: true }))
            .mockRejectedValue(new Error('still broken'));

        const { req } = request();
        await GET(req as never, ARGS as never);
        // Open: a poll, a heartbeat and a deadline.
        expect(jest.getTimerCount()).toBeGreaterThanOrEqual(3);

        await jest.advanceTimersByTimeAsync(2_000);
        const afterFailure = feed.mock.calls.length;

        // EVERY TIMER GONE. `cleanup` clears all three, so a route that
        // forgot one leaves this non-zero.
        expect(jest.getTimerCount()).toBe(0);

        // And three more intervals' worth of clock queries nothing.
        await jest.advanceTimersByTimeAsync(6_000);
        jest.useRealTimers();
        expect(feed.mock.calls.length).toBe(afterFailure);
    });
});

describe('the wall-clock cap', () => {
    it('ends with `timeout` at fifteen minutes, not with `complete`', async () => {
        // A PAUSED run awaiting a human can sit for days, and a connection held
        // that long is a file descriptor and a poll spent on a tab somebody
        // left open. The reason has to be its own: `EventSource` reconnects,
        // and the client's cursor resumes where it stopped.
        jest.useFakeTimers();
        feed.mockResolvedValue(page({ live: true, status: 'AWAITING_APPROVAL' }));

        const { req } = request();
        const res = (await GET(req as never, ARGS as never)) as Response;
        await jest.advanceTimersByTimeAsync(15 * 60_000);
        jest.useRealTimers();
        const text = await drain(res.body as ReadableStream<Uint8Array>);

        expect(endReason(text)).toBe('timeout');
        expect(openRunStreamCount()).toBe(0);
    });

    it('is still open just before the cap', async () => {
        // The positive control: without it, a deadline of ZERO would satisfy
        // the assertion above.
        jest.useFakeTimers();
        feed.mockResolvedValue(page({ live: true, status: 'AWAITING_APPROVAL' }));

        const { req } = request();
        await GET(req as never, ARGS as never);
        await jest.advanceTimersByTimeAsync(15 * 60_000 - 1_000);
        jest.useRealTimers();
        expect(openRunStreamCount()).toBe(1);
    });
});

describe('the client going away', () => {
    it('closes the stream and untracks it, WITHOUT sending `end`', async () => {
        // An abort means the socket is gone, so there is nobody to tell. What
        // matters is that the timers stop and the registry forgets it — a
        // stream left tracked is a poll running for a client that hung up.
        jest.useFakeTimers();
        feed.mockResolvedValue(page({ live: true }));

        const { req, abort } = request();
        await GET(req as never, ARGS as never);
        expect(openRunStreamCount()).toBe(1);

        abort();
        expect(openRunStreamCount()).toBe(0);

        // And the poll is dead: advancing the clock queries nothing further.
        const before = feed.mock.calls.length;
        await jest.advanceTimersByTimeAsync(10_000);
        jest.useRealTimers();
        expect(feed.mock.calls.length).toBe(before);
    });
});

describe('the shutdown drain', () => {
    it('a SIGTERM sweep closes the stream the route registered', async () => {
        // The Epic E drain this point reuses. `open-run-streams.test.ts` covers
        // the registry itself; what is asserted here is that the ROUTE enrols
        // in it, which that file cannot see.
        jest.useFakeTimers();
        feed.mockResolvedValue(page({ live: true }));

        const { req } = request();
        await GET(req as never, ARGS as never);
        expect(openRunStreamCount()).toBe(1);

        // THE REAL SWEEP, which is this case's subject — not the test reset.
        expect(closeOpenRunStreams()).toEqual({ closed: 1, failed: 0 });
        expect(openRunStreamCount()).toBe(0);

        const before = feed.mock.calls.length;
        await jest.advanceTimersByTimeAsync(10_000);
        jest.useRealTimers();
        expect(feed.mock.calls.length).toBe(before);
    });
});
