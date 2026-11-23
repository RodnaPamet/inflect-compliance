/**
 * The Managed Agents engine, chosen and used through the product (Step 5d of
 * docs/claude-managed-agents-design.md, #4167).
 *
 * MUTATING, so it runs in its own isolated tenant. Its OWNER connects the
 * workspace's own Anthropic workspace, chooses the Managed Agents engine,
 * writes and submits a profile version. A second member approves it, which
 * provisions its agent in the workspace, and presses Test run. The run then
 * COMPLETES, and the faux workspace holds no session afterwards: the
 * connection is at its default, which deletes each session when its run ends.
 *
 * WHERE THE WORKSPACE IS. The provider and the engine's client dial the
 * loopback faux Playwright starts (`scripts/e2e-anthropic-workspace-faux.mjs`)
 * instead of api.anthropic.com, because NEXT_TEST_MODE and AUTH_TEST_MODE are
 * both set on the process: the deployment-level seam in `e2e-faux.ts`, which no
 * tenant setting reaches. The workspace ID is unique to this test, and the faux
 * keeps each workspace's objects apart, so parallel specs never meet.
 *
 * WHO RUNS THE RUN. The harness runs no worker (owner decision of 2026-10-29
 * on #4150), so the queued run is executed by `run-queued-agent-run.ts`, which
 * calls the worker's own job body for this run's id and nothing else.
 *
 * Needs `AGENT_MANAGED_AGENTS=1` and `AGENT_PROFILES=1`, both in
 * `.env.e2e.example`. One `test()` with `test.step(...)`, because the steps are
 * one sequence.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { APIRequestContext, BrowserContext, Page } from '@playwright/test';

import { test, expect } from './fixtures';
import { safeGoto, waitForHydration } from './e2e-utils';
import en from '../../messages/en.json';
import { ANTHROPIC_WORKSPACE_E2E_FAUX_PORT } from '../../src/app-layer/integrations/providers/anthropic-workspace/e2e-faux';

const run = promisify(execFile);
const ENGINES = en.admin.agentEngines;
const FAUX = `http://127.0.0.1:${ANTHROPIC_WORKSPACE_E2E_FAUX_PORT}`;

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

type Seen = { method: string; path: string };
async function fauxRequests(request: APIRequestContext, workspace: string): Promise<Seen[]> {
    const res = await request.get(`${FAUX}/__faux/requests?workspace=${encodeURIComponent(workspace)}`);
    expect(res.ok()).toBe(true);
    return ((await res.json()) as { requests: Seen[] }).requests;
}

async function fauxSessions(
    request: APIRequestContext,
    workspace: string,
): Promise<{ live: Array<{ id: string; status: string }>; created: number; deleted: string[] }> {
    const res = await request.get(`${FAUX}/__faux/sessions?workspace=${encodeURIComponent(workspace)}`);
    expect(res.ok()).toBe(true);
    return res.json();
}

test.describe('the Managed Agents engine: connected, chosen, then a profile Test run', () => {
    test('a Test run completes in the connected workspace, and no session is left there', async ({
        authedPage: page,
        isolatedTenant,
        browser,
        request,
    }) => {
        test.setTimeout(300_000);
        const { tenantSlug, tenantId, ownerUserId } = isolatedTenant;
        const stamp = Date.now();
        const workspace = `wrkspc_e2eMa${stamp}`;
        const reviewerEmail = `ma-reviewer-${stamp}@e2e.test`;
        const reviewerPassword = `RevT3st!${stamp}`;
        const instructions = `Summarise the open risks for the weekly review. Run ${stamp}.`;
        const api = (path: string) => `/api/t/${tenantSlug}${path}`;

        const agentId = await test.step('an active, scored agent granted one read tool', async () => {
            const res = await page.request.post(api('/admin/agents'), {
                headers: { 'Content-Type': 'application/json' },
                data: {
                    name: `E2E managed agent ${stamp}`,
                    description: 'Runs a profile Test run on the Managed Agents engine.',
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

        await test.step('with no workspace connected, the engine cannot be chosen', async () => {
            await safeGoto(page, `/t/${tenantSlug}/admin/ai-features`, { waitUntil: 'domcontentloaded' });
            const section = page.locator('#agent-engines');
            await expect(section).toHaveAttribute('data-control', 'editable', { timeout: 30_000 });
            await expect(section.locator('#agent-engine-MANAGED_AGENTS')).toBeDisabled();
            await expect(section.locator('[data-testid="agent-engines-managed-agents-blocked"]')).toContainText(
                ENGINES.managedAgentsNeedsWorkspace,
            );
            // The writer refuses it too, by name.
            const put = await page.request.put(api('/admin/agent-driver'), {
                headers: { 'Content-Type': 'application/json' },
                data: { mode: 'MANAGED_AGENTS' },
            });
            expect(put.status()).toBe(409);
            expect(await put.text()).toContain('MANAGED_AGENTS_NO_WORKSPACE');
        });

        await test.step('the owner connects the workspace, keeping sessions off', async () => {
            await safeGoto(page, `/t/${tenantSlug}/admin/integrations`, { waitUntil: 'domcontentloaded' });
            const card = page.getByRole('main').locator('#anthropic-workspace-card');
            await expect(card).toBeVisible({ timeout: 30_000 });
            await card.locator('#anthropic-workspace-id').fill(workspace);
            await card.locator('#anthropic-api-key').fill('sk-ant-e2e-valid');
            await card.locator('#anthropic-workspace-connect').click();
            await expect(card.getByText(`Workspace ${workspace}`)).toBeVisible({ timeout: 30_000 });
            await expect(card.getByRole('checkbox', { name: 'Keep sessions in my workspace' })).not.toBeChecked();
        });

        await test.step('the owner chooses the Managed Agents engine', async () => {
            await safeGoto(page, `/t/${tenantSlug}/admin/ai-features`, { waitUntil: 'domcontentloaded' });
            const section = page.locator('#agent-engines');
            await expect(section).toHaveAttribute('data-control', 'editable', { timeout: 30_000 });
            await expect(section.locator('[data-testid="agent-engines-managed-agents-explainer"]')).toContainText(
                ENGINES.managedAgentsExplainer.sessions,
            );
            await section.getByRole('radio', { name: new RegExp(`^${ENGINES.engine.MANAGED_AGENTS.name}`) }).click();
            const dialog = page.getByRole('dialog');
            await expect(dialog).toContainText(ENGINES.confirmTitle.MANAGED_AGENTS);
            await dialog.getByRole('button', { name: ENGINES.confirmLabel }).click();
            await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 15_000 });
            // In force and ready: the switch, the build, profiles, the
            // workspace and an active agent are all there.
            await expect(section.locator('[data-testid="agent-engines-headline"]')).toHaveText(
                ENGINES.runsOnManagedAgents,
                { timeout: 15_000 },
            );
        });

        await test.step('a second person joins the workspace as ADMIN', async () => {
            const reg = await page.request.post('/api/auth/register', {
                headers: { 'Content-Type': 'application/json' },
                data: {
                    action: 'register',
                    email: reviewerEmail,
                    password: reviewerPassword,
                    name: `MA Reviewer ${stamp}`,
                    orgName: `MA reviewer org ${stamp}`,
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

        const runId = await test.step('the second person approves it, which provisions its agent, and starts a Test run', async () => {
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
                // Approval provisioned the agent in the workspace: one environment
                // and one agent, and no session yet.
                await expect
                    .poll(async () => (await fauxRequests(request, workspace)).map((r) => `${r.method} ${r.path}`))
                    .toEqual(expect.arrayContaining(['POST /v1/environments', 'POST /v1/agents']));
                expect((await fauxSessions(request, workspace)).created).toBe(0);

                const button = inForce.locator('[data-testid="behaviour-test-run-1-button"]');
                await expect(button).toBeEnabled({ timeout: 15_000 });
                await button.click();
                const list = rp.getByRole('main').locator('[data-testid="agent-runs-list"]');
                const testRunName = en.agents.runs.profileRun.testRun.replace('{version}', '1');
                const link = list.getByRole('link', { name: testRunName });
                await expect(link).toHaveCount(1, { timeout: 30_000 });
                const href = (await link.getAttribute('href')) ?? '';
                const id = /\/agents\/runs\/([^/?#]+)/.exec(href)?.[1];
                expect(id, `run link ${href}`).toBeTruthy();
                return id as string;
            } finally {
                await ctx.close();
            }
        });

        await test.step('the worker body runs it to completion', async () => {
            const { stdout } = await run(
                process.execPath,
                ['--import', 'tsx', 'tests/e2e/run-queued-agent-run.ts', tenantId, runId],
                {
                    timeout: 180_000,
                    maxBuffer: 32 * 1024 * 1024,
                    env: {
                        ...process.env,
                        NODE_ENV: 'test',
                        NEXT_TEST_MODE: '1',
                        AUTH_TEST_MODE: '1',
                        SKIP_ENV_VALIDATION: '1',
                        // The key the web tier encrypted the connection's secret with.
                        DATA_ENCRYPTION_KEY:
                            process.env.DATA_ENCRYPTION_KEY ?? 'e2e-deterministic-test-encryption-key-32+-chars',
                    },
                },
            );
            const line = stdout.split('\n').find((l) => l.startsWith('RUN_OUTCOME ')) ?? 'RUN_OUTCOME {}';
            const outcome = JSON.parse(line.slice('RUN_OUTCOME '.length)) as { status?: string; skipped?: string };
            expect(outcome).toEqual({ status: 'COMPLETED', stepFailures: 0 });
        });

        await test.step('the run page shows it completed, with its decision rows marked span-derived', async () => {
            await safeGoto(page, `/t/${tenantSlug}/agents/runs/${runId}`, { waitUntil: 'domcontentloaded' });
            const timeline = page.getByRole('main').locator('#run-step-timeline');
            await expect(timeline).toBeVisible({ timeout: 30_000 });
            await expect(timeline.locator('[data-testid$="-span-derived"]')).toHaveCount(2, { timeout: 15_000 });
            await expect(timeline.locator('[data-testid$="-span-derived"]').first()).toHaveText(
                en.agents.runs.detail.spanDerived,
            );
        });

        await test.step('the faux workspace holds no session', async () => {
            const sessions = await fauxSessions(request, workspace);
            // Positive control: the run did create one, and deleted it.
            expect(sessions.created).toBe(1);
            expect(sessions.deleted).toHaveLength(1);
            expect(sessions.live).toEqual([]);
            const sent = (await fauxRequests(request, workspace)).map((r) => `${r.method} ${r.path}`);
            expect(sent).toContain(`DELETE /v1/sessions/${sessions.deleted[0]}`);
        });
    });
});
