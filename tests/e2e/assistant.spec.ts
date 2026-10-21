/**
 * The in-product assistant — mutating E2E (#3854).
 *
 * ═══ ISOLATION ═══
 *
 * MUTATING, so every test runs against its own fresh tenant via the
 * `isolatedTenant` fixture. The propose journey below CREATES an
 * agent-proposal, and a proposal left in the shared seeded tenant would be
 * visible to every other spec's approval-queue assertions — so this file must
 * never touch it.
 *
 * ═══ ONE ROADMAP DRIFT, RECORDED ═══
 *
 * The roadmap asks this spec to "propose a control". The assistant proposes
 * FINDINGS and RISKS — those are the only two intents in `produceAnswer`
 * (`/\b(create|open|raise|add|log|file)\b.*\bfinding\b/` and the `risk`
 * branch), and there is no control-proposal path to exercise. The journey is
 * therefore driven with a finding, which is the same shape: an intent that
 * queues an agent-proposal for human approval rather than writing anything.
 *
 * ═══ WHAT THE ANSWER COMES FROM HERE ═══
 *
 * No external model is configured in CI, so `resolveFlueModel` refuses and
 * `answerFromToolLoop` returns null — the deterministic keyword router
 * answers instead. That is the real production fallback, not a test seam, and
 * it means these assertions must not depend on model phrasing. They check the
 * transport and the UI contract: that a turn streams, that a proposal renders
 * as queued with a link, and that the link lands on the real queue.
 */

import { randomUUID } from 'node:crypto';
import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

/** Open the assistant from whatever page is currently loaded. */
async function openAssistant(page: Page): Promise<void> {
    const launcher = page.getByTestId('assistant-launcher');
    await expect(launcher).toBeVisible({ timeout: 15000 });
    await expect(launcher).toHaveAttribute('aria-expanded', 'false');
    await launcher.click();
}

/** Ask a question and wait for the turn to finish streaming. */
async function askAssistant(page: Page, question: string): Promise<void> {
    const input = page.getByTestId('assistant-input');
    await expect(input).toBeVisible({ timeout: 15000 });
    await input.fill(question);
    await input.press('Enter');
}

