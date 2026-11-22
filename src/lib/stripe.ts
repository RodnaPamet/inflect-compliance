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
 * Which account state a write may overwrite.
 *
 * `UNCONDITIONAL` is a completed checkout's: it sets a new subscription over
 * whatever is stored. `STORED_SUBSCRIPTION_UNCHANGED` is every other event's:
 * the write lands only while `stripeSubscriptionId` still holds the value
 * read before the Stripe round trip (null included), so a checkout that
 * commits during the re-fetch is not overwritten by an older event (#5316).
 */
type WriteCondition =
    | { kind: 'UNCONDITIONAL' }
    | { kind: 'STORED_SUBSCRIPTION_UNCHANGED'; storedSubscriptionId: string | null };

/**
 * `APPLIED` — the live state was written.
 * `ENDED_WITH_NO_STORED_SUBSCRIPTION` — the subscription has ended and the
 *   account stores none, so there was nothing to end; nothing written.
 * `SUPERSEDED` — the stored subscription changed during the re-fetch; the
 *   conditional write matched no row and nothing was written.
 */
type LiveApplyOutcome = 'APPLIED' | 'ENDED_WITH_NO_STORED_SUBSCRIPTION' | 'SUPERSEDED';

/**
 * Re-fetch the subscription an event names and apply Stripe's current state
 * to the customer's billing account. A subscription that has ended, or that
 * Stripe no longer has, is applied as a deletion: the same write the
 * `customer.subscription.deleted` branch made before #5316 — except to an
 * account that stores no subscription, which it leaves alone. Such an
 * account either never subscribed or already had the deletion applied, and
 * its plan may be one an operator set with `changeTenantPlan`, which the
 * deletion would reset to FREE (owner decision, 2026-11-14).
 */
async function applyLiveSubscription(
    customerId: string,
    subscriptionId: string,
    condition: WriteCondition,
): Promise<LiveApplyOutcome> {
    const sub = await retrieveLiveSubscription(subscriptionId);
    const ended = sub === null || ENDED_SUBSCRIPTION_STATUSES.has(sub.status as string);

    if (
        ended &&
        condition.kind === 'STORED_SUBSCRIPTION_UNCHANGED' &&
        condition.storedSubscriptionId === null
    ) {
        return 'ENDED_WITH_NO_STORED_SUBSCRIPTION';
    }

    const data =
        sub === null || ended
            ? {
                  status: 'CANCELED' as const,
                  // The subscription is gone, so is what it paid for (#5082).
                  plan: 'FREE' as const,
                  stripeSubscriptionId: null,
              }
            : {
                  stripeSubscriptionId: subscriptionId,
                  plan: planForSubscription(sub),
                  status: mapStripeStatus(sub.status as string),
                  currentPeriodEnd: getSubscriptionPeriodEnd(sub),
                  trialEndsAt: getSubscriptionTrialEnd(sub),
              };

    if (condition.kind === 'UNCONDITIONAL') {
        await db.billingAccount.update({ where: { stripeCustomerId: customerId }, data });
        return 'APPLIED';
    }

    const { count } = await db.billingAccount.updateMany({
        where: { stripeCustomerId: customerId, stripeSubscriptionId: condition.storedSubscriptionId },
        data,
    });
    return count === 0 ? 'SUPERSEDED' : 'APPLIED';
}

// ─── Which subscription an event is about ───

/** A Stripe reference: an id, or an expanded object carrying one. */
function idOf(ref: unknown): string | null {
    if (typeof ref === 'string') return ref || null;
    if (typeof ref === 'object' && ref !== null) {
        const id = (ref as { id?: unknown }).id;
        if (typeof id === 'string' && id) return id;
    }
    return null;
}

/**
 * The subscription an invoice names, or `null` when it names none (a one-off
 * invoice). The pinned SDK's types expose only
 * `parent.subscription_details.subscription` (API versions from 2025-03-31);
 * an endpoint on an older API version sends the top-level
 * `invoice.subscription`. Either is a string or an expanded object with `id`.
 */
function invoiceSubscriptionId(invoice: Record<string, unknown>): string | null {
    const parent = invoice.parent;
    if (typeof parent === 'object' && parent !== null) {
        const details = (parent as { subscription_details?: unknown }).subscription_details;
        if (typeof details === 'object' && details !== null) {
            const fromParent = idOf((details as { subscription?: unknown }).subscription);
            if (fromParent) return fromParent;
        }
    }
    return idOf(invoice.subscription);
}

async function recordBillingEvent(tenantId: string, event: Stripe.Event): Promise<void> {
    await db.billingEvent.create({
        data: {
            tenantId,
            type: event.type,
            stripeEventId: event.id,
            payloadJson: JSON.parse(JSON.stringify(event.data.object)),
        },
    });
}

/**
 * Whether an event may move the account to a subscription other than the one
 * it stores. Only a completed checkout sets a new subscription; every other
 * event is applied only when it is about the stored one (#5316).
 */
type SubscriptionScope = 'SETS_SUBSCRIPTION' | 'STORED_SUBSCRIPTION_ONLY';

/**
 * Apply the live state of the subscription an event names, then record the
 * event. The `BillingEvent` row is written only after the account write
 * succeeds, so an event whose write fails is not recorded and Stripe's
 * re-delivery is processed rather than skipped as a duplicate.
 */
async function applySubscriptionEvent(
    event: Stripe.Event,
    customerId: string,
    subscriptionId: string,
    scope: SubscriptionScope,
): Promise<void> {
    const billingAccount = await db.billingAccount.findUnique({
        where: { stripeCustomerId: customerId },
    });
    if (!billingAccount) return;

    const logFields = {
        component: 'billing',
        eventId: event.id,
        eventType: event.type,
        tenantId: billingAccount.tenantId,
    };
    const stored = billingAccount.stripeSubscriptionId ?? null;
    if (scope === 'STORED_SUBSCRIPTION_ONLY' && stored !== null && stored !== subscriptionId) {
        // An event about a replaced subscription. Recorded so Stripe does not
        // deliver it for ever; the account is left as it is.
        logger.info('Stripe event concerned a non-current subscription; ignored', logFields);
        await recordBillingEvent(billingAccount.tenantId, event);
        return;
    }

    const outcome = await applyLiveSubscription(
        customerId,
        subscriptionId,
        scope === 'SETS_SUBSCRIPTION'
            ? { kind: 'UNCONDITIONAL' }
            : { kind: 'STORED_SUBSCRIPTION_UNCHANGED', storedSubscriptionId: stored },
    );
    if (outcome === 'ENDED_WITH_NO_STORED_SUBSCRIPTION') {
        logger.info('Stripe event: the subscription has ended and the account stores no subscription; nothing changed', logFields);
    } else if (outcome === 'SUPERSEDED') {
        logger.info('Stripe event superseded: the stored subscription changed during the re-fetch; nothing changed', logFields);
    }
    // Recorded in every outcome. A superseded event lost to a newer write
    // for this customer; its re-delivery would find that newer state and
    // change nothing either.
    await recordBillingEvent(billingAccount.tenantId, event);
}

// ─── Event processor (source of truth for billing state) ───

/**
 * Apply one verified Stripe event. Any error propagates: the webhook route
 * answers non-2xx and Stripe delivers the event again.
 */
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
            const session = event.data.object as unknown as Record<string, unknown>;
            const customerId = idOf(session.customer);
            const subscriptionId = idOf(session.subscription);
            if (!customerId || !subscriptionId) break;

            await applySubscriptionEvent(event, customerId, subscriptionId, 'SETS_SUBSCRIPTION');
            break;
        }

        // The subscription embedded in these events is never applied: it can
        // be older than the state already stored. The event names the
        // subscription; Stripe's live answer is what is written (#5316).
        case 'customer.subscription.created':
        case 'customer.subscription.updated':
        case 'customer.subscription.deleted': {
            const eventSub = event.data.object as unknown as Record<string, unknown>;
            const customerId = idOf(eventSub.customer);
            const subscriptionId = idOf(eventSub.id);
            if (!customerId || !subscriptionId) break;

            await applySubscriptionEvent(event, customerId, subscriptionId, 'STORED_SUBSCRIPTION_ONLY');
            break;
        }

        // An invoice event's type is not the subscription's state: a late
        // `payment_failed` would set PAST_DUE on a subscription since paid or
        // cancelled. The invoice names the subscription, and its live state
        // is applied like any subscription event's (#5316).
        case 'invoice.payment_failed':
        case 'invoice.payment_succeeded': {
            const invoice = event.data.object as unknown as Record<string, unknown>;
            const customerId = idOf(invoice.customer ?? invoice.customer_id);
            if (!customerId) break;

            const subscriptionId = invoiceSubscriptionId(invoice);
            if (!subscriptionId) {
                logger.debug('Invoice names no subscription; nothing to apply', {
                    component: 'billing',
                    eventId: event.id,
                    eventType: event.type,
                });
                break;
            }

            if (event.type === 'invoice.payment_failed') {
                logger.warn('Payment failed', { component: 'billing', eventId: event.id, stripeCustomerId: customerId });
            }
            await applySubscriptionEvent(event, customerId, subscriptionId, 'STORED_SUBSCRIPTION_ONLY');
            break;
        }

        default:
            // Unhandled event type — log but don't process
            logger.debug('Unhandled event type', { component: 'billing', eventType: event.type });
            break;
    }
}
