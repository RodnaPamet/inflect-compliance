/**
 * Epic O-4 — CISO portfolio journey (E2E).
 *
 * Walks the full hub-and-spoke flow against the production-mode
 * Next server, the seeded `acme-org` Organization, and the seeded
 * `acme-corp` child Tenant (which already has controls / risks /
 * evidence courtesy of `prisma/seed.ts`):
 *
 *   A. Login as `ciso@acme.com` (ORG_ADMIN of acme-org, AUDITOR
 *      of acme-corp). Confirms the read-only AUDITOR badge on the
 *      tenant chrome.
 *
 *   B. Portfolio overview at `/org/acme-org` renders the four stat
 *      cards + the drill-down CTAs + the per-tenant coverage list.
 *
 *   C. Drill-down lists at `/org/acme-org/{controls,risks,evidence}`
 *      render with tenant attribution columns. The first risk row
 *      links to `/t/acme-corp/risks/{id}` and lands on the per-
 *      tenant detail page (RLS-enforced read via the auto-
 *      provisioned AUDITOR membership).
 *
 *   D. Read-only invariant: the AUDITOR membership grants no
 *      `canWrite`, so the tenant risks list must NOT render
 *      `#new-risk-btn`.
 *
 *   E. Tenant creation via `/org/acme-org/tenants/new`. Confirms
 *      the new tenant appears in the org tenants list. We do NOT
 *      navigate into the new tenant — the in-flight session JWT
 *      doesn't carry the just-issued OWNER membership until next
 *      refresh, and the middleware tenant-access gate is JWT-bound
 *      (separate concern, predates Epic O-4).
 *
 *   F. OrgSwitcher pivots from portfolio context to a tenant
 *      workspace via the sidebar header dropdown.
 *
 * Each test re-logs in and re-navigates from scratch — matches the
 * pattern in `core-flow.spec.ts` so a single failure doesn't cascade
 * across the suite.
 */
import { test, expect } from '@playwright/test';
import { type Page } from '@playwright/test';
import { safeGoto, waitForHydration } from './e2e-utils';

const CISO = { email: 'ciso@acme.com', password: 'password123' };
const ORG_SLUG = 'acme-org';
const SEED_TENANT = 'acme-corp';

/**
 * CISO-aware login helper.
 *
 * `loginAndGetTenant` from `e2e-utils` only succeeds when the user
 * has a single TenantMembership (post-login redirect lands directly
 * on `/t/{slug}/dashboard`). Once test G creates a 2nd tenant, the
 * CISO has two memberships and post-login lands on the `/tenants`
 * picker. This helper handles both cases — single-tenant fast path
 * and multi-tenant picker — and returns the seeded tenant slug.
 */
