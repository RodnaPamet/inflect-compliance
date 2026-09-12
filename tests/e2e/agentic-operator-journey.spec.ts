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
import en from '../../messages/en.json';

test.describe('an operator finds, registers, grants, and stops an agent', () => {
    test('the whole path holds together', async ({ authedPage: page, isolatedTenant }) => {
        const { tenantSlug, ownerUserId } = isolatedTenant;
        const main = page.getByRole('main');
        const agentName = `E2E journey agent ${Date.now()}`;

        // ─── 1. FIND IT FROM THE DASHBOARD ──────────────────────────────
        const agentId = await test.step('the sidebar reaches the register', async () => {
            await safeGoto(page, `/t/${tenantSlug}/dashboard`, { waitUntil: 'domcontentloaded' });
            // The sidebar is OUTSIDE `main`, so the default selector would be
            // waiting on a subtree that has nothing to do with the thing being
            // clicked. Same class of bug as step 3 — see the note there.
            await waitForHydration(page, '[data-testid="nav-agents"]');

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

            // HYDRATION OF `main` IS NOT HYDRATION OF THE TABLE, and that gap is
            // what failed this step three times in CI.
            //
            // `waitForHydration`'s default selector is `main`, which the root
            // layout hydrates almost immediately — long before a nested
            // virtualised table attaches its row handlers. So the wait returned
            // true, the click landed on inert markup, and `onRowClick` never
            // ran. The server log proves it rather than suggests it: for the
            // failing attempt's tenant there is no request to
            // `/admin/agents/{agentId}` at ALL, and the agent id appears exactly
            // once in the whole run — the POST that created it. A click that
            // navigated would have left a request behind.
            //
            // `[cursor=pointer]` on the row in the DOM snapshot is not evidence
            // against this: that className is computed during render, so it is
            // in the server-rendered HTML whether or not React has attached
            // anything to it.
            //
            // So: wait for the ROW ITSELF to carry React's fibers — the element
            // this step is about to click, whose ancestor owns the handler.
            // Hydration is top-down, so fibers on this node mean the row above
            // it is live.
            //
            // NOT `.catch(() => {})`. A table that never hydrates is the real
            // failure and should say so here, rather than 30s later as a
            // navigation that never happened.
            await waitForHydration(page, `[data-testid="agent-row-${agentId}"]`);

            // The cell is the anchor for the WAIT above (it is what hydrates);
            // the click target is the <tr> below. Kept as one assertion that
            // the row arrived at all, so a missing row fails here rather than
            // as a click on nothing.
            await expect(main.getByTestId(`agent-row-${agentId}`)).toBeVisible({
                timeout: 30_000,
            });

            // THE <tr>, AT A COORDINATE IN ITS FIRST CELL.
            //
            // `tests/rendered/agent-register-row-open.test.tsx` already proves
            // this contract and passes — it clicks `cell.closest('tr')`, and
            // its comment says why: the row carries the handler, and reaching
            // for it explicitly beats relying on bubbling from whichever
            // element the name happens to sit in. Three CI failures clicked the
            // CELL instead, so this now matches the target the passing test
            // uses.
            //
            // The position matters. Playwright clicks an element's CENTRE with
            // real coordinates, and the centre of a full-width row lands in the
            // middle columns — where the authority-tier cell renders a "More
            // information" BUTTON. `isClickOnInteractiveChild` walks up from
            // the event target and RETURNS EARLY on a button, skipping
            // `onRowClick` entirely. Clicking near the left edge keeps the
            // press inside the name cell, which holds no interactive child.
            const rowEl = main.locator(`tr:has([data-testid="agent-row-${agentId}"])`);
            await expect(rowEl).toBeVisible({ timeout: 30_000 });
            await rowEl.click({ position: { x: 12, y: 12 } });

            try {
                await page.waitForURL(`**/agents/${agentId}`, { timeout: 30_000 });
            } catch (err) {
                // If it STILL does not navigate, fail with the state of the DOM
                // rather than with a bare timeout. Three rounds of this were
                // spent inferring from a timeout what one `elementFromPoint`
                // would have said outright.
                const diag = await page.evaluate((id: string) => {
                    const cell = document.querySelector(`[data-testid="agent-row-${id}"]`);
                    const tr = cell?.closest('tr') ?? null;
                    const rect = tr?.getBoundingClientRect() ?? null;
                    const hit = rect
                        ? document.elementFromPoint(rect.left + 12, rect.top + 12)
                        : null;
                    return JSON.stringify({
                        cellFound: Boolean(cell),
                        rowFound: Boolean(tr),
                        // The decisive one: React attaches these on hydration,
                        // so their absence means the handler was never wired.
                        rowReactKeys: tr
                            ? Object.keys(tr).filter((k) => k.startsWith('__react'))
                            : [],
                        rowRect: rect
                            ? { x: rect.left, y: rect.top, w: rect.width, h: rect.height }
                            : null,
                        topmostAtClickPoint: hit
                            ? `${hit.tagName}#${hit.id}.${String(hit.className).slice(0, 60)}`
                            : null,
                        pathname: window.location.pathname,
                    });
                }, agentId);
                throw new Error(`row click did not navigate — DOM at failure: ${diag}`);
            }
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
            // The tab strip, not `main` — the control being clicked. Same
            // reasoning as step 3.
            await waitForHydration(page, '[role="tab"]');
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

            // FROM THE CATALOGUE, not from remembered wording. My regex looked
            // for "next request" and "already running"; the product says
            // "refused at the next registration request" and "A run already
            // under way is not affected" — which is BETTER copy, and precisely
            // the suspension semantics 2/4 corrected (a dispatch control, so it
            // does not reach work already running). The test was wrong about
            // the product for the second time in this file.
            //
            // Either variant is accepted because which one renders depends on
            // whether the workspace enforces registration, and that is the
            // fixture's business rather than this step's.
            const scope = en.admin.agentDetail.overview;
            const dialogText = await dialog.innerText();
            expect(
                dialogText.includes(scope.suspendScope) ||
                    dialogText.includes(scope.suspendScopeUnenforced),
                `the dialog did not explain suspension's scope. Got: ${dialogText}`,
            ).toBe(true);
            // The load-bearing half, asserted on its own so a copy edit that
            // dropped it could not pass by matching the other variant.
            expect(dialogText).toContain('A run already under way is not affected');

            // By ID. `suspendAction` and `suspendConfirm` are both "Suspend
            // agent", so a name regex is one DOM change away from matching the
            // trigger instead of the confirm — and it is translated copy this
            // step has no business pinning.
            await dialog.locator('#agent-status-suspend-confirm').click();

            // The ANSWER, which is the point of the step: the header states the
            // standing, and the page says what that standing means rather than
            // only badging it.
            await expect(main.getByText(/SUSPENDED/i).first()).toBeVisible({ timeout: 30_000 });
        });
    });
});
