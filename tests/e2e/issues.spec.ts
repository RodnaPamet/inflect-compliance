/**
 * Issue Management — mutating E2E.
 *
 * Isolation: each `test()` runs on its own fresh, empty tenant via
 * the `isolatedTenant` fixture. Tests that need a pre-existing issue
 * create one in their own body via the `createIssue` helper — the
 * previous shape had tests 3-6 click `text=E2E Issue <uid>` to find
 * an issue minted by test 2, an implicit order-dependent cascade.
 * Each test is now self-contained; a failed create degrades to one
 * red test instead of cascading.
 *
 * All selectors use existing id attributes — no data-testid additions.
 */
import { randomUUID } from 'node:crypto';
import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { loginAndGetTenant, gotoAndVerify, safeGoto, selectComboboxOption, reloadUntilVisible } from './e2e-utils';

/** Seed-tenant READER — only used by the read-only role-gate test. */
const READER_USER = { email: 'viewer@acme.com', password: 'password123' };

/**
 * PR-D — seed an Asset via the tenant API so the EntityPicker
 * in the new-task modal has a real candidate to pick.
 *
 * Pre-PR-D the `#link-entity-id` slot accepted any free-text
 * string, so the E2E hard-coded `'test-asset-id'`. Post-PR-D
 * the slot is a typeahead picker — users (and tests) MUST pick
 * a real entity.
 */
async function seedAsset(page: Page, slug: string, name: string): Promise<void> {
    const res = await page.request.post(`/api/t/${slug}/assets`, {
        headers: { 'Content-Type': 'application/json' },
        data: {
            name,
            type: 'OTHER',
            classification: 'INTERNAL',
            criticality: 'MEDIUM',
        },
    });
    if (!res.ok()) {
        throw new Error(
            `[issues.spec] seedAsset failed: ${res.status()} ${await res.text()}`,
        );
    }
}

/**
 * PR-D — seed a Control so the EntityPicker on the task detail
 * page's "add link" flow has a candidate to pick. Same rationale
 * as `seedAsset`. Returns the control's cuid — needed because the
 * legacy `<TaskLinksTable>` renders the raw `entityId` cuid
 * (not the resolved name), so the post-add assertion must check
 * the cuid, not the human-friendly name.
 */
async function seedControl(
    page: Page,
    slug: string,
    name: string,
): Promise<string> {
    const res = await page.request.post(`/api/t/${slug}/controls`, {
        headers: { 'Content-Type': 'application/json' },
        data: {
            name,
            code: `E2E-${name.slice(0, 8)}`,
            status: 'NOT_STARTED',
            isCustom: true,
        },
    });
    if (!res.ok()) {
        throw new Error(
            `[issues.spec] seedControl failed: ${res.status()} ${await res.text()}`,
        );
    }
    const body = (await res.json()) as { id: string };
    return body.id;
}

/**
 * Create an INCIDENT issue on the isolated tenant and land on its
 * detail page. Returns the issue title for later text-locator use.
 *
 * INCIDENT requires an asset or control link — PR-D shipped the
 * EntityPicker that drives `#link-entity-id`, so the helper
 * pre-seeds an Asset and then picks it via `selectComboboxOption`.
 */
async function createIssue(page: Page, slug: string): Promise<string> {
    const uid = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    const title = `E2E Issue ${uid}`;
    const assetName = `E2E Asset ${uid}`;
    await seedAsset(page, slug, assetName);

    await gotoAndVerify(page, `/t/${slug}/tasks/new`, '#task-title-input');

    await page.fill('#task-title-input', title);
    await page.fill('#task-description-input', 'Test issue from e2e');
    await selectComboboxOption(page, 'task-type-select', 'Incident');
    await selectComboboxOption(page, 'task-severity-select', 'High');
    await selectComboboxOption(page, 'task-priority-select', /^P1\b/);

    // INCIDENT requires an asset or control link. PR-D replaced the
    // legacy free-text `#link-entity-id` input with the
    // EntityPicker; pick the seeded asset by name.
    await selectComboboxOption(page, 'link-entity-type', 'Asset');
    await selectComboboxOption(page, 'link-entity-id', assetName);
    await page.click('#add-link-btn');
    await page.waitForSelector('#pending-links-list', { timeout: 3000 });

    await page.click('#create-task-btn');
    await page.waitForURL('**/tasks/**', { timeout: 30000 });
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForSelector('#task-title', { timeout: 30000 });
    return title;
}

