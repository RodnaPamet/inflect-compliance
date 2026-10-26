/**
 * Control → Evidence linking — mutating E2E.
 *
 * Isolation: every `test()` runs on its own fresh, empty tenant via
 * the `isolatedTenant` fixture. Each test mints the control (and,
 * where needed, the linked evidence) it operates on inside its own
 * body — no `controlDetailPath` is carried across tests in a
 * module-level `let`. A failed setup degrades to one red test
 * instead of cascading through the whole file.
 *
 * All selectors use existing id attributes — no data-testid additions.
 */
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { TENANT_TX_OPTIONS } from '../../src/lib/db/concurrency-limits';

/** Create a control on the isolated tenant; return its detail path. */
async function createControl(page: Page, slug: string): Promise<string> {
    const uid = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    await page.goto(`/t/${slug}/controls/new`);
    await page.waitForSelector('#control-name-input', { timeout: 15000 });
    await page.fill('#control-name-input', `Evidence Test ${uid}`);
    await page.fill('#control-code-input', `EV-${uid}`);
    await page.click('#create-control-btn');
    await page.waitForSelector('#control-title', { timeout: 60000 });
    return new URL(page.url()).pathname;
}

/**
 * Insert a PLAIN link (a `ControlEvidenceLink` row of kind LINK) on a
 * control, straight into the database. Nothing in the product writes one any
 * more — a link added on the Evidence tab, in the controls list's edit panel
 * or through `POST /controls/:id/evidence` is a library record (#4126) — but
 * rows saved before that still show and can still be removed. Such a row is
 * legacy data, so it is seeded the way legacy data exists: as a row. The
 * connection is the one `global-teardown.ts` uses.
 */
async function seedPlainLink(
    tenant: { tenantId: string; ownerUserId: string },
    controlDetailPath: string,
    note: string,
): Promise<void> {
    const controlId = controlDetailPath.split('/').filter(Boolean).pop() ?? '';
    const prisma = new PrismaClient({
        adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
        transactionOptions: TENANT_TX_OPTIONS,
    });
    try {
        await prisma.controlEvidenceLink.create({
            data: {
                tenantId: tenant.tenantId,
                controlId,
                kind: 'LINK',
                url: 'https://example.com/plain-link',
                note,
                createdByUserId: tenant.ownerUserId,
            },
        });
    } finally {
        await prisma.$disconnect();
    }
}