async function loginAsCiso(page: Page, preferredTenant = SEED_TENANT): Promise<string> {
    await safeGoto(page, '/login', { timeout: 90_000 });

    const credentialsForm = page.locator('#credentials-form');
    const emailInput = credentialsForm.locator('input[type="email"][name="email"]');
    await emailInput.waitFor({ state: 'visible', timeout: 30_000 });

    // Wait for React hydration so onSubmit is wired up.
    await page.waitForFunction(() => {
        const form = document.querySelector('form');
        return form && Object.keys(form).some(k => k.startsWith('__reactEvents') || k.startsWith('__reactFiber'));
    }, { timeout: 30_000 });

    await emailInput.fill(CISO.email);
    await credentialsForm.locator('input[type="password"]').fill(CISO.password);
    await credentialsForm.locator('button[type="submit"]').click();

    // Post-login lands on either `/t/{slug}/dashboard` (single
    // membership) or `/tenants` (picker). Wait for either, then
    // pivot to the preferred tenant if we hit the picker.
    await page.waitForURL(
        (url) =>
            /\/t\/[^/]+\/dashboard/.test(url.pathname) ||
            url.pathname === '/tenants',
        { waitUntil: 'domcontentloaded', timeout: 60_000 },
    );

    if (page.url().includes('/tenants')) {
        const link = page.locator(`a[href="/t/${preferredTenant}/dashboard"]`).first();
        await link.waitFor({ state: 'visible', timeout: 30_000 });
        await link.click();
        await page.waitForURL(new RegExp(`/t/${preferredTenant}/dashboard`), {
            waitUntil: 'domcontentloaded',
            timeout: 30_000,
        });
    }

    // Verify the tenant chrome rendered.
    await page.locator('aside').first().waitFor({ state: 'visible', timeout: 30_000 });

    const match = new URL(page.url()).pathname.match(/^\/t\/([^/]+)\//);
    if (!match) throw new Error('Could not extract tenant slug from ' + page.url());
    return match[1];
}

test.describe('CISO portfolio journey (Epic O-4)', () => {
    test.describe.configure({ mode: 'serial' });

    test('A — login as CISO and land on the auto-provisioned AUDITOR tenant', async ({ page }) => {
        const slug = await loginAsCiso(page);
        // CISO's only seeded TenantMembership is acme-corp/AUDITOR.
        expect(slug).toBe(SEED_TENANT);

        // Role pill in the sidebar reflects the AUDITOR posture.
        await expect(
            page.locator('aside').getByText(/AUDITOR/i).first(),
        ).toBeVisible({ timeout: 15_000 });
    });

    test('B — portfolio overview renders four stat cards + drill-down CTAs + tenant list', async ({ page }) => {
        await loginAsCiso(page);
        await safeGoto(page, `/org/${ORG_SLUG}`);

        await expect(
            page.getByRole('heading', { name: /Portfolio Overview/i }),
        ).toBeVisible({ timeout: 30_000 });

        // Four stat cards are present and rendered.
        //
        // All `#org-*` id locators in this spec are scoped to
        // `getByRole('main')`. Next's streaming render can briefly leave a
        // hidden duplicate of the page subtree in the DOM, so a BARE
        // `page.locator('#org-…')` intermittently matches 2 elements and trips
        // Playwright's strict-mode "resolved to N elements" — the
        // `#org-risks-table` / `#org-controls-table` flake. The real node lives
        // inside `<main>`; scoping there is unambiguous.
        await expect(page.getByRole('main').locator('#org-stat-coverage')).toBeVisible();
        await expect(page.getByRole('main').locator('#org-stat-critical-risks')).toBeVisible();
        await expect(page.getByRole('main').locator('#org-stat-overdue-evidence')).toBeVisible();
        await expect(page.getByRole('main').locator('#org-stat-tenants')).toBeVisible();

        // Drill-down + tenant coverage sections are present.
        await expect(page.getByRole('main').locator('#org-drilldown-ctas')).toBeVisible();
        await expect(page.getByRole('main').locator('#org-tenant-coverage')).toBeVisible();

        // The seeded acme-corp tenant is rendered as a clickable row.
        await expect(
            page.locator(`[data-testid="org-tenant-row-${SEED_TENANT}"]`).first(),
        ).toBeVisible({ timeout: 15_000 });
    });

    test('C — controls drill-down lists rows with tenant attribution', async ({ page }) => {
        await loginAsCiso(page);
        await safeGoto(page, `/org/${ORG_SLUG}/controls`);

        // Either rows or the empty state — both prove the page rendered
        // through getNonPerformingControls without an error.
        await expect(page.getByRole('main').locator('#org-controls-table')).toBeVisible({
            timeout: 30_000,
        });

        const hasRow = await page
            .locator(`[data-testid="org-control-tenant-${SEED_TENANT}"]`)
            .first()
            .isVisible()
            .catch(() => false);
        const hasEmpty = await page
            .getByText(/All controls performing/i)
            .first()
            .isVisible()
            .catch(() => false);
        expect(hasRow || hasEmpty).toBe(true);
    });

    test('D — risks drill-down → click row → land on /t/acme-corp/risks/{id}', async ({ page }) => {
        await loginAsCiso(page);
        await safeGoto(page, `/org/${ORG_SLUG}/risks`);
        await expect(page.getByRole('main').locator('#org-risks-table')).toBeVisible({
            timeout: 30_000,
        });

        const firstRiskLink = page
            .locator('[data-testid^="org-risk-link-"]')
            .first();

        if ((await firstRiskLink.count()) > 0) {
            // Tenant attribution surfaced alongside the row.
            await expect(
                page
                    .locator(`[data-testid="org-risk-tenant-${SEED_TENANT}"]`)
                    .first(),
            ).toBeVisible({ timeout: 15_000 });

            await firstRiskLink.click();
            await page.waitForURL(
                new RegExp(`/t/${SEED_TENANT}/risks/[^/?#]+`),
                { timeout: 30_000 },
            );
            // Per-tenant page rendered (sidebar + main visible).
            await expect(page.locator('aside').first()).toBeVisible({
                timeout: 30_000,
            });
        } else {
            // No critical risks seeded today — assert the empty state
            // copy so we know the page rendered cleanly.
            await expect(
                page.getByText(/No critical risks/i).first(),
            ).toBeVisible({ timeout: 15_000 });
        }
    });

    test('E — overdue evidence list renders with tenant attribution or empty state', async ({ page }) => {
        await loginAsCiso(page);
        await safeGoto(page, `/org/${ORG_SLUG}/evidence`);
        await expect(page.getByRole('main').locator('#org-evidence-table')).toBeVisible({
            timeout: 30_000,
        });

        const hasRow = await page
            .locator('[data-testid^="org-evidence-tenant-"]')
            .first()
            .isVisible()
            .catch(() => false);
        const hasEmpty = await page
            .getByText(/No overdue evidence/i)
            .first()
            .isVisible()
            .catch(() => false);
        expect(hasRow || hasEmpty).toBe(true);
    });

    test('F — read-only invariant: AUDITOR cannot create tenant-level records', async ({ page }) => {
        await loginAsCiso(page);
        await safeGoto(page, `/t/${SEED_TENANT}/risks`);

        // Wait for the tenant chrome to come up.
        await expect(page.locator('aside').first()).toBeVisible({
            timeout: 30_000,
        });
        await page.waitForLoadState('networkidle').catch(() => { /* best-effort */ });

        // The "+ New Risk" button is gated by `permissions.canWrite` —
        // AUDITOR never has it. Absence of the button is the read-only
        // proof.
        await expect(page.locator('#new-risk-btn')).toHaveCount(0);
    });

    test('G — CISO creates a 2nd tenant via /org/{slug}/tenants/new', async ({ page }) => {
        // Generate the slug INSIDE the test so each Playwright retry
        // gets a fresh value. Module-level UNIQUE persists across
        // retries within the same worker, and a retry would collide
        // with the slug the previous attempt already committed.
        const attemptUnique =
            Date.now().toString(36).slice(-6) +
            Math.floor(Math.random() * 1000).toString(36);
        const attemptSlug = `e2e-portfolio-${attemptUnique}`;
        const attemptName = `E2E Portfolio Tenant ${attemptUnique}`;

        await loginAsCiso(page);
        await safeGoto(page, `/org/${ORG_SLUG}/tenants/new`);

        // Scoped to `main` like every other locator in this spec (see the
        // note in test B): the streaming duplicate of the page made a bare
        // `[data-testid="org-new-tenant-form"]` resolve to 2 elements.
        const main = page.getByRole('main');
        await expect(
            main.locator('[data-testid="org-new-tenant-form"]'),
        ).toBeVisible({ timeout: 30_000 });

        // The slug field auto-fills via a debounced effect after
        // name input. Wait for it to settle (any non-empty value),
        // THEN replace with a collision-proof slug. Without the
        // wait, the auto-fill can fire AFTER our `fill` call and
        // overwrite the collision-proof value back to a name-
        // derived slug — which collides with prior runs and the
        // create POST 409s. That race showed up as the test being
        // marked "flaky" in CI.
        //
        // The name is typed INSIDE the retry because the form can remount
        // once while the page hydrates (its inputs' ids change from the
        // server-rendered `_R_…` to a client `_r_…`). A name typed into the
        // first copy is then gone, the auto-fill never runs, and a single
        // fill waits out its whole timeout on an empty slug.
        const nameInput = main.locator('[data-testid="org-new-tenant-name"]');
        const slugInput = main.locator('[data-testid="org-new-tenant-slug"]');
        await expect(async () => {
            await nameInput.fill(attemptName);
            await expect(slugInput).not.toHaveValue('', { timeout: 2_000 });
        }).toPass({ timeout: 20_000 });
        await slugInput.fill(attemptSlug);
        // Re-assert after a short settle window — if a debounced
        // effect tries to overwrite the slug again, this fails
        // deterministically rather than producing a 409 later.
        await expect(slugInput).toHaveValue(attemptSlug, { timeout: 5_000 });
        // "Choose later" — keeps the post-create redirect to a stable
        // surface that doesn't depend on the framework catalog.
        await main.locator('[data-testid="org-new-tenant-framework-later"]').click();

        await main.locator('[data-testid="org-new-tenant-submit"]').click();

        // The form attempts to redirect to /t/{newSlug}/dashboard. The
        // user's in-flight JWT doesn't carry the new OWNER membership
        // yet, so middleware bounces on /t/* — that's a known pre-Epic-
        // O-4 limitation. We only need to confirm the row was actually
        // created, which we verify on the org tenants list.
        await page.waitForURL(/\/(?:t|org|no-tenant|tenants)\b/, { timeout: 30_000 }).catch(() => {
            /* the URL may settle on an error or picker — fine */
        });

        await safeGoto(page, `/org/${ORG_SLUG}/tenants`);
        await expect(page.getByRole('main').locator('#org-tenants-table')).toBeVisible({
            timeout: 30_000,
        });
        // The newly-created tenant can lag on the org list (async provisioning
        // + list revalidation), so reload-poll until the row shows rather than
        // a single bounded wait (anti-flake).
        const newTenantLink = page.locator(
            `[data-testid="org-tenant-link-${attemptSlug}"]`,
        );
        await expect(async () => {
            if (!(await newTenantLink.isVisible().catch(() => false))) {
                await page.reload({ waitUntil: 'domcontentloaded' });
            }
            await expect(newTenantLink).toBeVisible({ timeout: 5_000 });
        }).toPass({ timeout: 75_000 });
    });

    test('H — OrgSwitcher pivots from portfolio context into a tenant workspace', async ({ page }) => {
        await loginAsCiso(page);
        await safeGoto(page, `/org/${ORG_SLUG}`);

        // Sidebar must be hydrated before the popover trigger fires.
        await waitForHydration(page, 'aside').catch(() => {
            /* best-effort */
        });

        const trigger = page
            .locator('[data-testid="org-switcher-trigger"]')
            .first();
        await expect(trigger).toBeVisible({ timeout: 15_000 });
        await trigger.click();

        await expect(
            page.locator('[data-testid="org-switcher-portfolio"]').first(),
        ).toBeVisible({ timeout: 10_000 });

        const tenantRow = page
            .locator(`[data-testid="org-switcher-tenant-${SEED_TENANT}"]`)
            .first();
        await expect(tenantRow).toBeVisible({ timeout: 15_000 });

        await tenantRow.click();
        await page.waitForURL(
            new RegExp(`/t/${SEED_TENANT}/dashboard`),
            { timeout: 30_000 },
        );
        await expect(page.locator('aside').first()).toBeVisible({
            timeout: 30_000,
        });
    });
});