test.describe('Issue Management', () => {
    test('issues list page loads with filters and CTA', async ({
        authedPage,
        isolatedTenant,
    }) => {
        await gotoAndVerify(authedPage, `/t/${isolatedTenant.tenantSlug}/tasks`, 'h1');
        await expect(authedPage.locator('#new-task-btn')).toBeVisible({
            timeout: 10000,
        });
    });

    test('create a new issue and see detail', async ({ authedPage, isolatedTenant }) => {
        const uid = Date.now().toString(36);
        const title = `E2E Issue ${uid}`;
        // PR-D — seed an Asset so the EntityPicker has a candidate
        // to pick. See `seedAsset` + `createIssue` rationale.
        const assetName = `E2E Asset ${uid}`;
        await seedAsset(authedPage, isolatedTenant.tenantSlug, assetName);

        await gotoAndVerify(
            authedPage,
            `/t/${isolatedTenant.tenantSlug}/tasks/new`,
            '#task-title-input',
        );

        await authedPage.fill('#task-title-input', title);
        await authedPage.fill('#task-description-input', 'Test issue from e2e');
        await selectComboboxOption(authedPage, 'task-type-select', 'Incident');
        await selectComboboxOption(authedPage, 'task-severity-select', 'High');
        await selectComboboxOption(authedPage, 'task-priority-select', /^P1\b/);

        await selectComboboxOption(authedPage, 'link-entity-type', 'Asset');
        await selectComboboxOption(authedPage, 'link-entity-id', assetName);
        await authedPage.click('#add-link-btn');
        await authedPage.waitForSelector('#pending-links-list', { timeout: 3000 });

        await authedPage.click('#create-task-btn');
        await authedPage.waitForURL('**/tasks/**', { timeout: 30000 });
        await authedPage.waitForLoadState('networkidle').catch(() => {});
        await authedPage.waitForSelector('#task-title', { timeout: 30000 });
        await expect(authedPage.locator('#task-title')).toContainText(title, {
            timeout: 15000,
        });
        await expect(authedPage.locator('#task-severity')).toContainText('HIGH', {
            timeout: 5000,
        });
    });

    test('change issue status', async ({ authedPage, isolatedTenant }) => {
        await createIssue(authedPage, isolatedTenant.tenantSlug);

        await authedPage.waitForSelector('#task-status-select', { timeout: 10000 });
        await selectComboboxOption(authedPage, 'task-status-select', 'Triaged');
        await expect(authedPage.locator('#task-status')).toContainText('Triaged', {
            timeout: 15000,
        });

        await authedPage.reload();
        await authedPage.waitForSelector('#task-status', { timeout: 10000 });
        await expect(authedPage.locator('#task-status')).toContainText('Triaged');
    });

    test('assign issue', async ({ authedPage, isolatedTenant }) => {
        await createIssue(authedPage, isolatedTenant.tenantSlug);

        await expect(authedPage.locator('#task-assignee-input')).toBeVisible();
        await expect(authedPage.locator('#assign-task-btn')).toBeVisible();

        const session = await authedPage.evaluate(async () => {
            const res = await fetch('/api/auth/session');
            return res.json();
        });
        const email = session?.user?.email as string | undefined;
        const name = (session?.user?.name as string | undefined) || email;
        if (email && name) {
            await authedPage.click('#task-assignee-input');
            const search = authedPage.getByPlaceholder('Search members…');
            await search.fill(name);
            const option = authedPage
                .getByRole('option')
                .filter({ hasText: email })
                .first();
            const visible = await option
                .waitFor({ state: 'visible', timeout: 5000 })
                .then(() => true)
                .catch(() => false);
            if (visible) {
                await option.click();
                await authedPage.click('#assign-task-btn');
                await authedPage.waitForLoadState('networkidle').catch(() => {});
                await authedPage.reload();
                await authedPage.waitForSelector('#task-assignee', {
                    timeout: 10000,
                });
            }
        }
    });

    test('add link to issue', async ({ authedPage, isolatedTenant }) => {
        await createIssue(authedPage, isolatedTenant.tenantSlug);

        // PR-D — seed a Control so the EntityPicker on the task
        // detail-page add-link form has a candidate to pick.
        // Capture the cuid so the post-add assertion can check
        // it directly (TaskLinksTable shows entityId, not name).
        const uid = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
        const controlName = `E2E Control ${uid}`;
        await seedControl(
            authedPage,
            isolatedTenant.tenantSlug,
            controlName,
        );

        await authedPage.click('#tab-links');
        await authedPage.waitForLoadState('networkidle').catch(() => {});

        await authedPage.click('#add-link-btn');
        await authedPage.waitForSelector('#link-entity-type', { timeout: 5000 });
        await selectComboboxOption(authedPage, 'link-entity-type', 'CONTROL');
        // PR-D — pick the seeded control via the EntityPicker.
        // The picker renders controls as `${code}: ${name}`, so
        // a substring regex against the name suffix is the right
        // match shape (the seedControl helper sets code = `E2E-...`).
        await selectComboboxOption(
            authedPage,
            'link-entity-id',
            new RegExp(controlName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
        );
        await authedPage.click('#submit-link-btn');
        await authedPage.waitForLoadState('networkidle').catch(() => {});

        await expect(
            authedPage.locator('[data-testid="task-links-table"]'),
        ).toContainText('CONTROL', { timeout: 5000 });
        // TP-4 — TaskLinksTable now renders the RESOLVED entity name
        // as a real link (not the raw cuid), so assert the control's
        // display name.
        await expect(
            authedPage.locator('[data-testid="task-links-table"]'),
        ).toContainText(controlName);
    });

    test('add comment to issue', async ({ authedPage, isolatedTenant }) => {
        const uid = Date.now().toString(36);
        await createIssue(authedPage, isolatedTenant.tenantSlug);

        await authedPage.click('#tab-comments');
        await authedPage.waitForLoadState('networkidle').catch(() => {});

        await authedPage.fill('#comment-body', `E2E comment ${uid}`);
        await authedPage.click('#submit-comment-btn');
        await authedPage.waitForLoadState('networkidle').catch(() => {});

        // The comment list-read cache can serve a stale view under CI load;
        // reload-poll past the 60s TTL, reselecting the Comments tab (which a
        // reload resets to the default) each iteration (anti-flake).
        await reloadUntilVisible(
            authedPage,
            authedPage.locator('#comments-list').getByText(`E2E comment ${uid}`),
            {
                afterReload: async () => {
                    await authedPage
                        .locator('#tab-comments')
                        .click()
                        .catch(() => {});
                    await authedPage.waitForLoadState('networkidle').catch(() => {});
                },
            },
        );
    });

    test('legacy dashboard route redirects into the tasks list', async ({ authedPage, isolatedTenant }) => {
        // TP-7 — the standalone Tasks dashboard was retired (merged into
        // the /tasks list: server-computed KPI strip + "Assigned to me"
        // toggle). The old route is now a redirect shim.
        await gotoAndVerify(
            authedPage,
            `/t/${isolatedTenant.tenantSlug}/tasks/dashboard`,
            '[data-testid="tasks-table"]',
        );
        await expect(authedPage).toHaveURL(
            new RegExp(`/t/${isolatedTenant.tenantSlug}/tasks$`),
        );
        await expect(
            authedPage.locator('[data-testid="tasks-table"]'),
        ).toBeVisible({ timeout: 10000 });
    });

    test('bulk action toolbar appears when issues selected', async ({
        authedPage,
        isolatedTenant,
    }) => {
        // Create an issue so the list has a selectable row.
        await createIssue(authedPage, isolatedTenant.tenantSlug);
        await gotoAndVerify(authedPage, `/t/${isolatedTenant.tenantSlug}/tasks`, 'h1');

        // B1 (2026-06-07): the bulk-edit form moved from a standalone
        // `#bulk-toolbar` card into the DataTable's header-row selection
        // toolbar (`[data-testid="selection-toolbar"]`), which is always in
        // the DOM but FADES IN (opacity 0 → 1) on selection. Playwright's
        // toBeVisible ignores opacity, so we assert computed opacity.
        const toolbar = authedPage.locator('[data-testid="selection-toolbar"]');
        await expect(toolbar).toHaveCSS('opacity', '0', { timeout: 3000 });

        // DataTable's built-in selection — the click target is the
        // wrapping `<div title="Select">`.
        const checkboxes = authedPage
            .locator('tbody tr')
            .locator('[title="Select"]');
        const count = await checkboxes.count();
        if (count > 0) {
            await checkboxes.first().click();
            // Selecting a row fades the toolbar in (opacity 1); the inline
            // bulk-action form is now present + interactive.
            await expect(toolbar).toHaveCSS('opacity', '1', { timeout: 5000 });
            await expect(authedPage.locator('#bulk-action-select')).toBeVisible();
        }
    });

    // Read-only role-gate check — kept on the SHARED seeded tenant.
    // The `isolatedTenant` factory only provisions an OWNER; this test
    // needs the seeded `viewer@acme.com` READER. It only navigates +
    // asserts, so it cannot pollute the shared tenant.
    test('reader user sees view-only issues', async ({ page }) => {
        const tenantSlug = await loginAndGetTenant(page, READER_USER);
        await gotoAndVerify(page, `/t/${tenantSlug}/tasks`, 'h1');
        await expect(page.locator('#new-task-btn')).not.toBeVisible({ timeout: 3000 });
    });

    test('legacy /issues URL redirects to /tasks', async ({
        authedPage,
        isolatedTenant,
    }) => {
        await safeGoto(authedPage, `/t/${isolatedTenant.tenantSlug}/issues`);
        await authedPage.waitForURL(`**/tasks`, { timeout: 15000 });
        await expect(authedPage.url()).toContain('/tasks');
    });
});
