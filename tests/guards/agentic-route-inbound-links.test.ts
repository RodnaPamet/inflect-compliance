/**
 * EVERY AGENTIC ROUTE HAS SOMETHING THAT LINKS TO IT.
 *
 * ── THE DEFECT THIS EXISTS FOR ──────────────────────────────────────────────
 *
 * The agent DETAIL page shipped with no inbound link at all: `grep -rn
 * 'admin/agents/\${' src/` returned only the page's own docstring, so the
 * policy card, the tool pins, the ASI coverage, the circuit breaker and the
 * kill switch were reachable by typing a URL and by nothing else. The ASI09
 * review-quality report shipped the same way, and stayed that way for longer
 * because it also had no permission gate and no behavioural test — the exact
 * combination.
 *
 * A route with no inbound link is not a feature with a discoverability problem.
 * It is a feature nobody can use, and it looks identical in CI to one that
 * works.
 *
 * ── WHAT COUNTS AS AN INBOUND LINK ──────────────────────────────────────────
 *
 * Four kinds, and the list is deliberately not "any occurrence of the path":
 *
 *   · a NAV SECTION entry (`SidebarNav`)
 *   · a HUB CARD or in-page link (`href={…}` / `tenantHref('…')`)
 *   · a COMMAND PALETTE entry
 *   · a ROW ACTION (`router.push('…')` from a table row)
 *
 * The ViewsMenu satisfies four of the five children on its own, which is the
 * point of folding them into one menu rather than five scattered links.
 *
 * ── WHAT IS DELIBERATELY NOT COUNTED ────────────────────────────────────────
 *
 * A route's OWN files. A page that names its own path in a docstring, a
 * breadcrumb or a `redirect()` is not linked from anywhere — and a scan that
 * accepted self-references would have passed the detail page on the strength of
 * the very docstring that recorded its unreachability.
 *
 * A REDIRECT SHIM's target also does not count as that shim being linked: the
 * shims exist for bookmarks, and requiring an inbound link to a compatibility
 * path would mean linking users at the slow way round. They are excluded by
 * name, with the reason.
 *
 * Population from `repoFiles()` — git's own file list — never a `readdirSync`
 * walk. `tests/guardrails/source-scan-population.test.ts` has no allowlist.
 *
 * ── AND THE POPULATION ITSELF IS PINNED ───────────────────────────────────
 *
 * Two registries live here, and the second half of the file asserts each is a
 * complete census rather than a sample: `AGENTIC_ROUTES` (+ `REDIRECT_SHIMS`)
 * for the pages, `AGENTIC_API_ROUTES` for the routes under `src/app/api/`.
 * Neither can grow without somebody writing the new entry down, which is what
 * makes "this phase ships no new surface" a claim CI can refuse rather than
 * one a plan can only assert. See
 * `docs/implementation-notes/2026-09-23-phase1-surface-reconciliation.md`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { codeOf } from '../helpers/source-blocks';
import { repoFiles, repoRelative } from '../helpers/repo-files';

const APP = 'src/app/t/[tenantSlug]/(app)';
const API = 'src/app/api';

/**
 * The repo root, computed HERE rather than imported. A guard that reads source
 * must fold its own root constant; an imported one lands every assertion below
 * in the un-analysable set.
 */
function repoRoot(): string {
    return path.resolve(__dirname, '../..');
}

/**
 * The agentic routes under `(app)/`, as a user types them.
 *
 * Written out rather than derived from the directory tree, and that is the
 * whole design of this guard: a derived list would grow silently when somebody
 * added an unreachable page, which is precisely the event it exists to catch.
 * A new agentic route fails the completeness check below until it is added
 * here AND linked from somewhere.
 */
const AGENTIC_ROUTES: readonly string[] = [
    '/agents',
    '/agents/[agentId]',
    '/agents/proposals',
    '/agents/runs',
    '/agents/runs/[runId]',
    '/agents/receipts',
    '/agents/quarantine',
    '/agents/review-quality',
    '/agents/reports',
    // The EU AI Act record, readable. Linked from the Views menu's Assurance
    // group beside the other read-only surfaces.
    '/agents/decisions',
    // The external-tool catalogue: approve a definition, grant it to an agent.
    // Linked from the Views menu's OPERATE group, because both are acts
    // somebody performs rather than a record they audit. Gated on
    // `admin.agent_registry` like its siblings — and unreachable by any API
    // key, since that flag is subtracted from even a `*` credential.
    '/agents/external-tools',
] as const;

