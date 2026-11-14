import Stripe from 'stripe';
import prisma from '@/lib/prisma';
import { logger } from '@/lib/observability/logger';
import { isManualCustomerId } from '@/lib/billing/manual-customer';
import { DomainError } from '@/lib/errors/types';

// ─── Types (matching Prisma enums, duplicated so we don't depend on generated client at import time) ───

type BillingPlan = 'FREE' | 'TRIAL' | 'PRO' | 'ENTERPRISE';
type BillingStatus = 'ACTIVE' | 'PAST_DUE' | 'CANCELED' | 'INCOMPLETE' | 'TRIALING';

// ─── Lazy Stripe client ───

let _stripe: Stripe | null = null;

export function getStripe(): Stripe {
    if (_stripe) return _stripe;
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error('STRIPE_SECRET_KEY is not configured');
    _stripe = new Stripe(key);
    return _stripe;
}

// ─── Price mapping ───

const PLAN_PRICE_MAP: Record<string, string | undefined> = {
    PRO: process.env.STRIPE_PRICE_ID_PRO,
    ENTERPRISE: process.env.STRIPE_PRICE_ID_ENTERPRISE,
};

export function getPriceId(plan: 'PRO' | 'ENTERPRISE'): string {
    const priceId = PLAN_PRICE_MAP[plan];
    if (!priceId) throw new Error(`No Stripe price configured for plan: ${plan}`);
    return priceId;
}

// ─── Customer helpers ───

export async function findOrCreateCustomer(
    tenantId: string,
    tenantName: string,
    adminEmail: string,
): Promise<{ billingAccountId: string; stripeCustomerId: string }> {
    const stripe = getStripe();

    // Check for existing billing account
    const existing = await prisma.billingAccount.findUnique({
        where: { tenantId },
    });

    // A row an operator created with `changeTenantPlan` carries a
    // `manual:<tenantId>` sentinel, not a Stripe customer, and Stripe refused
    // every checkout and portal session for it (#5120). Such a row is given a
    // real customer here; its plan is left as the operator set it.
    if (existing && !isManualCustomerId(existing.stripeCustomerId)) {
        return {
            billingAccountId: existing.id,
            stripeCustomerId: existing.stripeCustomerId,
        };
    }

    // Create Stripe customer
    const customer = await stripe.customers.create({
        name: tenantName,
        email: adminEmail,
        metadata: { tenantId },
    });

    if (existing) {
        await prisma.billingAccount.update({
            where: { id: existing.id },
            data: { stripeCustomerId: customer.id },
        });
        return { billingAccountId: existing.id, stripeCustomerId: customer.id };
    }

    // Create billing account
    const billingAccount = await prisma.billingAccount.create({
        data: {
            tenantId,
            stripeCustomerId: customer.id,
            plan: 'FREE',
            status: 'ACTIVE',
        },
    });

    return {
        billingAccountId: billingAccount.id,
        stripeCustomerId: customer.id,
    };
}

// ─── Checkout Session ───

export async function createCheckoutSession(
    stripeCustomerId: string,
    plan: 'PRO' | 'ENTERPRISE',
    successUrl: string,
    cancelUrl: string,
): Promise<string> {
    const stripe = getStripe();
    const priceId = getPriceId(plan);

    const session = await stripe.checkout.sessions.create({
        customer: stripeCustomerId,
        mode: 'subscription',
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: successUrl,
        cancel_url: cancelUrl,
        subscription_data: {
            metadata: { plan },
        },
    });

    if (!session.url) throw new Error('Stripe did not return a checkout URL');
    return session.url;
}

// ─── Customer Portal ───

export async function createPortalSession(
    stripeCustomerId: string,
    returnUrl: string,
): Promise<string> {
    const stripe = getStripe();

    const session = await stripe.billingPortal.sessions.create({
        customer: stripeCustomerId,
        return_url: returnUrl,
    });

    return session.url;
}

// ─── Webhook signature verification ───

export function constructWebhookEvent(
    payload: string | Buffer,
    signature: string,
): Stripe.Event {
    const stripe = getStripe();
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) throw new Error('STRIPE_WEBHOOK_SECRET is not configured');
    return stripe.webhooks.constructEvent(payload, signature, secret);
}

// ─── Stripe subscription status → BillingStatus mapping ───

function mapStripeStatus(status: string): BillingStatus {
    switch (status) {
        case 'active': return 'ACTIVE';
        case 'past_due': return 'PAST_DUE';
        case 'canceled': return 'CANCELED';
        case 'incomplete': return 'INCOMPLETE';
        case 'trialing': return 'TRIALING';
        case 'incomplete_expired': return 'CANCELED';
        case 'unpaid': return 'PAST_DUE';
        // A status this build does not know (Stripe's `paused`, or one added
        // later) is not evidence of a paying subscription (#5082).
        default: return 'INCOMPLETE';
    }
}