test.describe('the in-product assistant', () => {
    test('is reachable from a list page and answers about this tenant', async ({
        authedPage,
        isolatedTenant,
    }) => {
        // A LIST page, because the assistant's reason for existing is to
        // answer about what is already on screen.
        await authedPage.goto(`/t/${isolatedTenant.tenantSlug}/controls`);
        await expect(authedPage.getByRole('main')).toBeVisible({ timeout: 20000 });

        await openAssistant(authedPage);

        // The first-run view has to say what the assistant can do.
        await expect(authedPage.getByTestId('assistant-empty')).toBeVisible();
        await expect(authedPage.getByTestId('assistant-launcher')).toHaveAttribute(
            'aria-expanded',
            'true',
        );

        await askAssistant(authedPage, 'how many controls do we have?');

        // The ANSWER, not a phase label — a streamed turn that never produces
        // one is the hang this UI is built to make visible.
        await expect(authedPage.getByTestId('assistant-answer')).toBeVisible({ timeout: 30000 });
        const answer = await authedPage.getByTestId('assistant-answer').textContent();
        expect((answer ?? '').trim().length).toBeGreaterThan(0);

        // The page behind it is still MOUNTED — the whole point of a Sheet over
        // a Modal.
        //
        // NOT asserted with `getByRole('main')`: Vaul marks background content
        // `aria-hidden` while the drawer is open, which is correct dialog
        // semantics and removes it from the accessibility tree that `getByRole`
        // queries. The first version of this failed for that reason and read
        // like a product defect.
        //
        // The claim is about the DOM, so it is asserted against the DOM — the
        // landmark is still attached — and then against the behaviour that
        // actually matters: it is visible again once the sheet closes, which a
        // page that had been unmounted or navigated away from could not manage.
        await expect(authedPage.locator('main')).toBeAttached();
        await authedPage.keyboard.press('Escape');
        await expect(authedPage.getByRole('main')).toBeVisible({ timeout: 15000 });
    });

    test('does not appear on a page that has no tenant shell', async ({ authedPage }) => {
        // The launcher mounts in `AppShell`, which unauthenticated and
        // non-tenant surfaces do not render. Asserted on the account page,
        // which is signed-in but outside `/t/<slug>/(app)`.
        await authedPage.goto('/account');
        // Waited on `networkidle` rather than a `main` landmark: `/account` has
        // none, and the first version of this asserted one and failed there —
        // a precondition inventing a requirement the page never had.
        //
        // The wait is still load-bearing. `toHaveCount(0)` is satisfied by a
        // page that has not rendered yet, so without it this test would pass
        // whether or not the launcher is absent, which is the shape of an
        // assertion that cannot fail.
        await authedPage.waitForLoadState('networkidle');
        await expect(authedPage.getByRole('heading').first()).toBeVisible({ timeout: 20000 });
        await expect(authedPage.getByTestId('assistant-launcher')).toHaveCount(0);
    });

    test('a propose-phrased question queues NOTHING when no model is configured', async ({
        authedPage,
        isolatedTenant,
    }) => {
        /**
         * ═══ THIS TEST USED TO EXERCISE THE PROPOSE JOURNEY, AND CANNOT ═══
         *
         * It asked for a finding and asserted the queued block, the
         * review-queue link and the row appearing in the queue. That worked
         * because the KEYWORD branches owned proposing and needed no model.
         *
         * #3882 moved proposing behind the model: it is a propose TOOL the
         * model elects to call. CI configures no external model — deliberately,
         * and `resolveFlueModel` REFUSES rather than substituting one — so the
         * propose journey is now unreachable here. Not broken: unreachable,
         * for the same reason the read path falls back to the keyword router.
         *
         * So the assertion is inverted rather than deleted. Deleting it would
         * quietly drop a coverage claim the roadmap made (#3854); inverting it
         * pins the behaviour that IS reachable, and it is a property worth
         * holding in its own right — a propose-phrased question must not
         * silently become a read that looks like success, and must not queue
         * anything by keyword.
         *
         * The propose journey itself is covered at the usecase level in
         * `tests/unit/ai/assistant-proposes-through-the-loop.test.ts`, where
         * the model seams are mocked and the provider is scripted to LIE about
         * the outcome — a stronger assertion than this e2e ever made, since no
         * real model can be relied on to quarantine anything on cue.
         */
        const uid = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
        const title = `E2E assistant finding ${uid}`;

        await authedPage.goto(`/t/${isolatedTenant.tenantSlug}/controls`);
        await expect(authedPage.getByRole('main')).toBeVisible({ timeout: 20000 });

        await openAssistant(authedPage);
        await askAssistant(authedPage, `raise a finding about ${title}`);

        // It still ANSWERS — the deterministic router runs, so this is not a
        // silent failure dressed up as a policy.
        await expect(authedPage.getByTestId('assistant-answer')).toBeVisible({ timeout: 30000 });

        // And neither proposal block renders, because nothing was proposed.
        await expect(authedPage.getByTestId('assistant-proposal-queued')).toHaveCount(0);
        await expect(authedPage.getByTestId('assistant-proposal-quarantined')).toHaveCount(0);

        // The decisive one: the review queue is empty for this tenant. A
        // keyword branch surviving anywhere would put a row here, and the
        // assertions above would not necessarily catch it — a row can be
        // created without the UI rendering a block for it.
        await authedPage.goto(`/t/${isolatedTenant.tenantSlug}/agents/proposals`);
        await expect(authedPage.getByRole('main')).toBeVisible({ timeout: 20000 });
        await expect(authedPage.getByRole('main')).not.toContainText(title);
    });

    test('closes without disturbing the page, and returns focus to the launcher', async ({
        authedPage,
        isolatedTenant,
    }) => {
        await authedPage.goto(`/t/${isolatedTenant.tenantSlug}/risks`);
        await expect(authedPage.getByRole('main')).toBeVisible({ timeout: 20000 });
        const urlBefore = authedPage.url();

        await openAssistant(authedPage);
        await expect(authedPage.getByTestId('assistant-empty')).toBeVisible();

        // Escape, which is the Sheet's own dismissal rather than a handler
        // this feature added.
        await authedPage.keyboard.press('Escape');

        await expect(authedPage.getByTestId('assistant-launcher')).toHaveAttribute(
            'aria-expanded',
            'false',
            { timeout: 15000 },
        );
        // The assistant never navigates on the user's behalf (#3846), so the
        // URL must be exactly where it was.
        expect(authedPage.url()).toBe(urlBefore);
    });
});
