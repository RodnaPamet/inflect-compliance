/**
 * An agent profile is drafted and submitted by one person and approved by
 * another, in the product, and the approval is on the audit trail (Step 1b of
 * `docs/claude-agent-sdk-design.md`, #4144).
 *
 * MUTATING, so it runs in its own isolated tenant. Two users in that one
 * tenant: the isolated tenant's OWNER writes and submits the version, and a
 * second member, invited as ADMIN and signed in in a separate browser context,
 * approves it. The author is offered no Approve on their own submission; the
 * rendered tests hold that, and the step below asserts it on the real page too.
 *
 * Agent profiles are on in the E2E environment (`AGENT_PROFILES=1` in
 * `.env.e2e.example`); with them off the Behaviour tab does not exist.
 *
 * One `test()` with `test.step(...)`, because the steps are one sequence: a
 * failed draft must not be reported as a failed approval.
 */
import type { BrowserContext, Page } from '@playwright/test';

import { test, expect } from './fixtures';
import { safeGoto, waitForHydration } from './e2e-utils';

/** Sign in through the credentials form; lands on a dashboard or the tenant picker. */
async function signIn(page: Page, email: string, password: string): Promise<void> {
    const form = page.locator('#credentials-form');
    await form.locator('input[type="email"][name="email"]').waitFor({ state: 'visible', timeout: 30_000 });
    await page.waitForFunction(() => {
        const el = document.querySelector('form');
        return el && Object.keys(el).some((k) => k.startsWith('__reactEvents') || k.startsWith('__reactFiber'));
    }, { timeout: 30_000 });
    await form.locator('input[type="email"][name="email"]').fill(email);
    await form.locator('input[type="password"]').fill(password);
    await form.locator('button[type="submit"]').click();
    await page.waitForURL(/\/(tenants|t\/[^/]+\/dashboard)/, { waitUntil: 'domcontentloaded', timeout: 60_000 });
}

/** Open the agent's Behaviour tab and return the tab panel. */
async function openBehaviour(page: Page, tenantSlug: string, agentId: string) {
    await safeGoto(page, `/t/${tenantSlug}/agents/${agentId}`, { waitUntil: 'domcontentloaded' });
    const main = page.getByRole('main');
    const tab = main.getByRole('tab', { name: 'Behaviour' });
    await waitForHydration(page, '[role="tab"]#tab-behaviour');
    await tab.click();
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    const panel = main.getByRole('tabpanel');
    await expect(panel.locator('[data-testid="agent-behaviour-tab"]')).toBeVisible({ timeout: 30_000 });
    return panel;
}

