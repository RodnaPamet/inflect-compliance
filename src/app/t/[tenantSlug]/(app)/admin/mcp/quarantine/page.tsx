import { redirect } from 'next/navigation';

/**
 * `/admin/mcp/quarantine` compatibility shim — AGENTIC UI 1/4 (#2437).
 *
 * The quarantine triage surface moved to `/agents/quarantine`. Its data path is
 * unchanged: `GET /api/t/:slug/admin/mcp/quarantine`, which carries the
 * `requirePermission('admin.agent_registry')` gate that writes an
 * `AUTHZ_DENIED` audit row on refusal — and whose `ROUTE_PERMISSIONS` rule is
 * the only one in that map matching `/admin/mcp/**` at all, so the API path
 * must NOT be moved with the page.
 */
export default async function AgentQuarantineRedirect({
    params,
}: {
    params: Promise<{ tenantSlug: string }>;
}) {
    const { tenantSlug } = await params;
    redirect(`/t/${tenantSlug}/agents/quarantine`);
}
