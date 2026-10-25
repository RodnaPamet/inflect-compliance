/**
 * Policy Center — mutating E2E.
 *
 * Isolation: each `test()` runs on its own fresh, empty tenant via
 * the `isolatedTenant` fixture. The previous shape had module-level
 * `let createdPolicyTitle / createdPolicyPath` assigned in the
 * "create a blank policy" test and read by the version / activity /
 * role-gate tests — a failure in the create test cascaded into all
 * of them. Each test now mints the policy it needs via the
 * `createPolicy` helper.
 *
 * All selectors use existing id attributes — no data-testid additions.
 */
import { randomUUID } from 'node:crypto';
import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { gotoAndVerify, safeGoto } from './e2e-utils';

/**
 * Create a blank policy on the isolated tenant and return its detail
 * path. Self-contained setup helper.
 */
async function createPolicy(page: Page, slug: string): Promise<string> {
    const uid = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    await gotoAndVerify(page, `/t/${slug}/policies/new`, '#policy-title-input');
    await page.fill('#policy-title-input', `E2E Test Policy ${uid}`);
    await page.fill(
        '[data-testid="rich-text-editor-textarea"]',
        '# Test Policy\n\nThis is a test policy created by e2e.',
    );
    await page.click('#create-policy-btn');
    await page.waitForURL('**/policies/**', { timeout: 30000 });
    await page.waitForSelector('#policy-title', { timeout: 60000 });
    return new URL(page.url()).pathname;
}

