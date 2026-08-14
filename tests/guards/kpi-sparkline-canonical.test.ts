/**
 * Canonical KPI-card sparklines — every entity KPI page draws its sparklines
 * from the ONE shared pipeline (`@/lib/charts/kpi-trends`), not a hand-rolled
 * per-page fetch. Assets is the reference; the same six pages it was applied
 * to must each (a) import the shared hook + domain helper and (b) feed at
 * least one KPI card a `sparkline`.
 *
 * Locks the canonicalization so a new KPI page can't regress to a bespoke
 * trends fetch, and the data-backed cards keep their sparklines.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const CLIENTS: Record<string, string> = {
    Assets: 'src/app/t/[tenantSlug]/(app)/assets/AssetsClient.tsx',
    Controls: 'src/app/t/[tenantSlug]/(app)/controls/ControlsClient.tsx',
    Risks: 'src/app/t/[tenantSlug]/(app)/risks/RisksClient.tsx',
    Evidence: 'src/app/t/[tenantSlug]/(app)/evidence/EvidenceClient.tsx',
    Policies: 'src/app/t/[tenantSlug]/(app)/policies/PoliciesClient.tsx',
    Vendors: 'src/app/t/[tenantSlug]/(app)/vendors/VendorsClient.tsx',
    Tests: 'src/app/t/[tenantSlug]/(app)/tests/page.tsx',
    Tasks: 'src/app/t/[tenantSlug]/(app)/tasks/TasksClient.tsx',
};

describe('Canonical KPI sparklines — shared pipeline adoption', () => {
    it.each(Object.entries(CLIENTS))(
        '%s uses the shared kpi-trends pipeline + feeds a KPI card a sparkline',
        (_name, file) => {
            const src = read(file);
            // (a) shared hook + builder + domain helper from the canonical module
            expect(src).toMatch(
                /from\s+['"]@\/lib\/charts\/kpi-trends['"]/,
            );
            expect(src).toMatch(/useKpiTrends\(/);
            expect(src).toMatch(/buildKpiSparklines\(/);
            // (b) at least one KpiFilterCard is fed a sparkline + centered domain
            expect(src).toMatch(/sparkline=\{/);
            expect(src).toMatch(/sparklineDomain=\{centeredSparklineDomain\(/);
        },
    );

    it('the canonical module is the single source — no per-page /dashboard/trends fetch remains', () => {
        // The shared hook owns the only `/dashboard/trends` fetch. A page that
        // hand-rolls `fetch('/dashboard/trends')` again has bypassed it.
        for (const file of Object.values(CLIENTS)) {
            const src = read(file);
            expect(src).not.toMatch(/fetch\([^)]*dashboard\/trends/);
        }
    });
});

/**
 * U1 — the "edit cards" gear must edit the KPI CARDS, not the Filter
 * dropdown's categories.
 *
 * Five of these eight pages registered `filtersToCards(...)` with the gear,
 * so the gear listed FILTER categories and hiding one removed a filter from
 * the product — while the KPI strip, hardcoded JSX, never changed. The three
 * that worked (assets / controls / risks) registered `kind: 'kpi'` cards and
 * rendered the strip from the hook's output.
 *
 * The only gear coverage before this was hook-level
 * (`tests/rendered/use-filter-card-visibility.test.tsx`), whose fixtures are
 * `kind: 'filter'` only — so nothing caught a sixth page repeating the bug.
 * This file already enumerates exactly the right eight pages, which is why the
 * assertion belongs here rather than in a new file.
 */
/**
 * Strip comments before asserting.
 *
 * Both directions matter here. A NEGATIVE assertion that reads prose fails on a
 * comment explaining why the old call was removed — which is exactly the
 * comment a good migration leaves behind. And a POSITIVE assertion that reads
 * prose is worse: a page that merely MENTIONS `kind: 'kpi'` in a TODO would
 * pass without having migrated anything.
 */
const codeOnly = (src: string): string =>
    src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');

