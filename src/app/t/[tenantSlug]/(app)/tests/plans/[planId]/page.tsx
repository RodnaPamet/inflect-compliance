'use client';
/* PR-Q — tenant-wide test-plan detail. Lets the /tests register open a plan
 * in-context (breadcrumb trail Dashboard → Tests → {plan}) without bouncing
 * through /controls/{controlId}/tests/{planId}. Shares the whole body with the
 * control-scoped route via <TestPlanDetailView>. */

import { useParams } from 'next/navigation';
import { TestPlanDetailView } from '@/components/test-plans/TestPlanDetailView';

export default function TenantTestPlanDetailPage() {
    const params = useParams();
    const planId = params?.planId as string;
    return <TestPlanDetailView planId={planId} context="tests" />;
}
