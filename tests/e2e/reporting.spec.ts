/**
 * E2E Reporting & Audit Narrative Tests
 *
 * A) Frameworks page loads with framework cards    (read-only)
 * B) Framework coverage tab — metrics visible      (read-only)
 * D) Reports page — SOA & Risk Register tables     (read-only)
 * E-G) Audit cycle → pack → freeze → share link    (mutating scenario)
 *
 * Tenant strategy: per-test ISOLATED tenant (`authedPage` +
 * `isolatedTenant` fixtures). A `beforeEach` installs the ISO27001
 * pack into the fresh tenant via `installFramework`, so the
 * coverage tab (B) and the audit-cycle scenario (E-G) have a real
 * installed framework to assert against. `Framework` /
 * `FrameworkPack` are global catalog tables, so the frameworks-page
 * cards (A) render regardless; installing ISO27001 just gives the
 * coverage/cycle flows tenant-scoped controls to report on.
 *
 * Cascade fix: E-G is one sequential scenario expressed as a single
 * `test()` with `test.step(...)` sub-steps and no cross-test state.
 * A/B/D are each independent.
 */
import { test, expect } from './fixtures';
import type { BrowserContext } from '@playwright/test';
import { gotoAndVerify, installFramework } from './e2e-utils';

const UNIQUE = Date.now().toString(36);

