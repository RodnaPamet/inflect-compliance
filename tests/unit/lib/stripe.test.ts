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
        updateMany: jest.fn(),
    },
    billingEvent: { findUnique: jest.fn(), create: jest.fn() },
};
jest.mock('@/lib/prisma', () => ({ __esModule: true, default: db, prisma: db }));

jest.mock('@/lib/observability/logger', () => ({
    logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import * as stripeLib from '@/lib/stripe';
import { logger } from '@/lib/observability/logger';

const OLD_ENV = process.env;

beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...OLD_ENV, STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_x' };
    // Reset the lazy singleton between cases that flip the key.
    jest.resetModules();
    // Every event but a checkout writes through the conditional updateMany.
    db.billingAccount.updateMany.mockResolvedValue({ count: 1 });
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

    it('gives an operator-made row a real customer instead of its manual: sentinel (#5120)', async () => {
        // changeTenantPlan writes `manual:<tenantId>`; Stripe refused every
        // checkout and portal session that named it.
        db.billingAccount.findUnique.mockResolvedValue({ id: 'ba_m', stripeCustomerId: 'manual:t1', plan: 'PRO' });
        stripeMock.customers.create.mockResolvedValue({ id: 'cus_real' });
        const out = await stripeLib.findOrCreateCustomer('t1', 'Acme', 'a@x.io');
        expect(out).toEqual({ billingAccountId: 'ba_m', stripeCustomerId: 'cus_real' });
        expect(db.billingAccount.update).toHaveBeenCalledWith({
            where: { id: 'ba_m' },
            data: { stripeCustomerId: 'cus_real' },
        });
        expect(db.billingAccount.create).not.toHaveBeenCalled();
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
        expect(db.billingAccount.updateMany).not.toHaveBeenCalled();
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
        const live = {
            id: 'sub_2',
            customer: 'cus_2',
            status: 'trialing',
            metadata: {},
            current_period_end: 1_800_000_000,
            trial_end: 1_810_000_000,
        };
        stripeMock.subscriptions.retrieve.mockResolvedValue(live);
        await stripeLib.handleWebhookEvent(makeEvent('customer.subscription.updated', live));
        expect(stripeMock.subscriptions.retrieve).toHaveBeenCalledWith('sub_2');
        expect(db.billingAccount.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ plan: 'PRO', status: 'TRIALING' }) }),
        );
    });

    it('subscription.updated breaks when billing account is unknown', async () => {
        db.billingEvent.findUnique.mockResolvedValue(null);
        db.billingAccount.findUnique.mockResolvedValue(null);
        await stripeLib.handleWebhookEvent(
            makeEvent('customer.subscription.created', { id: 's', customer: 'cus_x', status: 'past_due', metadata: { plan: 'ENTERPRISE' } }),
        );
        expect(stripeMock.subscriptions.retrieve).not.toHaveBeenCalled();
        expect(db.billingAccount.updateMany).not.toHaveBeenCalled();
        expect(db.billingEvent.create).not.toHaveBeenCalled();
    });

    it('subscription.deleted marks CANCELED', async () => {
        db.billingEvent.findUnique.mockResolvedValue(null);
        db.billingAccount.findUnique.mockResolvedValue({ tenantId: 't1', stripeSubscriptionId: 's' });
        stripeMock.subscriptions.retrieve.mockResolvedValue({ id: 's', customer: 'cus_3', status: 'canceled' });
        await stripeLib.handleWebhookEvent(
            makeEvent('customer.subscription.deleted', { id: 's', customer: 'cus_3', status: 'canceled' }),
        );
        expect(db.billingAccount.updateMany).toHaveBeenCalledWith({
            where: { stripeCustomerId: 'cus_3', stripeSubscriptionId: 's' },
            data: { status: 'CANCELED', plan: 'FREE', stripeSubscriptionId: null },
        });
    });

    it('an ended subscription entitles to FREE, whatever its metadata says (#5082)', async () => {
        // Entitlements read the plan alone, so a cancelled PRO tenant kept PRO.
        for (const status of ['canceled', 'incomplete_expired']) {
            jest.clearAllMocks();
            db.billingEvent.findUnique.mockResolvedValue(null);
            db.billingAccount.findUnique.mockResolvedValue({ tenantId: 't1', stripeSubscriptionId: 'sub_e' });
            const live = { id: 'sub_e', customer: 'cus_e', status, metadata: { plan: 'ENTERPRISE' } };
            stripeMock.subscriptions.retrieve.mockResolvedValue(live);
            await stripeLib.handleWebhookEvent(makeEvent('customer.subscription.updated', live));
            expect(db.billingAccount.updateMany).toHaveBeenCalledWith(
                expect.objectContaining({ data: { status: 'CANCELED', plan: 'FREE', stripeSubscriptionId: null } }),
            );
        }
    });

    it('a status this build does not know is not read as ACTIVE (#5082)', async () => {
        db.billingEvent.findUnique.mockResolvedValue(null);
        db.billingAccount.findUnique.mockResolvedValue({ tenantId: 't1' });
        const live = { id: 'sub_p', customer: 'cus_p', status: 'paused', metadata: { plan: 'PRO' } };
        stripeMock.subscriptions.retrieve.mockResolvedValue(live);
        await stripeLib.handleWebhookEvent(makeEvent('customer.subscription.updated', live));
        expect(db.billingAccount.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ status: 'INCOMPLETE' }) }),
        );
    });

    it('invoice.payment_failed applies the live past_due subscription as PAST_DUE', async () => {
        db.billingEvent.findUnique.mockResolvedValue(null);
        db.billingAccount.findUnique.mockResolvedValue({ tenantId: 't1', status: 'ACTIVE', stripeSubscriptionId: 'sub_4' });
        stripeMock.subscriptions.retrieve.mockResolvedValue({ id: 'sub_4', status: 'past_due', metadata: { plan: 'PRO' } });
        await stripeLib.handleWebhookEvent(
            makeEvent('invoice.payment_failed', { customer: 'cus_4', subscription: 'sub_4' }),
        );
        expect(stripeMock.subscriptions.retrieve).toHaveBeenCalledWith('sub_4');
        expect(db.billingAccount.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ status: 'PAST_DUE', plan: 'PRO' }) }),
        );
    });

    it('invoice.payment_failed breaks when no customer id', async () => {
        db.billingEvent.findUnique.mockResolvedValue(null);
        await stripeLib.handleWebhookEvent(makeEvent('invoice.payment_failed', {}));
        expect(db.billingAccount.updateMany).not.toHaveBeenCalled();
    });

    it('invoice.payment_succeeded reactivates a PAST_DUE account whose live subscription is active', async () => {
        db.billingEvent.findUnique.mockResolvedValue(null);
        db.billingAccount.findUnique.mockResolvedValue({ tenantId: 't1', status: 'PAST_DUE', stripeSubscriptionId: 'sub_5' });
        stripeMock.subscriptions.retrieve.mockResolvedValue({ id: 'sub_5', status: 'active', metadata: { plan: 'PRO' } });
        await stripeLib.handleWebhookEvent(
            makeEvent('invoice.payment_succeeded', {
                customer_id: 'cus_5',
                parent: { subscription_details: { subscription: 'sub_5' } },
            }),
        );
        expect(db.billingAccount.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ status: 'ACTIVE' }) }),
        );
    });

    it('invoice.payment_succeeded does not set ACTIVE while the live subscription is still past_due', async () => {
        // Another invoice on the subscription is still unpaid; the event's
        // type is not the subscription's state.
        db.billingEvent.findUnique.mockResolvedValue(null);
        db.billingAccount.findUnique.mockResolvedValue({ tenantId: 't1', status: 'PAST_DUE', stripeSubscriptionId: 'sub_6' });
        stripeMock.subscriptions.retrieve.mockResolvedValue({ id: 'sub_6', status: 'past_due', metadata: { plan: 'PRO' } });
        await stripeLib.handleWebhookEvent(
            makeEvent('invoice.payment_succeeded', { customer: 'cus_6', subscription: 'sub_6' }),
        );
        expect(db.billingAccount.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ status: 'PAST_DUE' }) }),
        );
        expect(db.billingEvent.create).toHaveBeenCalled();
    });

    it('logs and ignores an unhandled event type (default arm)', async () => {
        db.billingEvent.findUnique.mockResolvedValue(null);
        await stripeLib.handleWebhookEvent(makeEvent('customer.created', {}));
        expect(db.billingAccount.update).not.toHaveBeenCalled();
        expect(db.billingAccount.updateMany).not.toHaveBeenCalled();
    });
});

