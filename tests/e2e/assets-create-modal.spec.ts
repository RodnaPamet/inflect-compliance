/**
 * Navigating to /assets/new opens the create modal.
 *
 * This replaces a source-text guard that asserted the same behaviour by
 * regexing three files for string fragments: that `new/page.tsx` contains
 * `redirect(...)`, that `AssetsClient.tsx` contains
 * `searchParams?.get('create') === '1'`, and that it contains
 * `setIsCreateOpen(true)`. All three could hold while the flow was broken —
 * rename the state setter, change the query key, or let the redirect land on
 * a page that throws, and every assertion still passes.
 *
 * The behaviour that actually matters is the one a user performs: open the
 * `/assets/new` URL (a bookmark, a link, a deep link from an email) and get
 * a usable create form. That is one navigation and one assertion.
 *
 * Read-only: this spec navigates and asserts, and never submits the form, so
 * it uses the SHARED seeded tenant per the E2E isolation convention. No new
 * `data-testid` attributes — `#new-asset-form` and `#asset-name-input`
 * already exist.
 */
import { test, expect } from '@playwright/test';
import { loginAndGetTenant } from './e2e-utils';

test.describe('Assets — create modal deep link', () => {
    test('navigating to /assets/new opens the create modal on the list page', async ({
        page,
    }) => {
        const slug = await loginAndGetTenant(page);

        await page.goto(`/t/${slug}/assets/new`);

        // The redirect shim lands on the list page carrying ?create=1 …
        await page.waitForURL(/\/assets\?create=1$/, { timeout: 15000 });

        // … and the list page turns that into an open, usable modal.
        const form = page.locator('#new-asset-form');
        await expect(form).toBeVisible({ timeout: 15000 });

        const nameInput = page.locator('#asset-name-input');
        await expect(nameInput).toBeVisible();
        await expect(nameInput).toBeEditable();
    });

    test('the list page without ?create=1 does not open the modal', async ({ page }) => {
        // The negative half — otherwise a modal stuck permanently open would
        // satisfy the test above.
        const slug = await loginAndGetTenant(page);

        await page.goto(`/t/${slug}/assets`);
        await page.waitForSelector('main', { timeout: 15000 });

        await expect(page.locator('#new-asset-form')).toHaveCount(0);
    });
});
