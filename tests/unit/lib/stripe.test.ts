/**
 * Branch coverage for `src/lib/stripe.ts`.
 *
 * The `stripe` SDK is fully mocked (never hits network) and the Prisma
 * singleton is replaced with an in-memory fake. Exercises:
 *   getStripe:          missing key throws; lazy singleton caches.
 *   getPriceId:         configured vs missing → throw.
 *   findOrCreateCustomer: existing account short-circuit vs create path.
 *   createCheckoutSession: returns url; throws when url absent.
 *   createPortalSession: returns url.
 *   constructWebhookEvent: missing secret throws; delegates to SDK.
 *   handleWebhookEvent: idempotency skip; every event-type switch arm
 *                       incl. missing-customer breaks, status mapping,
 *                       PAST_DUE reactivation, default unhandled.
 */

// ── Stripe SDK mock ──────────────────────────────────────────────────
const stripeMock = {
    customers: { create: jest.fn() },
    checkout: { sessions: { create: jest.fn() } },
    billingPortal: { sessions: { create: jest.fn() } },
    webhooks: { constructEvent: jest.fn() },
    subscriptions: { retrieve: jest.fn() },
};
jest.mock('stripe', () => {
    return { __esModule: true, default: jest.fn(() => stripeMock) };
});

// ── Prisma singleton mock (in-memory billing tables) ─────────────────
const db = {
    billingAccount: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
    },
    billingEvent: { findUnique: jest.fn(), create: jest.fn() },
};
jest.mock('@/lib/prisma', () => ({ __esModule: true, default: db, prisma: db }));

