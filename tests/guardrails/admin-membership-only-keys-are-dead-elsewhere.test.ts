/**
 * Six of the admin keys only an ADMIN membership's custom role may grant are
 * consumed nowhere but behind the admin API (owner decision, 2026-10-30).
 *
 * `ADMIN_MEMBERSHIP_ONLY_ADMIN_KEYS` (`src/lib/roles.ts`) is refused on every
 * EDITOR, READER and AUDITOR membership's custom role. It has two parts, and
 * this file holds the claim each part makes:
 *
 *   - `ADMIN_API_ONLY_KEYS`, the six. Refusing them costs nobody anything only
 *     while each is DEAD for those memberships: consumed by a route under
 *     `src/app/api/t/[tenantSlug]/admin/`, which the edge (`checkAdminAccess`)
 *     refuses to them by their built-in role, or by code only such a route
 *     reaches. The day one gains a consumer anywhere else, the rule starts
 *     taking something away without anybody deciding it should — so rules 1 to
 *     4 below fail first, and the key either moves to the second part by a
 *     decision or the consumer moves.
 *   - `SIDE_DOOR_ADMIN_KEYS`, the four refused BY DECISION (owner decision,
 *     2026-10-30): `scim`, `compliance_dsar_manage`, `agent_harness_ingest` and
 *     `agent_external_tools`. They are NOT dead elsewhere, and rules 1 to 4 do
 *     not ask about them. Rule 5 holds the opposite claim — that each is still
 *     reached outside the admin API's role gate — so the docblock saying the
 *     rule takes them away stays true, and a key that has gone dead is noticed
 *     and can move to the first part.
 *
 * What it asks, statically (in rules 1 to 4, "a listed key" is one of the six):
 *
 *   1. ROUTES. Every exported handler of every `src/app/api/**\/route.ts`
 *      outside the admin API, and every declaration its call graph reaches
 *      within three module hops (`reachedBodies` in
 *      `tests/helpers/route-authorization-graph.ts`, the analyser the
 *      authorization guardrail stands on), may not read a listed key: a
 *      `requirePermission('admin.<key>')`, an `appPermissions.admin.<key>`, or
 *      the key named to a policy helper (`assertAgentGovernanceWrite(ctx,
 *      '<key>')`).
 *   2. PAGES. The same, from every top-level declaration of every SERVER
 *      `page.tsx` and `layout.tsx` under `src/app/t/[tenantSlug]/` — admin
 *      pages included, because the edge does not refuse a page: a refused page
 *      request falls through to the page's own gate. A page that reads a key
 *      only to decide whether to SHOW a control whose request goes to the admin
 *      API is listed in `AFFORDANCE_ONLY_PAGES` with its reason; one that gates
 *      server-rendered data on a key must not be.
 *   3. MACHINE SURFACES. The tool funnel and its tools (`src/lib/mcp/`), the
 *      agent engines (`src/lib/agentic/`), the AI layer (`src/app-layer/ai/`)
 *      and the jobs (`src/app-layer/jobs/`) may not name a listed key at all. A
 *      tool call or a job acts with a membership's permissions custom role
 *      included, through no edge.
 *   4. BEARER TOKENS. An `iflk_` key skips the edge's role gate and, bound to an
 *      agent, acts with its creator's permissions intersected with its scopes.
 *      No scope may carry one of the five agent keys, so that path cannot reach
 *      them; `admin.sso` is carried by `admin:write` and consumed by nothing.
 *
 * LIMITS. The analysis is syntactic and follows calls only: a JSX element is
 * not a call (so a client component a page renders is not reached — by
 * construction it can only reach the server through an API route, which rule 1
 * covers), `import()` is not followed, and a chain longer than three module
 * hops is not resolved. A key read through a computed property
 * (`admin[name]`) or assembled from parts is not seen. Reachability is not
 * liveness: a read behind a branch that never runs still counts, which errs
 * towards failing. The definition modules that LIST keys rather than consume
 * them are skipped, each with its reason (`DEFINITION_MODULES`).
 */
import * as fs from 'fs';
import * as path from 'path';

