/**
 * Guardrail: Epic C.1 — API permission coverage.
 *
 * Locks in two invariants for every "privileged" API route, so a future
 * PR that adds a sensitive endpoint cannot ship without API-layer
 * permission enforcement:
 *
 *   1. The route file uses `requirePermission(...)` from
 *      `@/lib/security/permission-middleware`.
 *   2. The route's URL pathname matches at least one rule in
 *      `ROUTE_PERMISSIONS` — the declarative source of truth that
 *      `tools/SDK generation/docs read`.
 *
 * "Privileged" is defined deterministically below — currently every
 * route under `src/app/api/t/[tenantSlug]/admin/`. This is intentionally
 * narrow for Epic C.1; widening to other privileged surfaces (billing,
 * security, sso) lands in C.2 once those routes adopt
 * `requirePermission` and gain map entries.
 *
 * The complementary guardrail `admin-route-coverage.test.ts` keeps the
 * legacy role-based guards (`requireAdminCtx` etc.) honest. The two
 * together mean: a privileged route either uses the new permission
 * key model OR the legacy role model — never neither.
 *
 * Failure messages are written to be copy-paste-actionable. A reviewer
 * who sees a CI failure here should know exactly which file to edit
 * and which line to add.
 *
 * ─── THIS IS LAYER 1. IT IS THE STRONG CLAIM. ──────────────────────
 *
 * `tests/guardrails/api-route-has-some-authorization.test.ts` is layer 2:
 * it walks the WHOLE api tree and asks only "is there any authorization
 * on this path at all?", accepting a usecase-layer `assertCan*` reached
 * through the call graph. That is a strictly weaker question, and it is
 * ADDITIVE — it does not and must not relax anything here.
 *
 * Nothing in this file may be softened to lean on layer 2. In particular
 * a usecase `assertCan*` does NOT satisfy the assertion below, and the
 * routes in `PRIVILEGED_ROOTS` do not migrate there: a `requirePermission`
 * denial writes a hash-chained AUTHZ_DENIED audit row and an
 * `assertCanAdmin` denial writes nothing, which is exactly the defect
 * Epic D.3 fixed for seven tenant routes. Accepting the weaker mechanism
 * on this population was measured, once, at a net strictness regression
 * across 25 routes.
 */

import * as fs from 'fs';
import * as path from 'path';

import {
    ROUTE_PERMISSIONS,
    isRouteCovered,
    type RoutePermissionRule,
} from '@/lib/security/route-permissions';
import { getPermissionsForRole } from '@/lib/permissions';

// ─── Discovery ───────────────────────────────────────────────────────

/**
 * Roots that are scanned for privileged route files. Each entry comes
 * with a short description that surfaces in failure output so a
 * reviewer can see why the directory is in scope.
 */
