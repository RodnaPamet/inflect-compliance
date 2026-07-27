/**
 * Control Tests (Test-of-Control) — mutating E2E.
 *
 * Isolation: runs on a fresh, empty tenant via the `isolatedTenant`
 * fixture. The previous shape had four serial `test()`s that each
 * re-located the SAME `Test Ctrl <uid>` control and `Access Review
 * <uid>` plan by text-locator — an implicit order-dependent cascade
 * (test 2's plan-detail click depended on test 1 having created the
 * plan). The control → plan → run → result → fail-run flow is one
 * sequential scenario, so it is now a single `test()` with
 * `test.step(...)` sub-steps and no cross-test state. The standalone
 * rollup-page check stays its own `test()`.
 *
 * All selectors use existing id attributes — no data-testid additions.
 */
import { randomUUID } from 'node:crypto';
import { test, expect } from './fixtures';
import { gotoAndVerify, reloadUntilVisible } from './e2e-utils';

test.describe('Control Tests (Test-of-Control)', () => {
    test('control → test plan → run → PASS → FAIL scenario', async ({
        authedPage: page,
        isolatedTenant,
    }) => {
        const { tenantSlug } = isolatedTenant;
        const uid = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
        // Captured after create so a later step can return to the control's
        // detail page directly — the list's title cell now opens a quick-view
        // (Controls TidalControl PR-2), it no longer navigates.
        let controlDetailUrl = '';

        await test.step('create control + test plan', async () => {
            await gotoAndVerify(
                page,
                `/t/${tenantSlug}/controls/new`,
                '#control-name-input',
            );
            await page.fill('#control-name-input', `Test Ctrl ${uid}`);
            await page.fill('#control-code-input', `TC-${uid}`);
            await page.click('#create-control-btn');
            await page.waitForURL(/\/controls\/[a-z0-9]{20,}/, { timeout: 30000 });
            controlDetailUrl = page.url();
            await page.waitForLoadState('networkidle').catch(() => {});
            await page.waitForSelector('#control-title', { timeout: 30000 });
            await expect(page.locator('#control-title')).toContainText(
                `Test Ctrl ${uid}`,
                { timeout: 5000 },
            );

            await page.click('#tab-tests');
            await page.waitForLoadState('networkidle').catch(() => {});
            await page.waitForSelector('#create-test-plan-btn', { timeout: 30000 });

            await page.click('#create-test-plan-btn');
            await page.waitForSelector('#test-plan-name-input', { timeout: 5000 });
            await page.fill('#test-plan-name-input', `Access Review ${uid}`);
            await page.selectOption('#test-plan-frequency-select', 'QUARTERLY');
            await page.click('#save-test-plan-btn');
            await page.waitForLoadState('networkidle').catch(() => {});
            await expect(
                page.locator(`text=Access Review ${uid}`),
            ).toBeVisible({ timeout: 10000 });
        });

        await test.step('open test plan detail and start a run', async () => {
            await page.click(`text=Access Review ${uid}`);
            await page.waitForLoadState('networkidle').catch(() => {});
            await page.waitForSelector('#test-plan-title', { timeout: 30000 });
            await expect(page.locator('#test-plan-title')).toContainText(
                `Access Review ${uid}`,
            );

            await page.click('#create-test-run-btn');
            await page.waitForLoadState('networkidle').catch(() => {});
            await page.waitForSelector('#test-run-title', { timeout: 30000 });
            await expect(page.locator('#test-run-status')).toContainText(
                'PLANNED',
                { timeout: 10000 },
            );
            // R3-P2 — "Run" now creates a PLANNED run; begin the guided
            // execution (PLANNED → RUNNING) before the result form appears.
            await page.click('#start-test-run-btn');
            await expect(page.locator('#test-run-status')).toContainText(
                'RUNNING',
                { timeout: 10000 },
            );
        });

        await test.step('link evidence while RUNNING, then complete as PASS', async () => {
            // A COMPLETED run is frozen audit evidence — its evidence set is
            // immutable and the add affordance is hidden. So link evidence
            // BEFORE completing, while the run is still RUNNING.
            // Link URL evidence — Epic 55 <Combobox> for the kind picker.
            await page.click('#link-evidence-btn');
            await page.waitForSelector('#evidence-kind-select', { timeout: 10000 });
            await page.locator('#evidence-kind-select').click();
            await page.getByRole('option', { name: /URL.*Link/ }).click();
            await page.waitForSelector('#evidence-url-input', { timeout: 5000 });
            await page.fill(
                '#evidence-url-input',
                'https://docs.example.com/access-review-q1',
            );
            await page.fill('#evidence-note-input', 'Q1 access review report');
            await page.click('#save-evidence-link-btn');
            await page.waitForLoadState('networkidle').catch(() => {});
            await expect(
                page.locator('text=docs.example.com'),
            ).toBeVisible({ timeout: 15000 });

            // Now complete the run as PASS.
            await page.click('#result-btn-PASS');
            await page.fill(
                '#test-run-notes',
                'All access levels verified correctly',
            );
            await page.click('#complete-test-run-btn');
            // R4-P2 — completing a run now confirms first (it freezes evidence).
            await page.click('[data-modal-confirm]');
            await page.waitForLoadState('networkidle').catch(() => {});
            await expect(page.locator('#test-run-status')).toContainText(
                'COMPLETED',
                { timeout: 15000 },
            );
            await expect(page.locator('#test-run-result')).toContainText('PASS', {
                timeout: 10000,
            });

            // The frozen evidence remains; the add affordance is gone on a
            // completed run (the immutability guard).
            await expect(page.locator('text=docs.example.com')).toBeVisible();
            await expect(page.locator('#link-evidence-btn')).toHaveCount(0);
        });

        await test.step('create another run, mark FAIL, verify finding', async () => {
            // Back to the control detail to start a 2nd run. Navigate directly
            // (the list title cell now opens a quick-view, not the detail page).
            await page.goto(controlDetailUrl);
            await page.waitForSelector('#control-title', { timeout: 10000 });
            await page.click('#tab-tests');
            await page.waitForLoadState('networkidle').catch(() => {});
            const planLink = page
                .locator(`[id^="test-plan-link-"]`)
                .filter({ hasText: `Access Review ${uid}` })
                .first();
            await planLink.click();
            await page.waitForSelector('#test-plan-title', { timeout: 10000 });

            await page.click('#create-test-run-btn');
            await page.waitForSelector('#test-run-title', { timeout: 10000 });

            // R3-P2 — start the guided run before the result form is available.
            await page.click('#start-test-run-btn');
            await expect(page.locator('#test-run-status')).toContainText(
                'RUNNING',
                { timeout: 10000 },
            );

            await page.click('#result-btn-FAIL');
            await page.waitForSelector('#test-run-finding-summary', {
                timeout: 5000,
            });
            await page.fill('#test-run-notes', 'Found unauthorized access');
            await page.fill(
                '#test-run-finding-summary',
                'Unauthorized admin access detected',
            );
            await page.click('#complete-test-run-btn');
            await page.click('[data-modal-confirm]');
            await page.waitForLoadState('networkidle').catch(() => {});
            await expect(page.locator('#test-run-status')).toContainText(
                'COMPLETED',
                { timeout: 15000 },
            );
            await expect(page.locator('#test-run-result')).toContainText('FAIL', {
                timeout: 10000,
            });
            // The finding is created from the test-run summary on completion and
            // surfaced after a revalidation round-trip that can lag under CI
            // load; reload-poll until it renders (anti-flake).
            await reloadUntilVisible(
                page,
                page.locator('text=Unauthorized admin access detected'),
            );
        });
    });

    test('tests rollup page loads', async ({ authedPage, isolatedTenant }) => {
        await gotoAndVerify(
            authedPage,
            `/t/${isolatedTenant.tenantSlug}/tests`,
            '#tests-page-title',
        );
        await expect(authedPage.locator('#tests-page-title')).toContainText('Tests');
        // R3-P1 — the generic subtitle was replaced by the global tests-vs-checks
        // explanation (the old copy ignored automated checks, the gap R3-P1 closes).
        await expect(
            authedPage.getByText(/manual plans/i),
        ).toBeVisible({ timeout: 5000 });
    });
});
