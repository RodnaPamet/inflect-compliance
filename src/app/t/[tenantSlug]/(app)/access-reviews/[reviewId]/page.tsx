/**
 * Epic G-4 — Access Review detail (server shell).
 *
 * Resolves the campaign + decisions + last-activity map server-side
 * and hands them off to the client for the reviewer-facing UI.
 */
import { notFound } from 'next/navigation';
import { getTenantCtx } from '@/app-layer/context';
import { getAccessReviewWithActivity } from '@/app-layer/usecases/access-review';
import { AccessReviewDetailClient } from './AccessReviewDetailClient';

export const dynamic = 'force-dynamic';

export default async function AccessReviewDetailPage({
    params,
}: {
    params: Promise<{ tenantSlug: string; reviewId: string }>;
}) {
    const { tenantSlug, reviewId } = await params;
    const ctx = await getTenantCtx({ tenantSlug });
    let review;
    try {
        review = await getAccessReviewWithActivity(ctx, reviewId);
    } catch {
        notFound();
    }
    return (
        <AccessReviewDetailClient
            tenantSlug={tenantSlug}
            initialReview={review}
            currentUserId={ctx.userId}
            isAdmin={ctx.permissions.canAdmin}
            // #4130 — each affordance follows BOTH gates its server path
            // takes: the route's key and the usecase's `assertCanAdmin`.
            canManage={ctx.permissions.canAdmin && ctx.appPermissions.access_reviews.create}
            canRegenerateEvidence={ctx.permissions.canAdmin && ctx.appPermissions.access_reviews.close}
        />
    );
}
