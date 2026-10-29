/**
 * Who sees which per-viewer parts of the dashboard.
 *
 * The executive payload is tenant-pure and cached per tenant, so nothing here
 * may go into it. These are computed per request by the server page, from the
 * same context the routes behind each control check, and passed down — so the
 * page offers a control only to a viewer the server would accept.
 */
import type { RequestContext } from '@/app-layer/types';

/** Which "Quick add" links the viewer may follow. */
export interface DashboardQuickAddGates {
    /**
     * POST /risks: the coarse write tier AND `risks.create` — the rule the
     * Risks list's own `riskCanCreate` states (not imported: a route
     * directory's internals are not a shared module).
     */
    risk: boolean;
    /**
     * The Evidence page's create menu: offered when the viewer can add a note
     * or link (`evidence.edit`) or upload a file (`evidence.upload`), each on
     * the coarse write tier — the same rule its "Evidence" button follows.
     */
    evidence: boolean;
    /** POST /policies: the coarse write tier AND `policies.create`. */
    policy: boolean;
}

type GateContext = Pick<RequestContext, 'permissions' | 'appPermissions'>;

export function dashboardQuickAddGates(ctx: GateContext): DashboardQuickAddGates {
    const { canWrite } = ctx.permissions;
    const p = ctx.appPermissions;
    return {
        risk: canWrite && p.risks.create,
        evidence: canWrite && (p.evidence.edit || p.evidence.upload),
        policy: canWrite && p.policies.create,
    };
}

/**
 * The Recent Activity card is the audit log's ten latest rows, so it is shown
 * to exactly the viewers `listAuditLogs` admits: `canAudit` — Owner, Admin
 * and Auditor (owner decision, 2026-10-29). `getDashboardRecentActivity`
 * asserts the same, so a viewer this refuses neither sees the card nor
 * fetches its rows.
 */
export function mayReadRecentActivity(ctx: GateContext): boolean {
    return ctx.permissions.canAudit;
}
