/**
 * Control templates install from a phone: two cards are ticked, the pinned
 * install bar counts them and is on screen and finger-sized, and installing
 * creates the two controls.
 *
 * The library used to put every template on one page (about 222,000 px at
 * 390), with no visible selection and the install action at the far end.
 * This drives the phone layout in both phone configurations (Bulgarian, 390
 * dark and 360 light): tick two cards by their 44 px boxes, check the bar,
 * tap Install, and read the controls back from the API.
 *
 * It mutates, so each test gets its own empty tenant.
 */
import type { Locator } from '@playwright/test';
import { test, expect } from './fixtures';
import { PHONE_CONFIGS, preferenceCookies } from '../../scripts/mobile-audit/configs';
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

/** The controls list, whichever envelope the route answers with. */
function controlsOf(body: unknown): Array<{ code?: string | null }> {
    if (Array.isArray(body)) return body;
    const o = body as { items?: unknown; data?: unknown };
    return (Array.isArray(o.items) ? o.items : Array.isArray(o.data) ? o.data : []) as Array<{ code?: string | null }>;
}

for (const config of MOBILE_E2E_CONFIGS) {
    test(`two control templates install from a phone — ${config}`, async ({ authedPage: page, isolatedTenant }, testInfo) => {
        test.setTimeout(3 * 60_000);
        const slug = isolatedTenant.tenantSlug;

        const phone = PHONE_CONFIGS[config];
        await page.setViewportSize({ width: phone.width, height: phone.height });
        await page.context().addCookies(preferenceCookies(phone, testInfo.project.use.baseURL!));
        await page.goto(`/t/${slug}/controls/templates`, { waitUntil: 'domcontentloaded' });

        const cards = page.locator('main [data-testid="template-phone-card"]');
        const dock = page.locator('[data-testid="template-install-dock"]');
        const install = dock.locator('#templates-phone-install');
        const codes: string[] = [];

        await test.step('the bar is there before anything is ticked', async () => {
            await cards.first().waitFor({ state: 'visible', timeout: 60_000 });
            await expectReachable(install, 'Install');
            await expect(install).toBeDisabled();
        });

        await test.step('tick two cards by their boxes', async () => {
            for (const i of [0, 1]) {
                const card = cards.nth(i);
                const box = card.locator('[data-testid="template-select"]');
                await box.scrollIntoViewIfNeeded();
                const hit = await box.boundingBox();
                expect(hit, 'the checkbox has no box').not.toBeNull();
                // A finger lands beside the painted box, inside its 44 px hit area.
                await page.touchscreen.tap(hit!.x + hit!.width + 8, hit!.y + hit!.height / 2);
                await expect(box).toHaveAttribute('data-state', 'checked');
                codes.push(((await card.locator('code').first().textContent()) ?? '').trim());
            }
            expect(codes.every(Boolean), 'a ticked card has no code').toBe(true);
        });

        await test.step('the bar counts two, on screen and finger-sized', async () => {
            await expect(install).toContainText('2');
            await expect(install).toBeEnabled();
            await expectReachable(install, 'Install (2)');
        });

        await test.step('install, and the two controls exist', async () => {
            await install.tap();
            await expect
                .poll(
                    async () => {
                        const r = await page.request.get(`/api/t/${slug}/controls`);
                        if (!r.ok()) return `HTTP ${r.status()}`;
                        const have = new Set(controlsOf(await r.json()).map((c) => c.code));
                        return codes.filter((c) => have.has(c)).length;
                    },
                    { timeout: 30_000 },
                )
                .toBe(2);
        });
    });
}
