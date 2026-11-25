/**
 * #5937 step 4 — the calendar Connect control on a phone, against the real
 * server, in an isolated tenant (the outcome and the panel's reads are the
 * tenant's own; a connect is started, never finished).
 *
 * A real OAuth round trip cannot run here, so the spec goes as far as the
 * hand-off: Connect leaves for Google's authorize URL with this deployment's
 * client, PKCE and the callback; the request is stopped at the browser. The
 * return leg is driven by visiting `?calendar=<outcome>` as the callback
 * would. Outlook has no organisation consent in a fresh tenant, so it must
 * say so and offer no button.
 *
 * Both phone configurations (Bulgarian), with the four zero-tolerance
 * invariants and the small-tap metric held on the open panel and on the
 * outcome message.
 */
import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { PHONE_CONFIGS, preferenceCookies } from '../../scripts/mobile-audit/configs';
import { countsOf, measurePage, settlePage } from '../../scripts/mobile-audit/measure';
import { findEnglishLeaks } from '../../scripts/mobile-audit/leaks';
import { safeGoto } from './e2e-utils';
import { MOBILE_E2E_CONFIGS, type MobileE2eConfig } from './mobile-ratchet';
import { holdInvariants, leakCatalog } from './mobile-support';
import bg from '../../messages/bg.json';

const OUTCOMES = Object.keys(bg.calendarConnect.outcome) as Array<keyof typeof bg.calendarConnect.outcome>;
/** Provider names are brands, written the same in every language. */
const BRANDS = new Set(['Google Calendar', 'Outlook', 'Google', 'Inflect']);

async function holdPhone(page: Page, key: string, config: MobileE2eConfig, tenantName: string) {
    const raw = await measurePage(page, { scrollToEnd: false });
    holdInvariants(key, config, raw);
    const leaks = findEnglishLeaks(raw, await leakCatalog(), new Set([tenantName, ...BRANDS]), new Set());
    const counts = countsOf(raw, { englishLeaks: leaks.length, consoleErrors: 0 });
    expect.soft(counts.tapUnder24, `${key} @ ${config}: a tap target under 24px`).toBe(0);
    expect.soft(counts.clipped, `${key} @ ${config}: clipped content`).toBe(0);
    expect.soft(leaks.map((l) => l.text), `${key} @ ${config}: English in Bulgarian`).toEqual([]);
}

for (const config of MOBILE_E2E_CONFIGS) {
    test(`calendar Connect control on a phone — ${config}`, async ({ authedPage: page, isolatedTenant }, testInfo) => {
        test.setTimeout(4 * 60_000);
        const slug = isolatedTenant.tenantSlug;
        const phone = PHONE_CONFIGS[config];
        await page.setViewportSize({ width: phone.width, height: phone.height });
        await page.context().addCookies(preferenceCookies(phone, testInfo.project.use.baseURL!));

        await test.step('the action is in the header menu and opens the panel', async () => {
            await safeGoto(page, `/t/${slug}/calendar`, { waitUntil: 'domcontentloaded' });
            const main = page.getByRole('main');
            await main.locator('[data-testid="page-actions-more-slot"] button').first().click();
            await page.getByRole('menuitem', { name: bg.calendarConnect.open }).click();
            await expect(page.locator('#calendar-connect-panel')).toBeVisible();
            await expect(page.locator('#calendar-connect-google-calendar')).toBeVisible();
            await settlePage(page);
            await page.waitForTimeout(600);
            await holdPhone(page, '/calendar#connect-panel', config, isolatedTenant.tenantName);
        });

        await test.step('Outlook without the organisation consent: the reason and no button', async () => {
            const outlook = page.locator('#calendar-connect-outlook-calendar');
            await expect(outlook.locator('#calendar-connect-outlook-calendar-refusal')).toHaveText(
                bg.calendarConnect.refusal.ADMIN_CONSENT_NOT_GRANTED,
            );
            await expect(outlook.getByRole('button')).toHaveCount(0);
        });

        await test.step('Connect hands the browser to Google with PKCE and the callback', async () => {
            await page.route('https://accounts.google.com/**', (route) =>
                route.fulfill({ status: 200, contentType: 'text/plain', body: 'stopped by the test' }),
            );
            const leaving = page.waitForRequest((r) => r.url().startsWith('https://accounts.google.com/'));
            await page
                .locator('#calendar-connect-google-calendar')
                .getByRole('button', { name: bg.calendarConnect.connect.replace('{provider}', 'Google Calendar') })
                .click();
            const url = new URL((await leaving).url());
            expect(url.searchParams.get('response_type')).toBe('code');
            expect(url.searchParams.get('code_challenge_method')).toBe('S256');
            expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
            expect(url.searchParams.get('redirect_uri')).toMatch(/\/api\/integrations\/calendar\/callback$/);
            expect(url.searchParams.get('state')).toBeTruthy();
            await page.unroute('https://accounts.google.com/**');
        });

        await test.step('each outcome is said once and taken out of the address', async () => {
            for (const outcome of OUTCOMES) {
                await safeGoto(page, `/t/${slug}/calendar?view=agenda&calendar=${outcome}`, {
                    waitUntil: 'domcontentloaded',
                });
                const notice = page.getByRole('main').locator('#calendar-connect-outcome');
                await expect(notice, outcome).toHaveText(bg.calendarConnect.outcome[outcome]);
                await expect(page).toHaveURL(new RegExp(`/t/${slug}/calendar\\?view=agenda$`));
                if (outcome === 'consent_withdrawn') {
                    await settlePage(page);
                    await holdPhone(page, '/calendar#connect-outcome', config, isolatedTenant.tenantName);
                }
            }
            // A reload does not say it again.
            await page.reload({ waitUntil: 'domcontentloaded' });
            await expect(page.getByRole('main').locator('#calendar-side-panel')).toBeAttached();
            await expect(page.locator('#calendar-connect-outcome')).toHaveCount(0);
        });
    });
}
