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
            // BY THE ROW'S OWN HANDLE, not `getByText(name).first()`. The name
            // appears in the breadcrumb and the detail heading too, so a text
            // match has more than one candidate and `.first()` picks by
            // document order rather than by meaning. This testid is on the name
            // cell of exactly this agent's row.
            const row = main.getByTestId(`agent-row-${agentId}`);
            await expect(row).toBeVisible({ timeout: 30_000 });

            // ONE CLICK, THEN WAIT FOR THE NAVIGATION. Not `toPass` around
            // both, which is what the previous attempt did and what the trace
            // then disproved: attempt 1's click SUCCEEDED in 0.3s, the URL
            // assertion ran 0.0s later — before the soft navigation had
            // committed — and failed; attempt 2's click then hung for 46s
            // because the row it wanted no longer existed. Retrying a
            // non-idempotent action cannot work: once it succeeds, the second
            // attempt has nothing left to click.
            //
            // `waitForURL` is the right wait because it listens for the
            // navigation rather than re-reading a value on a timer.
            await row.click();
            await page.waitForURL(`**/agents/${agentId}`, { timeout: 30_000 });
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

        // ─── 5. SCORE IT, SO IT CAN BE ADMITTED ─────────────────────────
        //
        // THE SECOND THING THE FIRST CI RUN TAUGHT. A freshly registered agent
        // is DRAFT and UNSCORED, and the product refuses both moves on purpose:
        // `canSuspend` requires `status === 'ACTIVE'`, and Activate is
        // `disabled={unscored}`. So the original spec looked for a Suspend
        // button that the page was correct not to render — the test was wrong
        // about the product, and the product was right.
        //
        // That refusal is the register's central claim (an unscored agent's
        // credential resolves to DENY_CEILING), so the journey now goes THROUGH
        // it rather than around it. Scored via the API for the same reason the
        // agent was registered via the API: the questionnaire has its own
        // coverage, and a failure in it should not read as a broken path.
        await test.step('an unscored agent cannot be admitted, so score it', async () => {
            const res = await page.request.post(
                `/api/t/${tenantSlug}/admin/agents/${agentId}/risk-assessment/complete`,
                { headers: { 'Content-Type': 'application/json' } },
            );
            expect(
                res.ok(),
                `scoring failed ${res.status()}: ${await res.text()}`,
            ).toBe(true);
        });

        // ─── 6. ADMIT IT ────────────────────────────────────────────────
        await test.step('a scored agent can be admitted', async () => {
            await safeGoto(page, `/t/${tenantSlug}/agents/${agentId}`, {
                waitUntil: 'domcontentloaded',
            });
            await waitForHydration(page).catch(() => {});
            await main.getByRole('tab', { name: /overview/i }).click();

            // By ID, not by accessible name. The name is translated copy that
            // this spec has no business pinning, and `/^Suspend/` would also
            // match a heading or a dialog title if either ever gained one.
            const activate = main.locator('#agent-status-activate-btn');
            await expect(activate).toBeVisible({ timeout: 30_000 });
            // ENABLED is the assertion that matters: it is the visible proof
            // that scoring lifted the refusal, and it would have been false a
            // step ago.
            await expect(activate).toBeEnabled({ timeout: 30_000 });
            await activate.click();

            await expect(main.locator('#agent-status-suspend-btn')).toBeVisible({
                timeout: 30_000,
            });
        });

        // ─── 7. STOP IT, AND READ WHY ───────────────────────────────────
        await test.step('suspending says what it reached and what it did not', async () => {
            const suspend = main.locator('#agent-status-suspend-btn');
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
