/**
 * E2E — THE VIEWS MENU REACHES EVERY DESTINATION, AND EVERY OLD PATH REDIRECTS.
 *
 * READ-ONLY: it navigates and asserts, and creates nothing. So it uses the
 * SHARED seeded tenant via `loginAndGetTenant` / `DEFAULT_USER` — read-only
 * access cannot cascade into another spec, and this one needs a tenant that
 * exists rather than an empty one.
 *
 * Two claims:
 *
 *   1. EVERY DESTINATION IS REACHABLE FROM THE MENU. Through the menu,
 *      not by `goto`: a goto proves the ROUTE exists and says nothing about
 *      whether anybody can find it, and "the route exists, nothing links to
 *      it" is the exact state the review-quality report shipped in.
 *
 *   2. EVERY OLD PATH REDIRECTS. Seven of them. Bookmarks, the old `/admin/mcp`
 *      hub cards and any external link have to keep working, and a shim that
 *      404s is indistinguishable in CI from a shim that was never written.
 *      Asserted on the RESULTING pathname after a full navigation, because
 *      `redirect()` in a Server Component is a real HTTP redirect the browser
 *      follows — which is also why a status-code assertion on the request would
 *      say the wrong thing.
 */
import { test, expect } from '@playwright/test';

import { loginAndGetTenant, safeGoto, waitForHydration } from './e2e-utils';

/** The menu entries, by their stable DOM ids, and where each must land. */
const ENTRIES = [
    { id: 'agents-view-proposals', path: '/agents/proposals' },
    { id: 'agents-view-runs', path: '/agents/runs' },
    { id: 'agents-view-receipts', path: '/agents/receipts' },
    { id: 'agents-view-quarantine', path: '/agents/quarantine' },
    { id: 'agents-view-review-quality', path: '/agents/review-quality' },
    // AGENTIC UI 4/4. Added with the menu entry rather than after it: "the
    // route exists, nothing links to it" is the exact state this file was
    // written to catch, and the reports page shipping unlisted here would have
    // reproduced it one prompt later.
    { id: 'agents-view-reports', path: '/agents/reports' },
] as const;

/**
 * The seven compatibility shims, each with the path it must land on.
 *
 * `[agentId]` is deliberately absent: the detail shim needs a real agent id to
 * forward, and minting one would make this spec MUTATING. `agent-detail.spec.ts`
 * owns the detail route's own navigation, in an isolated tenant.
 */
const REDIRECTS = [
    { from: '/admin/agents', to: '/agents' },
    { from: '/admin/agents/review-quality', to: '/agents/review-quality' },
    { from: '/admin/mcp/agent-receipts', to: '/agents/receipts' },
    { from: '/admin/mcp/quarantine', to: '/agents/quarantine' },
    { from: '/agent-proposals', to: '/agents/proposals' },
    { from: '/agent-runs', to: '/agents/runs' },
] as const;

