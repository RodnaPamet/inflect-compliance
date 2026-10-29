/**
 * Epic G-3 — vendor assessment review queue (admin index).
 *
 * Lists every G-3 assessment that has reached the reviewable /
 * reviewed set (SUBMITTED / REVIEWED / CLOSED). Click a row to open
 * the reviewer page.
 */
import { gateAdminPage } from '../_lib/admin-page-gate';
import { VendorAssessmentReviewsQueueClient } from './VendorAssessmentReviewsQueueClient';

export const dynamic = 'force-dynamic';

/** Reads nothing on the server; gated like every admin server page (`../_lib/admin-page-requirements.ts`). */
export default async function VendorAssessmentReviewsQueuePage({
    params,
}: {
    params: Promise<{ tenantSlug: string }>;
}) {
    const gate = await gateAdminPage('/admin/vendor-assessment-reviews', params);
    if (!gate.allowed) return gate.forbidden;
    return <VendorAssessmentReviewsQueueClient />;
}
