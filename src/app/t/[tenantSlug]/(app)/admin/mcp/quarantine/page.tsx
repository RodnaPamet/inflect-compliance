import { QuarantineClient } from './QuarantineClient';

export const dynamic = 'force-dynamic';

/**
 * QUARANTINE TRIAGE — Server Component.
 *
 * Deliberately thin: it renders the client and nothing else, so the data has
 * exactly ONE path — `GET /api/t/:slug/admin/mcp/quarantine`, which carries the
 * `requirePermission('admin.agent_registry')` gate that writes an
 * `AUTHZ_DENIED` audit row on refusal.
 *
 * The sibling admin pages SSR their rows through the usecase and hand them to a
 * client component, and that is the right shape when the surface is the only
 * consumer. It is the wrong shape here: this page's whole reason to exist is
 * that `listQuarantinedAgentProposals` had no HTTP entrance, and an SSR read
 * would have left the route with no production caller — the same defect one
 * layer up, shipped alongside its own fix.
 *
 * Be precise about what that gate does and does not record, because the loose
 * version of this sentence is wrong: `requirePermission` audits DENIALS. A
 * refused read appends a hash-chained `AUTHZ_DENIED` row; an ALLOWED one
 * appends nothing and leaves only the ordinary request log line. So this shape
 * buys a durable record of who was TURNED AWAY from the attempted content — not
 * a record of who read it. If the latter is ever wanted it is a new audit
 * action at the route, and nothing here provides it today.
 */
export default async function AgentQuarantinePage({
    params,
}: {
    params: Promise<{ tenantSlug: string }>;
}) {
    const { tenantSlug } = await params;
    return <QuarantineClient tenantSlug={tenantSlug} />;
}
