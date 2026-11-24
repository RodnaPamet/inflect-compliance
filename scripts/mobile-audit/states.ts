/**
 * The open states the audit captures besides each route's resting state: the
 * overlays a phone user opens on every page, where the shared primitives that
 * render them (popover drawer, sheet, modal, selection toolbar, tab strip)
 * either fit or do not.
 *
 * Each state names the route it opens on and how to open it. Opening uses
 * stable selectors only (`data-testid`, `id`, roles), never a label, so a
 * Bulgarian page opens the same way as an English one. A state whose trigger
 * is missing (the seed has no record to inspect) is reported as uncaptured
 * with the reason, like a route.
 */
import type { Page } from '@playwright/test';

export interface OpenState {
    id: string;
    label: string;
    /** The route pattern the state opens on (resolved like any route). */
    route: string;
    /** Opens the state; throws `StateUnavailable` when the page offers no trigger. */
    open: (page: Page) => Promise<void>;
}

export class StateUnavailable extends Error {}

const T = '/t/[tenantSlug]';

async function clickAndWait(page: Page, trigger: string, opened: string): Promise<void> {
    const t = page.locator(trigger).first();
    if (!(await t.isVisible().catch(() => false))) throw new StateUnavailable(`no visible ${trigger} on the page`);
    await t.click();
    await page.locator(opened).first().waitFor({ state: 'visible', timeout: 10_000 });
    // Let the drawer/sheet finish its entry animation before measuring.
    await page.waitForTimeout(600);
}

export const OPEN_STATES: readonly OpenState[] = [
    {
        id: 'nav-drawer',
        label: 'Navigation drawer',
        route: `${T}/dashboard`,
        open: (page) => clickAndWait(page, '[data-testid="nav-toggle"]', '[data-testid="nav-drawer"]'),
    },
    {
        id: 'user-menu',
        label: 'User menu',
        route: `${T}/dashboard`,
        open: (page) => clickAndWait(page, '[data-testid="top-chrome-user-menu"]', '[data-testid="user-menu-display-name"]'),
    },
    {
        id: 'command-palette',
        label: 'Command palette',
        route: `${T}/dashboard`,
        open: (page) => clickAndWait(page, '[data-testid="command-palette-top-bar-button"]', '[data-testid="command-palette-input"]'),
    },
    {
        id: 'assistant-sheet',
        label: 'Assistant sheet',
        route: `${T}/dashboard`,
        open: (page) => clickAndWait(page, '[data-testid="assistant-top-bar-button"]', '[role="dialog"]'),
    },
    {
        // #5904: the product tour, opened the way a phone opens it — from the
        // navigation drawer, which closes as the tour starts. In a test build
        // the tour never starts on its own, so this is the only way it is seen.
        id: 'onboarding-tour',
        label: 'Product tour (first step)',
        route: `${T}/dashboard`,
        open: async (page) => {
            await clickAndWait(page, '[data-testid="nav-toggle"]', '[data-testid="nav-drawer"]');
            await clickAndWait(page, '[data-testid="nav-drawer"] [data-testid="start-tour-btn"]', '#driver-popover-content');
        },
    },
    {
        id: 'create-modal',
        label: 'Create modal (new control)',
        route: `${T}/controls`,
        open: (page) => clickAndWait(page, '#new-control-btn', '[role="dialog"]'),
    },
    {
        id: 'selection-toolbar',
        label: 'Selection toolbar (one card ticked)',
        route: `${T}/controls`,
        open: async (page) => {
            // The first VISIBLE row checkbox (the select-all one is hidden in card mode).
            const box = page.locator('main [role="checkbox"]:visible').first();
            if (!(await box.isVisible().catch(() => false))) throw new StateUnavailable('no selectable card on the page');
            // A full-cell wrapper takes the tap for the checkbox, as on a phone.
            await box.click({ force: true });
            await page.waitForTimeout(600);
        },
    },
    {
        id: 'inspector-sheet',
        label: 'Inspector sheet (evidence row)',
        route: `${T}/evidence`,
        open: async (page) => {
            const row = page.locator('main [data-testid="evidence-table"] [role="button"], main [data-testid="evidence-table"] tbody tr').first();
            if (!(await row.isVisible().catch(() => false))) throw new StateUnavailable('no evidence row to inspect');
            await row.click();
            await page.locator('[role="dialog"]').first().waitFor({ state: 'visible', timeout: 10_000 });
            await page.waitForTimeout(600);
        },
    },
    {
        id: 'agent-tabs-scrolled',
        label: 'Agent tab bar scrolled to its end',
        route: `${T}/agents/[agentId]`,
        open: async (page) => {
            const list = page.locator('main [role="tablist"]').first();
            if (!(await list.isVisible().catch(() => false))) throw new StateUnavailable('no tab bar on the page');
            await list.evaluate((el) => {
                el.scrollLeft = el.scrollWidth;
            });
            await page.waitForTimeout(400);
        },
    },
];
