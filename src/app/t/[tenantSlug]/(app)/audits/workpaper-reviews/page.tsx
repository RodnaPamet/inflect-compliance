import { getTranslations } from 'next-intl/server';

import { getTenantCtx } from '@/app-layer/context';
import { ForbiddenPage } from '@/components/ForbiddenPage';
import { WorkpaperReviewsClient } from './WorkpaperReviewsClient';

export const dynamic = 'force-dynamic';

/**
 * INTERNAL AUDIT'S SAMPLED WORKPAPERS (#3677, step 3d) — Server Component.
 *
 * Thin on purpose: the data has ONE path, `GET /api/t/:slug/audits/
 * workpaper-reviews`, behind the literal `requirePermission('audits.view')`
 * that writes an `AUTHZ_DENIED` row on refusal, and the usecase behind it
 * narrows to the caller's own assigned reviews.
 *
 * The page gate is the SAME key as the route, so it neither admits a caller the
 * route refuses nor hides the page from one it admits. Every role holds
 * `audits.view`; whether the caller is in internal audit is the usecase's
 * question, and the page shows its answer rather than an empty queue.
 */
export default async function WorkpaperReviewsPage({
    params,
}: {
    params: Promise<{ tenantSlug: string }>;
}) {
    const { tenantSlug } = await params;
    const ctx = await getTenantCtx({ tenantSlug });

    if (!ctx.appPermissions.audits.view) {
        const t = await getTranslations('audits');
        return (
            <ForbiddenPage
                title={t('workpaperReviews.accessTitle')}
                message={t('workpaperReviews.accessMessage')}
            />
        );
    }

    return <WorkpaperReviewsClient tenantSlug={tenantSlug} />;
}
