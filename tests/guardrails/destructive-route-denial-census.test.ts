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
 *
 * RESOLUTION — what this does NOT prove. The scan is per FILE, not per
 * HANDLER: a route module counts as gated when ANY gate appears anywhere in
 * it. So a file exporting a gated POST and an ungated DELETE passes, and this
 * list reads "gated" over it.
 *
 * Measured, not assumed: renaming BOTH gates in a two-handler file fails the
 * guard; renaming only one passes it. That bound is worth knowing before
 * reading a shrinking number as "every destructive handler is gated" — it
 * means "every destructive route module has at least one gate".
 *
 * Closing it would mean parsing each `export const <VERB>` and attributing
 * gates to handlers, which is a real parser rather than a grep.
 *
 * SEVEN MIXED MODULES EXIST TODAY, so this is not hypothetical. They are a
 * by-product of the #2117 tranches: each gated its DELETE and left a PATCH or
 * PUT on the old path, because those compose through `withValidatedBody` and
 * were deferred. That reason has since evaporated — `parseJsonBody` composes
 * with `requirePermission` and 58 routes already pair them — so the remaining
 * verbs are now migratable and simply have not been migrated yet.
 *
 * Until they are, read this list as "every destructive route module has at
 * least one gate", never as "every destructive handler is gated". A guard that
 * overstates its own reach is the failure mode this suite exists to prevent.
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
/**
 * A route with no route-level gate, and WHY it still has none.
 *
 * The list used to be bare strings, which made every entry mean the same
 * thing: "not done yet". After four tranches that reading is wrong and
 * actively misleading — what is left is what the `requirePermission`
 * mechanism CANNOT take, and each one is a different reason. A residual
 * nobody can tell apart from a backlog gets re-triaged from scratch every
 * time somebody looks at it, which is exactly what happened when #2189 was
 * filed calling these "straightforward gaps".
 *
 *   'todo'   — a real gap. Someone should close it. Names its issue.
 *   'exempt' — a decision. The reason is the whole entry; if it stops being
 *              true, the entry is wrong and should move to 'todo'.
 *
 * An exemption is NOT permission to leave a refusal unrecorded. Two of the
 * three exempt routes below have no refusal to record; the third records it
 * somewhere this file cannot see, and says where.
 */
type UngatedRoute = {
    readonly route: string;
    readonly disposition: 'todo' | 'exempt';
    readonly reason: string;
};

const UNGATED_DESTRUCTIVE_ROUTES: readonly UngatedRoute[] = [
    {
        route: 'account/avatar/route.ts',
        disposition: 'exempt',
        reason:
            'Self-service, structurally. Both handlers read the session and call ' +
            'uploadOwnAvatar / removeOwnAvatar with session.user.id; there is no ' +
            'userId parameter anywhere in the module, so one user cannot act on ' +
            'another and there is no authorization decision to refuse or record.',
    },
    {
        route: 'scim/v2/Groups/[id]/route.ts',
        disposition: 'exempt',
        reason:
            'No refusal path exists. scim-groups.ts contains zero assertCan* and ' +
            'zero forbidden() calls, authenticateScimRequest returns ' +
            '{tenantId, tokenId, tokenLabel} rather than a RequestContext, and ' +
            'TenantScimToken has no scope column — so a valid token is fully ' +
            'authorized and an invalid one gets 401 at the door, which is ' +
            'authentication. A gate here would be a check that never fires, and a ' +
            'permanently-passing gate reads as coverage. Success IS audited, with ' +
            'actorType SCIM. See #2190; the unscoped-token property is #2200.',
    },
    {
        route: 'scim/v2/Users/[id]/route.ts',
        disposition: 'exempt',
        reason:
            'Same as the Groups sibling: scim-users.ts has zero assertCan* and zero ' +
            'forbidden() calls, so the DELETE has no authorization decision to ' +
            'refuse. See #2190.',
    },
    {
        route: 't/[tenantSlug]/security/mfa/enroll/route.ts',
        disposition: 'exempt',
        reason:
            'DUAL-MODE, so no single route-level gate is correct: with no body the ' +
            'DELETE removes the CALLER\'s enrolment and every member may do that; ' +
            'with targetUserId it is an admin action. One permission would either ' +
            'break self-service or admit everyone. The admin-branch refusal in ' +
            'removeMfaEnrollment therefore writes its own AUTHZ_DENIED row — this ' +
            'route is exempt from the GATE, not from the audit. Removing another ' +
            'user\'s second factor is the one action on this surface a reviewer ' +
            'most needs a refused attempt for.',
    },
    {
        route: 'sso/route.ts',
        disposition: 'todo',
        reason:
            'requirePermission cannot gate it: its handler type requires a ' +
            'tenantSlug route param and resolves via getTenantCtx, and this path ' +
            'has no slug — it uses getLegacyCtx, which resolves the tenant from ' +
            'the session. Also an uncalled duplicate of the gated ' +
            '/api/t/:slug/sso the UI reaches, so the fix is deprecation rather ' +
            'than gating. #2196.',
    },
    {
        route: 't/[tenantSlug]/business-continuity/[id]/dependencies/[depId]/route.ts',
        disposition: 'todo',
        reason:
            'Gates on assertCanWrite, which reads permissions.canWrite (role-tier) ' +
            'while requirePermission reads appPermissions, and PermissionSet has no ' +
            'continuity domain — so no key carries the matching population. Binding ' +
            'it to a neighbouring register\'s flag would change the caller set for a ' +
            'reason unrelated to the route. #2197.',
    },
    {
        route: 't/[tenantSlug]/business-continuity/[id]/route.ts',
        disposition: 'todo',
        reason:
            'Deleting a whole Business Impact Analysis, and the PUT that rewrites ' +
            'one. Same blocker as its dependencies sibling: assertCanWrite reads ' +
            'the role-tier permissions bag and PermissionSet has no continuity ' +
            'domain to gate on. #2197.',
    },
    {
        route: 't/[tenantSlug]/processes/[id]/snapshots/[version]/restore/route.ts',
        disposition: 'todo',
        reason:
            'Rolling a process map back to an earlier snapshot — destructive ' +
            'because the current version is what it overwrites. Same blocker as ' +
            'the business-continuity pair: assertCanWrite reads the role-tier bag ' +
            'and PermissionSet has no processes domain. #2197.',
    },
];

