/**
 * E2E — the agent detail page (`/t/:slug/agents/:agentId`).
 *
 * Everything that governs an autonomous agent — its policy card, its tool
 * grants, its ASI coverage, its circuit breaker and, above all, its KILL
 * SWITCH — was reachable only by `curl` until this page existed. Until this
 * spec, "reachable from the UI" was a grep result: no E2E opened any agentic
 * surface at all, so a route that 404s, a tab bar that paints five tabs, or a
 * kill switch that never renders for the operator entitled to pull it would
 * every one of them have shipped green.
 *
 * The claims, in the order an operator meets them:
 *
 *   1. the register renders, and an agent nobody has assessed appears there as
 *      "Unscored" — never as a tier, never as a dash. NULL means deny;
 *   2. the detail page opens for that agent and names it;
 *   3. all SIX governing tabs are present, in order, and selecting one swaps
 *      the panel beneath. A tab bar whose panel does not move is six labels
 *      over one screen, and five of the six surfaces would still be curl-only;
 *   4. the kill switch sits in the page HEADER for an operator holding
 *      `admin.agent_kill_switch`, and pressing it opens the dialog that
 *      commits it. This is the assertion the page exists for — the control
 *      that stops an agent mid-run is the one that must never be curl-only.
 *      Its companion negative is "Resume agent" is absent: the two controls
 *      are exclusive (`AgentKillSwitchAction` renders one or the other), and
 *      offering "Resume" on an agent nothing has stopped tells an on-call
 *      operator a halt is in force when none is;
 *   5. the back affordance returns to the register it came from.
 *
 * Step 2 is the load-bearing one, and it was written against a defect this spec
 * found. The register HAD no row navigation: `AgentsClient` never passed
 * `onRowClick` to `EntityListPage` and no cell rendered a link, so nothing in
 * the product navigated here — the page was reachable only by typing the URL,
 * which made "we shipped a detail page" true and "an operator can open it"
 * false. That is fixed, and this spec now opens the page the way a user does,
 * by clicking the row. Keep it that way: a `page.goto` here would still pass
 * while the register offered no route at all, which is precisely the state
 * that shipped.
 *
 * Seed + isolation: `prisma/seed.ts` seeds the agent-risk-assessment
 * questionnaire and NO registered agent, so there is no seeded agent to open
 * and no seeded row to assert on. The spec provisions its own tenant
 * (`isolatedTenant` — its OWNER holds all four agent keys by default) and
 * registers one agent through the production POST, so every fact asserted
 * below is one this test created rather than one the seed happens to hold.
 */
import type { Page } from '@playwright/test';

import { test, expect } from './fixtures';
import { safeGoto, waitForHydration } from './e2e-utils';

/**
 * The six tabs, exactly as `AgentDetailClient` declares them and `en.json`
 * words them. Asserted as an ordered list rather than one-by-one so a tab that
 * silently disappears — the policy card is `disabled`, not hidden, precisely
 * because "a missing tab says the product does not have it" — fails here.
 */
const TAB_LABELS = [
    'Overview',
    'Risk assessment',
    'Policy card',
    'Tools',
    'ASI coverage',
    'Circuit breaker',
];

/**
 * Register one agent through the production POST — the same route
 * `NewAgentModal` submits — and return its id.
 *
 * Through the API rather than the modal because this spec is about the DETAIL
 * page: driving the create form's six controls would put the register's modal
 * on the failure path of every assertion below. `page.request` carries the
 * signed-in session's cookies (the `seedAsset` idiom in `issues.spec.ts`).
 *
 * All three exposure axes are stated explicitly because the schema refuses to
 * default them — "an omitted axis must fail, not score zero" — and no
 * `riskTier` is sent because no caller can state one: the agent arrives
 * UNSCORED, which is what claim 1 reads back off the register.
 */
async function registerAgent(
    page: Page,
    tenantSlug: string,
    ownerUserId: string,
    name: string,
): Promise<string> {
    const res = await page.request.post(`/api/t/${tenantSlug}/admin/agents`, {
        headers: { 'Content-Type': 'application/json' },
        data: {
            name,
            description: 'Registered by tests/e2e/agent-detail.spec.ts.',
            ownerUserId,
            autonomyLevel: 3,
            dataAccessScope: 'READ_TENANT_DATA',
            reversibility: 'REVERSIBLE',
            provenance: 'FIRST_PARTY',
            // The AI-Act register entry is authored alongside the agent by the
            // deterministic classifier; an empty answer set is a legal input
            // and keeps this spec off the classification's branches.
            classification: {},
        },
    });
    if (!res.ok()) {
        const body = await res.text().catch(() => '<unreadable body>');
        throw new Error(
            `registerAgent: POST /api/t/${tenantSlug}/admin/agents failed ` +
                `(status ${res.status()}): ${body.slice(0, 400)}`,
        );
    }
    const created = (await res.json()) as { id: string };
    if (!created?.id) {
        throw new Error(
            'registerAgent: register response carried no id — check the POST ' +
                'response shape in src/app/api/t/[tenantSlug]/admin/agents/route.ts.',
        );
    }
    return created.id;
}

