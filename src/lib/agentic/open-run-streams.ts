/**
 * The run-replay SSE streams THIS PROCESS currently holds open, and the
 * SIGTERM stage that closes them instead of stranding them (#3472).
 *
 * ## The gap this closes
 *
 * A live run's tail is an open `text/event-stream` response in the web tier.
 * A rolling deploy sends SIGTERM to that process, and without this the socket
 * is torn down by the platform at whatever point it gets to it: the browser
 * sees a transport error rather than an orderly end, and `EventSource`'s
 * automatic reconnect waits out its own backoff before asking the next pod.
 *
 * Closing them deliberately is one line per stream and needs no new client
 * machinery — a closed SSE response is exactly what `EventSource` is built to
 * reconnect from, and the cursor the client already holds means the next pod
 * resumes at the step after the last one it delivered. Nothing is replayed and
 * nothing is skipped, because the ledger is append-only and ordered.
 *
 * ## Why a process-local registry and not a query
 *
 * The same reason `in-flight-runs.ts` gives for runs: there is no query that
 * distinguishes "a stream I am holding" from "a stream another pod is
 * holding", because the distinction is not in the database. It is held in
 * memory, written by the one route that opens them.
 *
 * ## The contract this module owes the shutdown handler
 *
 * Bounded, idempotent, never throws — the same contract `pauseInFlightRuns`,
 * `shutdownTelemetry` and `shutdownSentry` carry, because the handler races
 * each stage against a budget and an unguarded rejection would skip every
 * stage after it. There is no await here at all: closing a controller is
 * synchronous, so the stage cannot exceed its budget.
 */
import { logger } from '@/lib/observability/logger';

type CloseFn = () => void;

/**
 * Insertion-ordered so a shutdown closes the oldest first. `Set` rather than
 * an array because `untrack` is called once per stream on the ordinary path
 * (the client disconnected) and must not be O(n) in the number of viewers.
 */
const open = new Set<CloseFn>();

export function trackRunStream(close: CloseFn): void {
    open.add(close);
}

export function untrackRunStream(close: CloseFn): void {
    open.delete(close);
}

export function openRunStreamCount(): number {
    return open.size;
}

/** @internal test seam — the module state is process-global. */
export function _resetOpenRunStreamsForTesting(): void {
    open.clear();
}

export const CLOSE_RUN_STREAMS_STAGE = 'closeOpenRunStreams';

/**
 * Close every stream this process holds. Returns how many it closed, so the
 * shutdown log says something a reader can check against the gauge rather than
 * just "done".
 *
 * A `close` that throws is logged and the sweep CONTINUES: one torn-down
 * controller must not leave the remaining viewers hanging, which is the whole
 * point of this stage.
 */
export function closeOpenRunStreams(): { closed: number; failed: number } {
    let closed = 0;
    let failed = 0;
    // Snapshot first — and NOT for the reason this comment used to give.
    //
    // It said that deleting from a Set while iterating it skips entries. That
    // is false and a measurement said so: a `Set` iterator visits every
    // element that is still present, and deleting the element you are standing
    // on does not skip the next one (`for (const v of s) s.delete(v)` visits
    // all three of three). A mutation run confirmed it — iterating `open`
    // directly closed all three streams and reddened nothing.
    //
    // The real hazard is the other direction: an element ADDED during the
    // iteration IS visited by the same iterator (measured: a,b,c). A `close`
    // that opened a stream — directly, or through a handler it triggers —
    // would therefore be swept in the same pass, and a pathological chain
    // could iterate indefinitely inside a shutdown budget. The snapshot bounds
    // the sweep to the streams that existed when SIGTERM arrived, which is
    // exactly the set this stage is responsible for.
    for (const close of [...open]) {
        try {
            close();
            closed++;
        } catch (err) {
            failed++;
            logger.warn('shutdown: closing a run stream threw', {
                component: 'agentic',
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }
    open.clear();
    if (closed > 0 || failed > 0) {
        logger.info('shutdown: run streams closed', {
            component: 'agentic', closed, failed,
        });
    }
    return { closed, failed };
}
