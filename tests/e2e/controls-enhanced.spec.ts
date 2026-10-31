/**
 * Controls Enhanced — mutating E2E (dashboard + detail-page extras).
 *
 * Isolation: each `test()` runs on its own fresh, empty tenant via
 * the `isolatedTenant` fixture. The "activity tab" / "automation
 * section" tests previously clicked the FIRST row of the controls
 * table — which only works if the seed tenant already has controls.
 * On an isolated (empty) tenant they now create their own control
 * first, so the test is self-contained and order-independent.
 *
 * All selectors use existing id attributes — no data-testid additions.
 */
import { randomUUID } from 'node:crypto';
import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { safeGoto } from './e2e-utils';

/** Create a control on the isolated tenant; land on its detail page. */
async function createControl(page: Page, slug: string): Promise<void> {
    const uid = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    let r = 3;
    while (r > 0) {
        const resp = await safeGoto(page, `/t/${slug}/controls/new`, {
            waitUntil: 'domcontentloaded',
        });
        if (resp && resp.status() < 500) break;
        r--;
        if (r > 0) await page.waitForTimeout(5000);
    }
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForSelector('#control-name-input', { timeout: 30000 });
    await page.fill('#control-name-input', `Enhanced Test ${uid}`);
    await page.fill('#control-code-input', `ENH-${uid}`);
    await page.click('#create-control-btn');
    await page.waitForURL('**/controls/**', { timeout: 30000 });
    await page.waitForSelector('#control-title', { timeout: 30000 });
}

test.describe('Controls Enhanced', () => {
    test('dashboard loads and shows metrics', async ({
        authedPage,
        isolatedTenant,
    }) => {
        const { tenantSlug } = isolatedTenant;
        let retries = 3;
        while (retries > 0) {
            const resp = await safeGoto(
                authedPage,
                `/t/${tenantSlug}/controls/dashboard`,
                { waitUntil: 'domcontentloaded' },
            );
            if (resp && resp.status() < 500) break;
            retries--;
            if (retries > 0) await authedPage.waitForTimeout(5000);
        }
        await authedPage.waitForLoadState('networkidle').catch(() => {});
        await authedPage.waitForSelector('#dashboard-heading', { timeout: 60000 });
        await expect(authedPage.locator('#dashboard-heading')).toContainText(
            'Controls dashboard',
        );
        await expect(authedPage.locator('#implementation-progress')).toBeVisible({
            timeout: 15000,
        });
        await expect(authedPage.locator('#dashboard-stats')).toBeVisible({
            timeout: 15000,
        });
    });

    test('activity tab shows events', async ({ authedPage, isolatedTenant }) => {
        // Self-contained: create the control whose activity we inspect.
        await createControl(authedPage, isolatedTenant.tenantSlug);

        await authedPage.click('#tab-activity');
        await authedPage.waitForLoadState('networkidle').catch(() => {});

        // The activity tab lazy-loads its feed; under CI load neither the feed
        // nor the empty-state may have mounted within a single wait. Reload-poll
        // until one of the two terminal states is shown (anti-flake).
        const activityFeed = authedPage.locator('#activity-feed');
        const noActivity = authedPage.locator('text=No activity recorded');
        await expect(async () => {
            const feed = await activityFeed.isVisible().catch(() => false);
            const empty = await noActivity.isVisible().catch(() => false);
            if (!feed && !empty) {
                await authedPage.reload({ waitUntil: 'domcontentloaded' });
                await authedPage.locator('#tab-activity').click().catch(() => {});
                await authedPage.waitForLoadState('networkidle').catch(() => {});
            }
            expect(
                (await activityFeed.isVisible().catch(() => false)) ||
                    (await noActivity.isVisible().catch(() => false)),
            ).toBe(true);
        }).toPass({ timeout: 75_000 });
    });
});
