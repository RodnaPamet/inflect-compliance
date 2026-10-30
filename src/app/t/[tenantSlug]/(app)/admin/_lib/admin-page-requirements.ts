/**
 * What each admin SERVER page requires of its caller before it reads anything.
 *
 * ═══ WHY THE ADMIN LAYOUT IS NOT ENOUGH ═══
 *
 * `admin/layout.tsx` is a CLIENT component. Its `<RequirePermission
 * resource="admin" action="view">` decides what the browser SHOWS, but by the
 * time it runs, every server-component child below it has already rendered on
 * the server and its props are already in the RSC payload. A server page that
 * reads data and leans on the layout therefore sends that data to every tenant
 * member who opens the URL, under an "Access denied" screen. The edge does not
 * stop a page request either: for a page, `checkAdminAccess` returning `'deny'`
 * falls through to the App Router (`src/middleware.ts`, section 3).
 *
 * A server check in the layout would not close it on its own either: a layout
 * is not re-rendered on client navigation between its children, so the check
 * has to hold at each page. This table is what each page holds, and
 * `gateAdminPage` (`./admin-page-gate.tsx`) is the only way a page applies it.
 * `tests/guardrails/admin-layout-guard.test.ts` fails CI for an admin server
 * page that reads before the gate, gates under another page's route, or is
 * missing from this table.
 *
 * ═══ HOW EACH ROW WAS CHOSEN ═══
 *
 * `admin.view` — the layout's own rule — is the floor, so nobody the screen
 * refuses receives the page's data. On top of it, the key the page's data is
 * read under elsewhere: the API route that serves the same rows, or the check
 * the page's usecase already makes (a coarse `tier` where that check is
 * `assertCanAdmin` / `assertCanAudit`), so the page renders the forbidden page
 * rather than an error when the read would refuse.
 *
 * The one row without `admin.view` is the audit log: owner decision
 * 2026-10-29, an AUDITOR may read it, so it takes exactly what `listAuditLogs`
 * asserts (`canAudit`: OWNER, ADMIN, AUDITOR).
 *
 * ═══ THE CLIENT LAYOUT READS THIS TABLE TOO ═══
 *
 * The layout shows a page when the caller holds `admin.view` OR the page's own
 * row here admits them (`adminPageRouteForPath`). Every row but the audit
 * log's includes `admin.view`, so for those the second half adds nobody; for
 * the audit log it is what lets an AUDITOR see the page the server already
 * renders for them. One table, so what the screen shows and what the server
 * sends cannot disagree about a page in it.
 *
 * For every built-in OWNER and ADMIN each row admits, so they see no change.
 *
 * ═══ THE MEMBERSHIP'S OWN ROLE, AS THE EDGE READS IT ═══
 *
 * Every row also requires the caller's own membership role — not a custom
 * role's base — to be one the edge admits to an admin path: OWNER or ADMIN
 * (`EDGE_ADMIN_ROLES`), and on the audit log AUDITOR too. Without it a custom
 * role that grants `admin.view` to a Reader, Editor or Auditor membership
 * opened the admin pages while the edge refused almost every call they make
 * (owner decision 2026-10-30, #4581 B). An absent membership role admits
 * nobody, so an API-key context never opens a page.
 *
 * This module is pure — no session, no database, no React — so the role matrix
 * is unit-tested over it directly, and the client layout can import it.
 */
import type { Role } from '@prisma/client';

import type { RequestContext } from '@/app-layer/types';
import { EDGE_ADMIN_ROLES } from '@/lib/auth/edge-admin-roles';
import { hasPermission, type PermissionKey } from '@/lib/security/permission-key';

/** A coarse tier from `ctx.permissions`, for a read whose usecase asserts one. */
export type AdminPageTier = 'canAdmin' | 'canAudit';

export interface AdminPageRequirement {
    /** Granular keys on `ctx.appPermissions`, every one of which must be held. */
    readonly keys: readonly PermissionKey[];
    /** A coarse tier on `ctx.permissions` that must also hold. */
    readonly tier?: AdminPageTier;
    /**
     * The membership roles admitted, read off `membershipRole`. Absent means
     * the edge's own admin roles (`EDGE_ADMIN_ROLES`: OWNER, ADMIN).
     */
    readonly roles?: readonly Role[];
}

/**
 * Keyed by the page's route under the tenant, written as the folder path
 * (`/admin/vendor-templates/[templateId]`), so the guardrail can derive each
 * page's own key from its file path and refuse a page that names another's.
 *
 * Redirect-only pages are not here: they read nothing and render nothing.
 */
