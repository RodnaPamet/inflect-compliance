/**
 * #5624 — the SSE stream's teardown, driven rather than scanned.
 *
 * The leak was invisible to the existing wiring guard because that guard
 * asserts `signal.addEventListener('abort'` is PRESENT, and a handler that
 * returns immediately satisfies it. One flag carried two meanings: a failed
 * enqueue set `closed`, and `cleanup` read `closed` as "already torn down" and
 * returned before `clearInterval` or `unsubscribe`. So the 25s heartbeat ran
 * for the life of the process and the subscriber stayed in the bus's
 * module-level Set, which every publish iterates.
 *
 * These drive the real function with a real `ReadableStream`, through a
 * subclass that captures the controller so `enqueue` can be made to throw the
 * way a cancelled controller does. The assertions are the two things that
 * leaked: `getNotificationSubscriberCount()` and `jest.getTimerCount()`.
 */
import {
    __resetNotificationBusForTests,
    getNotificationSubscriberCount,
    publishNotificationEvent,
} from '@/lib/notifications/notification-bus';
// Imported STATICALLY and never through jest.resetModules(): a fresh module
// registry gives the stream its own copy of the bus, so every count this file
// reads would be 0 and every `toBe(0)` assertion would pass vacuously. The
// `toBe(1)` and `toBe(2)` cases below exist to catch exactly that, and did.
import { notificationStreamResponse } from '@/lib/notifications/notification-sse';

const RealReadableStream = globalThis.ReadableStream;

interface Captured {
    enqueueCalls: number;
    failEnqueue: boolean;
    cancel?: () => void;
}
let cap: Captured;

/**
 * A real stream (so `new Response(stream)` still works) whose controller is
 * wrapped, so a test can make `enqueue` throw at a chosen moment without
 * cancelling the stream — which would call `cancel()` and conflate the two
 * teardown paths this test keeps apart.
 */
class CapturingReadableStream<T> extends RealReadableStream<T> {
    constructor(source: UnderlyingDefaultSource<T>, strategy?: QueuingStrategy<T>) {
        const wrapped: UnderlyingDefaultSource<T> = {
            ...source,
            start(controller) {
                return source.start?.({
                    ...controller,
                    enqueue(chunk: T) {
                        cap.enqueueCalls += 1;
                        if (cap.failEnqueue) throw new TypeError('stream is closed');
                        controller.enqueue(chunk);
                    },
                    close: () => controller.close(),
                } as ReadableStreamDefaultController<T>);
            },
        };
        super(wrapped, strategy);
        cap.cancel = source.cancel ? () => void source.cancel?.(undefined) : undefined;
    }
}

const SUB = { tenantId: 't1', userId: 'u1' };
const EVENT = {
    id: 'n1', type: 'TASK_DUE', title: 'T', message: 'M',
    read: false, linkUrl: null, createdAt: '2026-11-14T00:00:00.000Z',
};

const open = (signal: AbortSignal) => notificationStreamResponse(SUB, signal);

beforeEach(() => {
    jest.useFakeTimers();
    __resetNotificationBusForTests();
    cap = { enqueueCalls: 0, failEnqueue: false };
    // Substituted per test rather than at import: the module reads the global
    // at CALL time, inside notificationStreamResponse.
    (globalThis as { ReadableStream: unknown }).ReadableStream = CapturingReadableStream;
});

afterEach(() => {
    (globalThis as { ReadableStream: unknown }).ReadableStream = RealReadableStream;
    jest.useRealTimers();
});

