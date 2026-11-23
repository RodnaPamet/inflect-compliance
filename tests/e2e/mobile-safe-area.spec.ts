/**
 * Bottom drawers clear the home indicator, on a phone that has one.
 *
 * Chromium reports `env(safe-area-inset-bottom)` as 0, so on an ordinary run a
 * drawer with its safe-area padding and one without it measure the same and an
 * assertion over them proves nothing. This spec makes the inset REAL: it
 * overrides it through the DevTools protocol to an iPhone's home indicator
 * (34 px), checks that the page now resolves `env(safe-area-inset-bottom)` to
 * that value (so a protocol that silently stopped honouring the override fails
 * here instead of passing vacuously), and then asserts, for each primitive:
 *
 *   - the panel sits inside the viewport (sized in `dvh`, its top and bottom
 *     edges are on screen);
 *   - every control in it, scrolled to its end, ends ABOVE the inset — a tap
 *     there would otherwise land on the system gesture.
 *
 * Covered: the create modal as a bottom sheet (new risk, its sticky Cancel /
 * Create footer), the assistant (a bottom `Sheet` with a footer), the
 * navigation drawer (a left `Sheet`) and the user menu (the `Popover` drawer).
 * Removing the safe-area padding from any one of them fails its step.
 *
 * Read-only on the shared seeded tenant: it opens and closes overlays and
 * submits nothing.
 */
import { test, expect, type Locator, type Page } from '@playwright/test';
import { signInTenantContext } from '../../scripts/mobile-audit/auth';
import { safeGoto } from './e2e-utils';
import { MOBILE_E2E_CONFIGS } from './mobile-ratchet';
import { phoneContext } from './mobile-support';

/** An iPhone's home-indicator inset, in CSS pixels. */
const HOME_INDICATOR = 34;

async function emulateHomeIndicator(page: Page): Promise<void> {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setSafeAreaInsetsOverride', {
        insets: { bottom: HOME_INDICATOR, bottomMax: HOME_INDICATOR },
    });
}

/** What `env(safe-area-inset-bottom)` resolves to on the page right now. */
async function resolvedInset(page: Page): Promise<number> {
    return page.evaluate(() => {
        const probe = document.createElement('div');
        probe.style.cssText = 'position:fixed;visibility:hidden;padding-bottom:env(safe-area-inset-bottom)';
        document.body.appendChild(probe);
        const px = parseFloat(getComputedStyle(probe).paddingBottom);
        probe.remove();
        return px;
    });
}

interface PanelGeometry {
    viewport: number;
    top: number;
    bottom: number;
    controls: number;
    lowestControl: number;
    lowestControlText: string;
    footerBottom: number | null;
}

/**
 * Scroll every scroll container inside the panel to its end (the last row is
 * what sits nearest the indicator), then read the panel's edges and the lowest
 * control in it.
 */
async function panelGeometry(panel: Locator): Promise<PanelGeometry> {
    return panel.evaluate((el) => {
        for (const node of [el, ...Array.from(el.querySelectorAll('*'))]) {
            const overflowY = getComputedStyle(node).overflowY;
            if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight + 1) {
                node.scrollTop = node.scrollHeight;
            }
        }
        const viewport = window.visualViewport?.height ?? window.innerHeight;
        const box = el.getBoundingClientRect();
        // What a finger can reach: the control's box cut by every ancestor
        // that clips its overflow (a scroll body, the panel itself). A row
        // scrolled out of the body is not on screen, wherever its box is.
        const reachable = (c: HTMLElement): { top: number; bottom: number } | null => {
            const r = c.getBoundingClientRect();
            if (r.width === 0 || r.height === 0 || getComputedStyle(c).visibility === 'hidden') return null;
            let top = r.top;
            let bottom = r.bottom;
            for (let a = c.parentElement; a; a = a.parentElement) {
                const cs = getComputedStyle(a);
                if (cs.overflowY !== 'visible' || cs.overflowX !== 'visible') {
                    const ar = a.getBoundingClientRect();
                    top = Math.max(top, ar.top);
                    bottom = Math.min(bottom, ar.bottom);
                }
                if (a === el) break;
            }
            return bottom > top ? { top, bottom } : null;
        };
        const controls = Array.from(
            el.querySelectorAll<HTMLElement>(
                'button, a[href], input:not([type="hidden"]), select, textarea, [role="menuitem"], [role="option"], [role="checkbox"]',
            ),
        ).flatMap((c) => {
            const r = reachable(c);
            return r ? [{ c, r }] : [];
        });
        const lowest = controls.reduce<(typeof controls)[number] | null>(
            (a, b) => (!a || b.r.bottom > a.r.bottom ? b : a),
            null,
        );
        const footer = el.querySelector('[data-modal-footer], [data-sheet-footer]');
        return {
            viewport,
            top: box.top,
            bottom: box.bottom,
            controls: controls.length,
            lowestControl: lowest?.r.bottom ?? 0,
            lowestControlText: (lowest?.c.getAttribute('aria-label') || lowest?.c.textContent || '').trim().slice(0, 60),
            footerBottom: footer ? footer.getBoundingClientRect().bottom : null,
        };
    });
}