import { createAnalyzer } from '../helpers/route-authorization-graph';
import { repoRelativeFiles } from '../helpers/repo-files';
import { codeOf } from '../helpers/source-blocks';
import { ADMIN_API_ONLY_KEYS, ADMIN_MEMBERSHIP_ONLY_ADMIN_KEYS, SIDE_DOOR_ADMIN_KEYS } from '@/lib/roles';
import { PERMISSION_SCHEMA } from '@/lib/permissions';
import { VALID_SCOPES, scopesToPermissions } from '@/lib/auth/api-key-auth';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const ADMIN_API = 'src/app/api/t/[tenantSlug]/admin/';

/**
 * Modules that LIST permission keys — the permission model, the scope map, the
 * route map and the rule itself. Reaching them is reaching a table, not a
 * decision; a key named there is consumed by whoever reads the table.
 */
const DEFINITION_MODULES: Readonly<Record<string, string>> = {
    'src/lib/permissions.ts': 'the permission model: every key, every role’s defaults',
    'src/lib/roles.ts': 'the rule itself: the list of keys it refuses',
    'src/lib/auth/api-key-auth.ts': 'the scope map; rule 4 below asks what it can carry',
    'src/lib/security/route-permissions.ts': 'the route → key map; its rules for these keys name admin API paths',
    'src/lib/security/permission-key.ts': 'the PermissionKey type and its parser',
    'src/app-layer/policies/agent-governance.policies.ts': 'the agent floor’s key UNION type; a caller names the key',
};

/**
 * Server pages that read a listed key ONLY to decide whether to show a control,
 * every request of which goes to the admin API. Not a consumer: on an EDITOR,
 * READER or AUDITOR membership the control is refused at the edge either way.
 */
const AFFORDANCE_ONLY_PAGES: Readonly<Record<string, string>> = {
    'src/app/t/[tenantSlug]/(app)/agents/[agentId]/page.tsx':
        'the policy-card, tools, skills and ownership-transfer flags passed to the tabs; every one of those tabs reads and writes `/api/t/:slug/admin/agents/[agentId]/**`',
};

const SCANNED_MACHINE_DIRS = ['src/lib/mcp/', 'src/lib/agentic/', 'src/app-layer/ai/', 'src/app-layer/jobs/'];

/** `s` as a literal inside a RegExp: every metacharacter escaped, the backslash included. */
function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The patterns that read `key`, for a code text with comments stripped. */
function readsOf(key: string): RegExp[] {
    const quoted = [`'admin.${key}'`, `"admin.${key}"`, '`admin.' + key + '`'].map((q) => new RegExp(escapeRegex(q)));
    const property = new RegExp(`\\badmin\\s*\\??\\.\\s*${escapeRegex(key)}\\b`);
    // An agent key is named bare to the policy helpers; `sso` is too common a
    // word for that (`component: 'sso'`), and no helper takes it bare.
    const bare = key.startsWith('agent_') ? [new RegExp(`(['"\`])${escapeRegex(key)}\\1`), new RegExp(`\\.${escapeRegex(key)}\\b`)] : [];
    return [...quoted, property, ...bare];
}

const DETECTORS = ADMIN_API_ONLY_KEYS.map((key) => ({ key, patterns: readsOf(key) }));

/** The listed keys `code` reads. */
function keysRead(code: string): string[] {
    return DETECTORS.filter((d) => d.patterns.some((re) => re.test(code))).map((d) => d.key);
}

const files = repoRelativeFiles();
const analyzer = createAnalyzer(REPO_ROOT);
const rel = (abs: string) => path.relative(REPO_ROOT, abs).split(path.sep).join('/');

const isServerModule = (relPath: string) =>
    !/^\s*(['"])use client\1/m.test(fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8').slice(0, 400));

/** Every listed key read anywhere `file`'s roots reach, outside the definition modules. */
function findings(file: string, roots: 'handlers' | 'all', source?: string): string[] {
    const out = new Set<string>();
    for (const body of analyzer.reachedBodies(path.join(REPO_ROOT, file), { roots, source })) {
        if (rel(body.file) in DEFINITION_MODULES) continue;
        for (const key of keysRead(codeOf(body.text))) out.add(`${key} via ${body.trail} @${rel(body.file)}`);
    }
    return [...out].sort();
}