// ─── Stripe plan metadata → BillingPlan mapping ───

function mapStripePlan(metadata: Record<string, string> | null): BillingPlan {
    const plan = metadata?.plan;
    if (plan === 'PRO') return 'PRO';
    if (plan === 'ENTERPRISE') return 'ENTERPRISE';
    return 'PRO'; // default for new subscriptions
}

/**
 * The plan a subscription in this state entitles its tenant to.
 *
 * Entitlements read `BillingAccount.plan` and nothing else (docs/billing.md),
 * so the webhook is what moves a tenant back to FREE when a subscription ends.
 * It wrote only the status, and a cancelled PRO tenant kept PRO for good
 * (#5082). An ended subscription (`canceled`, `incomplete_expired`) entitles
 * to FREE; any other keeps the plan its metadata names.
 */
function planForSubscription(sub: Record<string, unknown>): BillingPlan {
    return mapStripeStatus(sub.status as string) === 'CANCELED'
        ? 'FREE'
        : mapStripePlan(sub.metadata as Record<string, string> | null);
}

// ─── Subscription period helpers ───
// Stripe v20 moved current_period_end to subscription items.
// We extract it from items or fall back to a safe default.

function getSubscriptionPeriodEnd(sub: Record<string, unknown>): Date | null {
    // Try top-level (older API versions)
    if (typeof sub.current_period_end === 'number') {
        return new Date(sub.current_period_end * 1000);
    }
    // Try items array (Stripe v20+)
    const items = sub.items as { data?: Array<{ current_period_end?: number }> } | undefined;
    if (items?.data?.[0]?.current_period_end) {
        return new Date(items.data[0].current_period_end * 1000);
    }
    return null;
}

function getSubscriptionTrialEnd(sub: Record<string, unknown>): Date | null {
    if (typeof sub.trial_end === 'number') {
        return new Date(sub.trial_end * 1000);
    }
    return null;
}

const db = prisma;

// ─── Live subscription re-fetch (#5316 item 28) ───
//
// Stripe does not deliver webhook events in order, and it re-delivers late
// ones. A handler that applied the snapshot embedded in its event let an
// older event overwrite newer state: `customer.subscription.created`
// (status `incomplete`) arriving after `checkout.session.completed` had
// stored ACTIVE, or a delayed `customer.subscription.updated` arriving after
// `customer.subscription.deleted` and writing the ended subscription back as
// ACTIVE. So every subscription branch reads the subscription as Stripe
// holds it NOW and applies that; an event only says which subscription to
// look at, and the order events arrive in decides nothing.

/**
 * Thrown when the live subscription cannot be read for any reason other than
 * Stripe answering that it no longer exists. Nothing has been written; the
 * webhook route answers non-2xx so Stripe delivers the event again.
 */
export class SubscriptionRefetchError extends DomainError {
    constructor(subscriptionId: string, cause: unknown) {
        super(
            `Could not re-fetch Stripe subscription ${subscriptionId}`,
            'EXTERNAL_SERVICE_ERROR',
            503,
            { cause: cause instanceof Error ? cause.message : String(cause) },
        );
        this.name = 'SubscriptionRefetchError';
    }
}

/** Stripe's own answer that the object does not exist. */
function isResourceMissing(err: unknown): boolean {
    return (
        typeof err === 'object' &&
        err !== null &&
        (err as { code?: unknown }).code === 'resource_missing'
    );
}

/**
 * The subscription as Stripe holds it now, or `null` when Stripe answers
 * that it no longer exists. Any other failure throws
 * {@link SubscriptionRefetchError} before anything is written.
 */
async function retrieveLiveSubscription(
    subscriptionId: string,
): Promise<Record<string, unknown> | null> {
    try {
        const stripe = getStripe();
        const subResponse = await stripe.subscriptions.retrieve(subscriptionId);
        return subResponse as unknown as Record<string, unknown>;
    } catch (err) {
        if (isResourceMissing(err)) return null;
        throw new SubscriptionRefetchError(subscriptionId, err);
    }
}

/** A live status that means the subscription has ended. */
const ENDED_SUBSCRIPTION_STATUSES: ReadonlySet<string> = new Set(['canceled', 'incomplete_expired']);

/**
 * Re-fetch the subscription an event names and apply Stripe's current state
 * to the customer's billing account. A subscription that has ended, or that
 * Stripe no longer has, is applied as a deletion: the same write the
 * `customer.subscription.deleted` branch made before #5316.
 */