const PRIVILEGED_ROOTS: ReadonlyArray<{
    /** Filesystem path relative to repo root. */
    relPath: string;
    /** Human-readable rationale, surfaced in failures. */
    why: string;
}> = [
    {
        relPath: 'src/app/api/t/[tenantSlug]/admin',
        why: 'Tenant admin surface — RBAC management, SCIM, integrations, key rotation.',
    },
    {
        relPath: 'src/app/api/t/[tenantSlug]/issues',
        why:
            'The surviving evidence-bundle routes. The rest of `/issues` was a ' +
            'parallel write API over the same Task rows with no requirePermission ' +
            'at all — deleted 2026-08-11. These three had no `/tasks` twin, so they ' +
            'kept the path and gained the gate; the root is in scope so a future ' +
            'route added here cannot arrive ungated the way the others did.',
    },
    // Epic D.3 — billing, SSO, security session-management bulk
    // endpoints, and the MFA-policy PUT all moved off legacy
    // `requireAdminCtx` to `requirePermission(...)`. Their
    // route directories now belong in scope so a future regression
    // here gets caught.
    {
        relPath: 'src/app/api/t/[tenantSlug]/billing',
        why: 'Stripe checkout/portal/events — admin-only commercial actions.',
    },
    {
        relPath: 'src/app/api/t/[tenantSlug]/sso',
        why: 'Tenant SSO configuration — admin-only.',
    },
    {
        relPath: 'src/app/api/t/[tenantSlug]/security',
        why: 'Tenant security surface — MFA policy mutations + admin-driven session revocation.',
    },
    {
        relPath: 'src/app/api/t/[tenantSlug]/incidents',
        why: 'NIS2 Article 23 incident response — privileged security-team mutations (incidents.manage) + member-visibility reads (incidents.view).',
    },
    {
        relPath: 'src/app/api/t/[tenantSlug]/gap-assessments',
        why: 'NIS2 gap-assessment delegation — dispatch/list/finalize are assessment-admin actions (admin.manage). Per-respondent answering is self-service under the separate /gap-assignments root (ctx-scoped in the usecase).',
    },
    // Report export surface — the UI gates these on reports.export; the API
    // must match. Narrow leaf roots so only the export handlers are in scope.
    {
        relPath: 'src/app/api/t/[tenantSlug]/reports/pdf/generate',
        why: 'PDF report generation — an export action gated on reports.export.',
    },
    {
        relPath: 'src/app/api/t/[tenantSlug]/reports/soa/export.csv',
        why: 'SoA / coverage CSV export — an export action gated on reports.export.',
    },
    {
        relPath: 'src/app/api/t/[tenantSlug]/risks/reports',
        why: 'Risk-report generation (POST) is an export action gated on reports.export. The GET (list) plus the schedule/template config CRUD + already-generated-run download siblings are excluded below with reasons.',
    },
    {
        relPath: 'src/app/api/t/[tenantSlug]/assets/bulk',
        why: 'Asset bulk mutations (status/assign/delete = assets.edit, import = assets.create) — gated so denials audit at the C.1 layer, matching the usecase asserts.',
    },
    {
        relPath: 'src/app/api/t/[tenantSlug]/assets/[id]/purge',
        why: 'Irreversible asset hard-delete — admin.manage, matching the usecase assertCanAdmin. Narrow leaf root so only the purge handler is in scope (its assets/[id] siblings are not).',
    },
    // The PLATFORM admin surface — create a tenant, transfer its ownership,
    // read process diagnostics. Its two tenant-lifecycle routes had carried
    // EXCLUDED_ROUTES entries since Epic 1 PR 2, but no root covered the
    // directory, so those entries excluded nothing and the scan never walked
    // it. `/api/admin/diagnostics` sat there the whole time gated by a
    // hand-rolled `ctx.permissions.canAdmin` check — a 403 that writes no
    // AUTHZ_DENIED row, and one resolved against the CALLER'S OWN tenant.
    {
        relPath: 'src/app/api/admin',
        why: 'Platform-admin surface — tenant creation, ownership transfer, process diagnostics. Authenticated by PLATFORM_ADMIN_API_KEY rather than a tenant role, so every route in it is excluded individually; the root is in scope so the next one cannot arrive unexamined.',
    },
    // NOT tenant-scoped, and that is exactly why it is here. Every other
    // root above sits under `/api/t/[tenantSlug]/`; `/api/account` acts on
    // the SESSION's user, so `requirePermission` — which resolves a tenant
    // role — does not apply to the three routes in it today. That made the
    // directory structurally invisible to this guardrail: not exempt, just
    // never looked at. A route added here arrived with no gate and nothing
    // to notice, which is the same hole `/issues` above was closed for.
    //
    // In scope so the triage is FORCED: a new route under `/api/account`
    // either uses requirePermission or gets an EXCLUDED_ROUTES entry with a
    // written reason. The three that exist today are excluded below.
    {
        relPath: 'src/app/api/account',
        why: 'Self-service account surface (avatar, profile). Session-scoped rather than tenant-scoped, so the existing routes are excluded individually — the root is in scope so a future one cannot arrive unexamined.',
    },
    // Also not tenant-scoped, and it arrived here the hard way. `/api/security`
    // held exactly one route, and that route's GET served the process-wide CSP
    // violation buffer to the internet for as long as it existed (#2103): the
    // path is on the edge allowlist so the credential-less POST can land, the
    // allowlist is path-scoped rather than method-scoped, and no guardrail
    // walked the directory. Nothing was exempt — nothing was looked at.
    //
    // In scope so the triage is FORCED for the next route added here.
    {
        relPath: 'src/app/api/security',
        why: 'Deployment-wide security surface. Not under /api/t/[tenantSlug], so requirePermission (which resolves a tenant role) does not apply to what lives here today; the one route is excluded individually with its actual gate named, and the root is in scope so the next one cannot arrive unexamined.',
    },
    {
        relPath: 'src/app/api/t/[tenantSlug]/vendors/[vendorId]/subprocessors',
        why: 'The GDPR Art.28 sub-processor register + its recursive nth-party chain. Reads gate on vendors.view, mutations on vendors.edit — matching the usecase asserts. In scope so denials audit at the C.1 layer and a future refactor cannot drop the usecase assert without failing here. Narrow leaf root: the other vendors/[vendorId] siblings are NOT privileged and stay on usecase-layer authorization.',
    },
];

