import { expect, test } from './fixtures';
import { safeGoto, waitForHydration } from './e2e-utils';

/**
 * E2E — THE ASKING SURFACE IS REACHED FROM THE SIDEBAR AND ANSWERS WITH A
 * NAMED REASON (#3870).
 *
 * Takes `isolatedTenant` / `authedPage`: submitting starts a workflow run, so
 * this writes and must never touch the shared seeded tenant.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * IT CLICKS. IT DOES NOT `goto`.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The sibling `/agents` spec records the reason and it applies doubly here: a
 * `page.goto('/agents/ask')` passes whether or not the sidebar entry exists.
 * That entry is the whole point of this page's inbound link — the Views menu
 * lives on an admin-gated page, so a reader-level surface reachable only from
 * there is unreachable in practice. Clicking is what tests it.
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
 * carry a code-shaped token, which is exactly what distinguishes this from the
 * "something went wrong" the server deliberately does not send.
 *
 * That makes this an end-to-end proof of the whole chain — sidebar entry, page,
 * POST route, rate-limit wrapper, usecase, resolver, named refusal, rendered
 * alert — without depending on configuration it does not control.
 */
test('reached from the sidebar, and a refusal arrives with its named reason', async ({
    authedPage,
    isolatedTenant,
}) => {
    await safeGoto(authedPage, `/t/${isolatedTenant.tenantSlug}/controls`, {
        waitUntil: 'domcontentloaded',
    });

    // THE INBOUND LINK, exercised — by the `nav-<slug>` testid every sibling
    // spec uses, not by its accessible name. Three reasons, each one a way the
    // first draft of this line failed or could:
    //
    //   * HYDRATION. The sidebar is OUTSIDE `main`, so the default hydration
    //     wait watches a subtree unrelated to the thing being clicked. A click
    //     landing before the App Router has hydrated does nothing at all, and
    //     the symptom is a URL that never changes — which is exactly what CI
    //     reported while the page itself was fine.
    //   * THE NAME IS NOT A KEY. `nav.agentsAsk` is the string "Ask", and so
    //     is `assistant.send`. Selecting on display text makes this spec fail
    //     the day a second affordance is labelled the same way or this one is
    //     relabelled, neither of which is a regression in what is claimed.
    //   * `nav-ask` IS the href. `<NavItem>` derives it as the last segment of
    //     `/t/<slug>/agents/ask`, so the locator cannot drift away from the
    //     route it is asserting reaches.
    await waitForHydration(authedPage, '[data-testid="nav-ask"]');
    const navEntry = authedPage
        .getByRole('navigation')
        .locator('[data-testid="nav-ask"]')
        .first();
    await expect(navEntry).toBeVisible({ timeout: 30_000 });
    await navEntry.click();
    // `expect.poll` on the pathname rather than `toHaveURL`, whose 5s default
    // is shorter than a cold client-side navigation under two CI workers.
    await expect
        .poll(() => new URL(authedPage.url()).pathname, { timeout: 30_000 })
        .toBe(`/t/${isolatedTenant.tenantSlug}/agents/ask`);

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
    // A CODE, not a generic apology. Upper-snake because that is the shape
    // every refusal in this path carries, and its presence is the difference
    // between a person who can act and a support ticket.
    await expect(alert).toContainText(/[A-Z][A-Z_]{6,}/);
});
