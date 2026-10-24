/**
 * "Mark read" on the notifications page reaches the tenant route it calls.
 *
 * The page sent a bare PATCH to `/api/t/:slug/notifications/:id`, which
 * exports only PUT, so every click was a 405 the page rolled back: the
 * notification never stayed read. The page now sends
 * `MARK_NOTIFICATION_READ_REQUEST`, and this file replays that exact request
 * through the real route module, so changing either side alone fails here.
 */
const mockMarkRead = jest.fn();
jest.mock('@/app-layer/usecases/notification', () => ({
    markNotificationRead: (...a: unknown[]) => mockMarkRead(...a),
}));
const ctx = { tenantId: 't1', userId: 'u1' };
jest.mock('@/app-layer/context', () => ({
    getTenantCtx: async () => ctx,
}));

import { NextRequest } from 'next/server';
import * as route from '@/app/api/t/[tenantSlug]/notifications/[id]/route';
import { MARK_NOTIFICATION_READ_REQUEST } from '@/lib/notifications/mark-read';

type Handler = (req: NextRequest, args: { params: Promise<{ tenantSlug: string; id: string }> }) => Promise<Response>;

const URL_ = 'https://app.test/api/t/acme/notifications/n1';
const args = () => ({ params: Promise.resolve({ tenantSlug: 'acme', id: 'n1' }) });

beforeEach(() => {
    jest.clearAllMocks();
    mockMarkRead.mockResolvedValue({ success: true });
});

describe('PUT /api/t/:slug/notifications/:id — the request the page sends', () => {
    it('the route exports a handler for the method the page uses', () => {
        const handler = (route as Record<string, unknown>)[MARK_NOTIFICATION_READ_REQUEST.method];
        expect(typeof handler).toBe('function');
    });

    it('marks the notification read and answers 200', async () => {
        const handler = (route as Record<string, unknown>)[MARK_NOTIFICATION_READ_REQUEST.method] as Handler;
        const res = await handler(new NextRequest(URL_, { ...MARK_NOTIFICATION_READ_REQUEST }), args());
        expect(res.status).toBe(200);
        expect(mockMarkRead).toHaveBeenCalledWith(ctx, 'n1');
    });

    it('needs the JSON body: the same PUT without one is refused before anything is marked', async () => {
        const res = await (route.PUT as unknown as Handler)(new NextRequest(URL_, { method: 'PUT' }), args());
        expect(res.status).toBe(400);
        expect(mockMarkRead).not.toHaveBeenCalled();
    });
});
