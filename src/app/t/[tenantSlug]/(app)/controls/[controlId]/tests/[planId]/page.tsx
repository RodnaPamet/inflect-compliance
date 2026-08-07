'use client';
/* Routing note (Task 2): the PLAN lives under
 * /controls/{controlId}/tests/{planId} while its RUNS live at the
 * top-level /tests/runs/{runId}. That split route tree is deliberate
 * (moving it is riskier + out of scope) — the breadcrumbs bridge the
 * hop so the control context never silently flips.
 *
 * PR-Q — the detail body is shared with the tenant-wide
 * /tests/plans/{planId} route via <TestPlanDetailView>; this page is the
 * control-scoped entry (control breadcrumb trail). */

import { useParams } from 'next/navigation';
import { TestPlanDetailView } from '@/components/test-plans/TestPlanDetailView';

export default function TestPlanDetailPage() {
    const params = useParams();
    const planId = params?.planId as string;
    return <TestPlanDetailView planId={planId} context="control" />;
}