const routes = files.filter((f) => /^src\/app\/api\/.*\/route\.tsx?$/.test(f) && !f.startsWith(ADMIN_API));
const pages = files.filter(
    (f) => /^src\/app\/t\/\[tenantSlug\]\/.*\/(page|layout)\.tsx?$/.test(f) && isServerModule(f),
);

describe('1. no route outside the admin API reaches a listed key', () => {
    it('the population is real', () => {
        expect(routes.length).toBeGreaterThan(300);
        expect(routes.some((f) => f.startsWith(ADMIN_API))).toBe(false);
    });

    it('none does', () => {
        const hits = routes.flatMap((f) => findings(f, 'handlers').map((h) => `${f}: ${h}`));
        expect(hits).toEqual([]);
    });

    it('the detector is not blind: a route gate planted outside the admin API is caught, for every key', () => {
        const route = 'src/app/api/t/[tenantSlug]/billing/events/route.ts';
        const source = fs.readFileSync(path.join(REPO_ROOT, route), 'utf8');
        expect(findings(route, 'handlers')).toEqual([]);
        for (const key of ADMIN_API_ONLY_KEYS) {
            const planted = source.replace("requirePermission('admin.manage'", `requirePermission('admin.${key}'`);
            expect(planted).not.toBe(source);
            expect(findings(route, 'handlers', planted).map((h) => h.split(' ')[0])).toEqual([key]);
        }
    });

    it('…and so is a read in a usecase the route reaches (the call graph is followed)', () => {
        // `GET /gap-assignments/[id]` → `getAssignmentForRespondent`, which reads
        // a NON-listed admin key today: the same shape with a listed one is caught.
        const route = 'src/app/api/t/[tenantSlug]/gap-assignments/[assignmentId]/route.ts';
        const reached = analyzer.reachedBodies(path.join(REPO_ROOT, route));
        const body = reached.find((b) => /getAssignmentForRespondent$/.test(b.trail));
        expect(body).toBeDefined();
        expect(codeOf(body!.text)).toMatch(/appPermissions\?\.admin\?\.tenant_lifecycle/);
        const asIfListed = codeOf(body!.text).replace('tenant_lifecycle', 'agent_ownership');
        expect(keysRead(asIfListed)).toEqual(['agent_ownership']);
    });

    it('each read shape is caught, and a mention that is not a read is not', () => {
        for (const sample of [
            "requirePermission('admin.agent_policy_card', h)",
            'ctx.appPermissions.admin.agent_skill_review === true',
            'ctx.appPermissions?.admin?.agent_skill_author',
            "assertAgentGovernanceWrite(ctx, 'agent_tool_exposure')",
            'perms.admin.sso',
            '{ keys: ["admin.agent_ownership"] }',
        ]) {
            expect({ sample, read: keysRead(sample).length }).toEqual({ sample, read: 1 });
        }
        expect(keysRead("logger.info('x', { component: 'sso' })")).toEqual([]);
        expect(keysRead('admin.agent_registry_view')).toEqual([]);
    });
});

describe('2. no server page gates data on a listed key', () => {
    it('the population is real, and admin pages are in it', () => {
        expect(pages.length).toBeGreaterThan(80);
        expect(pages.some((f) => f.includes('/(app)/admin/'))).toBe(true);
    });

    it('a page that reads one is listed as affordance-only, with its reason — and each listed page still reads one', () => {
        const reading = pages.filter((f) => findings(f, 'all').length > 0).sort();
        expect(reading).toEqual(Object.keys(AFFORDANCE_ONLY_PAGES).sort());
    });

    it('an affordance-only page reads the keys in its own module, never in a usecase it calls', () => {
        for (const page of Object.keys(AFFORDANCE_ONLY_PAGES)) {
            const elsewhere = findings(page, 'all').filter((h) => !h.endsWith(`@${page}`));
            expect({ page, elsewhere }).toEqual({ page, elsewhere: [] });
        }
    });
});