test.describe('agent behaviour: two people, one approved version', () => {
    test('the author drafts and submits, a second admin approves, and the audit log records it', async ({
        authedPage: page,
        isolatedTenant,
        browser,
    }) => {
        const { tenantSlug, ownerUserId } = isolatedTenant;
        const stamp = Date.now();
        const agentName = `E2E behaviour agent ${stamp}`;
        const reviewerName = `Behaviour Reviewer ${stamp}`;
        const reviewerEmail = `behaviour-reviewer-${stamp}@e2e.test`;
        const reviewerPassword = `RevT3st!${stamp}`;
        const instructions = `Summarise the open risks for the weekly review, grouped by owner. Run ${stamp}.`;

        const agentId = await test.step('register an agent and grant it a tool', async () => {
            const res = await page.request.post(`/api/t/${tenantSlug}/admin/agents`, {
                headers: { 'Content-Type': 'application/json' },
                data: {
                    name: agentName,
                    description: 'Holds an agent profile for the behaviour journey.',
                    autonomyLevel: 1,
                    dataAccessScope: 'READ_TENANT_DATA',
                    reversibility: 'REVERSIBLE',
                    provenance: 'FIRST_PARTY',
                    ownerUserId,
                    classification: {},
                },
            });
            expect(res.ok(), `POST /admin/agents ${res.status()}: ${await res.text()}`).toBe(true);
            const body = (await res.json()) as { id?: string; agent?: { id?: string } };
            const id = (body.id ?? body.agent?.id) as string;
            expect(id).toBeTruthy();
            const grant = await page.request.post(`/api/t/${tenantSlug}/admin/agents/${id}/tools`, {
                headers: { 'Content-Type': 'application/json' },
                data: { toolName: 'list_risks' },
            });
            expect(grant.status(), await grant.text()).toBe(201);
            return id;
        });

        await test.step('a second person joins the workspace as ADMIN', async () => {
            const reg = await page.request.post('/api/auth/register', {
                headers: { 'Content-Type': 'application/json' },
                data: { action: 'register', email: reviewerEmail, password: reviewerPassword, name: reviewerName, orgName: `Reviewer org ${stamp}` },
            });
            expect([200, 409], await reg.text()).toContain(reg.status());
            const invite = await page.request.post(`/api/t/${tenantSlug}/admin/invites`, {
                headers: { 'Content-Type': 'application/json' },
                data: { email: reviewerEmail, role: 'ADMIN' },
            });
            expect(invite.status(), await invite.text()).toBe(201);
            const invitePath = ((await invite.json()) as { url: string }).url;

            const ctx: BrowserContext = await browser.newContext();
            try {
                const rp = await ctx.newPage();
                await safeGoto(rp, invitePath, { waitUntil: 'domcontentloaded' });
                await rp.waitForSelector('a[href*="start-signin"]', { timeout: 30_000 });
                await rp.click('a[href*="start-signin"]');
                await rp.waitForURL(/\/login/, { timeout: 30_000 });
                await signIn(rp, reviewerEmail, reviewerPassword);
                expect(rp.url()).not.toContain('/no-tenant');
            } finally {
                await ctx.close();
            }
        });

        await test.step('the author writes the first version and submits it', async () => {
            const panel = await openBehaviour(page, tenantSlug, agentId);
            await expect(panel.locator('[data-testid="behaviour-in-force-empty"]')).toBeVisible();
            await panel.locator('[data-testid="behaviour-write"]').click();

            const editor = page.locator('[data-testid="behaviour-editor"]');
            await expect(editor).toBeVisible({ timeout: 15_000 });
            await editor.locator('#behaviour-instructions').fill(instructions);
            await editor.locator('#behaviour-tools').click();
            await page.getByRole('option', { name: /^\s*list_risks\s*$/ }).click();
            // Close the picker by clicking back into the form, not Escape,
            // which the sheet would also take as "close".
            await editor.locator('#behaviour-instructions').click();
            await expect(page.getByRole('listbox')).toHaveCount(0);
            await editor.locator('[data-testid="behaviour-editor-save"]').click();
            await expect(editor).toBeHidden({ timeout: 15_000 });

            const open = panel.locator('[data-testid="behaviour-open"]');
            await expect(open).toContainText('Draft', { timeout: 15_000 });
            await expect(open.locator('[data-testid="behaviour-version-1-instructions"]')).toHaveText(instructions);
            await open.locator('[data-testid="behaviour-submit"]').click();
            await expect(open).toContainText('Waiting for review', { timeout: 15_000 });
            // The author is never offered the decision on their own submission.
            await expect(open.locator('[data-testid="behaviour-author-note"]')).toBeVisible();
            await expect(open.locator('[data-testid="behaviour-approve"]')).toHaveCount(0);
        });

        await test.step('the second person approves it', async () => {
            const ctx: BrowserContext = await browser.newContext();
            try {
                const rp = await ctx.newPage();
                await safeGoto(rp, '/login', { waitUntil: 'domcontentloaded', timeout: 60_000 });
                await signIn(rp, reviewerEmail, reviewerPassword);
                const panel = await openBehaviour(rp, tenantSlug, agentId);
                const open = panel.locator('[data-testid="behaviour-open"]');
                await expect(open.locator('[data-testid="behaviour-version-1-instructions"]')).toHaveText(instructions);
                await open.locator('[data-testid="behaviour-approve"]').click();

                const inForce = panel.locator('[data-testid="behaviour-in-force"]');
                await expect(inForce.locator('[data-testid="behaviour-version-1-instructions"]')).toHaveText(instructions, {
                    timeout: 15_000,
                });
                await expect(panel.locator('[data-testid="behaviour-version-1-status"]')).toHaveText('In force');
                // Test run is disabled while no engine runs a profile, and says why.
                await expect(inForce.locator('[data-testid="behaviour-test-run-1-button"]')).toBeDisabled();
                await expect(inForce.locator('[data-testid="behaviour-test-run-1-reason"]')).toContainText('Agent engines');
            } finally {
                await ctx.close();
            }
        });

        await test.step('the approval is on the audit log, by the second person', async () => {
            await safeGoto(page, `/t/${tenantSlug}/admin/audit-log`, { waitUntil: 'domcontentloaded' });
            const table = page.getByRole('main').locator('#audit-log-table');
            await expect(table).toBeVisible({ timeout: 20_000 });
            // The Action column shows the code in words once #4468's display lands;
            // either form identifies the row.
            const row = table.getByRole('row').filter({ hasText: /AGENT_PROFILE_APPROVED|Agent profile approved/ });
            await expect(row).toHaveCount(1, { timeout: 15_000 });
            await expect(row).toContainText(reviewerName);
            await expect(row).toContainText(`Approved version 1 of the profile of agent ${agentName}`);
            await expect(table.getByRole('row').filter({ hasText: /AGENT_PROFILE_SUBMITTED|Agent profile submitted/ })).toHaveCount(1);
        });
    });
});
