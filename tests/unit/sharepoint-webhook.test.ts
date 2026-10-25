/**
 * SP-4 — Graph change-notification webhook receiver: the validation handshake,
 * clientState anti-spoof verification, and pull-job enqueue.
 */
const mockFindFirst = jest.fn();
const mockCreateEvent = jest.fn();
const mockEnqueue = jest.fn();

jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {
        policy: { findFirst: (...a: unknown[]) => mockFindFirst(...a) },
        integrationWebhookEvent: { create: (...a: unknown[]) => mockCreateEvent(...a) },
    },
}));
jest.mock('@/app-layer/jobs/queue', () => ({ __esModule: true, enqueue: (...a: unknown[]) => mockEnqueue(...a) }));
jest.mock('@/lib/observability/edge-logger', () => ({
    __esModule: true,
    edgeLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { POST } from '@/app/api/webhooks/sharepoint/route';
import { NextRequest } from 'next/server';

const ROUTE = 'https://ic.example/api/webhooks/sharepoint';

beforeEach(() => {
    jest.clearAllMocks();
    mockCreateEvent.mockResolvedValue({ id: 'evt1' });
    mockEnqueue.mockResolvedValue({ id: 'job1' });
});

describe('SharePoint webhook', () => {
    it('echoes the validationToken as text/plain (subscription handshake)', async () => {
        const req = new NextRequest(`${ROUTE}?validationToken=abc%20123`, { method: 'POST' });
        const res = await POST(req);
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('text/plain');
        expect(await res.text()).toBe('abc 123');
    });

    it('verifies clientState + enqueues a pull for a matching policy', async () => {
        mockFindFirst.mockResolvedValue({ id: 'p1', tenantId: 't1' });
        const req = new NextRequest(ROUTE, {
            method: 'POST',
            body: JSON.stringify({ value: [{ subscriptionId: 'sub-1', clientState: 't1:p1' }] }),
        });
        const res = await POST(req);
        expect(res.status).toBe(200);
        expect(mockEnqueue).toHaveBeenCalledWith('sharepoint-policy-pull', { tenantId: 't1', policyId: 'p1' });
        expect(mockCreateEvent).toHaveBeenCalled();
    });

    it('ignores a notification whose clientState matches no policy (anti-spoof)', async () => {
        mockFindFirst.mockResolvedValue(null);
        const req = new NextRequest(ROUTE, {
            method: 'POST',
            body: JSON.stringify({ value: [{ subscriptionId: 'forged', clientState: 't1:p1' }] }),
        });
        const res = await POST(req);
        expect(res.status).toBe(200);
        expect(mockEnqueue).not.toHaveBeenCalled();
    });

    it('skips malformed clientState', async () => {
        const req = new NextRequest(ROUTE, {
            method: 'POST',
            body: JSON.stringify({ value: [{ subscriptionId: 's', clientState: 'no-colon' }] }),
        });
        await POST(req);
        expect(mockFindFirst).not.toHaveBeenCalled();
        expect(mockEnqueue).not.toHaveBeenCalled();
    });
});
