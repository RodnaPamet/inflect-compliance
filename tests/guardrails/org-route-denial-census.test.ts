/**
 * Every privileged org mutation refuses through a gate that RECORDS the refusal.
 *
 * WHY A SECOND CENSUS, AND WHY ORG-SCOPED
 * ---------------------------------------
 * `destructive-route-denial-census.test.ts` asks its question of destructive
 * verbs only — delete / remove / wipe / deactivate / disable / reset. That scope
 * is deliberate and worth keeping: it is small enough to shrink, and shrinking is
 * the point of a ratchet.
 *
 * But it means a privileged NON-destructive mutation is invisible to it. Changing
 * a member's ROLE is the case that proved this expensive: a READER→ADMIN
 * promotion fans `Role.ADMIN` membership rows into every tenant in the
 * organization, its SUCCESS is audited as `ORG_MEMBER_ROLE_CHANGED`, and until
 * #2166 a refused attempt recorded nothing at all. The ledger held every
 * escalation that worked and nothing about one that was blocked — while a refused
 * widget deletion was fully audited.
 *
 * WHY NOT JUST WIDEN THE GLOBAL CENSUS. Measured across `src/app/api/**`: 438
 * mutating handlers, 268 without a route-level gate. That is not a baseline, it
 * is a blocker — a 268-line declared list nobody reads, and most of those are
 * correctly authorized by a usecase `assertCan*`, which
 * `api-route-has-some-authorization.test.ts` already covers. The org surface is
 * 22 handlers, so it can be held to the stricter standard without the list
 * decaying into noise.
 *
 * WHAT THIS DOES NOT CLAIM. Presence of a gate, not its correctness: it cannot
 * tell whether the right permission key was chosen, and it makes no ordering
 * claim. The behavioural half lives in
 * `tests/unit/security/org-route-denial-audit.test.ts`, which drives each route
 * and asserts on the row that reaches the audit writer.
 */
import * as fs from 'fs';
import * as path from 'path';
import { repoRelativeFiles, REPO_ROOT } from '../helpers/repo-files';

/**
 * The gate whose denials are audited on the org surface.
 *
 * Org routes cannot use the tenant-side `requirePermission`: it resolves a
 * tenant role, and `AuditLog.tenantId` is NOT NULL with an FK to Tenant while
 * `OrgContext` carries no tenant. Org denials go to `OrgAuditLog` instead.
 *
 * The bracket class admits both `X<Params>(` and `X(`. Omitting it was a real
 * bug in an earlier census, which then matched no gated route at all.
 */
const ORG_ROUTE_GATE = /requireOrgPermission\s*[(<]/;

const stripComments = (s: string): string =>
    s.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * Mutations that legitimately have no org permission gate.
 *
 * Each needs a reason, and the reason has to be that no org role EXISTS to
 * check — not that the check was inconvenient.
 */
const UNGATED_ORG_MUTATIONS: ReadonlyArray<readonly [string, string]> = [
    [
        'org/invite/[token]/route.ts#POST',
        'Self-service redemption by token. The caller is not yet a member, so ' +
            'there is no org role to resolve — the token IS the credential. The ' +
            'usecase audits an email-mismatch refusal itself.',
    ],
    [
        'org/invite/[token]/accept-redirect/route.ts#POST',
        'The browser-redirect sibling of the above, same token credential.',
    ],
    [
        'org/route.ts#POST',
        'Creates an organization. There is no organization yet, so no org ' +
            'permission exists to check; authorization is the authenticated ' +
            'session. Classed SESSION_SELF_SERVICE by the Layer-2 guard too.',
    ],
];

/** Split a route module into per-EXPORT blocks — the handler is the unit. */
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

const census = (): { mutations: string[]; ungated: string[] } => {
    const mutations: string[] = [];
    const ungated: string[] = [];
    for (const rel of repoRelativeFiles()) {
        if (!rel.startsWith('src/app/api/org/') || !rel.endsWith('route.ts')) continue;
        const src = stripComments(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'));
        for (const { verb, block } of handlerBlocks(src)) {
            if (verb === 'GET') continue;
            const key = `${rel.replace('src/app/api/', '')}#${verb}`;
            mutations.push(key);
            if (!ORG_ROUTE_GATE.test(block)) ungated.push(key);
        }
    }
    return { mutations: mutations.sort(), ungated: ungated.sort() };
};

describe('org mutations whose denials are invisible', () => {
    const { mutations, ungated } = census();

    it('the census is plausibly sized (guards against a vacuous pass)', () => {
        // A population that collapsed to nothing would make the exact-list
        // assertion below pass while measuring no routes at all.
        expect(mutations.length).toBeGreaterThanOrEqual(15);
        expect(mutations.length).toBeGreaterThan(ungated.length);
    });

    it('the set of ungated org mutations is exactly the declared list', () => {
        // PER EXPORT, so one gated verb cannot certify its siblings. That is not
        // hypothetical: `members/route.ts` had a gated DELETE beside an inline
        // POST and PUT, and a whole-file check reported the file clean.
        expect(ungated).toEqual([...UNGATED_ORG_MUTATIONS.map(([k]) => k)].sort());
    });

    it('no declared exemption is stale', () => {
        // A handler that gets gated must lose its line in the same diff, or the
        // list decays into claims about code that has moved on.
        const declared = UNGATED_ORG_MUTATIONS.map(([k]) => k);
        expect(declared.filter((k) => !ungated.includes(k))).toEqual([]);
    });

    it('every exemption carries a written reason', () => {
        for (const [key, reason] of UNGATED_ORG_MUTATIONS) {
            expect(reason.length).toBeGreaterThan(40);
            expect(key).toMatch(/#(POST|PUT|PATCH|DELETE)$/);
        }
    });

    it('the detector fires — an ungated handler is caught', () => {
        // Without this, "the list matches" and "the regex matched nothing" are
        // the same green.
        const gated = `export const POST = withApiErrorHandling(
            requireOrgPermission<P>('canManageMembers', async () => {}));`;
        const inline = `export const POST = withApiErrorHandling(async (req, rc) => {
            const ctx = await getOrgCtx(await rc.params, req);
            if (!ctx.permissions.canManageMembers) throw forbidden('no');
        });`;
        expect(ORG_ROUTE_GATE.test(gated)).toBe(true);
        expect(ORG_ROUTE_GATE.test(inline)).toBe(false);
    });
});
