import { expect, test } from './fixtures';
import { safeGoto, waitForHydration } from './e2e-utils';

/**
 * E2E — THE ASKING SURFACE ANSWERS WITH A NAMED REASON (#3870), AND IS NOT IN
 * THE SIDEBAR.
 *
 * Takes `isolatedTenant` / `authedPage`: submitting starts a workflow run, so
 * this writes and must never touch the shared seeded tenant.
 *
 * The sidebar's "Ask" entry was removed (owner decision, 2026-11-06). The page
 * stays, reached from the agent-run start form's "ad-hoc question" option and
 * by its URL, so this spec opens it by URL and asserts the entry is gone.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT IS ASSERTED ABOUT THE REFUSAL, AND WHY NOT THE EXACT CODE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * An isolated tenant is EMPTY: no registered agent, and therefore no
 * designated interactive agent. So a question here cannot be answered, and the
 * server refuses. WHICH code it refuses with depends on deployment
 * configuration rather than on this tenant:
 *
 *   `AGENT_INTERACTIVE_RUNS` unset  ->  DEPLOYMENT_NOT_ENABLED
 *   set, with no designation        ->  NO_AGENT_DESIGNATED
 *
 * Both are correct, and the flag defaults off. Pinning either one would make
 * this spec fail the day somebody enables the feature in CI — a test that
 * breaks when the product is switched on is worse than no test.
 *
 * So what is asserted is the PROPERTY M3 actually asks for: a funnel refusal
 * reaches the person WITH ITS NAMED REASON. The alert must appear and must
 * carry the reason for one of those two codes. Since #4629 the reason is said
 * in words rather than as the operator's `CODE: detail`, so the assertion
 * names the two sentences.
 */
test('not in the sidebar, and a refusal arrives with its named reason', async ({
    authedPage,
    isolatedTenant,
}) => {
    // The sidebar no longer offers it. `nav-ask` is the testid `<NavItem>`
    // derives from the `/agents/ask` href, so its absence is the entry's.
    await safeGoto(authedPage, `/t/${isolatedTenant.tenantSlug}/controls`, {
        waitUntil: 'domcontentloaded',
    });
    await waitForHydration(authedPage, '[data-testid="nav-controls"]');
    await expect(authedPage.locator('[data-testid="nav-ask"]')).toHaveCount(0);

    await safeGoto(authedPage, `/t/${isolatedTenant.tenantSlug}/agents/ask`, {
        waitUntil: 'domcontentloaded',
    });

    const main = authedPage.getByRole('main');
    await expect(main.getByRole('heading', { name: 'Ask a question' })).toBeVisible();

    // The button is disabled until there is a question — the idle state the
    // rendered suite pins, confirmed here against the real page.
    const ask = main.getByRole('button', { name: 'Ask' });
    await expect(ask).toBeDisabled();

    await main.getByLabel('Your question').fill('Which controls have no evidence this quarter?');
    await expect(ask).toBeEnabled();
    await ask.click();

    const alert = main.getByRole('alert');
    await expect(alert).toBeVisible();
    // The NAMED reason, not a generic apology: the sentence for
    // DEPLOYMENT_NOT_ENABLED or for NO_AGENT_DESIGNATED, whichever this
    // deployment produces (`agents.ask.refusal.*`).
    await expect(alert).toContainText(/not switched on for this installation|No agent answers questions in this workspace yet/);
});
