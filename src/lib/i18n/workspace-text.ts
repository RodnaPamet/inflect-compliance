import { createTranslator } from 'next-intl';

import type { PrismaTx } from '@/lib/db-context';
import { resolveLocale, type Locale } from '@/lib/locale-constants';

/**
 * Text the PRODUCT writes into a workspace's records on the workspace's
 * behalf, in the workspace's default language (owner decision 2026-11-24).
 *
 * A record such as a task is EDITABLE: a person may rename it, so it cannot be
 * re-worded on read the way a stock notification is (#5929). Its language is
 * therefore chosen once, when the server writes it, and the choice is the
 * workspace's (`Tenant.defaultLocale`), never the requester's browser cookie:
 * the person who dispatches an assessment is not the person who reads the task.
 *
 * Server-only. Each catalogue is loaded on demand, so a module that writes
 * records does not carry both catalogues in its import graph. The loaders are a
 * `Record<Locale, …>`, so adding a locale to `SUPPORTED_LOCALES` without a
 * catalogue here fails `tsc`.
 */

type Messages = Record<string, unknown>;

const CATALOGUES: Record<Locale, () => Promise<Messages>> = {
    en: async () => (await import('../../../messages/en.json')).default as Messages,
    bg: async () => (await import('../../../messages/bg.json')).default as Messages,
};

/** A translator over one catalogue namespace, in a given language. */
export interface WorkspaceTranslator {
    (key: string, values?: Record<string, string | number>): string;
}

/**
 * A translator for `namespace` in `locale`. An unsupported or missing value
 * reads as the default locale, as the request config does for a cookie.
 */
export async function workspaceTranslator(locale: unknown, namespace: string): Promise<WorkspaceTranslator> {
    const resolved = resolveLocale(locale);
    const messages = await CATALOGUES[resolved]();
    // The catalogue is untyped JSON here (no next-intl `AppConfig` augmentation
    // in this repo), so the translator's key type is widened to `string`; a
    // missing key is caught by the tests that read the produced text.
    const t = createTranslator({ locale: resolved, messages, namespace }) as unknown as WorkspaceTranslator;
    return (key, values) => t(key, values);
}

/** The workspace's default language, read from its row. Absent reads as the default. */
export async function readWorkspaceLocale(db: PrismaTx, tenantId: string): Promise<Locale> {
    const row = await db.tenant.findUnique({ where: { id: tenantId }, select: { defaultLocale: true } });
    return resolveLocale(row?.defaultLocale);
}