/**
 * Compatibility shims. Present as routes, deliberately UNLINKED.
 *
 * Each is a `redirect()` one-liner kept for bookmarks and for the old
 * `/admin/mcp` hub cards' outbound links. Linking to one would send a user the
 * long way round to a page the product can reach directly.
 */
const REDIRECT_SHIMS: readonly string[] = [
    '/admin/agents',
    '/admin/agents/[agentId]',
    '/admin/agents/review-quality',
    '/admin/mcp/agent-receipts',
    '/admin/mcp/quarantine',
    '/agent-proposals',
    '/agent-runs',
] as const;

/**
 * WHAT COUNTS AS THE AGENTIC SURFACE — one definition, used by both halves.
 *
 * Widening this widens the page population AND the API population together. A
 * needle that drifted between them would leave a gap exactly where the two
 * meet, which is where a page and the route it calls land in the same PR.
 */
const IS_AGENTIC = /agent|mcp/i;

/**
 * The agentic API surface, as route files under `src/app/api/`.
 *
 * ── WHY THIS LIST EXISTS ────────────────────────────────────────
 *
 * The Flue integration plan's point 01 says of phase 1: "Nothing else — phase
 * 1 ships no new surface." Phase 1 then shipped two agentic API routes
 * (`admin/agent-driver`, `agent-proposals/bulk/reject`), each compelled by a
 * later plan bullet and neither contradicted by anything that could go red.
 *
 * The PAGE half of that claim was already enforced: the completeness check
 * below refuses a new `(app)/agents/*` page until somebody writes it down.
 * The API half had nothing of the kind. What a new route DID hit was
 * `tests/contracts/api-schemas.test.ts` — and that is a CHECKSUM, not a
 * registry: the route walker publishes every route as a stub, so regenerating
 * `public/openapi.json` turns the red green without anybody deciding that new
 * agentic surface was intended. A checksum notices an addition; it cannot
 * refuse one.
 *
 * So this list is the decision seam. A route added here is a route someone
 * declared to be agentic surface, in the same file as the pages, where a claim
 * that a phase ships none of it is visibly contradicted.
 *
 * Paths are relative to `src/app/api/`, which is why the untenanted (`mcp/`)
 * and platform (`admin/agent-kill-switch`) routes sit beside the per-tenant
 * ones: the surface is what is CALLABLE, not what is tenant-scoped.
 */
const AGENTIC_API_ROUTES: readonly string[] = [
    // Platform scope — no tenant, behind PLATFORM_ADMIN_API_KEY.
    'admin/agent-kill-switch/route.ts',
    // The MCP transport itself, and the credential exchange in front of it.
    'mcp/route.ts',
    'mcp/token/route.ts',
    // PHASE 1, point 01's third bullet — the per-tenant driver toggle. The
    // column shipped with a reader, a default and no writer; a gate whose
    // customer half cannot be moved through the product is a constant wearing
    // a switch's name. The NOTE that used to sit here — "no page calls this
    // route today, so it is API surface without a user-facing page" — is now
    // STALE: `FlueEngineCard` on Admin → Integrations reads the wiring state
    // and PUTs this route's mode. It stayed true for as long as it did
    // because a toggle that is one of SIX terms tells an operator almost
    // nothing on its own, so there was nothing coherent to put on a page
    // until the other five could be shown beside it.
    't/[tenantSlug]/admin/agent-driver/route.ts',
    // The read half of that card: which of the six terms are satisfied and
    // which one blocks. Read-only, same tenant-lifecycle key.
    't/[tenantSlug]/admin/flue-wiring/route.ts',
    't/[tenantSlug]/admin/agents/[agentId]/circuit-breaker/route.ts',
    't/[tenantSlug]/admin/agents/[agentId]/coverage/route.ts',
    't/[tenantSlug]/admin/agents/[agentId]/policy-card/route.ts',
    't/[tenantSlug]/admin/agents/[agentId]/risk-assessment/complete/route.ts',
    't/[tenantSlug]/admin/agents/[agentId]/risk-assessment/route.ts',
    't/[tenantSlug]/admin/agents/[agentId]/route.ts',
    't/[tenantSlug]/admin/agents/[agentId]/status/route.ts',
    't/[tenantSlug]/admin/agents/[agentId]/tools/route.ts',
    't/[tenantSlug]/admin/agents/kill-switch/route.ts',
    't/[tenantSlug]/admin/agents/reports/export/route.ts',
    't/[tenantSlug]/admin/agents/reports/route.ts',
    't/[tenantSlug]/admin/agents/review-quality/route.ts',
    't/[tenantSlug]/admin/agents/route.ts',
    't/[tenantSlug]/admin/agents/tool-manifests/route.ts',
    // #2860 — saved arguments for an external MCP tool, and the approval a
    // change to one needs. Same tenant-wide class as the manifest pin above:
    // a set is keyed by (tenant, tool, label) and not by agent, so it governs
    // every agent granted that tool.
    't/[tenantSlug]/admin/agents/parameter-sets/route.ts',
    // An external server's catalogue and the approval that makes one of its
    // tools grantable. Under /admin/agents rather than /admin/integrations
    // because accepting a tool DESCRIPTION is agent governance, not credential
    // wiring — and that placement is what earns it admin.agent_registry.
    't/[tenantSlug]/admin/agents/external-tools/route.ts',
    // #2912 — the Entra consent flow for an MCP server connection. The start
    // is tenant-scoped and admin-gated; the callback is tenant-AGNOSTIC because
    // one registered redirect URI serves every tenant, and it re-authorises
    // through getTenantCtx rather than trusting the URL it was called with.
    't/[tenantSlug]/admin/integrations/[connectionId]/mcp-consent/route.ts',
    'integrations/mcp-server/callback/route.ts',
    't/[tenantSlug]/admin/mcp/quarantine/route.ts',
    't/[tenantSlug]/admin/security-settings/agent-enforcement/route.ts',
    't/[tenantSlug]/agent-proposals/[id]/approve/route.ts',
    't/[tenantSlug]/agent-proposals/[id]/reject/route.ts',
    // PHASE 1, point 03 — bulk reject on the review queue. A queue too slow to
    // clear is a queue people stop reading, which is the automation-bias
    // problem the queue exists to resist arriving from the other side.
    't/[tenantSlug]/agent-proposals/bulk/reject/route.ts',
    't/[tenantSlug]/agent-proposals/route.ts',
    't/[tenantSlug]/agent-proposals/sample-audits/[id]/route.ts',
    't/[tenantSlug]/agent-proposals/sample-audits/route.ts',
    't/[tenantSlug]/agent-receipts/[id]/export/route.ts',
    't/[tenantSlug]/agent-receipts/route.ts',
    't/[tenantSlug]/agent-runs/[id]/abort/route.ts',
    't/[tenantSlug]/agent-runs/[id]/resume/route.ts',
    't/[tenantSlug]/agent-runs/[id]/route.ts',
    't/[tenantSlug]/agent-runs/route.ts',
] as const;