/**
 * Routes intentionally excluded from API permission coverage. Each
 * entry MUST carry a `reason` so the carve-out is reviewable.
 *
 * Format: relative path from `src/app` (the same prefix `Next.js`
 * uses), e.g. `api/t/[tenantSlug]/admin/foo/route.ts`.
 */
const EXCLUDED_ROUTES: ReadonlyArray<{ relPath: string; reason: string }> = [
    // Epic D.3 — self-service security routes that are intentionally
    // NOT admin-gated. Any authenticated tenant member may operate on
    // their own MFA enrolment / challenge / current session. The
    // handlers resolve ctx via `getTenantCtx` and the underlying
    // usecases scope each action to `ctx.userId`. Admin-driven
    // counterparts (`/admin/sessions`, `/security/sessions/revoke-{all,user}`)
    // ARE in scope and gated by `requirePermission`.
    {
        relPath: 'api/t/[tenantSlug]/security/sessions/revoke-current/route.ts',
        reason: 'Self-service: revoke MY sessions (scoped to ctx.userId).',
    },
    {
        relPath: 'api/t/[tenantSlug]/security/mfa/enroll/route.ts',
        reason: 'Self-service: enrol MY MFA factor (scoped to ctx.userId).',
    },
    {
        relPath: 'api/t/[tenantSlug]/security/mfa/enroll/start/route.ts',
        reason: 'Self-service: start MY MFA enrolment.',
    },
    {
        relPath: 'api/t/[tenantSlug]/security/mfa/enroll/verify/route.ts',
        reason: 'Self-service: verify MY MFA enrolment.',
    },
    {
        relPath: 'api/t/[tenantSlug]/security/mfa/challenge/verify/route.ts',
        reason: 'Self-service: complete MY MFA challenge during sign-in.',
    },
    // Epic 1, PR 2 — Platform-admin routes authenticated by PLATFORM_ADMIN_API_KEY
    // (X-Platform-Admin-Key header, constant-time verified). These routes operate
    // outside the tenant-session model — there is no tenantId or userId in scope
    // when the platform key is verified, so requirePermission(...) does not apply.
    // The key is injected by the orchestrator / secret-manager and is never exposed
    // to tenant-level callers.
    {
        relPath: 'api/admin/tenants/route.ts',
        reason: 'Platform-admin-key-gated: POST /api/admin/tenants — tenant-scope does not apply.',
    },
    {
        relPath: 'api/admin/tenants/[slug]/transfer-ownership/route.ts',
        reason: 'Platform-admin-key-gated: transfer-ownership — tenant-scope does not apply.',
    },
    {
        relPath: 'api/admin/diagnostics/route.ts',
        reason: 'Platform-admin-key-gated: process/runtime diagnostics — server-wide, with no tenant dimension, so tenant-scope does not apply.',
    },
    {
        relPath: 'api/security/csp-report/route.ts',
        reason:
            'Platform-admin-key-gated GET (verifyPlatformApiKey) over the ' +
            'process-wide CSP violation ring buffer — server-wide, no tenant ' +
            'dimension, so tenant-scope does not apply; a tenant role would ' +
            'be a cross-tenant read. The POST on the same file is the ' +
            'credential-less browser report sink and stays open by design. ' +
            'The GET gate is asserted behaviourally in ' +
            'tests/unit/security/csp-report-authz.test.ts.',
    },
    // Risk-report siblings pulled in by the `risks/reports` privileged root.
    // Only the POST /risks/reports generate handler is an export action (gated
    // on reports.export in the same file). These siblings are NOT exports:
    {
        relPath: 'api/t/[tenantSlug]/risks/reports/templates/route.ts',
        reason: 'Report TEMPLATE metadata CRUD (list/create a template definition) — not an export; authorised at the usecase layer for tenant members.',
    },
    {
        relPath: 'api/t/[tenantSlug]/risks/reports/schedules/route.ts',
        reason: 'Recurring-delivery SCHEDULE config CRUD (list/create) — not an export itself; the scheduled delivery job runs server-side. Generation is gated at POST /risks/reports.',
    },
    {
        relPath: 'api/t/[tenantSlug]/risks/reports/schedules/[scheduleId]/route.ts',
        reason: 'Recurring-delivery SCHEDULE config CRUD (patch/delete) — not an export itself; the scheduled delivery job runs server-side.',
    },
    {
        relPath: 'api/t/[tenantSlug]/risks/reports/[reportId]/download/route.ts',
        reason: 'Retrieval of an already-generated report run scoped to the tenant — a view-level action mirroring the /risks/reports page download affordance. The privileged export-GENERATION action is gated at POST /risks/reports.',
    },
    // `/api/account` — session-scoped, so there is no tenant role for
    // `requirePermission` to resolve. Each authenticates via
    // `getServerSession` and is described below by what it ACTUALLY
    // authorises, not by the directory it sits in.
    {
        relPath: 'api/account/profile/route.ts',
        reason: 'Self-service: PATCH MY profile. The handler writes to session.user.id and takes no user identifier from the request.',
    },
    {
        relPath: 'api/account/avatar/route.ts',
        reason: 'Self-service: upload/delete MY avatar. Both handlers key storage off session.user.id and take no user identifier from the request.',
    },
    {
        relPath: 'api/account/avatar/[userId]/route.ts',
        reason:
            'Reads ANOTHER user, so it is neither self-service nor unguarded — ' +
            'it is gated by `canViewAvatar`, which requires an ACTIVE membership ' +
            'shared with the subject and answers a caller outside that audience ' +
            'with the same 404 an absent avatar returns (#2104). Not ' +
            '`requirePermission`: the route resolves no tenant from its path, so ' +
            'there is no tenant role for a permission key to be checked against — ' +
            'the audience is "any tenant we both belong to", which is a membership ' +
            'question rather than a role one. Behaviour is asserted in ' +
            'tests/unit/account-avatar-serve-authz.test.ts.',
    },
];

