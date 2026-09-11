/**
 * E2E — `/agents` IS A STANDARD LIST PAGE, REACHED FROM THE SIDEBAR.
 *
 * MUTATING: it registers an agent. So it takes the `isolatedTenant` /
 * `authedPage` fixture and gets a fresh, EMPTY tenant of its own — never the
 * shared seeded one. A write into the shared tenant is how a spec becomes
 * order-dependent, and this one writes.
 *
 * The two claims that make the whole prompt real:
 *
 *   1. THE SIDEBAR REACHES IT IN ONE CLICK. Before this, the agent register
 *      was at `/admin/agents` and the entire agentic feature was reachable
 *      through exactly one thing: a pill labelled "MCP" on the admin landing
 *      page — two clicks, behind an acronym. A `page.goto('/agents')` would
 *      pass whether or not the sidebar entry exists, which is why this spec
 *      clicks.
 *
 *   2. AN AGENT OPENS IN ONE MORE CLICK. Single, not double: the register
 *      passes `selectionEnabled: false` (#2434), so the row's action is not
 *      competing with a selection gesture any more.
 *
 * Everything is scoped to `getByRole('main')`. These pages have a
 * `loading.tsx`, so Next streams them through a Suspense boundary and under CI
 * load the staging DOM can leave a second, hidden copy of the subtree in the
 * document — harmless to a user, fatal to a bare locator under strict mode.
 * The table is selected as `#agents-table`, which exists because the page
 * passes `data-testid` to the DataTable (that prop IS the id setter).
 */
import { test, expect } from './fixtures';
import { safeGoto, waitForHydration } from './e2e-utils';

test.describe('the agent register, reached from the sidebar', () => {
    test('one click from the sidebar, one more into an agent', async ({
        authedPage: page,
        isolatedTenant,
    }) => {
        const { tenantSlug, ownerUserId } = isolatedTenant;
        const main = page.getByRole('main');
        const agentName = `E2E reconciler ${Date.now()}`;

        // ─── Register an agent through the API ──────────────────────────
        //
        // The API, not the modal: this spec is about the REGISTER page and the
        // navigation into it, and driving the create form would make a failure
        // in the form read as a failure in the routing. The form has its own
        // coverage. The API path is unchanged by the move — it stays at
        // `/api/t/:slug/admin/agents`, deliberately (see the page's docstring).
        const agentId = await test.step('register an agent', async () => {
            // The AI-system link is REQUIRED — every agent is an entry in the
            // EU AI Act register — so `registerAgent` authors both in one
            // transaction from this single payload.
            const res = await page.request.post(`/api/t/${tenantSlug}/admin/agents`, {
                headers: { 'Content-Type': 'application/json' },
                data: {
                    name: agentName,
                    description: 'Reconciles control status against evidence.',
                    autonomyLevel: 3,
                    dataAccessScope: 'READ_TENANT_DATA',
                    reversibility: 'COMPENSABLE',
                    provenance: 'FIRST_PARTY',
                    ownerUserId,
                    classification: {},
                },
            });
            expect(
                res.ok(),
                `POST /api/t/${tenantSlug}/admin/agents failed ${res.status()}: ` +
                    `${await res.text()}`,
            ).toBe(true);
            const body = (await res.json()) as { id?: string; agent?: { id?: string } };
            const id = body.id ?? body.agent?.id;
            expect(id, `no agent id in the create response: ${JSON.stringify(body)}`)
                .toBeTruthy();
            return id as string;
        });

        // ─── The sidebar, in ONE click ──────────────────────────────────
        await test.step('the sidebar entry reaches the register in one click', async () => {
            await safeGoto(page, `/t/${tenantSlug}/dashboard`, {
                waitUntil: 'domcontentloaded',
            });
            await waitForHydration(page).catch(() => {});

            // The nav row by its stable `data-testid` — `nav-<slug>`, derived
            // from the href's last segment by `<NavItem>`. Scoped to the
            // navigation landmark so the dashboard's own links cannot satisfy
            // it: the claim is that the SIDEBAR reaches the register.
            const navEntry = page
                .getByRole('navigation')
                .locator('[data-testid="nav-agents"]')
                .first();
            await expect(navEntry).toBeVisible({ timeout: 30_000 });
            // The singular noun, from `nav.agents` — the plural-key /
            // singular-value shape every sibling entity key uses.
            await expect(navEntry).toContainText('Agent');

            await navEntry.click();
            await expect
                .poll(() => new URL(page.url()).pathname, { timeout: 30_000 })
                .toBe(`/t/${tenantSlug}/agents`);
        });

        // ─── The page is a standard list page ───────────────────────────
        await test.step('the register is the main table, with its KPI strip', async () => {
            await page.waitForLoadState('networkidle').catch(() => {});
            // A regex, not the exact accessible name: the title node carries a
            // decorative <Robot/> beside the copy, and an icon that ever gained
            // a <title> would change the accname without changing the sentence
            // an operator reads.
            await expect(main.getByRole('heading', { name: /Agent register/ })).toBeVisible({
                timeout: 30_000,
            });

            const table = main.locator('#agents-table');
            await expect(table).toBeVisible({ timeout: 30_000 });
            // The agent THIS test created — not "the first row", which would
            // pass against somebody else's data even in an isolated tenant.
            await expect(
                table.locator(`[data-testid="agent-row-${agentId}"]`),
            ).toContainText(agentName, { timeout: 20_000 });

            // The four server-side KPI cards. `total` must read 1: this tenant
            // was created empty and this test registered exactly one agent, so
            // a card reading anything else is reading the wrong population.
            await expect(main.locator('#agents-kpi-total')).toHaveText('1', {
                timeout: 20_000,
            });
            // …and `unscored` must read 1 too, because a freshly registered
            // agent is UNSCORED by construction — the register exists because
            // that is the state you most want to find.
            await expect(main.locator('#agents-kpi-unscored')).toHaveText('1');
            for (const id of ['active', 'egress']) {
                await expect(main.locator(`#agents-kpi-${id}`)).toBeVisible();
            }

            // The governance banner renders in every state — including the
            // reassuring one. An empty tenant has no security-settings row, and
            // an absent row reads as ENFORCING (the documented fail direction).
            await expect(
                main.locator('[data-testid="agents-governance-banner"]'),
            ).toBeVisible();
        });

        await test.step('no dead checkbox on the rows', async () => {
            // The register has no batch actions, so the select column would be
            // a control that does nothing — and it would take the single click
            // the next step depends on.
            const table = main.locator('#agents-table');
            await expect(table.locator('input[type="checkbox"]')).toHaveCount(0);
        });

        // ─── One more click opens the agent ─────────────────────────────
        await test.step('a single click on the row opens that agent', async () => {
            const row = main.getByRole('row').filter({ hasText: agentName });
            await expect(row).toBeVisible({ timeout: 20_000 });
            // A click, not a `goto`: a goto would pass even if the register
            // offered no route to the detail page, which is the state that
            // shipped before the row action landed.
            await row.click();
            await page.waitForURL(`**/t/${tenantSlug}/agents/${agentId}`, {
                timeout: 30_000,
            });
            await waitForHydration(page).catch(() => {});

            const header = main.locator('[data-testid="entity-detail-header"]');
            await expect(header).toBeVisible({ timeout: 30_000 });
            await expect(header.getByRole('heading', { level: 1 })).toContainText(
                agentName,
                { timeout: 20_000 },
            );
        });
    });
});
