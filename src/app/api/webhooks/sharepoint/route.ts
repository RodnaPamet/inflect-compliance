import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { enqueue } from '@/app-layer/jobs/queue';
import { edgeLogger } from '@/lib/observability/edge-logger';

/**
 * SP-4 — Microsoft Graph change-notification receiver for policy sync.
 *
 * Two modes:
 *   1. **Validation handshake** — on subscription creation Graph POSTs with a
 *      `?validationToken=...` query param and expects it echoed back as
 *      `text/plain` within 10s.
 *   2. **Notifications** — `{ value: [{ subscriptionId, clientState, ... }] }`.
 *      We verify `clientState` (`<tenantId>:<policyId>`) against the stored
 *      `policy.spSubscriptionId` (anti-spoof), persist an IntegrationWebhookEvent,
 *      and enqueue a `sharepoint-policy-pull` job per verified item.
 *
 * Unauthenticated by design (Graph is the caller); trust is established via the
 * opaque `clientState` + the stored subscription id, not a session.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
    // 1. Subscription validation handshake.
    const validationToken = req.nextUrl.searchParams.get('validationToken');
    if (validationToken) {
        return new NextResponse(validationToken, {
            status: 200,
            headers: { 'Content-Type': 'text/plain' },
        });
    }

    // 2. Real notifications.
    let body: { value?: Array<{ subscriptionId?: string; clientState?: string }> };
    try {
        body = (await req.json()) as typeof body;
    } catch {
        return NextResponse.json({ error: 'invalid body' }, { status: 400 });
    }

    for (const note of body.value ?? []) {
        const clientState = note.clientState ?? '';
        const sep = clientState.indexOf(':');
        if (sep < 0) {
            edgeLogger.info('SharePoint webhook: dropped malformed clientState', { component: 'sharepoint' });
            continue;
        }
        const tenantId = clientState.slice(0, sep);
        const policyId = clientState.slice(sep + 1);

        // Anti-spoof: the clientState must match a policy whose stored
        // subscription id equals the notification's subscriptionId. A note
        // with no subscriptionId is refused: an undefined filter is dropped
        // by Prisma, which would match on the clientState alone.
        if (!note.subscriptionId) {
            edgeLogger.warn('SharePoint webhook: notification without subscriptionId', { component: 'sharepoint' });
            continue;
        }
        const policy = await prisma.policy.findFirst({
            where: { id: policyId, tenantId, spSubscriptionId: note.subscriptionId },
            select: { id: true, tenantId: true },
        });
        if (!policy) {
            edgeLogger.warn('SharePoint webhook: unverified notification', { component: 'sharepoint' });
            continue;
        }

        try {
            await prisma.integrationWebhookEvent.create({
                data: {
                    tenantId,
                    provider: 'sharepoint',
                    eventType: 'policy.updated',
                    payloadJson: { policyId, subscriptionId: note.subscriptionId } as object,
                    status: 'received',
                },
            });
            await enqueue('sharepoint-policy-pull', { tenantId, policyId });
        } catch (err) {
            edgeLogger.error('SharePoint webhook: enqueue failed', {
                component: 'sharepoint',
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    // Always 200 so Graph doesn't retry on our processing errors.
    return NextResponse.json({ received: true });
}
