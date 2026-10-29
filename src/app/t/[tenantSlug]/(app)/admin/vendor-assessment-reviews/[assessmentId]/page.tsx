/**
 * Epic G-3 — vendor assessment reviewer page.
 */
import { gateAdminPage } from '../../_lib/admin-page-gate';
import { VendorAssessmentReviewClient } from './VendorAssessmentReviewClient';

export const dynamic = 'force-dynamic';

export default async function VendorAssessmentReviewPage({
    params,
}: {
    params: Promise<{ tenantSlug: string; assessmentId: string }>;
}) {
    const gate = await gateAdminPage('/admin/vendor-assessment-reviews/[assessmentId]', params);
    if (!gate.allowed) return gate.forbidden;
    const { assessmentId } = await params;
    return <VendorAssessmentReviewClient assessmentId={assessmentId} />;
}