describe('Policies KPI cards read the SERVER count, not the loaded array', () => {
    const src = codeOnly(read(CLIENTS.Policies));

    /**
     * The defect this pins: every card count was `policies.filter(...).length`
     * over an array that is capped (LIST_BACKFILL_CAP) and SSR-windowed, while
     * each card's filter resolves against the whole tenant. A card read 3 and
     * produced 47 rows.
     *
     * Two of the six were wrong for a second, independent reason:
     *   - `total` displayed the CURRENT FILTERED length while its click calls
     *     clearAll(), so it disagreed with itself whenever a filter was set;
     *   - `approved` counted APPROVED||PUBLISHED but applied status=APPROVED
     *     alone, over-counting by the published set on every render.
     *
     * A filter card's number is a promise about its own click. These assert
     * the number now comes from the database.
     */
    it('reads counts from the list response, falling back to the SSR counts', () => {
        expect(src).toMatch(
            /serverKpiCounts\s*=\s*policiesQuery\.data\?\.kpiCounts\s*\?\?\s*initialKpiCounts/,
        );
    });

    it.each(['total', 'draft', 'inReview', 'approved', 'overdueReview', 'outstandingAck'])(
        '%s reads the server count with NO client-side fallback',
        (id) => {
            // The `?? policies.filter(...)` fallback this replaced was itself
            // the defect in miniature — and it tripped the
            // no-client-side-filtering guardrail, which is the right guardrail.
            // page.tsx computes the counts for the first paint, so there is
            // nothing left to fall back to.
            expect(src).toMatch(new RegExp(`serverKpiCounts\\.${id};`));
            expect(src).not.toMatch(new RegExp(`serverKpiCounts\\?\\.${id}\\s*\\?\\?`));
        },
    );

    it('the SSR path supplies counts so the client never derives them', () => {
        const page = codeOnly(read('src/app/t/[tenantSlug]/(app)/policies/page.tsx'));
        expect(page).toMatch(/listPolicyKpiCounts\(/);
        expect(page).toMatch(/initialKpiCounts=\{initialKpiCounts\}/);
    });

    it('approved selects BOTH statuses it counts', () => {
        // Counting one set and filtering to another is the same class of lie
        // as counting a page and filtering a tenant.
        // Bound the read to policyKpiDefs. `id: 'approved'` also appears in
        // the CardDefinition array above it, and slicing from the FIRST match
        // reads the wrong block — which is how this assertion first failed
        // against correct code.
        const defsStart = src.indexOf('policyKpiDefs');
        expect(defsStart).toBeGreaterThan(-1);
        const defs = src.slice(defsStart);
        const block = defs.slice(defs.indexOf("id: 'approved'"), defs.indexOf("id: 'approved'") + 400);
        expect(block).toMatch(/ctx\.set\('status', 'APPROVED'\)/);
        expect(block).toMatch(/ctx\.add\('status', 'PUBLISHED'\)/);
    });

    it('the two sparkline-less cards are opt-in, and keep their ids', () => {
        // defaultVisible:false — NOT removed, NOT renamed. Renaming would
        // leave one live persisted id, which skips the stale-id migration and
        // strands prior gear users with a single visible card.
        expect(src).toMatch(/id: 'overdueReview'[^}]*defaultVisible: false/);
        expect(src).toMatch(/id: 'outstandingAck'[^}]*defaultVisible: false/);
        // The other four stay default-visible: four fills the
        // grid-cols-2 md:grid-cols-4 row exactly.
        for (const id of ['total', 'draft', 'inReview', 'approved']) {
            const m = src.match(new RegExp(`\\{ id: '${id}'[^}]*\\}`));
            expect(m?.[0]).toBeDefined();
            expect(m?.[0]).not.toMatch(/defaultVisible: false/);
        }
    });
});

describe('the filter-cards gear controls KPI cards on every list page', () => {
    it.each(Object.entries(CLIENTS))(
        '%s registers kind:"kpi" cards and renders its KPI strip from them',
        (_name, file) => {
            const src = codeOnly(read(file));

            expect(src).toMatch(/useFilterCardVisibility\(/);
            expect(src).toMatch(/kind: 'kpi'/);

            // The strip is DERIVED, not hardcoded: the cards come from the
            // hook's visible set. A page that still hardcodes its
            // <KpiFilterCard> list cannot respond to the gear at all.
            expect(src).toMatch(/visibleKpiCards\.map\(/);

            // And the gear must NOT be fed filter categories — that is the
            // exact defect. `filtersToCards` stamps kind:'filter' on
            // everything, which is what put filters in the gear.
            expect(src).not.toMatch(/filtersToCards\(/);

            // `selectVisibleFilters` returns [] once every card is kind:'kpi',
            // so a page still wiring it into its toolbar renders an EMPTY
            // Filter dropdown. The full defs must reach the toolbar.
            expect(src).not.toMatch(/selectVisibleFilters\(/);
        },
    );

    /**
     * The hook's own documentation must not teach what this file forbids.
     *
     * The header of `use-filter-card-visibility.tsx` carried a usage example
     * calling `filtersToCards` and `selectVisibleFilters` — the exact two
     * functions the assertions above FAIL a page for calling. A contributor
     * following the module's documented usage would have written code that
     * could not merge, and the docs were the more authoritative-looking
     * source.
     *
     * This is deliberately NOT a general prose check. It does not grep for
     * future tense or stale claims — CLAUDE.md is explicit that CI must not
     * gate on prose, because a doc-mention check verifies mention rather than
     * accuracy. It asserts one concrete, mechanical contradiction: the
     * documented usage cannot call a banned function.
     */
    it('the hook docs do not demonstrate the banned functions', () => {
        const src = read('src/components/ui/filter/use-filter-card-visibility.tsx');
        const header = src.slice(0, src.indexOf('import '));
        expect(header.length).toBeGreaterThan(200); // the block exists at all
        expect(header).not.toMatch(/filtersToCards\(/);
        expect(header).not.toMatch(/selectVisibleFilters\(/);
    });

    /**
     * The id-collision failure mode, locked before it can happen.
     *
     * Card visibility persists ONE ordered id list per page under
     * `inflect:filter-vis:<entity>`. The stale-data migration that makes the
     * kind swap safe only fires when EVERY persisted id is dead. If a KPI card
     * id happened to equal a filter key, that one id would survive, the
     * migration would be skipped, and the user would be left with exactly one
     * visible KPI card and no way to understand why.
     *
     * There are zero collisions today. This keeps it that way — a rename like
     * `outstandingAck` → `outstanding` or `dueWeek` → `due` would otherwise
     * introduce one silently.
     */
    it.each(Object.entries(CLIENTS))(
        '%s has no KPI card id equal to one of its filter keys',
        (_name, file) => {
            const src = codeOnly(read(file));

            const kpiIds = [...src.matchAll(/\{\s*id: '([a-zA-Z0-9_]+)',\s*label:[^}]*kind: 'kpi'/g)]
                .map((m) => m[1]);
            // Only meaningful once the page has been migrated; the assertion
            // above already fails a page that has not been.
            if (kpiIds.length === 0) return;

            const filterKeys = [...src.matchAll(/state\.([a-zA-Z0-9_]+)\b/g)].map((m) => m[1]);
            const overlap = kpiIds.filter((id) => filterKeys.includes(id));

            expect({ file, overlap }).toEqual({ file, overlap: [] });
        },
    );
});
