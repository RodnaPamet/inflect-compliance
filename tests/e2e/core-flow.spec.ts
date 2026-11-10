/**
 * E2E Core Certification Flow
 *
 * Covers the full GRC certification lifecycle as ONE scenario:
 *   A) Log in (OWNER of a fresh isolated tenant)
 *   B) Create a Control
 *   C) Upload Evidence linked to that Control
 *   D) Create a Risk (via API)
 *   E) Link Control → Risk and verify on the risk detail
 *   F) Verify the bidirectional link on the control detail
 *
 * Isolation: the whole flow runs against ONE fresh, empty tenant
 * provisioned by the `isolatedTenant` fixture. The previous shape
 * was six separate `test()`s sharing a module-level `let
 * tenantSlug` + `const CONTROL_CODE/RISK_TITLE` — a resource minted
 * in step B was read by step C, so a failure in B cascaded into
 * C-F. This is genuinely a single sequential scenario, so it is now
 * a single `test()` with `test.step(...)` sub-steps: a step failure
 * fails exactly this one test, nothing else, and there is no
 * cross-test state to leak.
 *
 * All selectors use existing id attributes — no data-testid additions.
 */
import { randomUUID } from 'node:crypto';
import { test, expect } from './fixtures';
import { reloadUntilVisible } from './e2e-utils';
import * as path from 'path';

const EVIDENCE_FIXTURE = path.resolve(__dirname, '../fixtures/evidence.txt');

