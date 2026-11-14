/**
 * The notification SSE stream tears down exactly once, whichever way the
 * connection ends (#5316).
 *
 * A failed enqueue — a heartbeat or a published event hitting a controller
 * whose stream was already cancelled — used to set the same `closed` flag the
 * abort cleanup checked, so the later abort did nothing: the 25 s heartbeat
 * ran for the life of the process and the subscriber stayed in the bus's
 * module-level Set, which every publish iterates.
 */
import {
    __resetNotificationBusForTests,
    getNotificationSubscriberCount,
    publishNotificationEvent,
    type NotificationEvent,
} from '@/lib/notifications/notification-bus';
import { notificationStreamResponse } from '@/lib/notifications/notification-sse';

const WHO = { tenantId: 'tenant-1', userId: 'user-1' };
const EVENT = { type: 'notification.created' } as unknown as NotificationEvent;

describe('notificationStreamResponse teardown', () => {
    beforeEach(() => {
        jest.useFakeTimers();
        __resetNotificationBusForTests();
    });

    afterEach(() => {
        jest.clearAllTimers();
        jest.useRealTimers();
        __resetNotificationBusForTests();
    });

    it('a cancelled stream that then fails an enqueue and aborts leaves no subscriber and no heartbeat', async () => {
        const ac = new AbortController();
        const res = notificationStreamResponse(WHO, ac.signal);
        expect(getNotificationSubscriberCount()).toBe(1);
        expect(jest.getTimerCount()).toBe(1);

        // The browser tab goes away: the response body is cancelled…
        await res.body!.cancel();
        // …a notification arrives for the cancelled controller…
        publishNotificationEvent(WHO.tenantId, WHO.userId, EVENT);
        jest.advanceTimersByTime(30_000);
        // …and only then does the request signal abort.
        ac.abort();

        expect(getNotificationSubscriberCount()).toBe(0);
        expect(jest.getTimerCount()).toBe(0);
    });

    it('an abort alone tears the stream down', () => {
        const ac = new AbortController();
        notificationStreamResponse(WHO, ac.signal);
        ac.abort();
        expect(getNotificationSubscriberCount()).toBe(0);
        expect(jest.getTimerCount()).toBe(0);
    });

    it('a request already aborted subscribes nothing', () => {
        const ac = new AbortController();
        ac.abort();
        notificationStreamResponse(WHO, ac.signal);
        expect(getNotificationSubscriberCount()).toBe(0);
        expect(jest.getTimerCount()).toBe(0);
    });
});
