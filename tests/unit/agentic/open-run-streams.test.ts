/**
 * #3472 — the process-local registry of open run-replay streams.
 *
 * Small enough to read in a minute, and every assertion here is about a way
 * the obvious implementation goes wrong:
 *
 *   - The sweep is bounded to the streams open when SIGTERM arrived. A `Set`
 *     iterator VISITS an element added during the iteration (measured:
 *     a,b,c), so a `close` that opens a stream would be swept in the same
 *     pass — which the snapshot prevents. It is NOT about skipping: deleting
 *     the element you are standing on does not skip the next one, and a
 *     mutation run proved iterating `open` directly closes all three.
 *   - A `close` that throws must not abandon the viewers after it, which is
 *     the entire point of the stage.
 *   - The sweep must be idempotent: a second SIGTERM (common as a container
 *     escalation) must not re-close controllers that are already closed.
 */
import {
    trackRunStream,
    untrackRunStream,
    openRunStreamCount,
    closeOpenRunStreams,
    _resetOpenRunStreamsForTesting,
} from '@/lib/agentic/open-run-streams';

jest.mock('@/lib/observability/logger', () => ({
    logger: { info: jest.fn(), warn: jest.fn() },
}));

beforeEach(() => {
    _resetOpenRunStreamsForTesting();
});

describe('open run streams', () => {
    it('counts what is open, and nothing once a stream unregisters itself', () => {
        const a = jest.fn();
        const b = jest.fn();
        trackRunStream(a);
        trackRunStream(b);
        expect(openRunStreamCount()).toBe(2);

        untrackRunStream(a);
        expect(openRunStreamCount()).toBe(1);
        // The ordinary path: the client disconnected, so nothing was closed by
        // the sweep.
        expect(a).not.toHaveBeenCalled();
    });

    it('closes EVERY stream even though each one untracks itself', () => {
        // Self-untracking is the real handler's shape (`cleanup` calls
        // `untrackRunStream(cleanup)`), so this holds that the sweep survives
        // it. It does NOT discriminate the snapshot — see the test below for
        // the one that does.
        const closed: string[] = [];
        const make = (name: string) => {
            const fn = () => {
                closed.push(name);
                untrackRunStream(fn);
            };
            return fn;
        };
        for (const name of ['a', 'b', 'c']) trackRunStream(make(name));

        const result = closeOpenRunStreams();
        expect(closed).toEqual(['a', 'b', 'c']);
        expect(result).toEqual({ closed: 3, failed: 0 });
        expect(openRunStreamCount()).toBe(0);
    });

    it('does not sweep a stream opened DURING the sweep', () => {
        // The snapshot's real job. A `Set` iterator visits an element added
        // mid-iteration, so without it a `close` that opens a stream — or
        // triggers a handler that does — is swept in the same pass, and a
        // chain of them iterates inside a shutdown budget that cannot stop it.
        //
        // The newcomer belongs to the NEXT shutdown, not this one: it was
        // opened after SIGTERM, so this stage is not responsible for it, and
        // closing a stream a request just opened would hand that viewer an
        // error for a connection nobody abandoned.
        const late = jest.fn();
        trackRunStream(() => { trackRunStream(late); });

        const result = closeOpenRunStreams();
        expect(late).not.toHaveBeenCalled();
        expect(result).toEqual({ closed: 1, failed: 0 });
    });

    it('a throwing close does not abandon the streams after it', () => {
        const after = jest.fn();
        trackRunStream(() => { throw new Error('controller already detached'); });
        trackRunStream(after);

        const result = closeOpenRunStreams();
        expect(after).toHaveBeenCalledTimes(1);
        // COUNTED, not swallowed: a shutdown log that says "closed 1" when it
        // tried two is how a leak stays invisible.
        expect(result).toEqual({ closed: 1, failed: 1 });
    });

    it('a second sweep closes nothing — a repeated SIGTERM is not a double close', () => {
        const a = jest.fn();
        trackRunStream(a);

        expect(closeOpenRunStreams()).toEqual({ closed: 1, failed: 0 });
        expect(closeOpenRunStreams()).toEqual({ closed: 0, failed: 0 });
        expect(a).toHaveBeenCalledTimes(1);
    });

    it('sweeping an empty registry is a no-op, not an error', () => {
        // The common case in production: most web processes hold no stream at
        // all when a deploy lands, and the stage must cost nothing there.
        expect(closeOpenRunStreams()).toEqual({ closed: 0, failed: 0 });
    });

    it('untracking something never tracked is harmless', () => {
        untrackRunStream(jest.fn());
        expect(openRunStreamCount()).toBe(0);
    });
});
