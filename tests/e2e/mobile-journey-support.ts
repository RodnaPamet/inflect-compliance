/**
 * Shared steps of the key phone journeys (`mobile-journeys.spec.ts`, Phase 5
 * of docs/mobile-roadmap.md): put a page on a phone, create records through
 * the product's own API, and hold each screen a journey passes through to the
 * phone invariants the fixed routes are held to.
 *
 * A journey's screens are held to the four zero-tolerance invariants
 * (`ZERO_TOLERANCE_INVARIANTS` in scripts/mobile-audit/measure.ts), to no text
 * clipped at the screen edge, to no English on the Bulgarian page, and its
 * primary action to the size a thumb needs. Every screen is the journey's own
 * isolated tenant, so the counts cannot move with another spec's data.
 */
import { createHmac } from 'node:crypto';
import { expect, test, type APIResponse, type Browser, type Page, type TestInfo } from '@playwright/test';
import { PHONE_CONFIGS, preferenceCookies } from '../../scripts/mobile-audit/configs';
import { findEnglishLeaks } from '../../scripts/mobile-audit/leaks';
import { measurePage, settlePage, ZERO_TOLERANCE_INVARIANTS } from '../../scripts/mobile-audit/measure';
import { createIsolatedTenant, signInAs, type IsolatedTenantCredentials } from './e2e-utils';
import { leakCatalog } from './mobile-support';
import type { MobileE2eConfig } from './mobile-ratchet';

/** Resize the page to `config` and set its theme and language. */
export async function onPhone(page: Page, config: MobileE2eConfig, testInfo: TestInfo): Promise<void> {
    const baseURL = testInfo.project.use.baseURL;
    if (!baseURL) throw new Error('the mobile project needs a baseURL');
    const phone = PHONE_CONFIGS[config];
    await page.setViewportSize({ width: phone.width, height: phone.height });
    await page.context().addCookies(preferenceCookies(phone, baseURL));
}

/** The JSON body of a create call, or a failure naming what could not be made. */
export async function created<T = { id: string }>(res: APIResponse, what: string): Promise<T> {
    if (!res.ok()) throw new Error(`creating ${what} failed: ${res.status()} ${(await res.text()).slice(0, 400)}`);
    return (await res.json()) as T;
}

/** A POST to the tenant API as the signed-in page. */
export function tenantApi(page: Page, tenantSlug: string) {
    return (path: string, data?: unknown) =>
        page.request.post(`/api/t/${tenantSlug}${path}`, {
            headers: { 'Content-Type': 'application/json' },
            data: data === undefined ? undefined : (data as Record<string, unknown>),
            failOnStatusCode: false,
        });
}

/**
 * A second person in the journey's tenant: registered on their own (which
 * gives them a tenant of their own, tracked for teardown like every isolated
 * tenant), invited by the signed-in owner with `role`, and redeeming the
 * invite from their own browser session — the product's own path, never a
 * database write.
 */
export async function addMember(
    page: Page,
    browser: Browser,
    tenantSlug: string,
    role: 'OWNER' | 'ADMIN' | 'EDITOR' | 'READER' | 'AUDITOR',
    testInfo: TestInfo,
): Promise<IsolatedTenantCredentials> {
    const baseURL = testInfo.project.use.baseURL;
    if (!baseURL) throw new Error('the mobile project needs a baseURL');
    // Its own request context: registering through the page's would replace the owner's session.
    const person = await createIsolatedTenant({ baseURL, namePrefix: 'mobile-journey-member' });
    const invite = await created<{ invite: { token: string } }>(
        await tenantApi(page, tenantSlug)('/admin/invites', { email: person.ownerEmail, role }),
        'an invite',
    );
    const ctx = await browser.newContext({ baseURL, ignoreHTTPSErrors: true });
    try {
        const theirs = await ctx.newPage();
        await signInAs(theirs, person);
        await created(await theirs.request.post(`/api/invites/${invite.invite.token}`, { failOnStatusCode: false }), 'the redeemed invite');
    } finally {
        await ctx.close();
    }
    return person;
}

/**
 * Hold the screen the journey is on: the zero-tolerance invariants, no text
 * cut at the screen edge, and no English on the Bulgarian page. Soft, so one
 * run reports every defect on the screen. `dataNames` are the records the
 * journey made (English on purpose, like the seed's).
 */
export async function holdScreen(page: Page, label: string, dataNames: readonly string[] = []): Promise<void> {
    await settlePage(page);
    // The leak check means nothing on a page that is not in Bulgarian.
    await expect(page.locator('html'), `${label}: the page is in Bulgarian`).toHaveAttribute('lang', /^bg/);
    await test.info().attach(`${label}.jpg`, {
        body: await page.screenshot({ type: 'jpeg', quality: 60 }),
        contentType: 'image/jpeg',
    });
    const m = await measurePage(page, { scrollToEnd: false });
    const detail = (k: keyof typeof m) => {
        const v = m[k] as { samples?: Array<{ el: string; text: string; box: number[] }> };
        return (v.samples ?? []).map((s) => `${s.el} "${s.text}" @${s.box.join(',')}`).join('\n    ');
    };
    for (const inv of ZERO_TOLERANCE_INVARIANTS) {
        expect.soft(m[inv].count, `${label}: ${inv}\n    ${detail(inv)}`).toBe(0);
    }
    expect.soft(m.clippedText.count, `${label}: clippedText\n    ${detail('clippedText')}`).toBe(0);
    const leaks = findEnglishLeaks(m, await leakCatalog(), new Set(dataNames));
    expect.soft(leaks, `${label}: English on a Bulgarian page`).toEqual([]);
    await page.evaluate(() => window.scrollTo(0, 0));
}

/**
 * The journey's primary action: on screen once scrolled to, and at least
 * 44 px on its short side, the size docs/mobile-roadmap.md's Phase 5 asks of
 * every primary action.
 */
export async function expectThumbSized(action: ReturnType<Page['locator']>, label: string): Promise<void> {
    await action.scrollIntoViewIfNeeded();
    await expect(action, `${label}: the primary action is on screen`).toBeInViewport();
    const box = await action.boundingBox();
    expect(box, `${label}: the primary action has a box`).not.toBeNull();
    expect.soft(Math.min(box!.width, box!.height), `${label}: the primary action is at least 44 px`).toBeGreaterThanOrEqual(44);
}

/** RFC 6238 TOTP (SHA-1, 6 digits, 30 s) for the time step `step`, as an authenticator app computes it. */
export function totpAt(base32Secret: string, step: number): string {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = '';
    for (const c of base32Secret.replace(/=+$/, '').toUpperCase()) {
        const v = alphabet.indexOf(c);
        if (v < 0) throw new Error('the secret is not base32');
        bits += v.toString(2).padStart(5, '0');
    }
    const key = Buffer.from((bits.match(/.{8}/g) ?? []).map((b) => parseInt(b, 2)));
    const counter = Buffer.alloc(8);
    counter.writeUInt32BE(Math.floor(step / 0x100000000), 0);
    counter.writeUInt32BE(step % 0x100000000, 4);
    const hmac = createHmac('sha1', key).update(counter).digest();
    const offset = hmac[hmac.length - 1] & 0x0f;
    const code = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
    return String(code % 1_000_000).padStart(6, '0');
}

/** The current TOTP time step. */
export const totpStepNow = (): number => Math.floor(Date.now() / 1000 / 30);
