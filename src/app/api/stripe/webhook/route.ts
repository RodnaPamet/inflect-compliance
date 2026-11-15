import { NextRequest, NextResponse } from 'next/server';
import { constructWebhookEvent, handleWebhookEvent, SubscriptionRefetchError } from '@/lib/stripe';
import { logger } from '@/lib/observability/logger';
import { jsonResponse } from '@/lib/api-response';

/**
 * POST /api/stripe/webhook
 * Stripe webhook endpoint. Public (no auth), but verifies signature.
 *
 * IMPORTANT: This route must NOT parse body as JSON — Stripe signature
 * verification requires the raw body text.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
    const signature = req.headers.get('stripe-signature');
    if (!signature) {
        return jsonResponse({ error: 'Missing stripe-signature header' }, { status: 400 });
    }

    let event;
    try {
        const body = await req.text();
        event = constructWebhookEvent(body, signature);
    } catch (err) {
        const message = err instanceof Error ? err.message : 'Invalid signature';
        logger.error('Stripe webhook signature verification failed', { component: 'stripe', error: message });
        return jsonResponse({ error: `Webhook signature verification failed: ${message}` }, { status: 400 });
    }

    try {
        await handleWebhookEvent(event);
    } catch (err) {
        // The event id and type, and the error's class and code. Never the
        // payload, and not the message: a Prisma error's message quotes the
        // arguments of the failed query.
        logger.error('Stripe webhook event processing failed', {
            component: 'stripe',
            eventId: event.id,
            eventType: event.type,
            errorName: err instanceof Error ? err.name : typeof err,
            errorCode: errorCodeOf(err),
        });
        // Every processing error answers non-2xx, so Stripe delivers the
        // event again; answering 200 would lose it. The `BillingEvent`
        // idempotency row is written only after a successful write, so the
        // re-delivery is processed, not skipped (#5316 item 28). 503 when
        // the live subscription could not be read; 500 for anything else.
        if (err instanceof SubscriptionRefetchError) {
            return jsonResponse({ error: 'Subscription could not be re-fetched; retry' }, { status: 503 });
        }
        return jsonResponse({ error: 'Webhook event processing failed; retry' }, { status: 500 });
    }

    return jsonResponse({ received: true });
}

/** A string `code` on the error (Prisma's `P…`, Stripe's), if it has one. */
function errorCodeOf(err: unknown): string | undefined {
    if (typeof err !== 'object' || err === null) return undefined;
    const code = (err as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
}