/** Every `.ts`/`.tsx` file under `src/`, comment-stripped, by repo-relative path. */
const SOURCES: ReadonlyArray<{ rel: string; code: string }> = repoFiles({
    under: 'src',
    extensions: ['.ts', '.tsx'],
}).map((abs) => ({
    rel: repoRelative(abs),
    // COMMENTS STRIPPED. A docstring naming a path is the exact evidence the
    // detail page's unreachability was recorded in, so prose must not count as
    // a link.
    code: codeOf(fs.readFileSync(abs, 'utf8')),
}));

/**
 * The directory a route's own files live in — the self-reference exclusion.
 *
 * `/agents/[agentId]` lives under `(app)/agents/[agentId]/`, so the register's
 * own `AgentsClient.tsx` is NOT self and DOES count as the inbound link. That
 * asymmetry is deliberate: the register linking to the detail page is exactly
 * the fix #2422 landed.
 */
function ownDir(route: string): string {
    return `${APP}${route}/`;
}

/**
 * Files that NAME a route without linking to it, and must not count.
 *
 * This exclusion is the difference between a guard and a grep, and leaving it
 * out was measured: with `src/lib/nav/**` in the population, DELETING the
 * review-quality entry from the ViewsMenu left the route still "linked" — by
 * `page-segregation.ts` and `canonical-parents.ts`, which are DECLARATIVE
 * REGISTRIES. Every route in the product is listed in both by construction, so
 * they make the inbound-link question unanswerable: the guard would go green
 * for a page with no way in, which is the one thing it exists to refuse.
 *
 * The redirect shims are excluded for the sibling reason: each one's
 * `redirect()` names its target, so a shim would vouch for the page it forwards
 * to. A shim is a bookmark's landing, not a route into the product.
 */
const NOT_A_LINK: readonly string[] = [
    // Route CLASSIFICATION (main vs subpage) and back-affordance fallbacks.
    'src/lib/nav/page-segregation.ts',
    'src/lib/nav/canonical-parents.ts',
    // Every shim's own redirect target.
    ...REDIRECT_SHIMS.map((r) => `${APP}${r}/page.tsx`),
];

/**
 * Does anything OUTSIDE the route's own directory link to it?
 *
 * The needle is the route with its dynamic segment replaced by a template
 * hole, because that is how a link to a detail page is actually written:
 * `` router.push(`/t/${tenantSlug}/agents/${row.original.id}`) ``.
 */
