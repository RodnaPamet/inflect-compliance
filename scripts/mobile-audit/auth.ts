/**
 * Sign the audit's browser contexts in, the way the E2E suite does.
 *
 * Tenant pages are captured as the seeded tenant OWNER through
 * `loginAndGetTenant` (`tests/e2e/e2e-utils.ts`) itself. Org pages need the
 * seeded ORG_OWNER, whose sign-in lands outside a tenant, so that helper (which
 * waits for a tenant dashboard) cannot be reused; `signInAnywhere` fills the
 * same `#credentials-form` and waits for the URL to leave `/login`.
 */
import type { BrowserContext, Page } from '@playwright/test';
import { DEFAULT_USER, loginAndGetTenant, safeGoto } from '../../tests/e2e/e2e-utils';

export const TENANT_USER = DEFAULT_USER;
export const ORG_USER = { email: 'ciso@acme.com', password: DEFAULT_USER.password };

export async function signInAnywhere(page: Page, user: { email: string; password: string }): Promise<void> {
    await safeGoto(page, '/login', { timeout: 90_000 });
    const form = page.locator('#credentials-form');
    await form.locator('input[type="email"][name="email"]').waitFor({ state: 'visible', timeout: 30_000 });
    await page.waitForFunction(() => {
        const f = document.querySelector('#credentials-form');
        return !!f && Object.keys(f).some((k) => k.startsWith('__reactEvents') || k.startsWith('__reactFiber'));
    }, undefined, { timeout: 30_000 });
    await form.locator('input[type="email"][name="email"]').fill(user.email);
    await form.locator('input[type="password"]').fill(user.password);
    await form.locator('button[type="submit"]').click();
    await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 60_000 });
}

/** Sign `context` in as the tenant OWNER; returns the tenant slug it landed on. */
export async function signInTenantContext(context: BrowserContext): Promise<string> {
    const page = await context.newPage();
    try {
        return await loginAndGetTenant(page, TENANT_USER);
    } finally {
        await page.close();
    }
}

/** Sign `context` in as the org owner. */
export async function signInOrgContext(context: BrowserContext): Promise<void> {
    const page = await context.newPage();
    try {
        await signInAnywhere(page, ORG_USER);
    } finally {
        await page.close();
    }
}
