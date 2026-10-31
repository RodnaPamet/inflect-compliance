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

    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            let closed = false;

            const safeEnqueue = (chunk: string) => {
                if (closed) return;
                try {
                    controller.enqueue(encoder.encode(chunk));
                } catch {
                    // Stream already torn down (client disconnected
                    // mid-flush). Drop the chunk silently.
                    closed = true;
                }
            };

            // Initial comment so the client knows the channel is
            // open. EventSource doesn't fire `onopen` for some
            // browsers until at least one byte has been received.
            safeEnqueue(': connected\n\n');

            const unsubscribe = subscribeToNotifications({
                tenantId: subscriber.tenantId,
                userId: subscriber.userId,
                send: (event) => safeEnqueue(sseFormat(event)),
            });

            const heartbeat = setInterval(() => {
                safeEnqueue(': hb\n\n');
            }, HEARTBEAT_INTERVAL_MS);

            const cleanup = () => {
                if (closed) return;
                closed = true;
                clearInterval(heartbeat);
                unsubscribe();
                try {
                    controller.close();
                } catch {
                    // Already closed by upstream — fine.
                }
            };

            // Client closed the tab, navigated away, or lost the
            // network. The browser sends a TCP FIN which Next
            // surfaces as an `abort` on the request signal.
            signal.addEventListener('abort', cleanup);
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
