/**
 * An owner connects the workspace's own Anthropic workspace on Admin →
 * Integrations and tests it, and the Test reads and writes nothing (Step 5a of
 * docs/claude-managed-agents-design.md).
 *
 * MUTATING, so it runs in its own isolated tenant.
 *
 * The provider is registered because `AGENT_MANAGED_AGENTS=1` is in
 * `.env.e2e.example`. It dials the loopback faux Playwright starts
 * (`scripts/e2e-anthropic-workspace-faux.mjs`) instead of api.anthropic.com
 * because the webServer command sets both NEXT_TEST_MODE and AUTH_TEST_MODE —
 * the deployment-level seam in `e2e-faux.ts`, which no tenant setting reaches.
 * The faux answers key `sk-ant-e2e-valid` for whatever workspace the request
 * names, and counts every request it receives.
 *
 * One `test()` with `test.step(...)`: connect, then Test, is one sequence.
 */
import { test, expect } from './fixtures';
import { safeGoto } from './e2e-utils';
import { ANTHROPIC_WORKSPACE_E2E_FAUX_PORT } from '../../src/app-layer/integrations/providers/anthropic-workspace/e2e-faux';

const FAUX = `http://127.0.0.1:${ANTHROPIC_WORKSPACE_E2E_FAUX_PORT}`;
const WORKSPACE = 'wrkspc_e2eIsolated';

type Seen = { method: string; path: string };
async function fauxRequests(request: import('@playwright/test').APIRequestContext): Promise<Seen[]> {
    const res = await request.get(`${FAUX}/__faux/requests`);
    expect(res.ok()).toBe(true);
    return ((await res.json()) as { requests: Seen[] }).requests;
}

test('an owner connects an Anthropic workspace and tests it, and nothing is written there', async ({
    authedPage: page,
    isolatedTenant,
    request,
}) => {
    const slug = isolatedTenant.tenantSlug;
    const card = page.getByRole('main').locator('#anthropic-workspace-card');

    await test.step('the card is there, with keep sessions off', async () => {
        await safeGoto(page, `/t/${slug}/admin/integrations`, { waitUntil: 'domcontentloaded' });
        await expect(card).toBeVisible({ timeout: 30_000 });
        await expect(card).toContainText('What Inflect will create in the workspace');
        await expect(card.getByRole('checkbox', { name: 'Keep sessions in my workspace' })).not.toBeChecked();
    });

    await test.step('connect with a workspace ID and a key', async () => {
        await card.locator('#anthropic-workspace-id').fill(WORKSPACE);
        await card.locator('#anthropic-api-key').fill('sk-ant-e2e-valid');
        await card.locator('#anthropic-workspace-connect').click();
        await expect(card.getByTestId('anthropic-workspace-notice')).toContainText('Anthropic workspace connected', {
            timeout: 30_000,
        });
        await expect(card.getByText(`Workspace ${WORKSPACE}`)).toBeVisible({ timeout: 30_000 });
    });

    await test.step('Test reaches the faux with ONE read and passes', async () => {
        const before = (await fauxRequests(request)).length;
        await card.getByRole('button', { name: 'Test' }).click();
        await expect(card.getByTestId('anthropic-workspace-notice')).toContainText(
            'The key works for this workspace. Nothing was created in it.',
            { timeout: 30_000 },
        );
        const sent = (await fauxRequests(request)).slice(before);
        expect(sent).toEqual([{ method: 'GET', path: '/v1/agents' }]);
        await expect(card.getByText('Tested', { exact: true })).toBeVisible();
    });
});