export const ADMIN_PAGE_REQUIREMENTS = {
    // The landing page: navigation only, gated to match the layout.
    '/admin': { keys: ['admin.view'] },
    // `listAuditLogs` asserts `canAudit`; owner decision 2026-10-29 (above).
    // The page makes no admin API call, so AUDITOR is admitted beside the
    // edge's admin roles.
    '/admin/audit-log': { keys: [], tier: 'canAudit', roles: ['OWNER', 'ADMIN', 'AUDITOR'] },
    // BillingAccount + BillingEvent; `/billing/events` is `admin.manage`.
    '/admin/billing': { keys: ['admin.view', 'admin.manage'] },
    // `GET /devices` is `personnel.view`.
    '/admin/devices': { keys: ['admin.view', 'personnel.view'] },
    // `GET /admin/dsar-requests` and `listDsarRequests` are `admin.compliance_dsar_view`.
    '/admin/dsar-requests': { keys: ['admin.view', 'admin.compliance_dsar_view'] },
    // `listAgentCredentials` asserts `canAdmin`.
    '/admin/mcp': { keys: ['admin.view'], tier: 'canAdmin' },
    // `GET /personnel` and `listEmployees` are `personnel.view`.
    '/admin/personnel': { keys: ['admin.view', 'personnel.view'] },
    // `getPrivacyPosture` asserts `canAdmin`.
    '/admin/privacy': { keys: ['admin.view'], tier: 'canAdmin' },
    // Every membership with its email and role; `GET /admin/members` is `admin.members`.
    '/admin/rbac': { keys: ['admin.view', 'admin.members'] },
    // The matrix config is read under `risks.view` (`GET /risk-matrix-config`).
    '/admin/risk-matrix': { keys: ['admin.view', 'risks.view'] },
    // The deploy's sandbox declaration; read-only, no narrower key exists.
    '/admin/sandbox-runtime': { keys: ['admin.view'] },
    // `GET /training` and `listTrainingAssignments` are `personnel.view`.
    '/admin/training': { keys: ['admin.view', 'personnel.view'] },
    // `GET /admin/trust-center` and `getTrustCenter` are `admin.manage`.
    '/admin/trust-center': { keys: ['admin.view', 'admin.manage'] },
    // The four vendor pages read nothing on the server (their client islands
    // fetch through gated routes); gated to match the layout, so a later read
    // added to one of them is already behind the gate.
    '/admin/vendor-assessment-reviews': { keys: ['admin.view'] },
    '/admin/vendor-assessment-reviews/[assessmentId]': { keys: ['admin.view'] },
    '/admin/vendor-templates': { keys: ['admin.view'] },
    '/admin/vendor-templates/[templateId]': { keys: ['admin.view'] },
} as const satisfies Record<string, AdminPageRequirement>;

export type AdminPageRoute = keyof typeof ADMIN_PAGE_REQUIREMENTS;

/**
 * Whether `ctx` meets `requirement`. Fails closed: a requirement naming neither
 * a key nor a tier would admit everybody, so it admits nobody, and an absent
 * membership role admits nobody.
 */
export function admitsAdminPage(
    ctx: Pick<RequestContext, 'permissions' | 'appPermissions' | 'membershipRole'>,
    requirement: AdminPageRequirement,
): boolean {
    if (requirement.keys.length === 0 && requirement.tier === undefined) return false;
    const membershipRole = ctx.membershipRole;
    if (membershipRole == null) return false;
    const roleAdmitted = requirement.roles
        ? requirement.roles.includes(membershipRole)
        : EDGE_ADMIN_ROLES.has(membershipRole);
    if (!roleAdmitted) return false;
    if (requirement.tier !== undefined && ctx.permissions?.[requirement.tier] !== true) return false;
    const granted = ctx.appPermissions;
    if (!granted) return false;
    return requirement.keys.every((key) => hasPermission(granted, key));
}

const ROUTE_PARAM = /^\[[^\]/]+\]$/;

/**
 * The row of `ADMIN_PAGE_REQUIREMENTS` naming the page at `pathname`
 * (`/t/acme/admin/vendor-templates/t-1` → `/admin/vendor-templates/[templateId]`),
 * or `null` when no row names it. For the client layout, which knows the
 * browser's path and not the page's folder.
 *
 * Fails towards `null`, which leaves the layout on its `admin.view` floor: a
 * path that is not exactly `/t/<slug>/admin/...` (one optional trailing
 * slash), or whose segment count or static segments match no row. A static row
 * wins over a dynamic one, and a `[param]` matches one non-empty segment.
 */
export function adminPageRouteForPath(pathname: string): AdminPageRoute | null {
    const match = /^\/t\/[^/]+(\/admin(?:\/[^?#]*)?)$/.exec(pathname);
    if (!match) return null;
    let under = match[1];
    if (under.length > '/admin'.length && under.endsWith('/')) under = under.slice(0, -1);
    if (Object.prototype.hasOwnProperty.call(ADMIN_PAGE_REQUIREMENTS, under)) {
        return under as AdminPageRoute;
    }
    const segments = under.split('/');
    for (const route of Object.keys(ADMIN_PAGE_REQUIREMENTS) as AdminPageRoute[]) {
        const pattern = route.split('/');
        if (pattern.length !== segments.length || !pattern.some((p) => ROUTE_PARAM.test(p))) continue;
        const fits = pattern.every((p, i) => (ROUTE_PARAM.test(p) ? segments[i] !== '' : p === segments[i]));
        if (fits) return route;
    }
    return null;
}
