/**
 * The Tool Runner engine, chosen and used through the product (Step 2c of
 * `docs/claude-tool-runner-design.md`, #4150).
 *
 * MUTATING, so it runs in its own isolated tenant. Its OWNER chooses the Tool
 * Runner engine on the AI features page, then writes and submits a profile
 * version. A second member, invited as ADMIN in a separate browser context,
 * approves it and presses Test run, and the run appears on the agent's Runs
 * tab under its Test-run key.
 *
 * WHERE THIS STOPS, by owner decision (2026-10-29, on #4150): the E2E harness
 * runs no worker and has no model, so a Tool Runner run is queued and stays
 * running here. That the run completes, read-only, with MODEL_CALL and
 * TOOL_CALL steps is proved by `tests/integration/agent-profile-test-run.test.ts`,
 * which drives the same start path and the worker's own body on a real
 * database with a fake model.
 *
 * Needs `AGENT_DRIVER_TOOL_RUNNER=1` and `AGENT_PROFILES=1`, both in
 * `.env.e2e.example`. One `test()` with `test.step(...)`, because the steps are
 * one sequence.
 */
import type { BrowserContext, Page } from '@playwright/test';

import { test, expect } from './fixtures';
import { safeGoto, waitForHydration } from './e2e-utils';
import en from '../../messages/en.json';

const ENGINES = en.admin.agentEngines;
const BEHAVIOUR = en.agents.behaviour;

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

test.describe('the Tool Runner engine: chosen, then a profile test-run', () => {
    test('an owner chooses the engine, a second admin approves a version and starts its Test run', async ({
        authedPage: page,
        isolatedTenant,
        browser,
    }) => {
        const { tenantSlug, ownerUserId } = isolatedTenant;
        const stamp = Date.now();
        const reviewerEmail = `test-run-reviewer-${stamp}@e2e.test`;
        const reviewerPassword = `RevT3st!${stamp}`;
        const instructions = `Summarise the open risks for the weekly review. Run ${stamp}.`;
        const api = (path: string) => `/api/t/${tenantSlug}${path}`;

        const agentId = await test.step('an active, scored agent granted one read tool', async () => {
            const res = await page.request.post(api('/admin/agents'), {
                headers: { 'Content-Type': 'application/json' },
                data: {
                    name: `E2E test-run agent ${stamp}`,
                    description: 'Runs a profile Test run on the Tool Runner engine.',
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
            // The operator journey's order: grant, score, then activate.
            for (const [path, data] of [
                [`/admin/agents/${id}/tools`, { toolName: 'list_risks' }],
                [`/admin/agents/${id}/risk-assessment/complete`, undefined],
                [`/admin/agents/${id}/status`, { status: 'ACTIVE' }],
            ] as const) {
                const r = await page.request.post(api(path), { headers: { 'Content-Type': 'application/json' }, data });
                expect(r.ok(), `POST ${path} ${r.status()}: ${await r.text()}`).toBe(true);
            }
            return id;
        });

        await test.step('the owner chooses the Tool Runner engine', async () => {
            await safeGoto(page, `/t/${tenantSlug}/admin/ai-features`, { waitUntil: 'domcontentloaded' });
            const section = page.locator('#agent-engines');
            await expect(section).toHaveAttribute('data-control', 'editable', { timeout: 30_000 });
            await section.getByRole('radio', { name: new RegExp(`^${ENGINES.engine.TOOL_RUNNER.name}`) }).click();
            const dialog = page.getByRole('dialog');
            await expect(dialog).toContainText(ENGINES.confirmTitle.TOOL_RUNNER);
            await dialog.getByRole('button', { name: ENGINES.confirmLabel }).click();
            await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 15_000 });
            // The owner reads the engine's own checklist. This environment has no
            // Anthropic key, so the engine is chosen and in force but not ready,
            // and the checklist names the missing key as the operator's.
            await expect(section.locator('[data-testid="agent-engines-headline"]')).toHaveText(
                ENGINES.runsOnToolRunnerNotReady,
                { timeout: 15_000 },
            );
            await expect(section.locator('[data-testid="agent-engines-term-MODEL_KEY"]')).toHaveAttribute(
                'data-satisfied',
                'false',
            );
        });

        await test.step('a second person joins the workspace as ADMIN', async () => {
            const reg = await page.request.post('/api/auth/register', {
                headers: { 'Content-Type': 'application/json' },
                data: {
                    action: 'register',
                    email: reviewerEmail,
                    password: reviewerPassword,
                    name: `Test-run Reviewer ${stamp}`,
                    orgName: `Reviewer org ${stamp}`,
                },
            });
            expect([200, 409], await reg.text()).toContain(reg.status());
            const invite = await page.request.post(api('/admin/invites'), {
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

        await test.step('the owner writes the first version and submits it', async () => {
            const panel = await openBehaviour(page, tenantSlug, agentId);
            await panel.locator('[data-testid="behaviour-write"]').click();
            const editor = page.locator('[data-testid="behaviour-editor"]');
            await expect(editor).toBeVisible({ timeout: 15_000 });
            await editor.locator('#behaviour-instructions').fill(instructions);
            await editor.locator('#behaviour-tools').click();
            await page.getByRole('option', { name: /^\s*list_risks\s*$/ }).click();
            await editor.locator('#behaviour-instructions').click();
            await expect(page.getByRole('listbox')).toHaveCount(0);
            await editor.locator('[data-testid="behaviour-editor-save"]').click();
            await expect(editor).toBeHidden({ timeout: 15_000 });
            const open = panel.locator('[data-testid="behaviour-open"]');
            await open.locator('[data-testid="behaviour-submit"]').click();
            await expect(open).toContainText('Waiting for review', { timeout: 15_000 });
        });

        await test.step('the second person approves it, starts a Test run, and sees it on the Runs tab', async () => {
            const ctx: BrowserContext = await browser.newContext();
            try {
                const rp = await ctx.newPage();
                await safeGoto(rp, '/login', { waitUntil: 'domcontentloaded', timeout: 60_000 });
                await signIn(rp, reviewerEmail, reviewerPassword);
                const panel = await openBehaviour(rp, tenantSlug, agentId);
                await panel.locator('[data-testid="behaviour-open"] [data-testid="behaviour-approve"]').click();

                const inForce = panel.locator('[data-testid="behaviour-in-force"]');
                await expect(inForce.locator('[data-testid="behaviour-version-1-instructions"]')).toHaveText(instructions, {
                    timeout: 15_000,
                });
                const button = inForce.locator('[data-testid="behaviour-test-run-1-button"]');
                await expect(button).toBeEnabled({ timeout: 15_000 });
                await expect(inForce.locator('[data-testid="behaviour-test-run-1-reason"]')).toHaveCount(0);
                await button.click();

                const main = rp.getByRole('main');
                await expect(main.getByRole('tab', { name: 'Runs' })).toHaveAttribute('aria-selected', 'true', {
                    timeout: 15_000,
                });
                await expect(rp.getByText(BEHAVIOUR.testRun.started)).toBeVisible({ timeout: 15_000 });
                const list = main.locator('[data-testid="agent-runs-list"]');
                await expect(list.getByRole('link', { name: /:test-run$/ })).toHaveCount(1, { timeout: 30_000 });
            } finally {
                await ctx.close();
            }
        });
    });
});
