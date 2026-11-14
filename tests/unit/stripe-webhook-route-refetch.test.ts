/**
 * #5316 item 28 — the Stripe webhook route answers non-2xx when the live
 * subscription could not be re-fetched, so Stripe delivers the event again.
 *
 * Every subscription branch of `handleWebhookEvent` re-fetches the live
 * subscription before it writes. A retrieve that fails for any reason but
 * `resource_missing` writes nothing; if the route then answered 200, Stripe
 * would treat the event as delivered and the state change would be lost.
 *
 * Runs the real route over the real `handleWebhookEvent`, with the Stripe SDK
 * and the Prisma singleton mocked.
 */
const stripeMock = {
    webhooks: { constructEvent: jest.fn() },
    subscriptions: { retrieve: jest.fn() },
};
jest.mock('stripe', () => ({ __esModule: true, default: jest.fn(() => stripeMock) }));

const db = {
    billingAccount: { findUnique: jest.fn(), update: jest.fn(), create: jest.fn() },
    billingEvent: { findUnique: jest.fn(), create: jest.fn() },
};
jest.mock('@/lib/prisma', () => ({ __esModule: true, default: db, prisma: db }));

jest.mock('@/lib/observability/logger', () => ({
    logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { NextRequest } from 'next/server';
import { POST } from '@/app/api/stripe/webhook/route';

const OLD_ENV = process.env;

function webhookRequest(): NextRequest {
    return new NextRequest('http://localhost/api/stripe/webhook', {
        method: 'POST',
        headers: { 'stripe-signature': 't=1,v1=test' },
        body: '{}',
    });
}

beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...OLD_ENV, STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_x' }; // pragma: allowlist secret — test-only placeholder
    db.billingEvent.findUnique.mockResolvedValue(null);
    db.billingAccount.findUnique.mockResolvedValue({ tenantId: 't1', stripeCustomerId: 'cus_1' });
    stripeMock.webhooks.constructEvent.mockReturnValue({
        id: 'evt_1',
        type: 'customer.subscription.updated',
        data: { object: { id: 'sub_1', customer: 'cus_1', status: 'active', metadata: { plan: 'PRO' } } },
    });
});

afterAll(() => {
    process.env = OLD_ENV;
});

describe('POST /api/stripe/webhook — live subscription re-fetch', () => {
    it('answers 503 and writes nothing when the re-fetch fails, so Stripe retries', async () => {
        stripeMock.subscriptions.retrieve.mockRejectedValue(new Error('socket hang up'));

        const res = await POST(webhookRequest());

        expect(res.status).toBe(503);
        expect(db.billingAccount.update).not.toHaveBeenCalled();
        expect(db.billingEvent.create).not.toHaveBeenCalled();
    });

    it('answers 200 when Stripe says the subscription no longer exists (applied as a deletion)', async () => {
        stripeMock.subscriptions.retrieve.mockRejectedValue(
            Object.assign(new Error('No such subscription'), { code: 'resource_missing', statusCode: 404 }),
        );

        const res = await POST(webhookRequest());

        expect(res.status).toBe(200);
        expect(db.billingAccount.update).toHaveBeenCalledWith({
            where: { stripeCustomerId: 'cus_1' },
            data: { status: 'CANCELED', plan: 'FREE', stripeSubscriptionId: null },
        });
    });

    it('answers 200 and applies the live state when the re-fetch succeeds', async () => {
        stripeMock.subscriptions.retrieve.mockResolvedValue({
            id: 'sub_1', customer: 'cus_1', status: 'past_due', metadata: { plan: 'PRO' },
        });

        const res = await POST(webhookRequest());

        expect(res.status).toBe(200);
        expect(db.billingAccount.update).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ status: 'PAST_DUE' }) }),
        );
    });
});