function inboundLinkers(route: string): string[] {
    const own = ownDir(route);
    const needles = route.includes('[')
        ? // A dynamic route: the literal prefix followed by an interpolation.
          [route.replace(/\/\[[^\]]+\]$/, '') + '/${']
        : // A static route: the path, followed by a quote or a template close.
          [`${route}'`, `${route}"`, '${' + `}${route}`, `${route}\``];

    return SOURCES.filter(({ rel, code }) => {
        if (rel.startsWith(own)) return false;
        if (NOT_A_LINK.includes(rel)) return false;
        return needles.some((n) => code.includes(n));
    }).map(({ rel }) => rel);
}

describe('the scan has a population and a needle that work at all', () => {
    it('git lists the source tree', () => {
        // Without this, every "has an inbound link" result below could be
        // vacuous over an empty file list.
        expect(SOURCES.length).toBeGreaterThan(500);
    });

    it('the needle finds a link that is KNOWN to exist', () => {
        // Positive control: the sidebar links `/agents`. If this stops
        // matching, the detector is broken rather than the product.
        expect(inboundLinkers('/agents')).toContain(
            'src/components/layout/SidebarNav.tsx',
        );
    });

    it('the needle does NOT match a path that is only in prose', () => {
        // Negative control, planted rather than found: comment-stripping is
        // what makes the whole guard mean anything, and a guard that had
        // silently stopped stripping would pass every case above.
        const commented = codeOf(`
            /** See /t/:slug/agents/nowhere for the rationale. */
            export const x = 1;
        `);
        expect(commented).not.toContain('/agents/nowhere');
    });
});

describe('every agentic route under (app)/ has at least one inbound link', () => {
    it.each(AGENTIC_ROUTES.map((r) => [r] as const))('%s is linked from somewhere', (route) => {
        const linkers = inboundLinkers(route);
        if (linkers.length === 0) {
            throw new Error(
                `${route} has NO inbound link from anywhere outside its own directory.\n\n` +
                    `A route nothing links to is reachable by typing a URL and by nothing ` +
                    `else — the shape the agent detail page and the review-quality report ` +
                    `both shipped in. Add a nav entry, a hub card, a command-palette entry ` +
                    `or a row action.`,
            );
        }
        expect(linkers.length).toBeGreaterThanOrEqual(1);
    });

    it('the ViewsMenu is what links four of the five children', () => {
        // Named, not counted. The point of folding the secondary navigation
        // into ONE labelled menu is that these four arrive together; a future
        // change that scattered them again would still pass the per-route
        // assertions above, and would lose the reason they are discoverable.
        const menu = `${APP}/agents/AgentsViewsMenu.tsx`;
        for (const route of [
            '/agents/proposals',
            '/agents/runs',
            '/agents/receipts',
            '/agents/quarantine',
            '/agents/review-quality',
            '/agents/reports',
        ]) {
            expect(inboundLinkers(route)).toContain(menu);
        }
    });

    it('the REGISTER is linked from the sidebar AND the command palette', () => {
        const linkers = inboundLinkers('/agents');
        expect(linkers).toContain('src/components/layout/SidebarNav.tsx');
        expect(linkers).toContain('src/components/command-palette/use-palette-commands.ts');
    });

    it('the RUN DETAIL page is linked from the run list’s row', () => {
        // The step ledger was served by `GET /agent-runs/:id` from the day the
        // engine shipped and read by nothing — the same unreachable shape the
        // agent detail page had, one surface along. `AgentRunsClient` is
        // outside `(app)/agents/runs/[runId]/`, so it counts.
        expect(inboundLinkers('/agents/runs/[runId]')).toContain(
            `${APP}/agents/runs/AgentRunsClient.tsx`,
        );
    });

    it('the DETAIL page is linked from the register’s row action', () => {
        // The one that shipped unreachable. `AgentsClient` is outside
        // `(app)/agents/[agentId]/`, so it counts — see `ownDir`.
        expect(inboundLinkers('/agents/[agentId]')).toContain(
            `${APP}/agents/AgentsClient.tsx`,
        );
    });
});