jest.mock('@/lib/observability/logger', () => ({
    logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import * as stripeLib from '@/lib/stripe';

const OLD_ENV = process.env;

beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...OLD_ENV, STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_x' };
    // Reset the lazy singleton between cases that flip the key.
    jest.resetModules();
});

afterAll(() => {
    process.env = OLD_ENV;
});

describe('getStripe', () => {
    it('throws when STRIPE_SECRET_KEY is unset', () => {
        jest.isolateModules(() => {
            const lib = require('@/lib/stripe');
            delete process.env.STRIPE_SECRET_KEY;
            expect(() => lib.getStripe()).toThrow('STRIPE_SECRET_KEY is not configured');
        });
    });

    it('returns a cached singleton on the second call', () => {
        const a = stripeLib.getStripe();
        const b = stripeLib.getStripe();
        expect(a).toBe(b);
    });
});

describe('getPriceId', () => {
    it('returns the configured price id', () => {
        jest.isolateModules(() => {
            process.env.STRIPE_PRICE_ID_PRO = 'price_pro';
            const lib = require('@/lib/stripe');
            expect(lib.getPriceId('PRO')).toBe('price_pro');
        });
    });

    it('throws when no price is configured for the plan', () => {
        jest.isolateModules(() => {
            delete process.env.STRIPE_PRICE_ID_ENTERPRISE;
            const lib = require('@/lib/stripe');
            expect(() => lib.getPriceId('ENTERPRISE')).toThrow(/No Stripe price configured/);
        });
    });
});

describe('findOrCreateCustomer', () => {
    it('short-circuits when a billing account already exists', async () => {
        db.billingAccount.findUnique.mockResolvedValue({ id: 'ba1', stripeCustomerId: 'cus_1' });
        const out = await stripeLib.findOrCreateCustomer('t1', 'Acme', 'a@x.io');
        expect(out).toEqual({ billingAccountId: 'ba1', stripeCustomerId: 'cus_1' });
        expect(stripeMock.customers.create).not.toHaveBeenCalled();
    });

    it('creates a Stripe customer + billing account when none exists', async () => {
        db.billingAccount.findUnique.mockResolvedValue(null);
        stripeMock.customers.create.mockResolvedValue({ id: 'cus_new' });
        db.billingAccount.create.mockResolvedValue({ id: 'ba_new' });
        const out = await stripeLib.findOrCreateCustomer('t1', 'Acme', 'a@x.io');
        expect(stripeMock.customers.create).toHaveBeenCalledWith(
            expect.objectContaining({ name: 'Acme', metadata: { tenantId: 't1' } }),
        );
        expect(out).toEqual({ billingAccountId: 'ba_new', stripeCustomerId: 'cus_new' });
    });
});

describe('createCheckoutSession / createPortalSession', () => {
    // PLAN_PRICE_MAP is built at module-load from env, so the price env
    // must be present BEFORE the module is required → isolateModules.
    function freshLib() {
        process.env.STRIPE_PRICE_ID_PRO = 'price_pro';
        let lib!: typeof import('@/lib/stripe');
        jest.isolateModules(() => {
            lib = require('@/lib/stripe');
        });
        return lib;
    }

    it('returns the checkout url', async () => {
        stripeMock.checkout.sessions.create.mockResolvedValue({ url: 'https://pay' });
        const url = await freshLib().createCheckoutSession('cus_1', 'PRO', 's', 'c');
        expect(url).toBe('https://pay');
    });

    it('throws when Stripe omits the checkout url', async () => {
        stripeMock.checkout.sessions.create.mockResolvedValue({ url: null });
        await expect(freshLib().createCheckoutSession('cus_1', 'PRO', 's', 'c')).rejects.toThrow(
            /did not return a checkout URL/,
        );
    });

    it('returns the portal url', async () => {
        stripeMock.billingPortal.sessions.create.mockResolvedValue({ url: 'https://portal' });
        expect(await stripeLib.createPortalSession('cus_1', 'r')).toBe('https://portal');
    });
});

describe('constructWebhookEvent', () => {
    it('throws when the webhook secret is unset', () => {
        jest.isolateModules(() => {
            delete process.env.STRIPE_WEBHOOK_SECRET;
            const lib = require('@/lib/stripe');
            expect(() => lib.constructWebhookEvent('p', 'sig')).toThrow(
                'STRIPE_WEBHOOK_SECRET is not configured',
            );
        });
    });

    it('delegates to the SDK verifier', () => {
        stripeMock.webhooks.constructEvent.mockReturnValue({ id: 'evt' });
        const out = stripeLib.constructWebhookEvent('payload', 'sig');
        expect(stripeMock.webhooks.constructEvent).toHaveBeenCalledWith('payload', 'sig', 'whsec_x');
        expect(out).toEqual({ id: 'evt' });
    });
});

describe('handleWebhookEvent', () => {
    const makeEvent = (type: string, object: Record<string, unknown>) =>
        ({ id: `evt-${type}`, type, data: { object } }) as never;

    it('skips an already-processed event (idempotency)', async () => {
        db.billingEvent.findUnique.mockResolvedValue({ id: 'seen' });
        await stripeLib.handleWebhookEvent(makeEvent('checkout.session.completed', {}));
        expect(db.billingAccount.update).not.toHaveBeenCalled();
    });

    it('checkout.session.completed updates plan/status and records the event', async () => {
        db.billingEvent.findUnique.mockResolvedValue(null);
        db.billingAccount.findUnique.mockResolvedValue({ tenantId: 't1' });
        stripeMock.subscriptions.retrieve.mockResolvedValue({
            id: 'sub_1',
            status: 'active',
            metadata: { plan: 'PRO' },
            items: { data: [{ current_period_end: 1_900_000_000 }] },
        });
        await stripeLib.handleWebhookEvent(
            makeEvent('checkout.session.completed', { customer: 'cus_1', subscription: 'sub_1' }),
        );
        expect(db.billingAccount.update).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ plan: 'PRO', status: 'ACTIVE' }) }),
        );
        expect(db.billingEvent.create).toHaveBeenCalled();
    });

    it('checkout.session.completed breaks early when customer/subscription missing', async () => {
        db.billingEvent.findUnique.mockResolvedValue(null);
        await stripeLib.handleWebhookEvent(makeEvent('checkout.session.completed', {}));
        expect(db.billingAccount.update).not.toHaveBeenCalled();
    });

    it('subscription.updated maps trialing + top-level period_end and unknown plan default', async () => {
        db.billingEvent.findUnique.mockResolvedValue(null);
        db.billingAccount.findUnique.mockResolvedValue({ tenantId: 't1' });
        await stripeLib.handleWebhookEvent(
            makeEvent('customer.subscription.updated', {
                id: 'sub_2',
                customer: 'cus_2',
                status: 'trialing',
                metadata: {},
                current_period_end: 1_800_000_000,
                trial_end: 1_810_000_000,
            }),
        );
        expect(db.billingAccount.update).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ plan: 'PRO', status: 'TRIALING' }) }),
        );
    });

    it('subscription.updated breaks when billing account is unknown', async () => {
        db.billingEvent.findUnique.mockResolvedValue(null);
        db.billingAccount.findUnique.mockResolvedValue(null);
        await stripeLib.handleWebhookEvent(
            makeEvent('customer.subscription.created', { id: 's', customer: 'cus_x', status: 'past_due', metadata: { plan: 'ENTERPRISE' } }),
        );
        expect(db.billingAccount.update).not.toHaveBeenCalled();
        expect(db.billingEvent.create).not.toHaveBeenCalled();
    });

    it('subscription.deleted marks CANCELED', async () => {
        db.billingEvent.findUnique.mockResolvedValue(null);
        db.billingAccount.findUnique.mockResolvedValue({ tenantId: 't1' });
        await stripeLib.handleWebhookEvent(
            makeEvent('customer.subscription.deleted', { id: 's', customer: 'cus_3', status: 'canceled' }),
        );
        expect(db.billingAccount.update).toHaveBeenCalledWith(
            expect.objectContaining({ data: { status: 'CANCELED', stripeSubscriptionId: null } }),
        );
    });

    it('invoice.payment_failed marks PAST_DUE', async () => {
        db.billingEvent.findUnique.mockResolvedValue(null);
        db.billingAccount.findUnique.mockResolvedValue({ tenantId: 't1', status: 'ACTIVE' });
        await stripeLib.handleWebhookEvent(
            makeEvent('invoice.payment_failed', { customer: 'cus_4' }),
        );
        expect(db.billingAccount.update).toHaveBeenCalledWith(
            expect.objectContaining({ data: { status: 'PAST_DUE' } }),
        );
    });

    it('invoice.payment_failed breaks when no customer id', async () => {
        db.billingEvent.findUnique.mockResolvedValue(null);
        await stripeLib.handleWebhookEvent(makeEvent('invoice.payment_failed', {}));
        expect(db.billingAccount.update).not.toHaveBeenCalled();
    });

    it('invoice.payment_succeeded reactivates a PAST_DUE account', async () => {
        db.billingEvent.findUnique.mockResolvedValue(null);
        db.billingAccount.findUnique.mockResolvedValue({ tenantId: 't1', status: 'PAST_DUE' });
        await stripeLib.handleWebhookEvent(
            makeEvent('invoice.payment_succeeded', { customer_id: 'cus_5' }),
        );
        expect(db.billingAccount.update).toHaveBeenCalledWith(
            expect.objectContaining({ data: { status: 'ACTIVE' } }),
        );
    });

    it('invoice.payment_succeeded does NOT reactivate an already-ACTIVE account', async () => {
        db.billingEvent.findUnique.mockResolvedValue(null);
        db.billingAccount.findUnique.mockResolvedValue({ tenantId: 't1', status: 'ACTIVE' });
        await stripeLib.handleWebhookEvent(
            makeEvent('invoice.payment_succeeded', { customer: 'cus_6' }),
        );
        expect(db.billingAccount.update).not.toHaveBeenCalled();
        expect(db.billingEvent.create).toHaveBeenCalled();
    });

    it('logs and ignores an unhandled event type (default arm)', async () => {
        db.billingEvent.findUnique.mockResolvedValue(null);
        await stripeLib.handleWebhookEvent(makeEvent('customer.created', {}));
        expect(db.billingAccount.update).not.toHaveBeenCalled();
    });
});
