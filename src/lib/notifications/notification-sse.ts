/**
 * The Server-Sent Events response behind the notification bell's live channel.
 *
 * Shared by the two stream routes (#4643): `/api/notifications/stream`, which
 * subscribes the session's own workspace and serves the bell in the org
 * chrome, and `/api/t/:slug/notifications/stream`, which subscribes the
 * workspace the bell is open in. Each route resolves WHO is listening; this
 * builds the stream. Moved here from the first route unchanged — heartbeat,
 * headers, subscribe-on-connect and unsubscribe-on-abort — so the two cannot
 * drift apart. See that route for why SSE rather than a WebSocket.
 */
import {
    subscribeToNotifications,
    type NotificationEvent,
} from '@/lib/notifications/notification-bus';

const HEARTBEAT_INTERVAL_MS = 25_000;

const encoder = new TextEncoder();

function sseFormat(event: NotificationEvent): string {
    // SSE wire format: `data: <json>\n\n`. No `event:` field —
    // the bell handles a single message kind so the default
    // `message` event type works fine.
    return `data: ${JSON.stringify(event)}\n\n`;
}

export function notificationStreamResponse(
    subscriber: { tenantId: string; userId: string },
    signal: AbortSignal,
): Response {
    // Hoisted out of `start` so `cancel` can reach it: the two are sibling
    // methods of the same source object and do not share `start`'s scope.
    let teardown: (() => void) | undefined;

    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            // TWO flags, because one carried two meanings and that was the
            // leak (#5624). `closed` means "do not enqueue"; `torn` means
            // "the heartbeat and the subscription are gone". A failed enqueue
            // set the single old flag, and cleanup read it as the second
            // meaning and returned before clearing the interval or
            // unsubscribing — so the 25s timer ran for the life of the
            // process and the subscriber stayed in the bus's module-level Set,
            // which every publish iterates.
            let closed = false;
            let torn = false;
            let heartbeat: ReturnType<typeof setInterval> | undefined;
            let unsubscribe: (() => void) | undefined;

            // A `function` declaration, not a `const` arrow, because it is
            // hoisted: the first `safeEnqueue` below runs before this point,
            // and reaching a TDZ ReferenceError from the catch would break
            // exactly the failure path this fix exists for.
            function cleanup(): void {
                if (torn) return;
                torn = true;
                closed = true;
                if (heartbeat !== undefined) clearInterval(heartbeat);
                heartbeat = undefined;
                unsubscribe?.();
                unsubscribe = undefined;
                signal.removeEventListener('abort', cleanup);
                try {
                    controller.close();
                } catch {
                    // Already closed or cancelled upstream — fine.
                }
            }
            teardown = cleanup;

            const safeEnqueue = (chunk: string) => {
                if (closed) return;
                try {
                    controller.enqueue(encoder.encode(chunk));
                } catch {
                    // The client went away mid-flush. TEAR DOWN rather than
                    // only recording that we cannot write: this is the one
                    // path that reliably observes the disconnect, and it used
                    // to be the path that disabled every other one. Note it
                    // also means `send` never throws back to
                    // `publishNotificationEvent`, whose own poison-pill
                    // removal therefore never fired either; cleanup
                    // unsubscribes directly, which is strictly stronger.
                    cleanup();
                }
            };

            // Initial comment so the client knows the channel is
            // open. EventSource doesn't fire `onopen` for some
            // browsers until at least one byte has been received.
            safeEnqueue(': connected\n\n');

            unsubscribe = subscribeToNotifications({
                tenantId: subscriber.tenantId,
                userId: subscriber.userId,
                send: (event) => safeEnqueue(sseFormat(event)),
            });

            heartbeat = setInterval(() => {
                safeEnqueue(': hb\n\n');
            }, HEARTBEAT_INTERVAL_MS);

            // Client closed the tab, navigated away, or lost the
            // network. The browser sends a TCP FIN which Next
            // surfaces as an `abort` on the request signal.
            signal.addEventListener('abort', cleanup);

            // An ALREADY-aborted signal never fires the listener above, so a
            // request that died before the stream started would subscribe and
            // then never be cleaned up. Checked after registering, so the two
            // orderings cannot both miss, and cleanup is idempotent.
            if (signal.aborted) cleanup();
        },

        // The consumer cancelled the stream without the request signal
        // aborting — a different way to lose the reader, and previously one
        // that tore nothing down.
        cancel() {
            teardown?.();
        },
    });

    return new Response(stream, {
        status: 200,
        headers: {
            'Content-Type': 'text/event-stream; charset=utf-8',
            // Disable proxy buffering — without this, nginx / Cloud
            // Run buffer SSE bytes and the client doesn't see them
            // until the buffer fills.
            'Cache-Control': 'no-cache, no-transform',
            'X-Accel-Buffering': 'no',
            Connection: 'keep-alive',
        },
    });
}