describe('the agentic API surface is declared, not discovered', () => {
    /** Every `route.ts` under `src/app/api/` whose path mentions agents or mcp. */
    function discoveredAgenticApiRoutes(): string[] {
        return repoFiles({ under: API, extensions: ['.ts'] })
            .filter((abs) => path.basename(abs) === 'route.ts')
            .map((abs) => path.relative(path.join(repoRoot(), API), abs))
            .map((r) => r.replace(/\\/g, '/'))
            .filter((r) => IS_AGENTIC.test(r));
    }

    it('the scan finds an agentic API surface at all', () => {
        // Positive control. Every assertion below is satisfied by an EMPTY
        // discovery, so without a floor a scan that had silently stopped
        // matching would read as a clean bill of health.
        expect(discoveredAgenticApiRoutes().length).toBeGreaterThan(20);
    });

    it('every discovered agentic API route is registered', () => {
        const unlisted = discoveredAgenticApiRoutes().filter(
            (r) => !AGENTIC_API_ROUTES.includes(r),
        );
        if (unlisted.length > 0) {
            throw new Error(
                'New agentic API surface landed unregistered:\n' +
                    unlisted.map((r) => `  - ${r}`).join('\n') +
                    '\n\nAdd it to AGENTIC_API_ROUTES with the reason it exists. ' +
                    'Regenerating public/openapi.json is NOT the same thing: the ' +
                    "route walker stubs every route, so the spec's drift check " +
                    'goes green on a regenerate without anybody deciding the ' +
                    'surface was intended.',
            );
        }
        expect(unlisted).toEqual([]);
    });

    it('every registered agentic API route still exists', () => {
        // The other direction. A stale entry is a line nobody has to satisfy,
        // and it makes the list stop being a census of what is callable.
        const missing = AGENTIC_API_ROUTES.filter(
            (r) => !fs.existsSync(path.join(repoRoot(), API, r)),
        );
        expect(missing).toEqual([]);
    });

    it('the registry names each route once', () => {
        expect(new Set(AGENTIC_API_ROUTES).size).toBe(AGENTIC_API_ROUTES.length);
    });
});

describe('the route list is complete — a new agentic page cannot land unlisted', () => {
    /** Every `page.tsx` under `(app)/` whose route mentions agents or mcp. */
    function discoveredAgenticRoutes(): string[] {
        return repoFiles({ under: APP, extensions: ['.tsx'] })
            .filter((abs) => path.basename(abs) === 'page.tsx')
            .map((abs) => '/' + path.relative(path.join(repoRoot(), APP), path.dirname(abs)))
            .map((r) => r.replace(/\\/g, '/'))
            .filter((r) => IS_AGENTIC.test(r));
    }

    it('classifies every discovered agentic page as a route or a shim', () => {
        const known = new Set<string>([
            ...AGENTIC_ROUTES,
            ...REDIRECT_SHIMS,
            // The MCP credential panel. NOT an agentic ROUTE in this guard's
            // sense: it is an admin settings page reached from the admin
            // landing pill, and prompt 2/4 merges its panel into
            // /admin/api-keys. Listed so the completeness check is exhaustive
            // rather than filtered.
            '/admin/mcp',
        ]);
        const unlisted = discoveredAgenticRoutes().filter((r) => !known.has(r));
        expect(unlisted).toEqual([]);
    });

    it('every listed route and shim actually exists', () => {
        // The other direction. A stale entry is an entry nobody has to satisfy
        // — and the inbound-link assertions above would pass it by matching
        // some leftover string.
        for (const route of [...AGENTIC_ROUTES, ...REDIRECT_SHIMS]) {
            const page = path.join(repoRoot(), APP, route, 'page.tsx');
            expect(fs.existsSync(page)).toBe(true);
        }
    });

    it('every shim is a redirect and nothing else', () => {
        // What justifies excluding them from the inbound-link requirement. A
        // shim that grew real content would need a link like anything else.
        //
        // The SUBJECT of each assertion is a list of ROUTES, not a file's text.
        // Two reasons, and the first is the test's own quality: a failure names
        // which shim broke rather than which of six iterations threw. The
        // second is `assertion-needle-uniqueness-ratchet` — a `toContain`
        // against `codeOf(readFileSync(…))` is a whole-file read wearing a
        // transform the analyser cannot follow, so it lands in that ratchet's
        // CAPPED un-analysable bucket. Filtering first moves the claim off the
        // file text entirely.
        const shimCode = (route: string) =>
            codeOf(fs.readFileSync(path.join(repoRoot(), APP, route, 'page.tsx'), 'utf8'));

        const notRedirects = REDIRECT_SHIMS.filter((r) => !shimCode(r).includes('redirect('));
        expect(notRedirects).toEqual([]);

        // No JSX at all — the tell that it renders nothing, and therefore that
        // it has no content anybody needs a link to.
        const withJsx = REDIRECT_SHIMS.filter((r) => /return\s*\(/.test(shimCode(r)));
        expect(withJsx).toEqual([]);
    });
});
