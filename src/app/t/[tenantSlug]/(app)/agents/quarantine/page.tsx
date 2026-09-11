import { getTranslations } from 'next-intl/server';

import { getTenantCtx } from '@/app-layer/context';
import { ForbiddenPage } from '@/components/ForbiddenPage';
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
 *
 * ── THE PAGE GATE IS SEPARATE FROM THE ROUTE GATE (#2438) ───────────────────
 *
 * The route gate above is the security boundary and stays exactly as it was.
 * This page ALSO refuses, and the two are not redundant: while the file sat
 * under `/admin` an ancestor layout refused a non-admin BEFORE the client ever
 * mounted, and moving it out took that away. Without a gate here the page
 * would render its chrome, its empty state and its terminal-quarantine notice
 * to anyone, then show a failed fetch — a surface that says "nothing has been
 * quarantined" to a caller who is simply not allowed to know.
 *
 * Same key as the route it calls (`admin.agent_registry`), deliberately: a
 * page that admits a caller the route will refuse is a page that lies, and one
 * that refuses a caller the route would admit hides a surface somebody is
 * entitled to.
 */
export default async function AgentQuarantinePage({
    params,
}: {
    params: Promise<{ tenantSlug: string }>;
}) {
    const { tenantSlug } = await params;
    const ctx = await getTenantCtx({ tenantSlug });

    if (!ctx.appPermissions.admin.agent_registry) {
        const t = await getTranslations('agents');
        return (
            <ForbiddenPage
                title={t('quarantine.accessTitle')}
                message={t('quarantine.accessMessage')}
            />
        );
    }

    return <QuarantineClient tenantSlug={tenantSlug} />;
}
