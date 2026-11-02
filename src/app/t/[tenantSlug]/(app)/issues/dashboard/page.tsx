import { redirect } from 'next/navigation';

/**
 * Legacy redirect: /issues/dashboard → /tasks. TP-7 retired the standalone
 * Tasks dashboard; the list carries the KPI strip now.
 *
 * Server-side `redirect()` (instant 307), like `/issues` and
 * `/issues/[issueId]` beside it: no client shell, no loading flash.
 */
export default async function IssueDashboardRedirect({
    params,
}: {
    params: Promise<{ tenantSlug: string }>;
}) {
    const { tenantSlug } = await params;
    redirect(`/t/${tenantSlug}/tasks`);
}