async function applyLiveSubscription(customerId: string, subscriptionId: string): Promise<void> {
    const sub = await retrieveLiveSubscription(subscriptionId);

    if (sub === null || ENDED_SUBSCRIPTION_STATUSES.has(sub.status as string)) {
        await db.billingAccount.update({
            where: { stripeCustomerId: customerId },
            data: {
                status: 'CANCELED',
                // The subscription is gone, so is what it paid for (#5082).
                plan: 'FREE',
                stripeSubscriptionId: null,
            },
        });
        return;
    }

    await db.billingAccount.update({
        where: { stripeCustomerId: customerId },
        data: {
            stripeSubscriptionId: subscriptionId,
            plan: planForSubscription(sub),
            status: mapStripeStatus(sub.status as string),
            currentPeriodEnd: getSubscriptionPeriodEnd(sub),
            trialEndsAt: getSubscriptionTrialEnd(sub),
        },
    });
}

// ─── Event processor (source of truth for billing state) ───

export async function handleWebhookEvent(event: Stripe.Event): Promise<void> {
    // Idempotency: skip if already processed
    const existingEvent = await db.billingEvent.findUnique({
        where: { stripeEventId: event.id },
    });
    if (existingEvent) {
        logger.debug('Skipping duplicate event', { component: 'billing', eventId: event.id, eventType: event.type });
        return;
    }

    switch (event.type) {
        case 'checkout.session.completed': {
            const session = event.data.object as Stripe.Checkout.Session;
            const customerId = session.customer as string;
            const subscriptionId = session.subscription as string;
            if (!customerId || !subscriptionId) break;

            const billingAccount = await db.billingAccount.findUnique({
                where: { stripeCustomerId: customerId },
            });
            if (!billingAccount) break;

            await applyLiveSubscription(customerId, subscriptionId);

            await db.billingEvent.create({
                data: {
                    tenantId: billingAccount.tenantId,
                    type: event.type,
                    stripeEventId: event.id,
                    payloadJson: JSON.parse(JSON.stringify(event.data.object)),
                },
            });
            break;
        }

        // The subscription embedded in these events is never applied: it can
        // be older than the state already stored. The event names the
        // subscription; Stripe's live answer is what is written (#5316).
        case 'customer.subscription.created':
        case 'customer.subscription.updated':
        case 'customer.subscription.deleted': {
            const eventSub = event.data.object as unknown as Record<string, unknown>;
            const customerId = eventSub.customer as string;
            const subscriptionId = eventSub.id as string;
            if (!customerId || !subscriptionId) break;

            const billingAccount = await db.billingAccount.findUnique({
                where: { stripeCustomerId: customerId },
            });
            if (!billingAccount) break;

            await applyLiveSubscription(customerId, subscriptionId);

            await db.billingEvent.create({
                data: {
                    tenantId: billingAccount.tenantId,
                    type: event.type,
                    stripeEventId: event.id,
                    payloadJson: JSON.parse(JSON.stringify(event.data.object)),
                },
            });
            break;
        }

        case 'invoice.payment_failed': {
            const invoice = event.data.object as unknown as Record<string, unknown>;
            const customerId = (invoice.customer ?? invoice.customer_id) as string;
            if (!customerId) break;

            const billingAccount = await db.billingAccount.findUnique({
                where: { stripeCustomerId: customerId },
            });
            if (!billingAccount) break;

            // Mark account as PAST_DUE on payment failure
            await db.billingAccount.update({
                where: { stripeCustomerId: customerId },
                data: { status: 'PAST_DUE' },
            });

            await db.billingEvent.create({
                data: {
                    tenantId: billingAccount.tenantId,
                    type: event.type,
                    stripeEventId: event.id,
                    payloadJson: JSON.parse(JSON.stringify(event.data.object)),
                },
            });
            logger.warn('Payment failed', { component: 'billing', stripeCustomerId: customerId, tenantId: billingAccount.tenantId });
            break;
        }

        case 'invoice.payment_succeeded': {
            const invoice = event.data.object as unknown as Record<string, unknown>;
            const customerId = (invoice.customer ?? invoice.customer_id) as string;
            if (!customerId) break;

            const billingAccount = await db.billingAccount.findUnique({
                where: { stripeCustomerId: customerId },
            });
            if (!billingAccount) break;

            // Re-activate if was PAST_DUE
            if (billingAccount.status === 'PAST_DUE') {
                await db.billingAccount.update({
                    where: { stripeCustomerId: customerId },
                    data: { status: 'ACTIVE' },
                });
            }

            await db.billingEvent.create({
                data: {
                    tenantId: billingAccount.tenantId,
                    type: event.type,
                    stripeEventId: event.id,
                    payloadJson: JSON.parse(JSON.stringify(event.data.object)),
                },
            });
            break;
        }

        default:
            // Unhandled event type — log but don't process
            logger.debug('Unhandled event type', { component: 'billing', eventType: event.type });
            break;
    }
}
