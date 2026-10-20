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

        // The page behind it is still there — the whole point of a Sheet.
        await expect(authedPage.getByRole('main')).toBeVisible();
    });

    test('does not appear on a page that has no tenant shell', async ({ authedPage }) => {
        // The launcher mounts in `AppShell`, which unauthenticated and
        // non-tenant surfaces do not render. Asserted on the account page,
        // which is signed-in but outside `/t/<slug>/(app)`.
        await authedPage.goto('/account');
        await expect(authedPage.getByRole('main')).toBeVisible({ timeout: 20000 });
        await expect(authedPage.getByTestId('assistant-launcher')).toHaveCount(0);
    });

    test('a proposal renders as queued and its link reaches the real queue', async ({
        authedPage,
        isolatedTenant,
    }) => {
        const uid = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
        const title = `E2E assistant finding ${uid}`;

        await authedPage.goto(`/t/${isolatedTenant.tenantSlug}/controls`);
        await expect(authedPage.getByRole('main')).toBeVisible({ timeout: 20000 });

        await openAssistant(authedPage);
        // Phrased to hit the finding intent: a create/raise verb plus the noun.
        await askAssistant(authedPage, `raise a finding about ${title}`);

        // QUEUED, with the review-queue link. A quarantined proposal renders
        // the other block and carries no link — the two are deliberately
        // distinguishable from the outside.
        const queued = authedPage.getByTestId('assistant-proposal-queued');
        await expect(queued).toBeVisible({ timeout: 30000 });
        await expect(authedPage.getByTestId('assistant-proposal-quarantined')).toHaveCount(0);

        // Follow the deep link rather than navigating by URL, so the thing
        // under test is the href the product rendered.
        await queued.getByRole('link').first().click();

        // `/agents/proposals` is the real queue; `/agent-proposals` is a
        // redirect shim, so a wrong href would bounce through it.
        await expect(authedPage).toHaveURL(
            new RegExp(`/t/${isolatedTenant.tenantSlug}/agents/proposals`),
            { timeout: 30000 },
        );

        // And the proposal the assistant queued is actually listed. Scoped to
        // main so chrome text cannot satisfy it.
        await expect(authedPage.getByRole('main')).toContainText(title, { timeout: 30000 });
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
