/**
 * E2E — CONNECT AN AGENT YOU RUN (Step 3a, #4155).
 *
 * From a registered agent's page, the operator mints a key bound to that agent,
 * copies it, and finds it on the API keys page, bound to the agent at the
 * agent's own level. The configuration the sheet hands back names exactly the
 * granted tool.
 *
 * MUTATING: it registers an agent, grants it a tool and mints a key, so it takes
 * the `isolatedTenant` / `authedPage` fixture and a fresh, empty tenant of its
 * own. The agent is registered, scored, activated and granted through the API:
 * those steps have their own coverage, and this spec is about the wizard.
 *
 * The sheet is portalled outside `main`, so it is reached as the page's one
 * dialog; the agent page and the keys table are scoped to `main`.
 */
import { test, expect } from './fixtures';
import { safeGoto, waitForHydration } from './e2e-utils';
import en from '../../messages/en.json';

const CONNECT = en.admin.agentDetail.connect;

test.describe('connect an agent you run', () => {
    test.beforeEach(async ({ context }) => {
        await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    });

    test('mints a key bound to the agent, copies it, and lists it on the API keys page', async ({
        authedPage: page,
        isolatedTenant,
    }) => {
        const { tenantSlug, ownerUserId } = isolatedTenant;
        const main = page.getByRole('main');
        const agentName = `E2E connect agent ${Date.now()}`;
        const api = (path: string) => `/api/t/${tenantSlug}${path}`;

        const agentId = await test.step('an active agent granted one read tool', async () => {
            const created = await page.request.post(api('/admin/agents'), {
                headers: { 'Content-Type': 'application/json' },
                data: {
                    name: agentName,
                    description: 'Connected through the wizard.',
                    autonomyLevel: 2,
                    dataAccessScope: 'READ_TENANT_DATA',
                    reversibility: 'REVERSIBLE',
                    provenance: 'FIRST_PARTY',
                    ownerUserId,
                    classification: {},
                },
            });
            expect(created.ok(), `POST /admin/agents failed ${created.status()}: ${await created.text()}`).toBe(true);
            const body = (await created.json()) as { id?: string; agent?: { id?: string } };
            const id = (body.id ?? body.agent?.id) as string;
            expect(id).toBeTruthy();

            // The operator journey's order: grant, score, then activate.
            for (const [path, data] of [
                [`/admin/agents/${id}/tools`, { toolName: 'list_risks' }],
                [`/admin/agents/${id}/risk-assessment/complete`, undefined],
                [`/admin/agents/${id}/status`, { status: 'ACTIVE' }],
            ] as const) {
                const res = await page.request.post(api(path), { headers: { 'Content-Type': 'application/json' }, data });
                expect(res.ok(), `POST ${path} failed ${res.status()}: ${await res.text()}`).toBe(true);
            }
            return id;
        });

        const key = await test.step('the wizard mints the key and shows it once', async () => {
            await safeGoto(page, `/t/${tenantSlug}/agents/${agentId}`, { waitUntil: 'domcontentloaded' });
            await waitForHydration(page, '[role="tab"]');
            await main.getByRole('button', { name: CONNECT.action }).click();

            const sheet = page.getByRole('dialog');
            await expect(sheet.locator('#connect-agent-key-name')).toBeVisible({ timeout: 30_000 });
            await sheet.getByRole('button', { name: CONNECT.mint }).click();

            const shown = sheet.locator('code').filter({ hasText: /^iflk_/ });
            await expect(shown).toBeVisible({ timeout: 30_000 });
            const plaintext = (await shown.textContent())?.trim() ?? '';
            expect(plaintext).toMatch(/^iflk_/);

            await sheet.getByRole('button', { name: CONNECT.copyKey }).click();
            await expect
                .poll(() => page.evaluate(async () => navigator.clipboard.readText().catch(() => '')), { timeout: 10_000 })
                .toBe(plaintext);

            // The configuration names the granted tool and no other.
            const sdk = (await sheet.locator('pre').first().textContent()) ?? '';
            expect([...sdk.matchAll(/"(mcp__[^"]+)"/g)].map((m) => m[1])).toEqual(['mcp__inflect__list_risks']);
            expect(sdk).not.toContain(plaintext);

            await sheet.getByRole('button', { name: CONNECT.done }).click();
            await expect(page.getByRole('dialog')).toHaveCount(0);
            return plaintext;
        });

        await test.step('the API keys page lists it, bound to the agent at its own level', async () => {
            await safeGoto(page, `/t/${tenantSlug}/admin/api-keys`, { waitUntil: 'domcontentloaded' });
            const row = main
                .locator('#active-keys-table')
                .getByRole('row')
                .filter({ hasText: CONNECT.defaultKeyName.replace('{name}', agentName) });
            await expect(row).toHaveCount(1, { timeout: 30_000 });
            await expect(row).toContainText(agentName);
            await expect(row).toContainText(en.admin.apiKeys.autonomyCap.replace('{level}', '2'));
            await expect(main).not.toContainText(key);
        });
    });
});