test.describe('the agents Views menu, and the old paths', () => {
    test('reaches every destination through the menu', async ({ page }) => {
        const tenantSlug = await loginAndGetTenant(page);
        // Scoped to `main`: these pages have a `loading.tsx`, so Next streams
        // them through a Suspense boundary and under CI load the staging DOM
        // can leave a second, hidden copy of the subtree in the document —
        // harmless to a user, fatal to a bare locator under strict mode.
        const main = page.getByRole('main');

        for (const entry of ENTRIES) {
            await test.step(`the menu reaches ${entry.path}`, async () => {
                // Back to the register before each one, so every destination is
                // reached from the SAME starting point. Without this the fourth
                // entry would be tested from the third's page, and a menu that
                // only worked on the register would still pass.
                await safeGoto(page, `/t/${tenantSlug}/agents`, {
                    waitUntil: 'domcontentloaded',
                });
                await waitForHydration(page).catch(() => {});

                const trigger = main.locator('#agents-views-menu');
                await expect(trigger).toBeVisible({ timeout: 30_000 });
                await trigger.click();

                const item = page.locator(`#${entry.id}`);
                await expect(item).toBeVisible({ timeout: 20_000 });
                await item.click();

                await expect
                    .poll(() => new URL(page.url()).pathname, { timeout: 30_000 })
                    .toBe(`/t/${tenantSlug}${entry.path}`);
                // The destination RENDERED, not merely navigated: a route that
                // resolved to an error boundary would satisfy the URL poll.
                await expect(main).toBeVisible({ timeout: 30_000 });
            });
        }
    });

    test('the menu marks the destination it is on', async ({ page }) => {
        const tenantSlug = await loginAndGetTenant(page);
        const main = page.getByRole('main');

        // On the quarantine page, its own entry is the selected one — the menu
        // says where you are as well as where you can go. Quarantine is the
        // pick because it is the only destination that mounts the menu
        // inside a list-page TOOLBAR rather than a page header, so it also
        // proves the menu survives both host shapes.
        await safeGoto(page, `/t/${tenantSlug}/agents/quarantine`, {
            waitUntil: 'domcontentloaded',
        });
        await waitForHydration(page).catch(() => {});

        const trigger = main.locator('#agents-views-menu');
        await expect(trigger).toBeVisible({ timeout: 30_000 });
        await trigger.click();

        const selected = page.locator('#agents-view-quarantine');
        await expect(selected).toBeVisible({ timeout: 20_000 });
        // The selected tone. Read as a class rather than a role state because
        // a link row has no `aria-pressed` — it is navigation, not a toggle.
        await expect(selected).toHaveClass(/bg-bg-subtle/);
        // …and a sibling is NOT marked, so the assertion above is "this one"
        // rather than "all of them".
        await expect(page.locator('#agents-view-receipts')).not.toHaveClass(
            /bg-bg-subtle/,
        );
    });

    test('every old path redirects to its new home', async ({ page }) => {
        const tenantSlug = await loginAndGetTenant(page);

        for (const { from, to } of REDIRECTS) {
            await test.step(`${from} → ${to}`, async () => {
                await safeGoto(page, `/t/${tenantSlug}${from}`, {
                    waitUntil: 'domcontentloaded',
                });
                await expect
                    .poll(() => new URL(page.url()).pathname, { timeout: 30_000 })
                    .toBe(`/t/${tenantSlug}${to}`);
                // The target actually rendered. A redirect into a 404 or an
                // error boundary would satisfy the pathname poll above, and
                // that is the failure a shim is most likely to have.
                await expect(page.getByRole('main')).toBeVisible({ timeout: 30_000 });
            });
        }
    });

    test('the retired MCP hub keeps its credential panel and points at the register', async ({
        page,
    }) => {
        // `/admin/mcp` is NOT a shim: its five cards were retired (#2442) and
        // the page was restated as the MCP credential-binding surface, which is
        // the one thing it uniquely carried. So it must still render, must NOT
        // offer the retired cards, and must offer exactly one way onward.
        const tenantSlug = await loginAndGetTenant(page);
        await safeGoto(page, `/t/${tenantSlug}/admin/mcp`, {
            waitUntil: 'domcontentloaded',
        });
        await waitForHydration(page).catch(() => {});
        const main = page.getByRole('main');

        await expect(main.locator('#mcp-agent-credentials')).toBeVisible({
            timeout: 30_000,
        });
        // The retired card grid is GONE. Named by the ids it used to carry, so
        // a card that came back fails here rather than passing a text check.
        for (const id of [
            'mcp-agent-register-card',
            'mcp-agent-proposals-card',
            'mcp-agent-runs-card',
            'mcp-agent-receipts-card',
            'mcp-quarantine-card',
        ]) {
            await expect(main.locator(`#${id}`)).toHaveCount(0);
        }
        // One link onward, to the register.
        const link = main.locator('#mcp-agent-register-link');
        await expect(link).toBeVisible();
        await link.click();
        await expect
            .poll(() => new URL(page.url()).pathname, { timeout: 30_000 })
            .toBe(`/t/${tenantSlug}/agents`);
    });
});
