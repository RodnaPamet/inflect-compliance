import { redirect } from 'next/navigation';

/**
 * `/admin/agents` compatibility shim — AGENTIC UI 1/4 (#2427).
 *
 * The agent register moved out of `/admin` and became a top-level sidebar
 * destination at `/agents`, a sibling of `/policies` and `/vendors`. Bookmarks,
 * the old `/admin/mcp` hub card and any deep link continue to work.
 *
 * The API did NOT move: every route stays at `/api/t/:slug/admin/agents/*`,
 * where `ROUTE_PERMISSIONS` matches it and where the privileged-roots
 * population `api-permission-coverage.test.ts` curates expects it. The UI path
 * and the API path are allowed to differ, and here they deliberately do.
 */
export default async function AdminAgentsRedirect({
    params,
}: {
    params: Promise<{ tenantSlug: string }>;
}) {
    const { tenantSlug } = await params;
    redirect(`/t/${tenantSlug}/agents`);
}
