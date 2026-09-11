import { redirect } from 'next/navigation';

/**
 * `/admin/agents/review-quality` compatibility shim — AGENTIC UI 1/4 (#2428).
 *
 * The ASI09 review-quality report moved to `/agents/review-quality`. It also
 * gained its first inbound link in the process: before this it had ZERO — no
 * nav entry, no hub card, no row action — and was reachable only by typing the
 * URL. It is now the "Review quality" entry in the agents ViewsMenu.
 */
export default async function AdminAgentReviewQualityRedirect({
    params,
}: {
    params: Promise<{ tenantSlug: string }>;
}) {
    const { tenantSlug } = await params;
    redirect(`/t/${tenantSlug}/agents/review-quality`);
}
