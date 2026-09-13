/**
 * E2E — THE GOVERNANCE PACK RENDERS, AND SAYS WHAT IT CANNOT ANSWER.
 *
 * READ-ONLY, and that is a constraint rather than an omission. It navigates and
 * asserts and creates nothing, so it uses the SHARED seeded tenant via
 * `loginAndGetTenant` / `DEFAULT_USER`: read-only access cannot cascade into
 * another spec, and this page needs a tenant with rows in it rather than an
 * empty one. The export button is asserted PRESENT and never clicked — a click
 * would file a retained Evidence row into the shared tenant and make every
 * spec that counts evidence order-dependent. `agentic-reports-export.test.ts`
 * owns the write, against its own tenants.
 *
 * ── WHY AN E2E AT ALL, WHEN THE PAGE HAS RENDERED COVERAGE ──────────────────
 *
 * `agentic-reports-pack.test.tsx` renders the client against a hand-built pack,
 * so it proves the component's logic and nothing about the five real queries
 * behind it. The failure it cannot see is the one this page is most exposed to:
 * a report that throws, returns a shape the client does not expect, or silently
 * renders every figure as an absence because the server read came back empty.
 * That only shows up against a real database through the real route.
 *
 * ── THE ASSERTIONS ARE ABOUT HONESTY, NOT ABOUT VALUES ─────────────────────
 *
 * The seeded tenant's numbers are not this spec's to pin — they belong to the
 * seed, and asserting them here would make every seed change a failure in a
 * file that is not about seeding. So the claims are structural: all five
 * reports arrive, every figure is either a real number or a NAMED absence, and
 * the two things an assessor could be misled by are on the page.
 *
 * Everything is scoped to `getByRole('main')`: these pages stream through a
 * Suspense boundary, and under CI load the staging DOM can leave a second
 * hidden copy of the subtree — harmless to a user, fatal to a bare locator
 * under strict mode.
 */
import { test, expect } from '@playwright/test';

import { loginAndGetTenant, safeGoto, waitForHydration } from './e2e-utils';

test.describe('the agent governance pack', () => {
    test('renders all five reports, and names every absence', async ({ page }) => {
        const tenantSlug = await loginAndGetTenant(page);
        await safeGoto(page, `/t/${tenantSlug}/agents/reports`, {
            waitUntil: 'domcontentloaded',
        });
        await waitForHydration(page).catch(() => {});

        const main = page.getByRole('main');
        await expect(main.getByTestId('agent-reports')).toBeVisible({ timeout: 30_000 });

        // ── THE STAMP ───────────────────────────────────────────────────
        // An assessor screenshots this, so it has to carry its own provenance
        // without the surrounding conversation.
        await expect(main.getByTestId('reports-stamp')).toBeVisible({ timeout: 30_000 });

        // ── EVERY FIGURE IS EITHER A NUMBER OR A NAMED ABSENCE ─────────
        //
        // The claim the whole `Measure` type exists to make. A figure rendered
        // as a bare `0` where nothing was counted, or as an em dash, is the
        // failure mode — so this asserts on the POPULATION of rendered metrics
        // rather than on any one of them.
        const values = main.getByTestId(/^metric-value-/);
        const absences = main.getByTestId(/^metric-absent-/);
        const rendered = (await values.count()) + (await absences.count());
        // A floor, not a check for "some": a page that rendered one metric and
        // swallowed the rest would satisfy `> 0` while being broken. Five
        // reports publish figures, so a healthy page is well above this.
        expect(rendered).toBeGreaterThan(4);

        // No metric may render as the "definition missing" state — that is the
        // component's own alarm that a metric id has no entry in the registry.
        await expect(main.getByTestId(/^metric-undefined-/)).toHaveCount(0);

        // Every rendered absence names its BASIS rather than sitting blank.
        for (let i = 0; i < (await absences.count()); i++) {
            const text = (await absences.nth(i).innerText()).trim();
            expect(text.length, 'an absent figure rendered with no stated basis').toBeGreaterThan(0);
            expect(text).not.toBe('—');
        }

        // ── THE DEFINITIONS TRAVEL WITH THE FIGURES ────────────────────
        // A figure whose definition stayed behind cannot be challenged, and a
        // figure that cannot be challenged is not evidence.
        expect(await main.getByTestId(/^metric-definition-/).count()).toBeGreaterThan(0);

        // ── THE TWO THINGS AN ASSESSOR COULD BE MISLED BY ──────────────
        //
        // 1. Two unrelated figures in this product are called "ASI coverage".
        //    One measures the platform's own source tree.
        await expect(main.getByTestId('reports-asi-which-number')).toBeVisible();

        // 2. Approval quality looks complete unless it says what it cannot see.
        await expect(main.getByTestId('reports-approvals-unobservable')).toBeVisible();

        // ── THE FIVE SECTIONS ARRIVED ──────────────────────────────────
        // By their own handles rather than by heading text, which is
        // translated copy this spec has no business pinning. The ASI section
        // renders one of two handles depending on whether the framework is
        // installed, and the seeded tenant's answer is the seed's business —
        // so EITHER satisfies it, and a page missing both fails.
        const asiPresent =
            (await main.getByTestId('reports-asi-agents').count()) +
            (await main.getByTestId('reports-asi-no-framework').count());
        expect(asiPresent, 'the ASI coverage report rendered neither state').toBeGreaterThan(0);
        // ATTACHED, not VISIBLE. Both are unconditional `<ul>`s, so an empty
        // one still renders — but an empty list has a zero-height box and
        // Playwright calls that invisible. Asserting visibility here would make
        // the spec pass or fail on whether the shared seed happens to contain a
        // kill or a third-party agent, which is the seed's business and not
        // this file's.
        await expect(main.getByTestId('reports-kills')).toHaveCount(1);
        await expect(main.getByTestId('reports-third-party')).toHaveCount(1);
    });

    test('offers the export without this spec ever filing one', async ({ page }) => {
        const tenantSlug = await loginAndGetTenant(page);
        await safeGoto(page, `/t/${tenantSlug}/agents/reports`, {
            waitUntil: 'domcontentloaded',
        });
        await waitForHydration(page).catch(() => {});

        const main = page.getByRole('main');
        await expect(main.getByTestId('agent-reports')).toBeVisible({ timeout: 30_000 });

        // PRESENT, NOT CLICKED. The default seeded user holds `evidence.edit`,
        // so the offer must be here — its absence would mean the page had
        // silently stopped offering the only way to file the pack. Clicking it
        // would write a retained Evidence row into the tenant every other
        // read-only spec shares.
        await expect(page.getByTestId('reports-export-button')).toBeVisible({ timeout: 30_000 });

        // And nothing has been filed by looking at it: the confirmation only
        // renders after a successful POST.
        await expect(page.getByTestId('reports-export-filed')).toHaveCount(0);
    });
});
