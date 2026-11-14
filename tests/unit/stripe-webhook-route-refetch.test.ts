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
    billingAccount: { findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn(), create: jest.fn() },
    billingEvent: { findUnique: jest.fn(), create: jest.fn() },
};
jest.mock('@/lib/prisma', () => ({ __esModule: true, default: db, prisma: db }));

jest.mock('@/lib/observability/logger', () => ({
    logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { NextRequest } from 'next/server';
import { POST } from '@/app/api/stripe/webhook/route';
import { logger } from '@/lib/observability/logger';

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
    db.billingAccount.findUnique.mockResolvedValue({ tenantId: 't1', stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_1' });
    db.billingAccount.updateMany.mockResolvedValue({ count: 1 });
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
        expect(db.billingAccount.updateMany).not.toHaveBeenCalled();
        expect(db.billingEvent.create).not.toHaveBeenCalled();
    });

    it('answers 200 when Stripe says the subscription no longer exists (applied as a deletion)', async () => {
        stripeMock.subscriptions.retrieve.mockRejectedValue(
            Object.assign(new Error('No such subscription'), { code: 'resource_missing', statusCode: 404 }),
        );

        const res = await POST(webhookRequest());

        expect(res.status).toBe(200);
        expect(db.billingAccount.updateMany).toHaveBeenCalledWith({
            where: { stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_1' },
            data: { status: 'CANCELED', plan: 'FREE', stripeSubscriptionId: null },
        });
    });

    it('answers 200 and applies the live state when the re-fetch succeeds', async () => {
        stripeMock.subscriptions.retrieve.mockResolvedValue({
            id: 'sub_1', customer: 'cus_1', status: 'past_due', metadata: { plan: 'PRO' },
        });

        const res = await POST(webhookRequest());

        expect(res.status).toBe(200);
        expect(db.billingAccount.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ status: 'PAST_DUE' }) }),
        );
    });
});

/**
 * #5316 item 28 follow-up (owner decision 2026-11-14): every processing error
 * after the signature check answers non-2xx, so Stripe delivers the event
 * again. The route answered 200 to all of them but a failed re-fetch, and the
 * event was lost.
 */
describe('POST /api/stripe/webhook — any processing error is retried', () => {
    beforeEach(() => {
        stripeMock.subscriptions.retrieve.mockResolvedValue({
            id: 'sub_1', customer: 'cus_1', status: 'past_due', metadata: { plan: 'PRO' },
        });
    });

    it('answers 500 and records no BillingEvent when the account write fails', async () => {
        db.billingAccount.updateMany.mockRejectedValueOnce(
            Object.assign(new Error('Invalid `prisma.billingAccount.updateMany()` invocation'), {
                name: 'PrismaClientKnownRequestError',
                code: 'P1017',
            }),
        );

        const res = await POST(webhookRequest());

        expect(res.status).toBe(500);
        expect(db.billingEvent.create).not.toHaveBeenCalled();
    });

    it('answers 500 when recording the BillingEvent fails after the write', async () => {
        db.billingEvent.create.mockRejectedValueOnce(new Error('connection terminated'));

        const res = await POST(webhookRequest());

        expect(res.status).toBe(500);
    });

    it('answers 500 when the idempotency read fails', async () => {
        db.billingEvent.findUnique.mockRejectedValueOnce(new Error('connection terminated'));

        const res = await POST(webhookRequest());

        expect(res.status).toBe(500);
        expect(db.billingAccount.updateMany).not.toHaveBeenCalled();
    });

    it('logs the event id and type, never the payload', async () => {
        db.billingAccount.updateMany.mockRejectedValueOnce(new Error('connection terminated'));

        await POST(webhookRequest());

        expect(logger.error).toHaveBeenCalledTimes(1);
        const [, fields] = (logger.error as jest.Mock).mock.calls[0];
        expect(fields).toMatchObject({ eventId: 'evt_1', eventType: 'customer.subscription.updated' });
        const logged = JSON.stringify((logger.error as jest.Mock).mock.calls[0]);
        expect(logged).not.toContain('metadata');
        expect(logged).not.toContain('"customer"');
    });

    it('answers 200 and records the event when the conditional write is superseded', async () => {
        // The stored subscription changed during the re-fetch: the write
        // matches no row. That is newer state, not a failure to retry.
        db.billingAccount.updateMany.mockResolvedValueOnce({ count: 0 });

        const res = await POST(webhookRequest());

        expect(res.status).toBe(200);
        expect(db.billingEvent.create).toHaveBeenCalledTimes(1);
    });

    it('still answers 400 to a signature failure', async () => {
        stripeMock.webhooks.constructEvent.mockImplementationOnce(() => {
            throw new Error('No signatures found matching the expected signature');
        });

        const res = await POST(webhookRequest());

        expect(res.status).toBe(400);
        expect(db.billingEvent.findUnique).not.toHaveBeenCalled();
    });
});