const UNGATED_ROUTE_KEYS: readonly string[] = UNGATED_DESTRUCTIVE_ROUTES.map((r) => r.route);

/**
 * Split a route module into per-EXPORT blocks.
 *
 * The census used to read the whole file, which made the claim it reports
 * imprecise: a file was "gated" if the pattern appeared ANYWHERE in it. A route
 * module with a gated DELETE beside an ungated destructive sibling therefore
 * read as clean, and the output said "this file", not "this handler".
 *
 * Splitting on the export boundary makes the unit the handler, which is the
 * thing that is actually gated or not.
 */
const handlerBlocks = (src: string): Array<{ verb: string; block: string }> => {
    const boundary = /export\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|PATCH|DELETE)\b/g;
    const marks: Array<{ verb: string; at: number }> = [];
    for (let m = boundary.exec(src); m !== null; m = boundary.exec(src)) {
        marks.push({ verb: m[1], at: m.index });
    }
    return marks.map((mark, i) => ({
        verb: mark.verb,
        block: src.slice(mark.at, i + 1 < marks.length ? marks[i + 1].at : undefined),
    }));
};

const census = (): { destructive: string[]; ungated: string[] } => {
    const destructive: string[] = [];
    const ungated: string[] = [];
    for (const rel of repoRelativeFiles()) {
        if (!rel.startsWith('src/app/api/') || !rel.endsWith('route.ts')) continue;
        const src = stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
        const verbSegment = rel.split('/').some((s) => DESTRUCTIVE_SEGMENTS.has(s));
        const key = rel.replace('src/app/api/', '');

        // A destructive HANDLER is a DELETE, or any mutating verb on a path
        // whose segment already says the route destroys something.
        const blocks = handlerBlocks(src).filter(
            (h) => h.verb === 'DELETE' || (verbSegment && h.verb !== 'GET'),
        );
        if (blocks.length === 0) continue;

        destructive.push(key);
        // The file is reported ungated when ANY destructive handler in it is —
        // so a gated DELETE can no longer certify an ungated sibling. Keys stay
        // file-level so the declared list below keeps its shape; the change is
        // what the boolean MEANS, not how it is named.
        if (blocks.some((h) => !ROUTE_GATE.test(h.block))) ungated.push(key);
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
        expect(ungated).toEqual([...UNGATED_ROUTE_KEYS].sort());
    });

    it('every entry says WHY it is still here', () => {
        // The reason IS the entry. A disposition with a thin reason is the bare
        // string list again wearing a type, and the bare list is what let a
        // deliberate residual be re-read as a backlog.
        for (const e of UNGATED_DESTRUCTIVE_ROUTES) {
            // Asserted on a route-labelled object so a failure names the thin
            // entry instead of printing two bare numbers.
            expect({ route: e.route, thin: e.reason.length <= 80 }).toEqual({
                route: e.route,
                thin: false,
            });
        }
    });

    it('every remaining GAP names the issue tracking it', () => {
        // Only 'todo' entries. An exemption is a decision that stands on its own
        // reasoning and must not need an open issue to justify itself — requiring
        // one would push people to file tickets nobody intends to action.
        for (const e of UNGATED_DESTRUCTIVE_ROUTES.filter((x) => x.disposition === 'todo')) {
            expect(e.reason).toMatch(/#\d{3,}/);
        }
    });

    it('the number of real gaps only goes down', () => {
        // A ratchet floor, not a restatement of the list: this is the count that
        // must fall, and the exempt entries deliberately do not count toward it.
        // Gating a route, or reclassifying one to 'exempt' with an argument,
        // lowers this in the same diff.
        const todo = UNGATED_DESTRUCTIVE_ROUTES.filter((e) => e.disposition === 'todo');
        expect(todo.length).toBeLessThanOrEqual(4);
    });

    it('no declared entry is stale', () => {
        // A route that was gated, renamed or deleted must lose its line in the
        // same diff — otherwise the list decays into a set of claims about
        // files that no longer exist.
        const stale = UNGATED_ROUTE_KEYS.filter((r) => !ungated.includes(r));
        expect(stale).toEqual([]);
    });
});
