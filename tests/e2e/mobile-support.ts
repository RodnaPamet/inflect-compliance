/**
 * Shared steps of the mobile E2E specs: load a fixed route in a phone
 * configuration, measure it with the audit's own module, hold the four
 * zero-tolerance invariants, and compare the ratchet. See `mobile-ratchet.ts`
 * for the route set and the baselines.
 */
import path from 'node:path';
import { expect, type Browser, type BrowserContext, type Page, type TestInfo } from '@playwright/test';
import { PHONE_CONFIGS, contextOptionsFor, preferenceCookies } from '../../scripts/mobile-audit/configs';
import { findEnglishLeaks, loadLeakCatalog, type LeakCatalog } from '../../scripts/mobile-audit/leaks';
import { countsOf, measurePage, settlePage, ZERO_TOLERANCE_INVARIANTS, type MetricCounts, type RawMeasurement } from '../../scripts/mobile-audit/measure';
import { OPEN_STATES } from '../../scripts/mobile-audit/states';
import { safeGoto } from './e2e-utils';
import {
    DRIFT_ALLOWANCE,
    KNOWN_DEFECTS,
    RATCHETED_METRICS,
    type MobileE2eConfig,
    type RatchetedMetric,
} from './mobile-ratchet';

export const REPO_ROOT = path.resolve(__dirname, '..', '..');

let catalogPromise: Promise<LeakCatalog> | null = null;
export function leakCatalog(): Promise<LeakCatalog> {
    catalogPromise ??= loadLeakCatalog(REPO_ROOT);
    return catalogPromise;
}

/** A phone context for `config`, with the theme and locale cookies set. */
export async function phoneContext(browser: Browser, config: MobileE2eConfig, testInfo: TestInfo): Promise<BrowserContext> {
    const baseURL = testInfo.project.use.baseURL;
    if (!baseURL) throw new Error('the mobile project needs a baseURL');
    const ctx = await browser.newContext({ ...contextOptionsFor(PHONE_CONFIGS[config]), baseURL });
    await ctx.addCookies(preferenceCookies(PHONE_CONFIGS[config], baseURL));
    return ctx;
}

export interface RouteMeasurement {
    raw: RawMeasurement;
    counts: MetricCounts;
}

/** Load `url`, open `stateId` if given, and measure. Throws when the page cannot be loaded or the state opened. */
export async function measureRoute(
    page: Page,
    url: string,
    stateId: string | undefined,
    dataNames: ReadonlySet<string>,
): Promise<RouteMeasurement> {
    const res = await safeGoto(page, url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    if (res && res.status() >= 500) throw new Error(`${url} answered HTTP ${res.status()}`);
    await page.locator('main, #credentials-form').first().waitFor({ state: 'visible', timeout: 60_000 });
    await settlePage(page);
    if (stateId) {
        const state = OPEN_STATES.find((s) => s.id === stateId);
        if (!state) throw new Error(`no open state ${stateId} in scripts/mobile-audit/states.ts`);
        await state.open(page);
    }
    const raw = await measurePage(page, { scrollToEnd: !stateId });
    const leaks = findEnglishLeaks(raw, await leakCatalog(), dataNames);
    return { raw, counts: countsOf(raw, { englishLeaks: leaks.length, consoleErrors: 0 }) };
}

/** Soft-assert the four invariants for one route; a `KNOWN_DEFECTS` entry flips its assertion. */
export function holdInvariants(key: string, config: MobileE2eConfig, raw: RawMeasurement): void {
    for (const inv of ZERO_TOLERANCE_INVARIANTS) {
        const m = raw[inv];
        const known = KNOWN_DEFECTS.find((d) => d.key === key && d.invariant === inv && (!d.configs || d.configs.includes(config)));
        const where = `${key} @ ${config}`;
        if (known) {
            expect.soft(m.count, `${where}: ${inv} no longer reproduces — delete its KNOWN_DEFECTS entry (#${known.issue}) in tests/e2e/mobile-ratchet.ts`).toBeGreaterThan(0);
        } else {
            const detail = m.samples.map((s) => `${s.el} "${s.text}" @${s.box.join(',')}`).join('\n    ');
            expect.soft(m.count, `${where}: ${inv}\n    ${detail}`).toBe(0);
        }
    }
}

/** Routes failing each ratcheted metric. */
export function failingRoutes(all: ReadonlyArray<MetricCounts>): Record<RatchetedMetric, number> {
    return Object.fromEntries(
        RATCHETED_METRICS.map((m) => [m, all.filter((c) => c[m] > 0).length]),
    ) as Record<RatchetedMetric, number>;
}

/** The ratchet: equal to the baseline, give or take `DRIFT_ALLOWANCE` (0). */
export function holdRatchet(
    label: string,
    config: MobileE2eConfig,
    actual: Record<RatchetedMetric, number>,
    baseline: Record<RatchetedMetric, number>,
): void {
    for (const m of RATCHETED_METRICS) {
        expect.soft(
            actual[m],
            `${label} @ ${config}: routes failing ${m} ROSE above the baseline — a page regressed on a phone`,
        ).toBeLessThanOrEqual(baseline[m] + DRIFT_ALLOWANCE);
        expect.soft(
            actual[m],
            `${label} @ ${config}: routes failing ${m} FELL to ${actual[m]} — lower its baseline in tests/e2e/mobile-ratchet.ts in this diff`,
        ).toBeGreaterThanOrEqual(baseline[m] - DRIFT_ALLOWANCE);
    }
}