test.describe('Policy Center', () => {
    test('policies list page loads with controls', async ({
        authedPage,
        isolatedTenant,
    }) => {
        await gotoAndVerify(
            authedPage,
            `/t/${isolatedTenant.tenantSlug}/policies`,
            'h1',
        );
        await expect(authedPage.locator('#new-policy-btn')).toBeVisible({
            timeout: 10000,
        });
        // "From template" now lives inside the new-policy modal's "Start
        // with" selector (the standalone toolbar button was removed).
        await authedPage.locator('#new-policy-btn').click();
        await expect(authedPage.locator('#new-policy-mode')).toBeVisible();
    });

    test('template library redirects into the create modal (template mode)', async ({ authedPage, isolatedTenant }) => {
        // The standalone /policies/templates page was retired — the template
        // picker now lives inside the canonical new-policy modal. Navigating to
        // the old URL redirects into that modal in template-picker mode.
        await authedPage.goto(`/t/${isolatedTenant.tenantSlug}/policies/templates`);
        await expect(authedPage.locator('#new-policy-form')).toBeVisible();
        await expect(authedPage.locator('#new-policy-mode')).toBeVisible();
    });

    test('create a blank policy and see detail', async ({
        authedPage,
        isolatedTenant,
    }) => {
        const uid = Date.now().toString(36);
        const title = `E2E Test Policy ${uid}`;
        await gotoAndVerify(
            authedPage,
            `/t/${isolatedTenant.tenantSlug}/policies/new`,
            '#policy-title-input',
        );

        await authedPage.fill('#policy-title-input', title);
        await authedPage.fill(
            '[data-testid="rich-text-editor-textarea"]',
            '# Test Policy\n\nThis is a test policy created by e2e.',
        );
        await authedPage.click('#create-policy-btn');

        await authedPage.waitForURL('**/policies/**', { timeout: 30000 });
        await authedPage.waitForSelector('#policy-title', { timeout: 60000 });
        await expect(authedPage.locator('#policy-title')).toContainText(title);
        // The header shows the status label, not the raw enum (#4127).
        await expect(authedPage.locator('#policy-status')).toContainText('Draft');
    });

    test('create version via editor and view history', async ({
        authedPage,
        isolatedTenant,
    }) => {
        const policyPath = await createPolicy(authedPage, isolatedTenant.tenantSlug);
        await safeGoto(authedPage, policyPath);
        await authedPage.waitForLoadState('networkidle').catch(() => {});
        await authedPage.waitForSelector('#policy-title', { timeout: 30000 });

        await authedPage.click('#new-version-btn');
        await authedPage.waitForSelector('#version-editor', { timeout: 15000 });

        // Epic 45 — Tiptap-backed editor; the fillable element is the
        // inner Markdown <textarea>.
        await authedPage.fill(
            '[data-testid="rich-text-editor-textarea"]',
            '# Updated Policy\n\nVersion 2 of the policy.',
        );
        await authedPage.fill('#change-summary-input', 'Updated for e2e test');
        await authedPage.click('#save-version-btn');

        await authedPage.waitForSelector('#version-history', { timeout: 30000 });
        await expect(authedPage.locator('#version-history')).toContainText('v2');
    });

    test('create external link version', async ({
        authedPage,
        isolatedTenant,
    }) => {
        const policyPath = await createPolicy(authedPage, isolatedTenant.tenantSlug);
        await safeGoto(authedPage, policyPath);
        await authedPage.waitForLoadState('networkidle').catch(() => {});
        await authedPage.waitForSelector('#policy-title', { timeout: 30000 });

        await authedPage.click('#new-version-btn');
        await authedPage.waitForSelector('#version-editor', { timeout: 15000 });

        await authedPage.click('#mode-external_link');
        await authedPage.waitForSelector('#external-url-input', { timeout: 3000 });

        await authedPage.fill(
            '#external-url-input',
            'https://docs.example.com/policy-v3',
        );
        await authedPage.fill('#change-summary-input', 'Added external doc link');
        await authedPage.click('#save-version-btn');

        await authedPage.waitForSelector('#version-history', { timeout: 30000 });
        await expect(authedPage.locator('#version-history')).toContainText(
            'External Link',
        );
    });

    test('activity feed tab loads', async ({ authedPage, isolatedTenant }) => {
        const policyPath = await createPolicy(authedPage, isolatedTenant.tenantSlug);
        await safeGoto(authedPage, policyPath, { waitUntil: 'domcontentloaded' });
        await authedPage.waitForLoadState('networkidle').catch(() => {});
        await authedPage.waitForSelector('#policy-title', { timeout: 30000 });

        await authedPage.click('#tab-activity');
        await authedPage.waitForLoadState('networkidle').catch(() => {});

        // The activity API route may need JIT compilation on first
        // visit. The #activity-feed container renders immediately even
        // during loading, so wait for the localized "Created" event
        // label to appear (activity titles are localized, not raw enums).
        let createdVisible = false;
        for (let attempt = 0; attempt < 2 && !createdVisible; attempt++) {
            try {
                await expect(
                    authedPage.locator('#activity-feed'),
                ).toContainText('Created', { timeout: 30000 });
                createdVisible = true;
            } catch {
                await authedPage.reload({ waitUntil: 'domcontentloaded' });
                await authedPage.waitForLoadState('networkidle').catch(() => {});
                await authedPage.waitForSelector('#policy-title', {
                    timeout: 15000,
                });
                await authedPage.click('#tab-activity');
                await authedPage.waitForLoadState('networkidle').catch(() => {});
            }
        }

        await expect(authedPage.locator('#activity-feed')).toBeVisible({
            timeout: 10000,
        });
        await expect(authedPage.locator('#activity-feed')).toContainText(
            'Created',
            { timeout: 10000 },
        );
    });

    test('policy detail shows role-gated action buttons', async ({
        authedPage,
        isolatedTenant,
    }) => {
        const policyPath = await createPolicy(authedPage, isolatedTenant.tenantSlug);
        await safeGoto(authedPage, policyPath);
        await authedPage.waitForLoadState('networkidle').catch(() => {});
        await authedPage.waitForSelector('#policy-title', { timeout: 30000 });

        // OWNER should see the action buttons.
        await expect(authedPage.locator('#new-version-btn')).toBeVisible({
            timeout: 5000,
        });
        await expect(authedPage.locator('#archive-btn')).toBeVisible({
            timeout: 5000,
        });
    });
});
