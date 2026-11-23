/**
 * The phone configurations the audit and the mobile E2E project capture.
 *
 * Bulgarian is the longer language, so it is where wrapping breaks first; the
 * light + English configuration exists to catch what only the other theme or
 * the other language does. Every configuration is a touch phone: Chromium then
 * matches `(pointer: coarse)`, which the 16px-field rule and the 44px hit
 * areas key on.
 */
import type { BrowserContextOptions } from '@playwright/test';

export interface PhoneConfig {
    /** `390-dark-bg` — width, theme, locale. */
    id: string;
    width: number;
    height: number;
    theme: 'dark' | 'light';
    locale: 'bg' | 'en';
}

export const PHONE_CONFIGS = {
    /** iPhone 14, the device the owner reported on. */
    '390-dark-bg': { id: '390-dark-bg', width: 390, height: 844, theme: 'dark', locale: 'bg' },
    '390-light-en': { id: '390-light-en', width: 390, height: 844, theme: 'light', locale: 'en' },
    /** A small Android phone. */
    '360-dark-bg': { id: '360-dark-bg', width: 360, height: 780, theme: 'dark', locale: 'bg' },
    /** The second configuration of the E2E project: the other width AND the other theme, still Bulgarian. */
    '360-light-bg': { id: '360-light-bg', width: 360, height: 780, theme: 'light', locale: 'bg' },
} as const satisfies Record<string, PhoneConfig>;

export type PhoneConfigId = keyof typeof PHONE_CONFIGS;

/** The audit's three configurations (the roadmap's headline table). */
export const AUDIT_CONFIG_IDS: readonly PhoneConfigId[] = ['390-dark-bg', '390-light-en', '360-dark-bg'];

/** Context options for a configuration. `deviceScaleFactor` 1 keeps screenshots small; layout does not depend on it. */
export function contextOptionsFor(config: PhoneConfig, deviceScaleFactor = 1): BrowserContextOptions {
    return {
        viewport: { width: config.width, height: config.height },
        screen: { width: config.width, height: config.height },
        deviceScaleFactor,
        isMobile: true,
        hasTouch: true,
        locale: config.locale === 'bg' ? 'bg-BG' : 'en-GB',
        colorScheme: config.theme,
        ignoreHTTPSErrors: true,
    };
}

/**
 * The theme and locale cookies the app reads on the server (`inflect_theme`,
 * `inflect_locale`), so the first paint is already in the configuration.
 */
export function preferenceCookies(config: PhoneConfig, baseUrl: string) {
    const url = new URL(baseUrl);
    return [
        { name: 'inflect_theme', value: config.theme, domain: url.hostname, path: '/' },
        { name: 'inflect_locale', value: config.locale, domain: url.hostname, path: '/' },
    ];
}
