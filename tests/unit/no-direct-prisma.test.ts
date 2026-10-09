/**
 * CI Regression Guard: Prevents accidental direct prisma/logAudit usage in route handlers.
 *
 * This test scans source files and FAILS if:
 * - Repositories import global prisma (except allowlisted)
 * - Usecases import global prisma (except allowlisted)
 * - ANY route handler (tenant-scoped or legacy) contains direct prisma usage
 * - ANY route handler contains logAudit calls (should be in usecases/events)
 * - ANY business route handler contains requireRole calls (should be in policies)
 *
 * RUN: npx jest tests/unit/no-direct-prisma.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';

const SRC_ROOT = path.resolve(__dirname, '../../src');

function readFilesInDir(dir: string, ext = '.ts'): { name: string; content: string; relPath: string }[] {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
        .filter((f) => f.endsWith(ext))
        .map((f) => ({
            name: f,
            content: fs.readFileSync(path.join(dir, f), 'utf8'),
            relPath: path.join(dir, f).replace(SRC_ROOT, 'src'),
        }));
}

function walkDir(dir: string): string[] {
    if (!fs.existsSync(dir)) return [];
    const results: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            results.push(...walkDir(fullPath));
        } else if (entry.name.endsWith('.ts')) {
            results.push(fullPath);
        }
    }
    return results;
}

function getNonCommentLines(content: string): string[] {
    return content.split('\n').filter((line) => {
        const trimmed = line.trim();
        return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*');
    });
}

describe('CI Guard: No direct prisma in tenant-scoped code', () => {
    // ─── Repositories ───
    const REPO_ALLOWLIST = ['ClauseRepository.ts', 'RiskTemplateRepository.ts', 'SsoConfigRepository.ts', 'IdentityLinkRepository.ts'];

    const repos = readFilesInDir(path.join(SRC_ROOT, 'app-layer/repositories'));

    for (const file of repos) {
        if (REPO_ALLOWLIST.includes(file.name)) continue;

        it(`${file.name} must NOT import global prisma`, () => {
            const hasPrismaImport =
                file.content.includes("from '@/lib/prisma'") ||
                file.content.includes('from "@/lib/prisma"') ||
                file.content.includes("from '../../lib/prisma'") ||
                file.content.includes('from "../../lib/prisma"');

            expect(hasPrismaImport).toBe(false);
        });
    }

    // ─── Usecases ───
    const USECASE_ALLOWLIST: string[] = [
        'sso.ts', 'mfa.ts', 'mfa-enrollment.ts', 'mfa-challenge.ts',
        'session-security.ts', 'webhook-processor.ts', 'scim-users.ts',
        // EI-3 — scim-groups resolves SCIM externalIds → IC users via a global
        // userIdentityLink lookup (cross-context, like scim-users); group
        // mutations themselves run inside runInTenantContext.
        'scim-groups.ts',
        'framework.ts', 'audit-hardening.ts',
        // Epic 1, PR 3 — redeemInvite and previewInviteByToken operate without
        // a tenant-scoped RequestContext (the caller is not yet a tenant member),
        // so they use the global prisma client directly. RLS policies are
        // bypassed intentionally here since the user has no tenant session.
        'tenant-invites.ts',
        // Epic 1, PR 2 — createTenantWithOwner + transferTenantOwnership run
        // under platform-admin auth with NO user RequestContext. Tenant is
        // being created or its ownership is changing; RLS doesn't apply
        // (Tenant itself is not in TENANT_SCOPED_MODELS).
        'tenant-lifecycle.ts',
        // Epic O-2 — org-layer usecases. Organization + OrgMembership are
        // user-scoped (org_isolation policy keyed on app.user_id), NOT
        // tenant-scoped — they're not in TENANT_SCOPED_MODELS. The
        // provisioning service crosses tenant boundaries by design (one
        // ORG_ADMIN add fans out to N tenants); cross-tenant fan-out goes
        // through createMany/deleteMany under the postgres role. The
        // tenant-scoped portion of `org-tenants.ts` (the OWNER membership
        // for the new tenant) runs in the same transaction as the tenant
        // creation itself — there's no pre-existing tenant ctx to switch
        // into, same pattern as `tenant-lifecycle.ts` above.
        'org-members.ts',
        'org-provisioning.ts',
        'org-tenants.ts',
        // Epic B — org audit ledger is org-scoped (not tenant-scoped).
        // The `OrgAuditLog` table has no `tenantId`; reads filter on
        // `organizationId` against the global prisma instance. Same
        // shape as the other org-level usecases above.
        'org-audit.ts',
        // Epic D — org invitation lifecycle. Same org-scoped shape:
        // OrgInvite/OrgMembership are user-scoped not tenant-scoped,
        // and redeemOrgInvite specifically operates pre-membership
        // (the redeemer is not yet a member, mirroring tenant-invites).
        'org-invites.ts',
        // #3323 — the grant endpoint's authenticator. The TENANT IS THIS
        // FUNCTION'S OUTPUT: it is handed `<connectionId>.<secret>` and its
        // whole job is to establish which tenant that credential belongs to,
        // so there is no tenant context to read within. Same shape as
        // `redeemOrgInvite` above, which is allowlisted because it operates
        // pre-membership. The read is by PRIMARY KEY, selects six columns,
        // cannot enumerate, and takes no caller-shaped filter; everything
        // afterwards runs through `buildSystemContext` on the tenant it
        // resolved.
        'entra-grant-auth.ts',
        // Epic 41 — configurable dashboard widget CRUD. OrgDashboardWidget
        // is org-scoped, NOT tenant-scoped (not in TENANT_SCOPED_MODELS).
        // Same access shape as org-members.ts / org-invites.ts: global
        // prisma + getOrgCtx for isolation. Read gated by canViewPortfolio,
        // write gated by canConfigureDashboard (ORG_ADMIN only).
        'org-dashboard-widgets.ts',
        // ORG_THREAT_LEVEL widget — OrgThreatLevel is org-scoped (NOT in
        // TENANT_SCOPED_MODELS); same global-prisma + getOrgCtx shape as
        // the other org usecases. Read gated by canViewPortfolio, set by
        // canSetThreatLevel (ORG_ADMIN), audited via ORG_THREAT_LEVEL_SET.
        'org-threat-level.ts',
        // ORG_MATURITY widget — org-scoped maturity ratings; same
        // global-prisma + getOrgCtx shape as the other org usecases.
        'org-maturity.ts',
        // ORG_INITIATIVES — org-scoped programme tracking; global prisma for
        // initiatives/links + withTenantDb for cross-tenant progress rollup.
        'org-security-initiative.ts',
        // Epic E.3 — request-scoped portfolio data helper. Memoises
        // tenants + snapshots reads via the AsyncLocalStorage
        // RequestContext + WeakMap. The repository methods it calls
        // are themselves org-scoped (not tenant-scoped), so the
        // helper proxies them at the global prisma layer.
        'portfolio-data.ts',
        // Epic O-3 — portfolio aggregation uses `runInGlobalContext` for
        // ComplianceSnapshot reads (org-wide aggregates, no business data)
        // and switches to per-tenant `withTenantDb(tid, ...)` for drill-
        // downs. The cross-tenant fan-out can't fit `runInTenantContext`'s
        // single-tenant RequestContext shape — the WITH_TENANT_DB_ALLOWLIST
        // entry below covers that side.
        'portfolio.ts',
        // Epic 47 — global search reads cross-tenant `Framework` rows
        // (frameworks are not tenant-scoped: they're shared catalogue
        // data). The tenant-scoped portion of the search runs through
        // `runInTenantContext` already; the framework lookup uses the
        // global prisma client because Framework has no `tenantId`
        // column to filter on. Authorization gate: the route's
        // `getTenantCtx` already enforces tenant membership; framework
        // metadata leaks no business data.
        'search.ts',
        // Epic G-3 — public token-gated vendor questionnaire response
        // surface. Token verification (SHA-256 hash compare) precedes
        // tenant resolution: the external respondent has no session
        // and no tenantId until after the token matches an assessment
        // row. `loadResponseByToken` and `submitResponse` therefore
        // use the global prisma client to look up the assessment by
        // hash, then continue under that row's tenantId. RLS bypass
        // is intentional and bounded — every subsequent write goes
        // through `runWithAuditContext` bound to the matched
        // assessment's tenantId. See
        // src/lib/security/external-assessment-access.ts for the
        // verifier and src/lib/errors/route-exemptions.ts for the
        // route-level anti-enumeration shape.
        'vendor-assessment-response.ts',
        // Audit S3 (2026-05-22) — daily cron that sweeps APPROVED
        // evidence past its `nextReviewDate` to NEEDS_REVIEW. Runs
        // either tenant-scoped (one tenant) OR sweep-all (all tenants
        // in one query). The sweep-all mode can't fit
        // `runInTenantContext`'s single-tenant shape; the global
        // prisma + tenantId-optional updateMany is the right call.
        // Pure write-only transition (no business data read), bounded
        // by the WHERE clause.
        'evidence-stale-review-sweep.ts',
        // Audit S6 (2026-05-22) — `notifyAssessmentReviewed` runs
        // post-commit, after `runInTenantContext` has returned, so
        // it needs a non-tenant-bound prisma client to look up the
        // recipient's email and tenant slug. Pre-this-allowlist the
        // file used `require('@/lib/prisma')` inline; the static
        // import is honest about the dependency and the audit
        // confirms it's correctly scoped (email lookup only).
        'vendor-assessment-review.ts',
        // Audit S6 (2026-05-22) — vendor re-assessment reminder cron.
        // Same shape as the evidence-stale-review-sweep above: sweeps
        // all tenants OR scopes to one; bounded WHERE clause; writes
        // a Notification row per overdue vendor + bumps the vendor's
        // nextReviewAt to silence the reminder until next cycle.
        'vendor-reassessment-reminder.ts',
        // Regwatch 2A — the framework-version delta engine. Two of its
        // functions run WITHOUT a tenant RequestContext: `recordFrameworkVersionDiff`
        // / `recordDiffFromVersionHistory` write the GLOBAL `FrameworkVersionDiff`
        // table (no `tenantId`, not in TENANT_SCOPED_MODELS), and
        // `propagateFrameworkDelta` is a cross-tenant fan-out invoked by the
        // library importer (post-import, no caller ctx). The tenant-scoped
        // read/review paths (list/get/review/materialize) all use
        // `runInTenantContext`. Same shape as portfolio.ts / org-security-initiative.ts.
        'framework-delta.ts',
    ];

    const usecases = readFilesInDir(path.join(SRC_ROOT, 'app-layer/usecases'));

    for (const file of usecases) {
        if (USECASE_ALLOWLIST.includes(file.name)) continue;

        it(`${file.name} must NOT import global prisma`, () => {
            const hasPrismaImport =
                file.content.includes("from '@/lib/prisma'") ||
                file.content.includes('from "@/lib/prisma"');

            expect(hasPrismaImport).toBe(false);
        });
    }

    // ─── Usecases must use runInTenantContext, not raw withTenantDb ───
    // Exception: background-job modules that accept raw tenantId (no RequestContext)
    // legitimately use the lower-level withTenantDb wrapper. RLS is still enforced.
    const WITH_TENANT_DB_ALLOWLIST = [
        'evidence-maintenance.ts',
        // Epic O-3 — cross-tenant drill-down loops over the org's tenants,
        // running each per-tenant query inside `withTenantDb(tid, ...)`.
        // RLS is preserved per-call (the CISO's auto-provisioned AUDITOR
        // membership is what grants read access). Can't use
        // `runInTenantContext` because that expects a single tenant id
        // on the RequestContext — drill-down is many tenants.
        'portfolio.ts',
        // ORG_INITIATIVES progress rollup resolves linked work per tenant via
        // withTenantDb(tid) — the sanctioned cross-tenant read (RLS enforced).
        'org-security-initiative.ts',
        // Regwatch 2A — `propagateFrameworkDelta` fans a framework-version diff
        // out to every INSTALLED tenant, running each tenant's flag/upsert/notify
        // inside `withTenantDb(tid, ...)`. Cross-tenant fan-out can't fit
        // `runInTenantContext`'s single-tenant shape (same as portfolio.ts).
        'framework-delta.ts',
    ];

    for (const file of usecases) {
        if (WITH_TENANT_DB_ALLOWLIST.includes(file.name)) continue;

        it(`${file.name} must use runInTenantContext (not raw withTenantDb)`, () => {
            const hasWithTenantDb = file.content.includes('withTenantDb(');
            expect(hasWithTenantDb).toBe(false);
        });
    }

    // ─── ALL route handlers (tenant-scoped + legacy) ───
    // Auth routes are explicitly excluded — they handle registration/login with global tables
    const ROUTE_DIR_ALLOWLIST = [
        'auth', 'health', 'staging', 'scim', 'integrations',
        // PR-8 — public trust-center download route consumes a single-use
        // token then loads the FileRecord + storage under the table-owner
        // role (no tenant session); the request path uses the isolated
        // gated module.
        'trust',
        // SP-4 — the MS Graph change-notification receiver verifies clientState
        // against policy.spSubscriptionId + enqueues a pull job. Caller is Graph
        // (no tenant context); the cross-tenant policy lookup is by id + the
        // verified clientState, not a tenant filter.
        'webhooks',
        // Epic O-1/O-2 — org routes operate at the org-management plane,
        // above tenant scope. They legitimately query the global prisma
        // for Organization + OrgMembership rows (user-scoped, not
        // tenant-scoped — see org_isolation policy). Cross-tenant
        // drill-down INSIDE these routes still uses withTenantDb per-
        // tenant — see `src/app-layer/usecases/portfolio.ts` security-
        // invariant block.
        'org',
        // System-level callbacks invoked by external services without
        // a tenant context. The AV webhook in particular is called by
        // ClamAV / Defender ATP after a scan — it looks up a
        // FileRecord by id (cross-tenant) and updates scan status.
        // The Epic C cast removal exposed this previously-hidden
        // direct-prisma usage; the access pattern is correct, the
        // allowlist entry codifies it.
        'storage',
    ];

    const apiDir = path.join(SRC_ROOT, 'app/api');
    const allRouteFiles = walkDir(apiDir).filter((f) => f.endsWith('route.ts'));

    for (const filePath of allRouteFiles) {
        const relPath = filePath.replace(SRC_ROOT + path.sep, '');

        // Skip allowlisted auth routes
        const pathParts = relPath.split(path.sep);
        const isAllowlisted = ROUTE_DIR_ALLOWLIST.some((dir) =>
            pathParts.includes(dir)
        );
        if (isAllowlisted) continue;

        const content = fs.readFileSync(filePath, 'utf8');
        const nonCommentLines = getNonCommentLines(content);

        it(`route ${relPath} must NOT call prisma directly`, () => {
            const violations = nonCommentLines.filter((line) =>
                /\bprisma\.\w+\b/.test(line) &&
                !line.includes('customPrisma') &&
                !line.includes('globalPrisma')
            );
            expect(violations).toEqual([]);
        });

        it(`route ${relPath} must NOT call logAudit directly`, () => {
            const violations = nonCommentLines.filter((line) =>
                /\blogAudit\s*\(/.test(line)
            );
            expect(violations).toEqual([]);
        });

        it(`route ${relPath} must NOT call requireRole directly`, () => {
            const violations = nonCommentLines.filter((line) =>
                /\brequireRole\s*\(/.test(line)
            );
            expect(violations).toEqual([]);
        });
    }
});
