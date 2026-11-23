/**
 * Bulk actions work on a phone: a card is selected, the action picker and
 * Apply are on screen and finger-sized, and Apply changes the record.
 *
 * The selection toolbar used to be one non-wrapping row about 408 px wide,
 * with Apply cut off by the shell's horizontal clip and no way to scroll to
 * it — bulk actions could not be used on a phone at all. This drives the
 * whole flow on the controls list in both phone configurations (Bulgarian,
 * 390 dark and 360 light): tick the card, check the picker and Apply are
 * fully inside the viewport and at least 44 px tall, set the status, tap
 * Apply, and read the control back from the API.
 *
 * It mutates, so each test gets its own empty tenant and creates the control
 * it acts on.
 */
import type { Locator } from '@playwright/test';
import { test, expect } from './fixtures';
import { PHONE_CONFIGS, preferenceCookies } from '../../scripts/mobile-audit/configs';
import { catalogValue } from '../helpers/catalog-translator';
import { MOBILE_E2E_CONFIGS } from './mobile-ratchet';

/** WCAG 2.5.5 / Apple HIG: a finger needs 44 px. */
const MIN_TARGET = 44;

async function expectReachable(control: Locator, name: string): Promise<void> {
    await expect(control, `${name} is not visible`).toBeVisible();
    const box = await control.boundingBox();
    expect(box, `${name} has no box`).not.toBeNull();
    const viewport = await control.page().evaluate(() => ({
        width: document.documentElement.clientWidth,
        height: window.visualViewport?.height ?? window.innerHeight,
    }));
    const { x, y, width, height } = box!;
    expect(x, `${name} starts left of the screen`).toBeGreaterThanOrEqual(-0.5);
    expect(x + width, `${name} ends right of the screen (${x + width} > ${viewport.width})`).toBeLessThanOrEqual(viewport.width + 0.5);
    expect(y, `${name} starts above the screen`).toBeGreaterThanOrEqual(-0.5);
    expect(y + height, `${name} ends below the screen`).toBeLessThanOrEqual(viewport.height + 0.5);
    expect(height, `${name} is ${height}px tall`).toBeGreaterThanOrEqual(MIN_TARGET);
}

for (const config of MOBILE_E2E_CONFIGS) {
    test(`a selected card's bulk action applies on a phone — ${config}`, async ({ authedPage: page, isolatedTenant }, testInfo) => {
        test.setTimeout(3 * 60_000);
        const slug = isolatedTenant.tenantSlug;
        const api = (p: string) => `/api/t/${slug}${p}`;

        const res = await page.request.post(api('/controls'), {
            headers: { 'Content-Type': 'application/json' },
            data: { name: 'Quarterly access review', code: 'MOB-BULK-1', status: 'NOT_STARTED', isCustom: true },
        });
        expect(res.ok(), `creating the control failed: ${res.status()} ${await res.text()}`).toBe(true);
        const controlId = ((await res.json()) as { id: string }).id;

        const phone = PHONE_CONFIGS[config];
        await page.setViewportSize({ width: phone.width, height: phone.height });
        await page.context().addCookies(preferenceCookies(phone, testInfo.project.use.baseURL!));
        await page.goto(`/t/${slug}/controls`, { waitUntil: 'domcontentloaded' });

        await test.step('select the card', async () => {
            const card = page.locator('main [data-testid="data-table-card-select"]').first();
            await card.waitFor({ state: 'visible', timeout: 60_000 });
            // A tap on the 44px hit area around the circle, where a finger lands.
            await card.tap();
            await expect(card.locator('[role="checkbox"]')).toHaveAttribute('data-state', 'checked');
            await expect(page.locator('[data-testid="selection-toolbar"]')).toBeVisible();
        });

        const toolbar = page.locator('[data-testid="selection-toolbar"]');
        const picker = toolbar.locator('#bulk-action-select');
        const apply = toolbar.locator('#bulk-apply-btn');

        await test.step('the action picker and Apply are on screen and finger-sized', async () => {
            await expectReachable(picker, 'the action picker');
            await expectReachable(apply, 'Apply');
        });

        await test.step('choose "set status" → Implemented, tap Apply', async () => {
            await picker.click();
            await page.getByRole('option', { name: catalogValue('bg', 'controls.bulk.setStatus'), exact: true }).click();
            const value = toolbar.locator('#bulk-value-input');
            await expectReachable(value, 'the status picker');
            await value.click();
            await page
                .getByRole('option', { name: catalogValue('bg', 'controls.filterEnums.status.IMPLEMENTED'), exact: true })
                .click();
            await expectReachable(apply, 'Apply, with an action chosen');
            await expect(apply).toBeEnabled();
            await apply.click();
        });

        await test.step('the control is implemented', async () => {
            await expect
                .poll(
                    async () => {
                        const r = await page.request.get(api(`/controls/${controlId}`));
                        return r.ok() ? ((await r.json()) as { status?: string }).status : `HTTP ${r.status()}`;
                    },
                    { timeout: 30_000 },
                )
                .toBe('IMPLEMENTED');
            // The bar clears once the apply settles.
            await expect(toolbar).toBeHidden();
        });
    });
}