describe('3. no machine surface names a listed key', () => {
    it('none does', () => {
        const hits = files
            .filter((f) => SCANNED_MACHINE_DIRS.some((d) => f.startsWith(d)) && /\.tsx?$/.test(f))
            .filter((f) => !(f in DEFINITION_MODULES))
            .flatMap((f) =>
                keysRead(codeOf(fs.readFileSync(path.join(REPO_ROOT, f), 'utf8'))).map((k) => `${f}: ${k}`),
            );
        expect(hits).toEqual([]);
    });
});

describe('4. no bearer token carries a listed agent key, and nothing reads admin.sso', () => {
    it.each(VALID_SCOPES)('scope %s carries none of the five agent keys', (scope) => {
        const admin = scopesToPermissions([scope]).admin;
        const carried = ADMIN_API_ONLY_KEYS.filter((k) => k !== 'sso' && admin[k]);
        expect(carried).toEqual([]);
    });

    it('admin.sso is read by no code at all outside the definition modules', () => {
        const hits = files
            .filter((f) => f.startsWith('src/') && /\.tsx?$/.test(f) && !(f in DEFINITION_MODULES))
            .filter((f) => keysRead(codeOf(fs.readFileSync(path.join(REPO_ROOT, f), 'utf8'))).includes('sso'));
        expect(hits).toEqual([]);
    });

    it('the scope population includes the wildcard and every admin group', () => {
        expect(VALID_SCOPES).toEqual(expect.arrayContaining(['*', 'admin:*', 'admin:write']));
    });

    it('every definition module still exists and every listed key is in the permission model', () => {
        for (const f of Object.keys(DEFINITION_MODULES)) expect(fs.existsSync(path.join(REPO_ROOT, f))).toBe(true);
        for (const key of ADMIN_API_ONLY_KEYS) expect(PERMISSION_SCHEMA.admin).toContain(key);
    });
});

/**
 * The four refused by decision are refused BECAUSE they are live outside the
 * admin API's role gate. If one stops being reached that way, the docblock in
 * `src/lib/roles.ts` that says the rule takes it away is wrong, and the key
 * belongs in the first part, where rules 1 to 4 would hold it.
 */
describe('5. the four refused by decision are live elsewhere, and the list is exactly six plus four', () => {
    it('the list is the two parts, disjoint, and nothing else', () => {
        expect([...ADMIN_MEMBERSHIP_ONLY_ADMIN_KEYS].sort()).toEqual([...ADMIN_API_ONLY_KEYS, ...SIDE_DOOR_ADMIN_KEYS].sort());
        expect(new Set<string>([...ADMIN_API_ONLY_KEYS, ...SIDE_DOOR_ADMIN_KEYS]).size).toBe(
            ADMIN_API_ONLY_KEYS.length + SIDE_DOOR_ADMIN_KEYS.length,
        );
        expect(SIDE_DOOR_ADMIN_KEYS).toEqual(['scim', 'compliance_dsar_manage', 'agent_harness_ingest', 'agent_external_tools']);
    });

    it.each(SIDE_DOOR_ADMIN_KEYS)(
        'admin.%s is carried by some API-key scope, so a key acting for the membership reaches it past the edge',
        (key) => {
            const carriers = VALID_SCOPES.filter((scope) => scopesToPermissions([scope]).admin[key]);
            expect(carriers.length).toBeGreaterThan(0);
        },
    );

    it.each(['agent_harness_ingest', 'agent_external_tools'] as const)(
        'admin.%s is named by the tool funnel, which acts for a membership through no edge',
        (key) => {
            const pattern = new RegExp(`(['"\`])admin\\.${key}\\1`);
            const naming = files
                .filter((f) => f.startsWith('src/lib/mcp/') && /\.tsx?$/.test(f))
                .filter((f) => pattern.test(codeOf(fs.readFileSync(path.join(REPO_ROOT, f), 'utf8'))));
            expect(naming.length).toBeGreaterThan(0);
        },
    );
});