test.describe('Control → Evidence Linking', () => {
    test('create control for evidence linking', async ({ authedPage, isolatedTenant }) => {
        const uid = Date.now().toString(36);
        await authedPage.goto(`/t/${isolatedTenant.tenantSlug}/controls/new`);
        await authedPage.waitForSelector('#control-name-input', { timeout: 15000 });

        await authedPage.fill('#control-name-input', `Evidence Test ${uid}`);
        await authedPage.fill('#control-code-input', `EV-${uid}`);
        await authedPage.click('#create-control-btn');
        await authedPage.waitForSelector('#control-title', { timeout: 60000 });
        await expect(authedPage.locator('#control-title')).toContainText(
            `Evidence Test ${uid}`,
        );
    });

    test('evidence tab starts empty', async ({ authedPage, isolatedTenant }) => {
        const controlDetailPath = await createControl(
            authedPage,
            isolatedTenant.tenantSlug,
        );
        await authedPage.goto(controlDetailPath);
        await authedPage.waitForSelector('#control-title', { timeout: 15000 });

        await authedPage.click('#tab-evidence');
        await expect(authedPage.locator('#no-evidence')).toBeVisible({ timeout: 5000 });
    });

    test('link URL evidence from control context', async ({
        authedPage,
        isolatedTenant,
    }) => {
        const uid = Date.now().toString(36);
        const controlDetailPath = await createControl(
            authedPage,
            isolatedTenant.tenantSlug,
        );
        await authedPage.goto(controlDetailPath);
        await authedPage.waitForSelector('#control-title', { timeout: 15000 });

        await authedPage.click('#tab-evidence');
        await authedPage.click('#link-evidence-btn');
        await authedPage.fill('#evidence-url-input', 'https://example.com/evidence-doc');
        // A link is a library record, so it is named by the Title field.
        await authedPage.fill('#control-upload-title', `Test link ${uid}`);
        await authedPage.click('#submit-evidence-btn');

        const table = authedPage.locator('#evidence-table');
        await expect(table).toBeVisible({ timeout: 10000 });
        await expect(table).toContainText(`Test link ${uid}`);
        await expect(table).toContainText('https://example.com/evidence-doc');
        // A library record, so it has a review status (#4126).
        await expect(table).toContainText('Draft');

        // …and it is in the evidence library, where it can be reviewed.
        await authedPage.goto(`/t/${isolatedTenant.tenantSlug}/evidence`);
        await expect(
            authedPage.getByRole('main').getByText(`Test link ${uid}`).first(),
        ).toBeVisible({ timeout: 15000 });
    });

    test('a link sent to the API is a library record, titled by its note', async ({
        authedPage,
        isolatedTenant,
    }) => {
        const uid = Date.now().toString(36);
        const controlDetailPath = await createControl(authedPage, isolatedTenant.tenantSlug);
        const controlId = controlDetailPath.split('/').filter(Boolean).pop();

        // The route the API and the controls list's edit panel share. It used
        // to write a plain link nothing in the library could review.
        const res = await authedPage.request.post(
            `/api/t/${isolatedTenant.tenantSlug}/controls/${controlId}/evidence`,
            { data: { kind: 'LINK', url: 'https://example.com/api-link', note: `API link ${uid}` } },
        );
        expect(res.status()).toBe(201);
        expect(await res.json()).toMatchObject({ type: 'LINK', status: 'DRAFT', title: `API link ${uid}` });

        await authedPage.goto(controlDetailPath);
        await authedPage.waitForSelector('#control-title', { timeout: 15000 });
        await authedPage.click('#tab-evidence');
        const table = authedPage.locator('#evidence-table');
        await expect(table).toContainText(`API link ${uid}`, { timeout: 10000 });
        await expect(table).toContainText('Draft');
        await expect(table).not.toContainText('Plain link');

        await authedPage.goto(`/t/${isolatedTenant.tenantSlug}/evidence`);
        await expect(
            authedPage.getByRole('main').getByText(`API link ${uid}`).first(),
        ).toBeVisible({ timeout: 15000 });
    });

    test('the + Evidence form offers both file upload and URL link', async ({
        authedPage,
        isolatedTenant,
    }) => {
        const controlDetailPath = await createControl(
            authedPage,
            isolatedTenant.tenantSlug,
        );
        await authedPage.goto(controlDetailPath);
        await authedPage.waitForSelector('#control-title', { timeout: 15000 });

        await authedPage.click('#tab-evidence');
        // The separate "Upload Evidence" button was merged into "+ Evidence".
        await authedPage.click('#link-evidence-btn');
        await expect(authedPage.locator('#control-evidence-form')).toBeVisible({
            timeout: 5000,
        });
        // File-upload section (browse + title) now lives in this one form…
        await expect(authedPage.locator('#control-file-input')).toBeVisible();
        await expect(authedPage.locator('#control-upload-title')).toBeVisible();
        // …alongside the URL-link section.
        await expect(authedPage.locator('#evidence-url-input')).toBeVisible();
    });

    test('unlink evidence removes it from tab', async ({
        authedPage,
        isolatedTenant,
    }) => {
        const uid = Date.now().toString(36);
        const controlDetailPath = await createControl(
            authedPage,
            isolatedTenant.tenantSlug,
        );
        await authedPage.goto(controlDetailPath);
        await authedPage.waitForSelector('#control-title', { timeout: 15000 });

        // This test needs a row to unlink — seed an older plain link.
        await seedPlainLink(isolatedTenant, controlDetailPath, `Test link ${uid}`);
        await authedPage.reload();
        await authedPage.waitForSelector('#control-title', { timeout: 15000 });
        await authedPage.click('#tab-evidence');
        await expect(authedPage.locator('#evidence-table')).toBeVisible({ timeout: 10000 });
        // Labelled as a plain link with no review status, note included.
        await expect(authedPage.locator('#evidence-table')).toContainText('Plain link');
        await expect(authedPage.locator('#evidence-table')).toContainText('No review status');
        await expect(authedPage.locator('#evidence-table')).toContainText(`Test link ${uid}`);

        // Count rows before
        const rowsBefore = await authedPage
            .locator('#evidence-table tbody tr')
            .count();
        expect(rowsBefore).toBeGreaterThan(0);

        // Click the first remove button
        const removeBtn = authedPage
            .locator('#evidence-table tbody tr button')
            .first();
        await removeBtn.click();

        // Wait for refetch — row count should decrease
        await expect(async () => {
            const rowsAfter = await authedPage
                .locator('#evidence-table tbody tr')
                .count();
            expect(rowsAfter).toBeLessThan(rowsBefore);
        }).toPass({ timeout: 15000 });
    });
});