const REPO_ROOT = path.resolve(__dirname, '../..');

function walkRouteFiles(dir: string): string[] {
    const out: string[] = [];
    if (!fs.existsSync(dir)) return out;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            out.push(...walkRouteFiles(full));
        } else if (entry.name === 'route.ts' || entry.name === 'route.tsx') {
            out.push(full);
        }
    }
    return out;
}

function discoverPrivilegedRoutes(): string[] {
    const seen = new Set<string>();
    for (const root of PRIVILEGED_ROOTS) {
        const abs = path.resolve(REPO_ROOT, root.relPath);
        for (const f of walkRouteFiles(abs)) seen.add(f);
    }
    return Array.from(seen).sort();
}

/**
 * Convert a route file's filesystem path back to its URL pathname.
 *
 *   src/app/api/t/[tenantSlug]/admin/scim/route.ts
 *      → /api/t/acme/admin/scim
 *
 * `[tenantSlug]` becomes a literal segment so the regexes in
 * `ROUTE_PERMISSIONS` (which use `\/[^/]+`) match cleanly. Other
 * dynamic `[id]` segments are similarly stubbed.
 */
function fileToPathname(routeFile: string): string {
    const rel = path.relative(path.join(REPO_ROOT, 'src/app'), routeFile);
    const noFile = rel.replace(/\/route\.tsx?$/, '');
    const segments = noFile.split('/').map((seg) => {
        if (seg === '[tenantSlug]') return 'acme';
        if (seg.startsWith('[') && seg.endsWith(']')) return 'stub-id';
        return seg;
    });
    return '/' + segments.join('/');
}