/**
 * Soft assertions per primitive, so one red run names every drawer that sits
 * in the inset rather than stopping at the first.
 */
function expectClearOfIndicator(name: string, g: PanelGeometry): void {
    const limit = g.viewport - HOME_INDICATOR + 0.5;
    expect.soft(g.controls, `${name}: the panel holds no visible control to measure`).toBeGreaterThan(0);
    expect.soft(g.top, `${name}: the panel's top edge is above the screen`).toBeGreaterThanOrEqual(-0.5);
    expect.soft(g.bottom, `${name}: the panel's bottom edge is below the screen`).toBeLessThanOrEqual(g.viewport + 0.5);
    expect.soft(
        g.lowestControl,
        `${name}: "${g.lowestControlText}" ends at ${g.lowestControl}px, inside the ${HOME_INDICATOR}px home indicator of a ${g.viewport}px screen`,
    ).toBeLessThanOrEqual(limit);
    if (g.footerBottom !== null) {
        expect.soft(g.footerBottom, `${name}: the footer ends inside the home indicator`).toBeLessThanOrEqual(limit);
    }
}

async function openAndSettle(page: Page, trigger: string, panel: Locator): Promise<void> {
    await page.locator(trigger).first().click();
    await panel.waitFor({ state: 'visible', timeout: 15_000 });
    // vaul slides the panel in; measure where it comes to rest.
    await page.waitForTimeout(700);
}

for (const config of MOBILE_E2E_CONFIGS) {
    test(`bottom drawers clear the home indicator — ${config}`, async ({ browser }, testInfo) => {
        test.setTimeout(5 * 60_000);
        const context = await phoneContext(browser, config, testInfo);
        try {
            const slug = await signInTenantContext(context);
            const page = await context.newPage();
            await emulateHomeIndicator(page);

            await test.step('the inset is real', async () => {
                await safeGoto(page, `/t/${slug}/risks`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
                await page.locator('main').first().waitFor({ state: 'visible', timeout: 60_000 });
                expect(await resolvedInset(page)).toBe(HOME_INDICATOR);
            });

            await test.step('the create modal (new risk) and its footer', async () => {
                const sheet = page.locator('[role="dialog"]').filter({ has: page.locator('[data-modal-footer]') });
                await openAndSettle(page, '#new-risk-btn', sheet);
                const g = await panelGeometry(sheet.first());
                expect(g.footerBottom, 'the new-risk sheet renders no Modal.Footer').not.toBeNull();
                expectClearOfIndicator('new-risk modal', g);
                await page.keyboard.press('Escape');
                await sheet.first().waitFor({ state: 'hidden', timeout: 10_000 });
            });

            await safeGoto(page, `/t/${slug}/dashboard`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
            await page.locator('main').first().waitFor({ state: 'visible', timeout: 60_000 });

            await test.step('the assistant (a bottom sheet with a footer)', async () => {
                const sheet = page.locator('[role="dialog"]').filter({ has: page.locator('[data-sheet-footer]') });
                await openAndSettle(page, '[data-testid="assistant-top-bar-button"]', sheet);
                expectClearOfIndicator('assistant sheet', await panelGeometry(sheet.first()));
                await page.keyboard.press('Escape');
                await sheet.first().waitFor({ state: 'hidden', timeout: 10_000 });
            });

            await test.step('the navigation drawer (a left sheet)', async () => {
                const drawer = page.locator('[role="dialog"]').filter({ has: page.locator('[data-testid="nav-drawer"]') });
                await openAndSettle(page, '[data-testid="nav-toggle"]', drawer);
                expectClearOfIndicator('navigation drawer', await panelGeometry(drawer.first()));
                await page.keyboard.press('Escape');
                await drawer.first().waitFor({ state: 'hidden', timeout: 10_000 });
            });

            await test.step('the user menu (the popover drawer)', async () => {
                const drawer = page.locator('[data-popover-drawer]');
                await openAndSettle(page, '[data-testid="top-chrome-user-menu"]', drawer);
                expectClearOfIndicator('user menu', await panelGeometry(drawer.first()));
            });
        } finally {
            await context.close();
        }
    });
}