/**
 * #5316 item 28 (owner decision 2026-11-14). Stripe delivers webhook events
 * out of order and re-delivers late ones, so applying an event's embedded
 * subscription let an older event overwrite newer billing state. Every
 * subscription branch now re-fetches the live subscription and applies that.
 *
 * These cases run ORDERED SEQUENCES of events against a stateful fake billing
 * row and a Stripe mock whose `retrieve` answers the live state, and assert
 * the state the sequence ends in.
 */
describe('handleWebhookEvent applies the live subscription, never the event snapshot (#5316)', () => {
    type Row = {
        tenantId: string;
        stripeCustomerId: string;
        stripeSubscriptionId: string | null;
        plan: string;
        status: string;
    };
    let row: Row;
    let seenEvents: Set<string>;

    const event = (id: string, type: string, object: Record<string, unknown>) =>
        ({ id, type, data: { object } }) as never;

    beforeEach(() => {
        row = {
            tenantId: 't1',
            stripeCustomerId: 'cus_1',
            stripeSubscriptionId: null,
            plan: 'FREE',
            status: 'ACTIVE',
        };
        seenEvents = new Set();
        db.billingAccount.findUnique.mockImplementation(
            async ({ where }: { where: { stripeCustomerId: string } }) =>
                where.stripeCustomerId === row.stripeCustomerId ? { ...row } : null,
        );
        db.billingAccount.update.mockImplementation(
            async ({ data }: { data: Partial<Row> }) => {
                row = { ...row, ...data };
                return { ...row };
            },
        );
        db.billingAccount.updateMany.mockImplementation(
            async ({ where, data }: { where: Partial<Row>; data: Partial<Row> }) => {
                const matches = (Object.keys(where) as Array<keyof Row>).every((k) => where[k] === row[k]);
                if (!matches) return { count: 0 };
                row = { ...row, ...data };
                return { count: 1 };
            },
        );
        db.billingEvent.findUnique.mockImplementation(
            async ({ where }: { where: { stripeEventId: string } }) =>
                seenEvents.has(where.stripeEventId) ? { id: where.stripeEventId } : null,
        );
        db.billingEvent.create.mockImplementation(
            async ({ data }: { data: { stripeEventId: string } }) => {
                seenEvents.add(data.stripeEventId);
                return { id: data.stripeEventId };
            },
        );
    });

    it('a late customer.subscription.created (incomplete) does not undo a completed checkout', async () => {
        // Live: the checkout has completed and the subscription is active.
        stripeMock.subscriptions.retrieve.mockResolvedValue({
            id: 'sub_1', customer: 'cus_1', status: 'active', metadata: { plan: 'PRO' },
        });

        await stripeLib.handleWebhookEvent(
            event('evt_checkout', 'checkout.session.completed', { customer: 'cus_1', subscription: 'sub_1' }),
        );
        expect(row).toMatchObject({ status: 'ACTIVE', plan: 'PRO', stripeSubscriptionId: 'sub_1' });

        // The earlier created event arrives late, carrying the old snapshot.
        await stripeLib.handleWebhookEvent(
            event('evt_created', 'customer.subscription.created', {
                id: 'sub_1', customer: 'cus_1', status: 'incomplete', metadata: { plan: 'PRO' },
            }),
        );

        expect(row).toMatchObject({ status: 'ACTIVE', plan: 'PRO', stripeSubscriptionId: 'sub_1' });
        expect(stripeMock.subscriptions.retrieve).toHaveBeenCalledTimes(2);
    });

    it('a delayed customer.subscription.updated after the deletion does not revive the subscription', async () => {
        row = { ...row, stripeSubscriptionId: 'sub_1', plan: 'PRO', status: 'ACTIVE' };
        // Live: the subscription has been cancelled.
        stripeMock.subscriptions.retrieve.mockResolvedValue({
            id: 'sub_1', customer: 'cus_1', status: 'canceled', metadata: { plan: 'PRO' },
        });

        await stripeLib.handleWebhookEvent(
            event('evt_deleted', 'customer.subscription.deleted', {
                id: 'sub_1', customer: 'cus_1', status: 'canceled', metadata: { plan: 'PRO' },
            }),
        );
        expect(row).toMatchObject({ status: 'CANCELED', plan: 'FREE', stripeSubscriptionId: null });

        // An update from before the cancellation arrives late, still saying active.
        await stripeLib.handleWebhookEvent(
            event('evt_updated', 'customer.subscription.updated', {
                id: 'sub_1', customer: 'cus_1', status: 'active', metadata: { plan: 'PRO' },
            }),
        );

        expect(row).toMatchObject({ status: 'CANCELED', plan: 'FREE', stripeSubscriptionId: null });
    });

    it('a retrieve failure other than resource_missing writes nothing and propagates', async () => {
        row = { ...row, stripeSubscriptionId: 'sub_1', plan: 'PRO', status: 'ACTIVE' };
        const before = { ...row };
        for (const failure of [
            new Error('socket hang up'),
            Object.assign(new Error('Too many requests'), { type: 'StripeRateLimitError', code: 'rate_limit', statusCode: 429 }),
        ]) {
            stripeMock.subscriptions.retrieve.mockRejectedValueOnce(failure);
            await expect(
                stripeLib.handleWebhookEvent(
                    event('evt_upd_fail', 'customer.subscription.updated', {
                        id: 'sub_1', customer: 'cus_1', status: 'canceled', metadata: {},
                    }),
                ),
            ).rejects.toBeInstanceOf(stripeLib.SubscriptionRefetchError);
        }

        expect(db.billingAccount.updateMany).not.toHaveBeenCalled();
        expect(db.billingEvent.create).not.toHaveBeenCalled();
        expect(row).toEqual(before);
        // Not recorded as processed, so Stripe's re-delivery is not skipped.
        expect(seenEvents.has('evt_upd_fail')).toBe(false);
    });

    it('a failed retrieve on checkout.session.completed also writes nothing and propagates', async () => {
        stripeMock.subscriptions.retrieve.mockRejectedValueOnce(new Error('ECONNRESET'));
        await expect(
            stripeLib.handleWebhookEvent(
                event('evt_co_fail', 'checkout.session.completed', { customer: 'cus_1', subscription: 'sub_1' }),
            ),
        ).rejects.toBeInstanceOf(stripeLib.SubscriptionRefetchError);
        expect(db.billingAccount.update).not.toHaveBeenCalled();
        expect(db.billingEvent.create).not.toHaveBeenCalled();
    });

    it('Stripe answering resource_missing is applied as a deletion', async () => {
        row = { ...row, stripeSubscriptionId: 'sub_1', plan: 'PRO', status: 'ACTIVE' };
        stripeMock.subscriptions.retrieve.mockRejectedValue(
            Object.assign(new Error('No such subscription: sub_1'), {
                type: 'StripeInvalidRequestError',
                code: 'resource_missing',
                statusCode: 404,
            }),
        );

        await stripeLib.handleWebhookEvent(
            event('evt_upd_missing', 'customer.subscription.updated', {
                id: 'sub_1', customer: 'cus_1', status: 'active', metadata: { plan: 'PRO' },
            }),
        );

        expect(db.billingAccount.updateMany).toHaveBeenCalledWith({
            where: { stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_1' },
            data: { status: 'CANCELED', plan: 'FREE', stripeSubscriptionId: null },
        });
        expect(row).toMatchObject({ status: 'CANCELED', plan: 'FREE', stripeSubscriptionId: null });
        expect(seenEvents.has('evt_upd_missing')).toBe(true);
    });

    it('an idempotent re-delivery still skips before any re-fetch', async () => {
        seenEvents.add('evt_dup');
        await stripeLib.handleWebhookEvent(
            event('evt_dup', 'customer.subscription.updated', { id: 'sub_1', customer: 'cus_1', status: 'active' }),
        );
        expect(stripeMock.subscriptions.retrieve).not.toHaveBeenCalled();
        expect(db.billingAccount.updateMany).not.toHaveBeenCalled();
    });
});

/**
 * #5316 item 28 follow-ups (owner decisions 2026-11-14): a subscription event
 * is applied only when it concerns the stored subscription, and the invoice
 * branches re-fetch the subscription the invoice names instead of writing a
 * status chosen by the event type.
 */
describe('handleWebhookEvent follow-ups: stored subscription and invoices (#5316)', () => {
    type Row = {
        tenantId: string;
        stripeCustomerId: string;
        stripeSubscriptionId: string | null;
        plan: string;
        status: string;
    };
    let row: Row;
    let seenEvents: Set<string>;

    const event = (id: string, type: string, object: Record<string, unknown>) =>
        ({ id, type, data: { object } }) as never;

    beforeEach(() => {
        row = {
            tenantId: 't1',
            stripeCustomerId: 'cus_1',
            stripeSubscriptionId: null,
            plan: 'FREE',
            status: 'ACTIVE',
        };
        seenEvents = new Set();
        db.billingAccount.findUnique.mockImplementation(
            async ({ where }: { where: { stripeCustomerId: string } }) =>
                where.stripeCustomerId === row.stripeCustomerId ? { ...row } : null,
        );
        db.billingAccount.update.mockImplementation(
            async ({ data }: { data: Partial<Row> }) => {
                row = { ...row, ...data };
                return { ...row };
            },
        );
        db.billingAccount.updateMany.mockImplementation(
            async ({ where, data }: { where: Partial<Row>; data: Partial<Row> }) => {
                const matches = (Object.keys(where) as Array<keyof Row>).every((k) => where[k] === row[k]);
                if (!matches) return { count: 0 };
                row = { ...row, ...data };
                return { count: 1 };
            },
        );
        db.billingEvent.findUnique.mockImplementation(
            async ({ where }: { where: { stripeEventId: string } }) =>
                seenEvents.has(where.stripeEventId) ? { id: where.stripeEventId } : null,
        );
        db.billingEvent.create.mockImplementation(
            async ({ data }: { data: { stripeEventId: string } }) => {
                seenEvents.add(data.stripeEventId);
                return { id: data.stripeEventId };
            },
        );
    });

    it('a DB error in the account write propagates and records no BillingEvent', async () => {
        row = { ...row, stripeSubscriptionId: 'sub_1', plan: 'PRO', status: 'ACTIVE' };
        stripeMock.subscriptions.retrieve.mockResolvedValue({
            id: 'sub_1', customer: 'cus_1', status: 'past_due', metadata: { plan: 'PRO' },
        });
        db.billingAccount.updateMany.mockRejectedValueOnce(new Error('connection terminated'));

        await expect(
            stripeLib.handleWebhookEvent(
                event('evt_db_fail', 'customer.subscription.updated', { id: 'sub_1', customer: 'cus_1' }),
            ),
        ).rejects.toThrow('connection terminated');

        expect(db.billingEvent.create).not.toHaveBeenCalled();
        expect(seenEvents.has('evt_db_fail')).toBe(false);
    });

    it('a subscription event about another subscription is recorded, changes nothing, and is not re-fetched', async () => {
        row = { ...row, stripeSubscriptionId: 'sub_new', plan: 'PRO', status: 'ACTIVE' };
        const before = { ...row };
        // Live: the old subscription has ended. Applying it would downgrade.
        stripeMock.subscriptions.retrieve.mockResolvedValue({
            id: 'sub_old', customer: 'cus_1', status: 'canceled', metadata: { plan: 'PRO' },
        });

        for (const type of ['customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted']) {
            await stripeLib.handleWebhookEvent(
                event(`evt_old_${type}`, type, { id: 'sub_old', customer: 'cus_1', status: 'canceled' }),
            );
            expect(seenEvents.has(`evt_old_${type}`)).toBe(true);
        }

        expect(row).toEqual(before);
        expect(db.billingAccount.updateMany).not.toHaveBeenCalled();
        expect(stripeMock.subscriptions.retrieve).not.toHaveBeenCalled();
        expect(logger.info).toHaveBeenCalledWith(
            expect.stringMatching(/non-current subscription/),
            expect.objectContaining({ eventType: 'customer.subscription.deleted' }),
        );
    });

    it('checkout.session.completed is exempt: it sets the new subscription over the stored one', async () => {
        row = { ...row, stripeSubscriptionId: 'sub_old', plan: 'PRO', status: 'CANCELED' };
        stripeMock.subscriptions.retrieve.mockResolvedValue({
            id: 'sub_new', customer: 'cus_1', status: 'active', metadata: { plan: 'ENTERPRISE' },
        });

        await stripeLib.handleWebhookEvent(
            event('evt_co_new', 'checkout.session.completed', { customer: 'cus_1', subscription: 'sub_new' }),
        );

        expect(row).toMatchObject({ stripeSubscriptionId: 'sub_new', plan: 'ENTERPRISE', status: 'ACTIVE' });
    });

    it('a late invoice.payment_failed on a cancelled account does not set PAST_DUE', async () => {
        row = { ...row, stripeSubscriptionId: null, plan: 'FREE', status: 'CANCELED' };
        stripeMock.subscriptions.retrieve.mockResolvedValue({
            id: 'sub_1', customer: 'cus_1', status: 'canceled', metadata: { plan: 'PRO' },
        });

        await stripeLib.handleWebhookEvent(
            event('evt_inv_late', 'invoice.payment_failed', {
                customer: 'cus_1',
                parent: { subscription_details: { subscription: 'sub_1' } },
            }),
        );

        expect(row).toMatchObject({ status: 'CANCELED', plan: 'FREE', stripeSubscriptionId: null });
    });

    it('an invoice that names no subscription changes nothing', async () => {
        row = { ...row, stripeSubscriptionId: 'sub_1', plan: 'PRO', status: 'ACTIVE' };
        const before = { ...row };

        for (const type of ['invoice.payment_failed', 'invoice.payment_succeeded']) {
            await stripeLib.handleWebhookEvent(
                event(`evt_inv_nosub_${type}`, type, { customer: 'cus_1', parent: null }),
            );
        }

        expect(row).toEqual(before);
        expect(db.billingAccount.updateMany).not.toHaveBeenCalled();
        expect(stripeMock.subscriptions.retrieve).not.toHaveBeenCalled();
    });

    it.each([
        ['invoice.subscription as a string (older API versions)', { subscription: 'sub_1' }],
        ['invoice.subscription as an object', { subscription: { id: 'sub_1', object: 'subscription' } }],
        ['parent.subscription_details.subscription as a string', { parent: { subscription_details: { subscription: 'sub_1' } } }],
        ['parent.subscription_details.subscription as an object', { parent: { subscription_details: { subscription: { id: 'sub_1' } } } }],
    ])('reads the invoice subscription from %s and applies the live state', async (_label, shape) => {
        row = { ...row, stripeSubscriptionId: 'sub_1', plan: 'PRO', status: 'ACTIVE' };
        stripeMock.subscriptions.retrieve.mockResolvedValue({
            id: 'sub_1', customer: 'cus_1', status: 'past_due', metadata: { plan: 'PRO' },
        });

        await stripeLib.handleWebhookEvent(
            event('evt_inv_shape', 'invoice.payment_failed', { customer: 'cus_1', ...shape }),
        );

        expect(stripeMock.subscriptions.retrieve).toHaveBeenCalledWith('sub_1');
        expect(row).toMatchObject({ status: 'PAST_DUE', plan: 'PRO', stripeSubscriptionId: 'sub_1' });
    });

    it('invoice.payment_succeeded applies the live state, not ACTIVE by event type', async () => {
        row = { ...row, stripeSubscriptionId: 'sub_1', plan: 'PRO', status: 'PAST_DUE' };
        stripeMock.subscriptions.retrieve.mockResolvedValue({
            id: 'sub_1', customer: 'cus_1', status: 'active', metadata: { plan: 'PRO' },
        });
        await stripeLib.handleWebhookEvent(
            event('evt_inv_ok', 'invoice.payment_succeeded', { customer: 'cus_1', subscription: 'sub_1' }),
        );
        expect(stripeMock.subscriptions.retrieve).toHaveBeenCalledWith('sub_1');
        expect(row).toMatchObject({ status: 'ACTIVE', plan: 'PRO' });
        expect(seenEvents.has('evt_inv_ok')).toBe(true);
    });

    it('an invoice about another subscription is recorded and changes nothing', async () => {
        row = { ...row, stripeSubscriptionId: 'sub_new', plan: 'PRO', status: 'ACTIVE' };
        const before = { ...row };
        await stripeLib.handleWebhookEvent(
            event('evt_inv_old', 'invoice.payment_failed', { customer: 'cus_1', subscription: 'sub_old' }),
        );
        expect(row).toEqual(before);
        expect(stripeMock.subscriptions.retrieve).not.toHaveBeenCalled();
        expect(seenEvents.has('evt_inv_old')).toBe(true);
    });
});

/**
 * #5316 item 28, second round of owner decisions (2026-11-14):
 *   1. With no stored subscription, an ended live subscription changes
 *      nothing: writing it reset an operator-set plan to FREE.
 *   2. The account write is conditional on the stored subscription id read
 *      before the Stripe round trip, so a checkout committing in between is
 *      not overwritten by an older event.
 */
describe('handleWebhookEvent: null stored subscription and the conditional write (#5316)', () => {
    type Row = {
        tenantId: string;
        stripeCustomerId: string;
        stripeSubscriptionId: string | null;
        plan: string;
        status: string;
    };
    let row: Row;
    let seenEvents: Set<string>;

    const event = (id: string, type: string, object: Record<string, unknown>) =>
        ({ id, type, data: { object } }) as never;

    beforeEach(() => {
        row = {
            tenantId: 't1',
            stripeCustomerId: 'cus_1',
            stripeSubscriptionId: null,
            plan: 'FREE',
            status: 'ACTIVE',
        };
        seenEvents = new Set();
        db.billingAccount.findUnique.mockImplementation(
            async ({ where }: { where: { stripeCustomerId: string } }) =>
                where.stripeCustomerId === row.stripeCustomerId ? { ...row } : null,
        );
        db.billingAccount.update.mockImplementation(
            async ({ data }: { data: Partial<Row> }) => {
                row = { ...row, ...data };
                return { ...row };
            },
        );
        // Matches the row only when every field the WHERE names agrees,
        // including a null `stripeSubscriptionId` (Prisma's IS NULL).
        db.billingAccount.updateMany.mockImplementation(
            async ({ where, data }: { where: Partial<Row>; data: Partial<Row> }) => {
                const matches = (Object.keys(where) as Array<keyof Row>).every((k) => where[k] === row[k]);
                if (!matches) return { count: 0 };
                row = { ...row, ...data };
                return { count: 1 };
            },
        );
        db.billingEvent.findUnique.mockImplementation(
            async ({ where }: { where: { stripeEventId: string } }) =>
                seenEvents.has(where.stripeEventId) ? { id: where.stripeEventId } : null,
        );
        db.billingEvent.create.mockImplementation(
            async ({ data }: { data: { stripeEventId: string } }) => {
                seenEvents.add(data.stripeEventId);
                return { id: data.stripeEventId };
            },
        );
    });

    it('an operator-set ENTERPRISE plan with no stored subscription survives late events about the old one', async () => {
        // `changeTenantPlan` writes the plan and leaves the subscription id
        // null after the subscription ended.
        row = { ...row, stripeSubscriptionId: null, plan: 'ENTERPRISE', status: 'CANCELED' };
        const before = { ...row };
        stripeMock.subscriptions.retrieve.mockResolvedValue({
            id: 'sub_old', customer: 'cus_1', status: 'canceled', metadata: { plan: 'PRO' },
        });

        await stripeLib.handleWebhookEvent(
            event('evt_late_deleted', 'customer.subscription.deleted', { id: 'sub_old', customer: 'cus_1' }),
        );
        await stripeLib.handleWebhookEvent(
            event('evt_late_updated', 'customer.subscription.updated', { id: 'sub_old', customer: 'cus_1', status: 'canceled' }),
        );
        await stripeLib.handleWebhookEvent(
            event('evt_late_invoice', 'invoice.payment_failed', { customer: 'cus_1', subscription: 'sub_old' }),
        );

        expect(row).toEqual(before);
        for (const id of ['evt_late_deleted', 'evt_late_updated', 'evt_late_invoice']) {
            expect(seenEvents.has(id)).toBe(true);
        }
        expect(logger.info).toHaveBeenCalledWith(
            expect.stringMatching(/stores no subscription/),
            expect.objectContaining({ eventId: 'evt_late_invoice', eventType: 'invoice.payment_failed' }),
        );
    });

    it('a subscription Stripe no longer has is not applied to an account that stores none', async () => {
        row = { ...row, stripeSubscriptionId: null, plan: 'ENTERPRISE', status: 'ACTIVE' };
        const before = { ...row };
        stripeMock.subscriptions.retrieve.mockRejectedValue(
            Object.assign(new Error('No such subscription'), { code: 'resource_missing', statusCode: 404 }),
        );

        await stripeLib.handleWebhookEvent(
            event('evt_missing', 'customer.subscription.updated', { id: 'sub_old', customer: 'cus_1' }),
        );

        expect(row).toEqual(before);
        expect(seenEvents.has('evt_missing')).toBe(true);
    });

    it('a never-subscribed FREE/ACTIVE account stays ACTIVE on a late deletion', async () => {
        const before = { ...row };
        stripeMock.subscriptions.retrieve.mockResolvedValue({
            id: 'sub_x', customer: 'cus_1', status: 'incomplete_expired', metadata: {},
        });

        await stripeLib.handleWebhookEvent(
            event('evt_never', 'customer.subscription.deleted', { id: 'sub_x', customer: 'cus_1' }),
        );

        expect(row).toEqual(before);
        expect(row.status).toBe('ACTIVE');
    });

    it('a null stored id with a live ACTIVE subscription is still applied', async () => {
        stripeMock.subscriptions.retrieve.mockResolvedValue({
            id: 'sub_1', customer: 'cus_1', status: 'active', metadata: { plan: 'PRO' },
        });

        await stripeLib.handleWebhookEvent(
            event('evt_created', 'customer.subscription.created', { id: 'sub_1', customer: 'cus_1' }),
        );

        expect(row).toMatchObject({ stripeSubscriptionId: 'sub_1', plan: 'PRO', status: 'ACTIVE' });
    });

    it.each([
        ['customer.subscription.deleted', 'canceled'],
        ['customer.subscription.updated', 'active'],
        ['invoice.payment_failed', 'past_due'],
    ])('a checkout committing a new subscription during the re-fetch is not overwritten by a late %s', async (type, liveStatus) => {
        row = { ...row, stripeSubscriptionId: 'sub_old', plan: 'PRO', status: 'ACTIVE' };
        stripeMock.subscriptions.retrieve.mockImplementationOnce(async () => {
            // The new checkout commits while Stripe is being asked.
            row = { ...row, stripeSubscriptionId: 'sub_new', plan: 'ENTERPRISE', status: 'ACTIVE' };
            return { id: 'sub_old', customer: 'cus_1', status: liveStatus, metadata: { plan: 'PRO' } };
        });
        const object = type.startsWith('invoice.')
            ? { customer: 'cus_1', subscription: 'sub_old' }
            : { id: 'sub_old', customer: 'cus_1' };

        await stripeLib.handleWebhookEvent(event(`evt_race_${type}`, type, object));

        expect(row).toMatchObject({ stripeSubscriptionId: 'sub_new', plan: 'ENTERPRISE', status: 'ACTIVE' });
        // Superseded state is recorded as processed: a re-delivery would find
        // the new subscription stored and be ignored anyway.
        expect(seenEvents.has(`evt_race_${type}`)).toBe(true);
        expect(logger.info).toHaveBeenCalledWith(
            expect.stringMatching(/changed during the re-fetch/),
            expect.objectContaining({ eventType: type }),
        );
    });

    it('checkout.session.completed overwrites whatever is stored, even if it changed during the re-fetch', async () => {
        row = { ...row, stripeSubscriptionId: 'sub_old', plan: 'PRO', status: 'ACTIVE' };
        stripeMock.subscriptions.retrieve.mockImplementationOnce(async () => {
            // The old subscription's deletion commits while Stripe is asked.
            row = { ...row, stripeSubscriptionId: null, plan: 'FREE', status: 'CANCELED' };
            return { id: 'sub_new', customer: 'cus_1', status: 'active', metadata: { plan: 'ENTERPRISE' } };
        });

        await stripeLib.handleWebhookEvent(
            event('evt_co', 'checkout.session.completed', { customer: 'cus_1', subscription: 'sub_new' }),
        );

        expect(row).toMatchObject({ stripeSubscriptionId: 'sub_new', plan: 'ENTERPRISE', status: 'ACTIVE' });
    });
});
