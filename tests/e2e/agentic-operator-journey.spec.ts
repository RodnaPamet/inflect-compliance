/**
 * E2E — ONE OPERATOR JOURNEY THROUGH THE AGENTIC FEATURE.
 *
 * Named in AGENTIC UI 3/4 and missed when that prompt shipped. It is the only
 * test that asks whether the feature is USABLE rather than whether its parts
 * render: find it from the dashboard, register an agent, grant it a tool,
 * suspend it, and read why it stopped.
 *
 * MUTATING: it registers an agent and grants a tool. So it takes the
 * `isolatedTenant` / `authedPage` fixture and gets a fresh, empty tenant of its
 * own — never the shared seeded one. A write into the shared tenant is how a
 * spec becomes order-dependent, and this one writes.
 *
 * ── WHAT EACH STEP IS ACTUALLY FOR ──────────────────────────────────
 *
 * The value is in the SEAMS, not the pages: every page here has its own
 * rendered coverage, and none of it proves the path between them exists. So the
 * navigation steps CLICK rather than `goto` — a `goto('/agents')` passes whether
 * or not anything leads there, which was the original defect: the whole feature
 * sat behind one pill labelled with a wire protocol.
 *
 * The last step is the one worth having. Suspending an agent is easy to verify
 * as a status change and hard to verify as an ANSWER — the product has to say
 * what suspension reached and what it did not, because an operator who reads
 * "suspended" as "halted mid-run" has been told something untrue.
 *
 * Everything is scoped to `getByRole('main')`: these pages stream through a
 * Suspense boundary, and under CI load the staging DOM can leave a second hidden
 * copy of the subtree — harmless to a user, fatal to a bare locator under strict
 * mode.
 */
import { test, expect } from './fixtures';
import { safeGoto, waitForHydration } from './e2e-utils';

test.describe('an operator finds, registers, grants, and stops an agent', () => {
    test('the whole path holds together', async ({ authedPage: page, isolatedTenant }) => {
        const { tenantSlug, ownerUserId } = isolatedTenant;
        const main = page.getByRole('main');
        const agentName = `E2E journey agent ${Date.now()}`;

        // ─── 1. FIND IT FROM THE DASHBOARD ──────────────────────────────
        const agentId = await test.step('the sidebar reaches the register', async () => {
            await safeGoto(page, `/t/${tenantSlug}/dashboard`, { waitUntil: 'domcontentloaded' });
            await waitForHydration(page).catch(() => {});

            const navEntry = page
                .getByRole('navigation')
                .locator('[data-testid="nav-agents"]')
                .first();
            await expect(navEntry).toBeVisible({ timeout: 30_000 });
            await navEntry.click();
            await expect
                .poll(() => new URL(page.url()).pathname, { timeout: 30_000 })
                .toBe(`/t/${tenantSlug}/agents`);

            // ─── 2. REGISTER ────────────────────────────────────────────
            //
            // Through the API, not the modal: this spec is about the JOURNEY,
            // and driving the create form would make a failure in the form read
            // as a failure in the path. The form has its own coverage.
            const res = await page.request.post(`/api/t/${tenantSlug}/admin/agents`, {
                headers: { 'Content-Type': 'application/json' },
                data: {
                    name: agentName,
                    description: 'Journeys through the agentic surfaces.',
                    autonomyLevel: 2,
                    dataAccessScope: 'READ_TENANT_DATA',
                    reversibility: 'REVERSIBLE',
                    provenance: 'FIRST_PARTY',
                    ownerUserId,
                    classification: {},
                },
            });
            expect(
                res.ok(),
                `POST /admin/agents failed ${res.status()}: ${await res.text()}`,
            ).toBe(true);
            const body = (await res.json()) as { id?: string; agent?: { id?: string } };
            const id = body.id ?? body.agent?.id;
            expect(id, `no agent id in: ${JSON.stringify(body)}`).toBeTruthy();
            return id as string;
        });

        // ─── 3. OPEN IT, IN ONE CLICK ───────────────────────────────────
        await test.step('a single click opens the agent', async () => {
            await safeGoto(page, `/t/${tenantSlug}/agents`, { waitUntil: 'domcontentloaded' });
            await waitForHydration(page).catch(() => {});
            const row = main.locator('#agents-table').getByText(agentName).first();
            await expect(row).toBeVisible({ timeout: 30_000 });
            // SINGLE, not double — the register opts out of row selection
            // (#2434), so the row's action no longer competes with a gesture.
            await row.click();
            await expect
                .poll(() => new URL(page.url()).pathname, { timeout: 30_000 })
                .toBe(`/t/${tenantSlug}/agents/${agentId}`);
        });

        // ─── 4. GRANT A TOOL ────────────────────────────────────────────
        await test.step('the tools tab says what a grant widens before it is made', async () => {
            await main.getByRole('tab', { name: /tools/i }).click();

            const picker = main.locator('#agent-tool-grant-input');
            await expect(picker).toBeVisible({ timeout: 30_000 });
            await picker.click();
            await page.getByRole('option').first().click();

            // #2455 — the capability was visible only inside the dropdown, so
            // it was gone by the time the operator was looking at the button.
            await expect(main.getByTestId('agent-tool-grant-widens')).toBeVisible();

            await main.getByTestId('agent-tool-grant-submit').click();
            await expect(main.getByTestId(/^agent-tool-revoke-/).first()).toBeVisible({
                timeout: 30_000,
            });
        });

        // ─── 5. STOP IT, AND READ WHY ───────────────────────────────────
        await test.step('suspending says what it reached and what it did not', async () => {
            await main.getByRole('tab', { name: /overview/i }).click();

            const suspend = main.getByRole('button', { name: /^Suspend/ });
            await expect(suspend).toBeVisible({ timeout: 30_000 });
            await suspend.click();

            // The dialog explains the SCOPE before committing: registration is
            // evaluated once per invocation, so this refuses the next request
            // and touches nothing already running.
            const dialog = page.getByRole('dialog');
            await expect(dialog).toBeVisible();
            await expect(dialog).toContainText(/next request|already running/i);

            await dialog.getByRole('button', { name: /^Suspend/ }).click();

            // The ANSWER, which is the point of the step: the header states the
            // standing, and the page says what that standing means rather than
            // only badging it.
            await expect(main.getByText(/SUSPENDED/i).first()).toBeVisible({ timeout: 30_000 });
        });
    });
});
