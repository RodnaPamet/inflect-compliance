/**
 * Compliance Calendar — the first browser-level spec this surface has had.
 *
 * Until now the only browser signal was a TTFB probe in
 * `page-load-budget.spec.ts`. Everything else was jsdom, which cannot exercise
 * the one claim that matters most here: that a calendar URL is **shareable**.
 * View, month, category filter and "my deadlines" are query params precisely so
 * a link pasted into chat lands the recipient on what the sender was looking
 * at — and a rendered test can only prove the component writes the params, not
 * that a real navigation reads them back.
 *
 * READ-ONLY by design, so it uses the shared seeded tenant per the E2E
 * conventions: toggling a filter writes to the URL, never to the database.
 * Nothing here creates, edits or deletes, so it cannot cascade into another
 * spec.
 *
 * Selectors are `id` attributes, not `data-testid` — the repo convention, and
 * the reason the calendar's redundant testids were removed alongside this file.
 *
 * Every `#id` locator is scoped to `getByRole('main')`. Next's streaming render
 * can briefly leave a hidden duplicate of the page subtree in the DOM, and a
 * bare `page.locator('#calendar-…')` then intermittently resolves to 2 elements
 * — the strict-mode failure behind the `#org-risks-table` flake. The real node
 * lives inside `<main>`.
 */
import { test, expect } from '@playwright/test';
import { loginAndGetTenant, safeGoto, waitForHydration } from './e2e-utils';

test.describe('Compliance Calendar', () => {
    test('renders the grid with its colour key and the filter in the side panel', async ({
        page,
    }) => {
        const tenantSlug = await loginAndGetTenant(page);
        await safeGoto(page, `/t/${tenantSlug}/calendar`, {
            waitUntil: 'domcontentloaded',
        });
        await page.waitForSelector('#calendar-side-panel', { timeout: 30_000 });
        await waitForHydration(page);

        const main = page.getByRole('main');

        // The legend/filter split: a key beside the grid, the controls in the
        // panel. Moving the chips wholesale would have left coloured events
        // with no key anywhere.
        await expect(main.locator('#calendar-legend')).toBeVisible();
        await expect(main.locator('#calendar-filter-group')).toBeVisible();

        // Containment, not co-existence — the filter must be INSIDE the panel.
        const filterInPanel = main.locator(
            '#calendar-side-panel #calendar-filter-group',
        );
        await expect(filterInPanel).toHaveCount(1);

        // …and the legend must NOT be.
        await expect(
            main.locator('#calendar-side-panel #calendar-legend'),
        ).toHaveCount(0);
    });

    test('a category filter survives being put in the URL and reloaded', async ({
        page,
    }) => {
        const tenantSlug = await loginAndGetTenant(page);

        // Arrive with the filter already applied, exactly as a pasted link
        // would. This is the half a rendered test cannot cover: a real
        // navigation initialising from the query string.
        await safeGoto(page, `/t/${tenantSlug}/calendar?categories=risk`, {
            waitUntil: 'domcontentloaded',
        });
        await page.waitForSelector('#calendar-filter-group', { timeout: 30_000 });
        await waitForHydration(page);

        const checked = page
            .getByRole('main')
            .locator(
                '#calendar-filter-group [data-state="checked"], #calendar-filter-group input:checked',
            );
        await expect(checked.first()).toBeVisible({ timeout: 15_000 });
    });

    test('the view toggle is readable back out of the URL', async ({ page }) => {
        const tenantSlug = await loginAndGetTenant(page);
        await safeGoto(page, `/t/${tenantSlug}/calendar?view=heatmap`, {
            waitUntil: 'domcontentloaded',
        });
        await waitForHydration(page);

        const main = page.getByRole('main');

        // Heatmap, not the default month grid — proof the param is read on
        // arrival rather than only written on click.
        await expect(
            main.locator('[data-testid="calendar-heatmap"]'),
        ).toBeVisible({ timeout: 30_000 });
        await expect(main.locator('#calendar-month-nav')).toHaveCount(0);
    });

    test('toggling a category writes it to the URL', async ({ page }) => {
        const tenantSlug = await loginAndGetTenant(page);
        await safeGoto(page, `/t/${tenantSlug}/calendar`, {
            waitUntil: 'domcontentloaded',
        });
        await page.waitForSelector('#calendar-filter-group', { timeout: 30_000 });
        await waitForHydration(page);

        const firstBox = page
            .getByRole('main')
            .locator('#calendar-filter-group')
            .locator('[role="checkbox"], input[type="checkbox"]')
            .first();
        await firstBox.click();

        // The other half of the round trip: state leaves the component and
        // lands somewhere a link can carry it.
        await expect(page).toHaveURL(/categories=/, { timeout: 15_000 });
    });

    test('month navigation moves the cursor and records it in the URL', async ({
        page,
    }) => {
        const tenantSlug = await loginAndGetTenant(page);
        await safeGoto(page, `/t/${tenantSlug}/calendar`, {
            waitUntil: 'domcontentloaded',
        });
        await page.waitForSelector('#calendar-month-nav', { timeout: 30_000 });
        await waitForHydration(page);

        const main = page.getByRole('main');
        const label = main.locator('#calendar-current-month');
        const before = (await label.textContent())?.trim();

        await main.locator('#calendar-month-nav button').first().click();

        await expect(label).not.toHaveText(before ?? '', { timeout: 15_000 });
        // A shared link to "the month I was looking at" needs this param.
        await expect(page).toHaveURL(/month=\d{4}-\d{2}/, { timeout: 15_000 });
    });
});