describe('#5624 — a failed enqueue must not disable the teardown', () => {
    it('subscribes and arms exactly one heartbeat on connect', () => {
        const ac = new AbortController();
        open(ac.signal);
        expect(getNotificationSubscriberCount()).toBe(1);
        expect(jest.getTimerCount()).toBe(1);
    });

    it('CONTROL — a plain abort unsubscribes and clears the heartbeat', () => {
        // The path that always worked. Without this the test below could pass
        // against a cleanup that never runs at all.
        const ac = new AbortController();
        open(ac.signal);
        ac.abort();
        expect(getNotificationSubscriberCount()).toBe(0);
        expect(jest.getTimerCount()).toBe(0);
    });

    it('THE BUG — a heartbeat that fails to enqueue, then an abort, still tears down', () => {
        const ac = new AbortController();
        open(ac.signal);

        // The client is gone; the next write throws the way a dead controller
        // does. This is the moment that used to set the flag cleanup misreads.
        cap.failEnqueue = true;
        jest.advanceTimersByTime(25_000);

        ac.abort();

        // Before #5624 both of these were 1: the interval ran for the life of
        // the process and the subscriber stayed in the bus's Set.
        expect(getNotificationSubscriberCount()).toBe(0);
        expect(jest.getTimerCount()).toBe(0);
    });

    it('a failed enqueue tears down on its own, without waiting for an abort', () => {
        // Stronger than the issue asked for, and the reason it is safe: the
        // failed write is the one event that reliably observes the disconnect.
        const ac = new AbortController();
        open(ac.signal);
        cap.failEnqueue = true;
        jest.advanceTimersByTime(25_000);

        expect(getNotificationSubscriberCount()).toBe(0);
        expect(jest.getTimerCount()).toBe(0);
        void ac;
    });

    it('a failed PUBLISH also tears down, not just a failed heartbeat', () => {
        // The other writer into safeEnqueue. publishNotificationEvent removes a
        // subscriber whose send() throws, but safeEnqueue swallows the throw,
        // so the bus's own poison-pill removal never fired either.
        const ac = new AbortController();
        open(ac.signal);
        cap.failEnqueue = true;

        publishNotificationEvent('t1', 'u1', EVENT);

        expect(getNotificationSubscriberCount()).toBe(0);
        expect(jest.getTimerCount()).toBe(0);
        void ac;
    });

    it('the heartbeat stops FIRING, not merely stops writing', () => {
        // `closed` alone would make safeEnqueue a no-op while the interval kept
        // waking the process every 25s. Count the callback, not the bytes.
        const ac = new AbortController();
        open(ac.signal);
        ac.abort();
        const before = cap.enqueueCalls;
        jest.advanceTimersByTime(25_000 * 20);
        expect(cap.enqueueCalls).toBe(before);
        expect(jest.getTimerCount()).toBe(0);
    });

    it('an ALREADY-aborted signal does not leave a subscription behind', () => {
        // addEventListener on an aborted signal never fires, so this needed its
        // own check rather than a listener.
        const ac = new AbortController();
        ac.abort();
        open(ac.signal);
        expect(getNotificationSubscriberCount()).toBe(0);
        expect(jest.getTimerCount()).toBe(0);
    });

    it('cancelling the stream tears down without the signal aborting', () => {
        const ac = new AbortController();
        open(ac.signal);
        expect(getNotificationSubscriberCount()).toBe(1);

        cap.cancel?.();

        expect(getNotificationSubscriberCount()).toBe(0);
        expect(jest.getTimerCount()).toBe(0);
        void ac;
    });

    it('teardown is idempotent — every path can run after every other', () => {
        const ac = new AbortController();
        open(ac.signal);
        cap.failEnqueue = true;
        jest.advanceTimersByTime(25_000);
        ac.abort();
        cap.cancel?.();
        ac.abort();
        expect(getNotificationSubscriberCount()).toBe(0);
        expect(jest.getTimerCount()).toBe(0);
    });

    it('two streams for the same user are torn down independently', () => {
        const a = new AbortController();
        const b = new AbortController();
        open(a.signal);
        open(b.signal);
        expect(getNotificationSubscriberCount()).toBe(2);
        expect(jest.getTimerCount()).toBe(2);

        a.abort();

        expect(getNotificationSubscriberCount()).toBe(1);
        expect(jest.getTimerCount()).toBe(1);
        b.abort();
        expect(getNotificationSubscriberCount()).toBe(0);
    });
});