test.describe('Reporting & Audit Narrative', () => {
    test.beforeEach(async ({ authedPage, isolatedTenant }) => {
        await installFramework(
            authedPage,
            isolatedTenant.tenantSlug,
            'ISO27001',
            'ISO27001_2022_BASE',
        );
    });

    // ─── A) Frameworks Page (read-only) ──────────────────────────────

    test('A — frameworks page loads with framework cards', async ({
        authedPage: page,
        isolatedTenant,
    }) => {
        const tenantSlug = isolatedTenant.tenantSlug;
        await gotoAndVerify(page, `/t/${tenantSlug}/frameworks`, '#frameworks-heading');
        await expect(page.locator('#frameworks-heading')).toContainText(
            'Compliance Frameworks',
        );
        await page.waitForLoadState('networkidle').catch(() => {});
        const cardCount = await page.locator('[data-testid^="fw-card-"]').count();
        expect(cardCount).toBeGreaterThanOrEqual(1);
    });

    // ─── B) Coverage Report (read-only) ──────────────────────────────

    test('B — ISO27001 coverage tab shows metrics', async ({
        authedPage: page,
        isolatedTenant,
    }) => {
        const tenantSlug = isolatedTenant.tenantSlug;
        await gotoAndVerify(
            page,
            `/t/${tenantSlug}/frameworks/ISO27001`,
            '#framework-detail-heading',
            3,
        );
        await expect(page.locator('#tab-coverage')).toBeVisible({ timeout: 30_000 });
        await page.locator('#tab-coverage').click();
        await expect(page.locator('#coverage-panel')).toBeVisible({ timeout: 30_000 });
    });

    // ─── D) Reports Page (read-only) ─────────────────────────────────

    test('D — reports landing is a framework-scoped report catalog', async ({
        authedPage: page,
        isolatedTenant,
    }) => {
        const tenantSlug = isolatedTenant.tenantSlug;
        await gotoAndVerify(page, `/t/${tenantSlug}/reports`, '#reports-heading', 4);

        // PR-G — the landing is a report catalog scoped by a framework selector,
        // NOT a SoA table. Assert the new IA.
        await expect(page.locator('#reports-framework-select')).toBeVisible();
        await expect(page.locator('[data-testid="report-catalog"]')).toBeVisible();
        await expect(page.locator('[data-testid="report-card-coverage"]')).toBeVisible();
        await expect(page.locator('[data-testid="report-card-risk"]')).toBeVisible();
        // The universal default report renders on-screen (coverage/readiness).
        await expect(
            page.locator('[data-testid="readiness-report-body"]'),
        ).toBeVisible({ timeout: 5000 });

        // The old SoA tab-table is gone from the hub (SoA now lives at /reports/soa).
        await expect(page.locator('#soa-tab-btn')).toHaveCount(0);
        await expect(page.locator('#soa-table')).toHaveCount(0);
    });

    // ─── E-G) Audit cycle → pack → freeze → share (one scenario) ─────

    test('E-G — create audit cycle, pack, freeze, and share', async ({
        authedPage: page,
        isolatedTenant,
        browser,
    }) => {
        const tenantSlug = isolatedTenant.tenantSlug;
        let cycleId = '';
        let packId = '';
        let shareToken = '';

        await test.step('E — create audit cycle (ISO27001)', async () => {
            await gotoAndVerify(page, `/t/${tenantSlug}/audits/cycles`, 'h1', 3);

            await page.click('#create-cycle-btn');
            await page.waitForSelector('#cycle-form', { timeout: 5000 });
            // ISO27001 is the default Combobox selection — no click needed.
            await page.fill('#cycle-name-input', `E2E Audit Cycle ${UNIQUE}`);
            await page.click('#submit-cycle-btn');

            await page.waitForURL(/\/audits\/cycles\//, { timeout: 15000 });
            await page.waitForSelector('#cycle-name', { timeout: 15000 });
            await expect(page.locator('#cycle-name')).toContainText(
                `E2E Audit Cycle ${UNIQUE}`,
            );
            const urlMatch = page.url().match(/\/cycles\/([^/]+)/);
            expect(urlMatch).toBeTruthy();
            cycleId = urlMatch![1];
        });

        await test.step('F — create default pack, freeze, share link', async () => {
            expect(cycleId).toBeTruthy();
            await gotoAndVerify(
                page,
                `/t/${tenantSlug}/audits/cycles/${cycleId}`,
                '#cycle-name',
                3,
            );

            const createPackBtn = page.locator('#create-default-pack-btn');
            await expect(createPackBtn).toBeVisible({ timeout: 5000 });
            await createPackBtn.click();

            await page.waitForURL(/\/audits\/packs\//, { timeout: 60000 });
            await page.waitForSelector('#pack-name', { timeout: 15000 });
            const packMatch = page.url().match(/\/packs\/([^/]+)/);
            expect(packMatch).toBeTruthy();
            packId = packMatch![1];

            // Status badge renders the localized label ("Draft"), not the enum.
            await expect(page.locator('#pack-status')).toContainText('Draft');

            // Freeze the pack. Freeze is now behind a confirmation dialog
            // (irreversible lock) — opening it doesn't write; the confirm
            // button does.
            const freezeBtn = page.locator('#freeze-pack-btn');
            await expect(freezeBtn).toBeVisible({ timeout: 5000 });
            await freezeBtn.click();
            const confirmFreeze = page.locator('[data-modal-confirm]');
            await expect(confirmFreeze).toBeVisible({ timeout: 15000 });
            await Promise.all([
                page.waitForResponse(
                    resp =>
                        resp.url().includes('/audits/packs/') &&
                        resp.url().includes('action=freeze'),
                    { timeout: 90000 },
                ),
                confirmFreeze.click(),
            ]);
            await page.waitForLoadState('networkidle').catch(() => {});
            await expect(page.locator('#pack-status')).toContainText('Frozen', {
                timeout: 60000,
            });

            // Generate a share link.
            const shareBtn = page.locator('#share-pack-btn');
            await expect(shareBtn).toBeVisible({ timeout: 5000 });
            await shareBtn.click();

            // Share now opens an expiry modal defaulting to a 30-day expiry —
            // submit with that default to generate the link.
            const shareSubmit = page.locator('#share-modal-submit');
            await expect(shareSubmit).toBeVisible({ timeout: 15000 });
            await shareSubmit.click();

            await expect(page.locator('#share-link-card')).toBeVisible({
                timeout: 10000,
            });
            const shareUrl = await page.locator('#share-link-url').textContent();
            expect(shareUrl).toBeTruthy();
            expect(shareUrl).toContain('/audit/shared/');
            const tokenMatch = shareUrl!.match(/\/audit\/shared\/([^/]+)/);
            expect(tokenMatch).toBeTruthy();
            shareToken = tokenMatch![1];
        });

        await test.step('G — shared pack is accessible without login', async () => {
            expect(shareToken).toBeTruthy();
            const freshContext: BrowserContext = await browser.newContext();
            const freshPage = await freshContext.newPage();
            try {
                await freshPage.goto(`/audit/shared/${shareToken}`, {
                    timeout: 30000,
                });
                await freshPage.waitForLoadState('networkidle').catch(() => {});
                await freshPage.waitForSelector('#shared-pack-name', {
                    timeout: 30000,
                });

                await expect(freshPage.locator('#shared-pack-name')).toBeVisible();
                await expect(
                    freshPage.locator('#shared-pack-summary'),
                ).toBeVisible({ timeout: 5000 });
                await expect(
                    freshPage.locator('text=Read-only view').first(),
                ).toBeVisible({ timeout: 5000 });
                await expect(
                    freshPage.locator('#freeze-pack-btn'),
                ).not.toBeVisible();
                await expect(
                    freshPage.locator('#share-pack-btn'),
                ).not.toBeVisible();
            } finally {
                try {
                    await freshPage.close();
                } catch {
                    /* ignore */
                }
                try {
                    await freshContext.close();
                } catch {
                    /* ignore */
                }
            }
        });
    });
});
