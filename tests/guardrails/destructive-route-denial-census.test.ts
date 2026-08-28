/**
 * The destructive-route audit census, as a LIST rather than a number.
 *
 * `AUTHZ_DENIED` is written in exactly one place — `auditPermissionDenied`
 * inside `requirePermission`. A usecase `assertCan*` throws `forbidden(...)`
 * and writes nothing. So a destructive route that authorizes only in the
 * usecase refuses correctly and records NOTHING, which in a compliance product
 * is a hole in the one artefact the product exists to produce (#2117).
 *
 * WHY THIS LIVES IN A TEST AND NOT IN A DOC. The tranche-2 implementation note
 * carried this census as prose and got it wrong by one — and its stated rule
 * would not have reproduced even its own number, because it scanned for the
 * literal `requirePermission(` while the routes are written
 * `requirePermission<Params>(...)` with a generic. A census nobody can re-run
 * is a claim, not a measurement. This computes it.
 *
 * WHY A LIST AND NOT A COUNT. A count is the merge-hazard shape: two branches
 * each adjust `expect(n).toBe(38)` to their own value, git merges both cleanly
 * because they touched one line in the same way, and main ends up wrong with
 * no conflict for a reviewer to catch. A list conflicts when it should.
 *
 * TO SHRINK IT: migrate a route to `requirePermission` and delete its line
 * here in the same diff. Adding a new ungated destructive route fails until
 * somebody either gates it or records why it cannot be gated.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { repoRelativeFiles } from '../helpers/repo-files';

const ROOT = path.resolve(__dirname, '../..');

/** Path segments that make a route destructive regardless of its verb. */
const DESTRUCTIVE_SEGMENTS = new Set([
    'purge', 'restore', 'delete', 'archive', 'revoke',
    'wipe', 'deactivate', 'disable', 'remove', 'reset',
]);

/**
 * The route-level gates whose denials are AUDITED.
 *
 * Two families, named explicitly rather than pattern-matched loosely:
 *
 *   requirePermission / requireAnyPermission / requireAllPermissions
 *     — tenant surface, writes AUTHZ_DENIED to AuditLog.
 *   requireOrgPermission
 *     — org surface, writes ORG_AUTHZ_DENIED to OrgAuditLog. It needs its own
 *       alternative because `Org` sits between `require` and `Permission`, so
 *       the tenant pattern does not match it — verified, not assumed.
 *
 * Org routes CANNOT use the tenant gate: it resolves a tenant role, and
 * `AuditLog.tenantId` is NOT NULL with an FK to Tenant while `OrgContext`
 * carries no tenant. That is why there are two, not one with a wider regex.
 *
 * Both call forms are admitted: `X<Params>(` and `X(`. The bracket class is
 * what allows the generic form, and omitting it was a real bug in an earlier
 * census — it matched no gated route at all and reported a 37% coverage
 * figure that was off by roughly a factor of three.
 */
const ROUTE_GATE = /require(?:Any|All)?Permissions?\s*[(<]|requireOrgPermission\s*[(<]/;

const stripComments = (s: string): string =>
    s.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * Every route that still authorizes only in its usecase, so its refusals are
 * invisible in the audit trail. Sorted; one line each so a diff is readable.
 */
const UNGATED_DESTRUCTIVE_ROUTES: readonly string[] = [
    'account/avatar/route.ts',
    'scim/v2/Groups/[id]/route.ts',
    'scim/v2/Users/[id]/route.ts',
    'sso/route.ts',
    't/[tenantSlug]/assets/[id]/controls/[controlId]/route.ts',
    't/[tenantSlug]/assets/[id]/evidence/attached/[evidenceId]/route.ts',
    't/[tenantSlug]/assets/[id]/risks/[riskId]/route.ts',
    't/[tenantSlug]/audits/auditors/[auditorId]/route.ts',
    't/[tenantSlug]/audits/auditors/access/route.ts',
    't/[tenantSlug]/automation/rules/[id]/route.ts',
    't/[tenantSlug]/business-continuity/[id]/dependencies/[depId]/route.ts',
    't/[tenantSlug]/business-continuity/[id]/route.ts',
    't/[tenantSlug]/controls/[controlId]/assets/route.ts',
    't/[tenantSlug]/controls/[controlId]/contributors/[userId]/route.ts',
    't/[tenantSlug]/controls/[controlId]/evidence/[linkId]/route.ts',
    't/[tenantSlug]/controls/[controlId]/requirements/route.ts',
    't/[tenantSlug]/controls/[controlId]/risks/[riskId]/route.ts',
    't/[tenantSlug]/evidence/[id]/controls/[controlId]/route.ts',
    't/[tenantSlug]/policies/[id]/control-links/route.ts',
    't/[tenantSlug]/processes/[id]/snapshots/[version]/restore/route.ts',
    't/[tenantSlug]/risks/[id]/evidence/attached/[evidenceId]/route.ts',
    't/[tenantSlug]/risks/correlations/route.ts',
    't/[tenantSlug]/risks/hierarchy/[nodeId]/links/route.ts',
    't/[tenantSlug]/security/mfa/enroll/route.ts',
    't/[tenantSlug]/tests/runs/[runId]/evidence/[linkId]/route.ts',
    't/[tenantSlug]/vendors/[vendorId]/bundles/[bundleId]/route.ts',
];

const census = (): { destructive: string[]; ungated: string[] } => {
    const destructive: string[] = [];
    const ungated: string[] = [];
    for (const rel of repoRelativeFiles()) {
        if (!rel.startsWith('src/app/api/') || !rel.endsWith('route.ts')) continue;
        const src = stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
        const hasDelete = /export\s+(async\s+)?(function|const)\s+DELETE/.test(src);
        const verbSegment = rel.split('/').some((s) => DESTRUCTIVE_SEGMENTS.has(s));
        if (!hasDelete && !verbSegment) continue;
        const key = rel.replace('src/app/api/', '');
        destructive.push(key);
        if (!ROUTE_GATE.test(src)) ungated.push(key);
    }
    return { destructive: destructive.sort(), ungated: ungated.sort() };
};

describe('destructive routes whose denials are invisible', () => {
    const { destructive, ungated } = census();

    it('the census is plausibly sized (guards against a vacuous pass)', () => {
        // A population that collapses to nothing would make the list assertion
        // below pass while measuring no routes at all.
        expect(destructive.length).toBeGreaterThanOrEqual(50);
        expect(destructive.length).toBeGreaterThan(ungated.length);
    });

    it('the set of ungated destructive routes is exactly the declared list', () => {
        expect(ungated).toEqual([...UNGATED_DESTRUCTIVE_ROUTES].sort());
    });

    it('no declared entry is stale', () => {
        // A route that was gated, renamed or deleted must lose its line in the
        // same diff — otherwise the list decays into a set of claims about
        // files that no longer exist.
        const stale = UNGATED_DESTRUCTIVE_ROUTES.filter((r) => !ungated.includes(r));
        expect(stale).toEqual([]);
    });
});
