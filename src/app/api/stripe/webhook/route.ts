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
        const message = err instanceof Error ? err.message : 'Unknown error';
        logger.error('Stripe webhook event processing failed', { component: 'stripe', error: message });
        // The live subscription could not be read, and nothing was written.
        // A non-2xx makes Stripe deliver the event again, and the retry
        // re-fetches (#5316 item 28). Answering 200 here would lose the event.
        if (err instanceof SubscriptionRefetchError) {
            return jsonResponse({ error: 'Subscription could not be re-fetched; retry' }, { status: 503 });
        }
        // Return 200 anyway to prevent Stripe from retrying — we log the error
        // In production, this should alert to an error tracking service
    }

    return jsonResponse({ received: true });
}