function readSource(file: string): string {
    return fs.readFileSync(file, 'utf8');
}

function relPathFromRepo(file: string): string {
    return path.relative(REPO_ROOT, file);
}

function lookupExclusion(
    fileFromAppRoot: string,
): { reason: string } | undefined {
    return EXCLUDED_ROUTES.find((e) => e.relPath === fileFromAppRoot);
}

const PRIVILEGED_ROUTES = discoverPrivilegedRoutes();

// ─── Tests ───────────────────────────────────────────────────────────

describe('Epic C.1 — API permission coverage guardrail', () => {
    it('discovers at least one privileged route (sanity check)', () => {
        // Catches a refactor that moves the admin directory and
        // silently empties the entire suite.
        expect(PRIVILEGED_ROUTES.length).toBeGreaterThan(0);
    });

    test.each(
        PRIVILEGED_ROUTES.map((r) => [relPathFromRepo(r), r] as const),
    )('%s wraps its handlers with requirePermission(...)', (relFromRepo, full) => {
        const fromAppRoot = path.relative(
            path.join(REPO_ROOT, 'src/app'),
            full,
        );
        const exclusion = lookupExclusion(fromAppRoot);
        if (exclusion) {

            console.log(`[exempt] ${relFromRepo} — ${exclusion.reason}`);
            return;
        }

        const src = readSource(full);
        const ok = /requirePermission\s*[<(]/.test(src);

        if (!ok) {
            // High-signal failure message a reviewer can act on without
            // re-reading the test.
            throw new Error(
                [
                    `Privileged route is missing API-layer permission enforcement.`,
                    `  File:  ${relFromRepo}`,
                    `  Fix:   Wrap each exported handler with`,
                    `         requirePermission('admin.<key>', async (req, { params }, ctx) => { ... })`,
                    `         imported from '@/lib/security/permission-middleware'.`,
                    `         Then add the route URL to ROUTE_PERMISSIONS in`,
                    `         src/lib/security/route-permissions.ts.`,
                    `  Or:    If the route is intentionally exempt, append it to`,
                    `         EXCLUDED_ROUTES in this guardrail with a written reason.`,
                ].join('\n'),
            );
        }
    });

    test.each(
        PRIVILEGED_ROUTES.map((r) => [relPathFromRepo(r), r] as const),
    )('%s is registered in ROUTE_PERMISSIONS', (relFromRepo, full) => {
        const fromAppRoot = path.relative(
            path.join(REPO_ROOT, 'src/app'),
            full,
        );
        if (lookupExclusion(fromAppRoot)) return;

        const pathname = fileToPathname(full);

        if (!isRouteCovered(pathname)) {
            throw new Error(
                [
                    `Privileged route is not in the ROUTE_PERMISSIONS map.`,
                    `  File:     ${relFromRepo}`,
                    `  URL:      ${pathname}`,
                    `  Fix:      Add a rule in src/lib/security/route-permissions.ts:`,
                    ``,
                    `              {`,
                    `                  path: new RegExp(\`^\\\\/api\\\\/t\\\\/[^/]+\\\\/admin\\\\/<segment>(\\\\/.*)?$\`),`,
                    `                  permission: 'admin.<key>',`,
                    `                  note: 'Why this route is admin-only.',`,
                    `              }`,
                    ``,
                    `            …and ensure the rule's regex matches the URL above.`,
                ].join('\n'),
            );
        }
    });

    // ── Map sanity ──────────────────────────────────────────────────

    it('every rule in ROUTE_PERMISSIONS carries a non-trivial `note`', () => {
        const offenders = ROUTE_PERMISSIONS.filter(
            (r: RoutePermissionRule) => !r.note || r.note.trim().length < 20,
        ).map((r) => r.path.source);

        if (offenders.length > 0) {
            throw new Error(
                [
                    `ROUTE_PERMISSIONS contains rules with missing or trivial \`note\`:`,
                    ...offenders.map((p) => `  - ${p}`),
                    ``,
                    `Each rule must have a one-sentence rationale (>=20 chars) so a`,
                    `reviewer can validate the policy in code review without`,
                    `chasing the handler.`,
                ].join('\n'),
            );
        }
    });

    it('every rule references a real PermissionSet key', () => {
        // PermissionKey is a TS-only contract; this runtime check
        // prevents `as PermissionKey` casts from ever sneaking in.
        const adminPerms = getPermissionsForRole('ADMIN');
        const offenders: string[] = [];

        for (const rule of ROUTE_PERMISSIONS) {
            const keys = Array.isArray(rule.permission)
                ? rule.permission
                : [rule.permission];
            for (const k of keys) {
                const [domain, action] = k.split('.');
                const bag = (adminPerms as Record<string, Record<string, boolean>>)[
                    domain
                ];
                if (!bag || typeof bag[action] !== 'boolean') {
                    offenders.push(`${rule.path.source}: ${k}`);
                }
            }
        }

        if (offenders.length > 0) {
            throw new Error(
                [
                    `ROUTE_PERMISSIONS references unknown PermissionKey(s):`,
                    ...offenders.map((o) => `  - ${o}`),
                    ``,
                    `Check the spelling against PermissionSet in src/lib/permissions.ts`,
                    `and against the keys returned by getPermissionsForRole('ADMIN').`,
                ].join('\n'),
            );
        }
    });

    it('every EXCLUDED_ROUTES entry points at a route that still exists', () => {
        // This list had no such check, which is the same shape of hole as the
        // one that kept `/api/account` out of scope: an exemption nothing
        // validates. A carve-out whose file was renamed or deleted stays on
        // the list forever, and the next route to land on that path inherits
        // an exemption written for different code — silently ungated, with a
        // reason attached that no longer describes it.
        //
        // Deleting a route means deleting its entry, in the same diff.
        const dangling = EXCLUDED_ROUTES.filter(
            (e) => !fs.existsSync(path.join(REPO_ROOT, 'src/app', e.relPath)),
        );

        if (dangling.length > 0) {
            throw new Error(
                [
                    `EXCLUDED_ROUTES lists routes that no longer exist:`,
                    ...dangling.map((e) => `  - ${e.relPath}\n      reason: ${e.reason}`),
                    ``,
                    `If the route was deleted, delete its exclusion too.`,
                    `If it moved, update the path — the exemption does not follow it.`,
                ].join('\n'),
            );
        }
    });

    it('every EXCLUDED_ROUTES entry is actually reachable by the scan', () => {
        // The mirror, and the half that matters more. An exclusion for a file
        // under no PRIVILEGED_ROOT is dead text: the scan never reaches the
        // route, so the entry excludes nothing and its reason is never read.
        // It looks like a considered carve-out and is inert — which is how a
        // reviewer concludes a directory was triaged when it was not.
        const unreachable = EXCLUDED_ROUTES.filter(
            (e) =>
                !PRIVILEGED_ROUTES.some(
                    (f) => path.relative(path.join(REPO_ROOT, 'src/app'), f) === e.relPath,
                ),
        );

        if (unreachable.length > 0) {
            throw new Error(
                [
                    `EXCLUDED_ROUTES entries that no PRIVILEGED_ROOT covers:`,
                    ...unreachable.map((e) => `  - ${e.relPath}`),
                    ``,
                    `These exclude nothing. Either add the covering root to`,
                    `PRIVILEGED_ROOTS, or drop the entry.`,
                ].join('\n'),
            );
        }
    });

    it('every rule path-regex matches at least one real route on disk', () => {
        // Catches dead rules left over after a route is moved or
        // deleted. A rule that matches nothing silently weakens the
        // map's coverage signal.
        const orphans: string[] = [];

        for (const rule of ROUTE_PERMISSIONS) {
            const matchesSomething = PRIVILEGED_ROUTES.some((file) =>
                rule.path.test(fileToPathname(file)),
            );
            if (!matchesSomething) {
                orphans.push(rule.path.source);
            }
        }

        if (orphans.length > 0) {
            throw new Error(
                [
                    `ROUTE_PERMISSIONS contains rules that match no route on disk:`,
                    ...orphans.map((p) => `  - ${p}`),
                    ``,
                    `If the route was moved or deleted, remove or update the rule.`,
                    `If the rule covers a future route, add it together with the`,
                    `route file in the same PR.`,
                ].join('\n'),
            );
        }
    });
});
