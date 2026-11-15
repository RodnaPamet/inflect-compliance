/**
 * The reconciliation review queue for one legacy connection — the server gate.
 *
 * #5695, owner decisions 2026-11-15: holding `identity_reconciliation.view` is
 * enough to open the queue, and OWNER, ADMIN and AUDITOR hold it. The admin
 * layout shows a page only to an OWNER or ADMIN membership unless the page's
 * own row in `ADMIN_PAGE_REQUIREMENTS` admits the caller, and a row belongs
 * only to a page that applies it on the server. So this page is that server
 * gate and nothing else: it reads nothing, and the queue itself is the client
 * component below, whose two reads are both `identity_reconciliation.view`.
 *
 * The gate is what refuses a custom role that withholds the view key, before
 * anything renders. Deciding is untouched: `identity_reconciliation.confirm`,
 * on routes the edge still opens to the admin roles only.
 */
import { gateAdminPage } from '../../../_lib/admin-page-gate';
import { ReconciliationQueueClient } from './ReconciliationQueueClient';

export default async function ReconciliationQueuePage({
    params,
}: {
    params: Promise<{ tenantSlug: string; connectionId: string }>;
}) {
    const gate = await gateAdminPage('/admin/integrations/[connectionId]/reconciliation', params);
    if (!gate.allowed) return gate.forbidden;

    return <ReconciliationQueueClient />;
}