test.describe('Agent detail page', () => {
    test('register → agent detail: six tabs, the kill switch, and back', async ({
        authedPage: page,
        isolatedTenant,
    }) => {
        const { tenantSlug, ownerUserId } = isolatedTenant;
        const agentName = `E2E Agent ${Date.now().toString(36)}`;
        const agentId = await registerAgent(page, tenantSlug, ownerUserId, agentName);

        // Every locator is scoped to `<main>`: the `/admin/*` segment has a
        // `loading.tsx`, so Next streams these pages through a Suspense
        // boundary and under CI load the staging DOM can leave a second,
        // hidden copy of the subtree in the document — harmless to a user,
        // fatal to a bare locator under Playwright strict mode. Same guard as
        // `risk-matrix-admin.spec.ts`.
        const main = page.getByRole('main');

        await test.step('the register renders the agent, unscored', async () => {
            await safeGoto(page, `/t/${tenantSlug}/agents`, {
                waitUntil: 'domcontentloaded',
            });
            await page.waitForLoadState('networkidle').catch(() => {});

            // A regex, not the exact accessible name: the title node carries a
            // decorative <Robot/> beside the copy, and an icon that ever gains
            // a <title> would change the accname without changing the sentence
            // an operator reads.
            await expect(
                main.getByRole('heading', { name: /Agent register/ }),
            ).toBeVisible({ timeout: 30_000 });

            // The row for the agent this test created — not "the first row",
            // which would pass against somebody else's data.
            const nameCell = main.locator(`[data-testid="agent-row-${agentId}"]`);
            await expect(nameCell).toBeVisible({ timeout: 20_000 });
            await expect(nameCell).toContainText(agentName);

            // NULL is not a low tier and not a dash. A freshly registered agent
            // is unscored by construction — the register exists because that is
            // the state you most want to see.
            // `hasText`, not `has: nameCell`: an inner locator passed to
            // `has` is re-queried RELATIVE to each row, so a `main`-rooted one
            // could never match inside a `<tr>` and the filter would quietly
            // select nothing.
            const row = main.getByRole('row').filter({ hasText: agentName });
            await expect(row).toContainText('Unscored');
        });

        await test.step('the detail page opens and names the agent', async () => {
            // SINGLE click since AGENTIC UI 1/4 (#2434), and still not a
            // `goto`.
            //
            // It used to be `dblclick`, because the DataTable primitive gives
            // single click to SELECTION whenever selection is enabled — the
            // default, which the register did not turn off — and fires
            // `onRowClick` on double click as the unambiguous open gesture.
            // The register now passes `selectionEnabled: false`: there are no
            // batch actions, so the checkbox was a control that did nothing
            // AND it took the single click away from the row's real action.
            // With selection off, one click opens, which is what the row's
            // trailing chevron has been advertising all along.
            //
            // And a click at all rather than `page.goto`, because a goto would
            // pass even if the register offered no route to this page — which
            // is the state that actually shipped before the row action landed.
            const targetRow = main.getByRole('row').filter({ hasText: agentName });
            await expect(targetRow).toBeVisible({ timeout: 20_000 });
            await targetRow.click();
            await page.waitForURL(`**/t/${tenantSlug}/agents/${agentId}`, {
                timeout: 20_000,
            });
            await page.waitForLoadState('networkidle').catch(() => {});
            await waitForHydration(page).catch(() => {});

            const header = main.locator('[data-testid="entity-detail-header"]');
            await expect(header).toBeVisible({ timeout: 30_000 });
            await expect(header.getByRole('heading', { level: 1 })).toContainText(
                agentName,
                { timeout: 20_000 },
            );
            // The header's own answer to "has anyone assessed this agent" —
            // rendered from the server payload, so it is a different renderer
            // from the register column above, and both must say the same thing.
            await expect(
                main.locator('[data-testid="page-header-meta"]'),
            ).toContainText('Unscored');
        });

        await test.step('the kill switch is in the header for a permitted operator', async () => {
            const actions = main.locator('[data-testid="page-header-actions"]');
            const stopAgent = actions.getByRole('button', { name: 'Stop agent' });
            await expect(stopAgent).toBeVisible({ timeout: 20_000 });

            // The exclusive twin. Nothing has stopped this agent, so the resume
            // control must not be on the page: it would tell an on-call
            // operator a halt is in force when none is. The assertion above is
            // its positive companion — a header that rendered nothing at all
            // cannot satisfy both.
            await expect(actions.getByRole('button', { name: /^Resume/ })).toHaveCount(0);

            // Present AND wired: the control the PR exists for opens the dialog
            // that commits the stop, and that dialog demands a reason — a stop
            // with no stated reason is an outage nobody can review afterwards.
            // The dialog is a Radix portal, so it is located off `page`, not
            // `main`.
            await stopAgent.click();

            // Scoped by the reason field, NOT a bare `getByRole('dialog')`.
            //
            // The app's navigation drawer sits permanently in the DOM as
            // `<div role="dialog" aria-modal="true" data-testid="nav-drawer">`,
            // closed only by a `-translate-x-full` transform — which Playwright
            // still reports as VISIBLE. It does not collide while the modal is
            // open, because Radix marks background content `aria-hidden` and
            // that removes the drawer from the accessibility tree; the moment
            // the modal closes the drawer reappears to the query, so a bare
            // `toBeHidden()` on `getByRole('dialog')` can never pass. Filtering
            // on a control only this modal owns keeps the locator pointed at
            // the thing under test in both states.
            const dialog = page
                .getByRole('dialog')
                .filter({ has: page.locator('#agent-kill-reason') });
            await expect(dialog).toBeVisible({ timeout: 15_000 });
            await expect(dialog).toContainText('Stop this agent');
            await expect(dialog.locator('#agent-kill-reason')).toBeVisible();

            // Closed again without committing: this spec proves reachability,
            // and a real kill would leave the banner over every later step.
            await dialog.getByRole('button', { name: 'Cancel' }).click();
            await expect(dialog).toHaveCount(0, { timeout: 10_000 });
        });

        await test.step('six tabs, and selecting one swaps the panel', async () => {
            const tabs = main.getByRole('tablist').getByRole('tab');
            await expect(tabs).toHaveText(TAB_LABELS, { timeout: 20_000 });

            const panel = main.getByRole('tabpanel');
            const overviewTab = main.getByRole('tab', { name: 'Overview' });
            const breakerTab = main.getByRole('tab', { name: 'Circuit breaker' });

            await expect(overviewTab).toHaveAttribute('aria-selected', 'true');
            await expect(panel).toHaveAttribute('aria-labelledby', 'tab-overview');
            // Content only the detail page has: the governing profile the
            // register cannot show. It also proves the panel is hydrated and
            // its read succeeded, so the click below lands on a live handler.
            await expect(panel).toContainText('Governing profile', { timeout: 30_000 });

            await breakerTab.click();

            await expect(breakerTab).toHaveAttribute('aria-selected', 'true');
            await expect(overviewTab).toHaveAttribute('aria-selected', 'false');
            await expect(panel).toHaveAttribute('aria-labelledby', 'tab-breaker');
            // The panel really swapped rather than the tab bar merely restyling
            // itself. Negative, with the three positive assertions above it
            // from the same render as its companions — and the breaker panel's
            // own copy is deliberately NOT asserted: it branches on whether the
            // detector has a baseline yet, which no fresh tenant determines.
            await expect(panel).not.toContainText('Governing profile');
        });

        await test.step('the back affordance returns to the register', async () => {
            const back = main.locator('[data-testid="page-header-back"]');
            await expect(back).toBeVisible();
            // The href, not the label: the label is "Agents" on this cold open
            // (the canonical parent) and varies when an in-tab referrer sends
            // the operator here, and the destination is the register either way
            // — which is the promise being pinned.
            await expect(back).toHaveAttribute('href', `/t/${tenantSlug}/agents`);

            await back.click();
            await expect
                .poll(() => new URL(page.url()).pathname, { timeout: 30_000 })
                .toBe(`/t/${tenantSlug}/agents`);
            await expect(
                main.locator(`[data-testid="agent-row-${agentId}"]`),
            ).toBeVisible({ timeout: 30_000 });
        });
    });
});