test.describe('Core Certification Flow', () => {
    test('full certification lifecycle: control → evidence → risk → link', async ({
        authedPage: page,
        isolatedTenant,
    }) => {
        const { tenantSlug } = isolatedTenant;
        const unique = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
        const CONTROL_CODE = `E2E-CTRL-${unique}`;
        const CONTROL_NAME = `E2E Access Control ${unique}`;
        const RISK_TITLE = `E2E Risk ${unique}`;

        // ── A) Already signed in via the `authedPage` fixture ──
        await test.step('A — landed on dashboard as the isolated OWNER', async () => {
            await expect(page).toHaveURL(/\/t\/[^/]+\/dashboard/);
            await expect(page.locator('aside').first()).toBeVisible({
                timeout: 30_000,
            });
        });

        // ── B) Create Control ──
        let controlId: string | undefined;
        await test.step('B — create a new control', async () => {
            await page.goto(`/t/${tenantSlug}/controls/new`);
            await page.waitForLoadState('networkidle').catch(() => {});
            await page.waitForSelector('#control-name-input', { timeout: 60000 });

            await page.fill('#control-name-input', CONTROL_NAME);
            await page.fill('#control-code-input', CONTROL_CODE);
            await page.click('#create-control-btn');

            await page.waitForURL('**/controls/**', { timeout: 30000 });
            await page.waitForLoadState('networkidle').catch(() => {});
            await page.waitForSelector('#control-title', { timeout: 60000 });
            await expect(page.locator('#control-title')).toContainText(
                CONTROL_NAME,
                { timeout: 5000 },
            );
            const m = page.url().match(/\/controls\/([^/?]+)/);
            controlId = m?.[1];
            expect(controlId).toBeTruthy();
        });

        // ── C) Upload Evidence linked to the Control ──
        await test.step('C — upload evidence and link to control', async () => {
            await page.goto(`/t/${tenantSlug}/evidence`);
            await page.waitForLoadState('networkidle').catch(() => {});
            await page.waitForSelector('h1', { timeout: 60000 });

            await page.click('#add-evidence-btn');
            await page.click('#create-evidence-upload'); // EP-3 create-menu → File upload
            await page.waitForSelector('#upload-form', { timeout: 5000 });

            await page.locator('#file-input').setInputFiles(EVIDENCE_FIXTURE);
            await page.fill('#upload-title-input', `E2E Evidence ${unique}`);

            // Epic 55: the control linker is a <Combobox>. Open it,
            // type into the cmdk search, click the matching option.
            // The tenant is isolated + freshly created, so this is the
            // ONLY control — the search is unambiguous.
            await page.click('#control-select');
            const comboSearch = page.getByPlaceholder('Search controls…');
            await comboSearch.fill(CONTROL_CODE);
            const codeOption = page
                .getByRole('option')
                .filter({ hasText: CONTROL_CODE })
                .first();
            await codeOption.waitFor({ state: 'visible', timeout: 10_000 });
            await codeOption.click();
            // The picker is multi-select (#5018): it stays open after a pick,
            // and its open list covers the submit button. Escape in its search
            // box closes the list only (the handler stops propagation), so
            // the modal underneath stays open.
            await comboSearch.press('Escape');
            await expect(codeOption).toBeHidden();
            await expect(page.locator('#upload-form')).toBeVisible();

            await page.click('#submit-upload-btn');
            await expect(page.locator('#upload-form')).not.toBeVisible({
                timeout: 15000,
            });
            // The evidence list-read cache can serve a stale (pre-upload) view
            // under parallel CI load; reload-poll past the 60s TTL so the new
            // row is guaranteed to surface (anti-flake).
            await reloadUntilVisible(
                page,
                page.locator(`text=E2E Evidence ${unique}`).first(),
            );
        });

        // ── D) Create a Risk via API ──
        let riskId: string | undefined;
        await test.step('D — create a risk via API', async () => {
            await page.goto(`/t/${tenantSlug}/risks`);
            await page.waitForLoadState('networkidle').catch(() => {});
            await page.waitForSelector('h1', { timeout: 60000 });

            const riskResult = await page.evaluate(async (riskTitle) => {
                const slug = window.location.pathname.split('/')[2];
                const res = await fetch(
                    `${window.location.origin}/api/t/${slug}/risks`,
                    {
                        method: 'POST',
                        credentials: 'include',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            title: riskTitle,
                            description: 'E2E test risk for certification flow',
                            category: 'Technical',
                            likelihood: 4,
                            impact: 5,
                            treatmentOwner: 'E2E Test Owner',
                        }),
                    },
                );
                const data = await res.json();
                return { ok: res.ok, status: res.status, id: data?.id, title: data?.title };
            }, RISK_TITLE);

            expect(riskResult.ok).toBe(true);
            expect(riskResult.title).toBe(RISK_TITLE);
            riskId = riskResult.id;
            expect(riskId).toBeTruthy();

            await page.goto(
                `/t/${tenantSlug}/risks?q=${encodeURIComponent(RISK_TITLE)}`,
            );
            await page.waitForLoadState('networkidle').catch(() => {});
            await page.waitForSelector('h1', { timeout: 30000 });
            await expect(
                page.locator(`text=${RISK_TITLE}`).first(),
            ).toBeVisible({ timeout: 10000 });
        });

        // ── E) Link Control → Risk and verify on the risk detail ──
        await test.step('E — link control to risk and verify in traceability', async () => {
            const linkResult = await page.evaluate(
                async ({ cId, rId }) => {
                    const slug = window.location.pathname.split('/')[2];
                    const res = await fetch(
                        `${window.location.origin}/api/t/${slug}/controls/${cId}/risks`,
                        {
                            method: 'POST',
                            credentials: 'include',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ riskId: rId }),
                        },
                    );
                    return { ok: res.ok, status: res.status };
                },
                { cId: controlId!, rId: riskId! },
            );
            expect(linkResult.ok).toBe(true);

            await page.goto(`/t/${tenantSlug}/risks/${riskId}`);
            await page.waitForLoadState('networkidle').catch(() => {});
            await page.waitForSelector('#risk-title-heading', { timeout: 60000 });
            await expect(page.locator('#risk-title-heading')).toContainText(
                RISK_TITLE,
                { timeout: 10000 },
            );

            // Traceability lives on its own tab now (it was removed from
            // the Overview tab, which duplicated it). Open the tab before
            // asserting on the linked-controls table.
            await page.click('#tab-traceability');
            await page.waitForSelector('#traceability-panel', { timeout: 60000 });
            await expect(
                page.locator('#linked-controls-table'),
            ).toBeVisible({ timeout: 30_000 });
            await expect(
                page.locator('#linked-controls-table'),
            ).not.toContainText('Loading', { timeout: 30_000 });
            await expect(
                page.locator('#linked-controls-table'),
            ).toContainText(CONTROL_NAME, { timeout: 15_000 });
        });

        // ── F) Verify the bidirectional link on the control detail ──
        await test.step('F — verify control shows linked risk in traceability', async () => {
            await page.goto(`/t/${tenantSlug}/controls/${controlId}`);
            await page.waitForLoadState('networkidle').catch(() => {});
            await page.waitForSelector('#control-title', { timeout: 60000 });
            await expect(page.locator('#control-title')).toContainText(
                CONTROL_NAME,
            );

            await page.click('button:has-text("Traceability")');
            await page.waitForSelector('#traceability-panel', { timeout: 60000 });

            await expect(
                page.locator('#linked-risks-table'),
            ).toBeVisible({ timeout: 10000 });
            await expect(
                page.locator('#linked-risks-table'),
            ).toContainText(RISK_TITLE, { timeout: 5000 });
        });
    });
});
