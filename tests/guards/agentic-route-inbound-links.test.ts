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
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { codeOf } from '../helpers/source-blocks';
import { repoFiles, repoRelative } from '../helpers/repo-files';

const APP = 'src/app/t/[tenantSlug]/(app)';

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
    '/agents/receipts',
    '/agents/quarantine',
    '/agents/review-quality',
    '/agents/reports',
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

    it('the DETAIL page is linked from the register’s row action', () => {
        // The one that shipped unreachable. `AgentsClient` is outside
        // `(app)/agents/[agentId]/`, so it counts — see `ownDir`.
        expect(inboundLinkers('/agents/[agentId]')).toContain(
            `${APP}/agents/AgentsClient.tsx`,
        );
    });
});

describe('the route list is complete — a new agentic page cannot land unlisted', () => {
    /** Every `page.tsx` under `(app)/` whose route mentions agents or mcp. */
    function discoveredAgenticRoutes(): string[] {
        return repoFiles({ under: APP, extensions: ['.tsx'] })
            .filter((abs) => path.basename(abs) === 'page.tsx')
            .map((abs) => '/' + path.relative(path.join(repoRoot(), APP), path.dirname(abs)))
            .map((r) => r.replace(/\\/g, '/'))
            .filter((r) => /agent|mcp/i.test(r));
    }
    function repoRoot(): string {
        return path.resolve(__dirname, '../..');
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
