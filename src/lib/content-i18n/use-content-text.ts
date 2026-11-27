'use client';

/**
 * `useContentText()` — catalogue content in the reader's language, for client
 * components (#5996).
 *
 *     const tc = useContentText();
 *     <span>{tc(control.name)}</span>
 *
 * `tc(text)` returns the stored text at once and the reader's-language text
 * once the lookup has answered. In English it returns the text and asks
 * nothing. A text the catalogue does not translate (anything a person wrote
 * or edited) stays as stored.
 *
 * Use it for DISPLAY only. An edit field shows the stored text: that is the
 * record, and saving a translation would turn it into an edit.
 *
 * The cache is module state, one per page load: every component shares it, a
 * text is asked for once, and texts first seen in the same tick go in one
 * request. Kept off the tenant context provider on purpose, so its code ships
 * only with the pages that use it.
 */
import { useMemo, useSyncExternalStore } from 'react';
import * as nextIntl from 'next-intl';
import { DEFAULT_LOCALE } from '@/lib/locale-constants';
import { CONTENT_TRANSLATION_BATCH, CONTENT_TRANSLATION_MAX_CHARS } from './limits';

/** text → translation, or `null` when the catalogue has none. Keyed `<locale>\n<text>`. */
const cache = new Map<string, string | null>();
const queued = new Map<string, Set<string>>();
const listeners = new Set<() => void>();
let version = 0;
let scheduled = false;

function emit(): void {
    version += 1;
    for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

const cacheKey = (locale: string, text: string): string => `${locale}\n${text}`;

/**
 * The reader's locale. `useLocale` wherever next-intl provides it, which is
 * everywhere the product runs; English where a test's partial mock of
 * next-intl leaves it out, so a component can adopt `tc` without every suite
 * that renders it having to know.
 */
const useReaderLocale: () => string =
    typeof nextIntl.useLocale === 'function' ? nextIntl.useLocale : () => DEFAULT_LOCALE;

/**
 * The workspace in the address bar (`/t/<slug>/…`), read when a lookup is
 * asked for. The lookup route is the workspace's, so a page outside a
 * workspace asks nothing and shows the text as stored.
 */
function workspaceSlug(): string | null {
    if (typeof window === 'undefined') return null;
    const match = /^\/t\/([^/]+)/.exec(window.location.pathname);
    return match ? decodeURIComponent(match[1]) : null;
}

async function flush(): Promise<void> {
    scheduled = false;
    const tenantSlug = workspaceSlug();
    const work = [...queued.entries()];
    queued.clear();
    if (!tenantSlug) return; // left unanswered: asked again on a later render
    for (const [locale, texts] of work) {
        const all = [...texts];
        for (let i = 0; i < all.length; i += CONTENT_TRANSLATION_BATCH) {
            const batch = all.slice(i, i + CONTENT_TRANSLATION_BATCH);
            let translations: Record<string, string> = {};
            try {
                const res = await fetch(`/api/t/${encodeURIComponent(tenantSlug)}/content-translations`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ locale, texts: batch }),
                });
                if (res.ok) translations = ((await res.json()) as { translations?: Record<string, string> }).translations ?? {};
                else continue; // left unanswered: asked again on a later render
            } catch {
                continue;
            }
            for (const text of batch) cache.set(cacheKey(locale, text), translations[text] ?? null);
            emit();
        }
    }
}

function request(locale: string, text: string): void {
    const set = queued.get(locale) ?? new Set<string>();
    set.add(text);
    queued.set(locale, set);
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => void flush(), 0);
}

export type ContentText = {
    (text: string): string;
    (text: string | null | undefined): string | null | undefined;
};

export function useContentText(): ContentText {
    const locale = useReaderLocale();
    // Re-render when an answer arrives, and hand out a new `tc` then, so a
    // memo keyed on it (table columns) recomputes.
    const answered = useSyncExternalStore(subscribe, () => version, () => 0);

    return useMemo(() => {
        // `answered` is the cache's version: reading it here makes the memo
        // (and so `tc`'s identity) follow each answer.
        void answered;
        const tc = (text: string | null | undefined): string | null | undefined => {
            if (text === null || text === undefined || text === '') return text;
            if (locale === DEFAULT_LOCALE) return text;
            if (text.length > CONTENT_TRANSLATION_MAX_CHARS) return text;
            const key = cacheKey(locale, text);
            if (cache.has(key)) return cache.get(key) ?? text;
            if (workspaceSlug() === null) return text;
            request(locale, text);
            return text;
        };
        return tc as ContentText;
    }, [locale, answered]);
}

/** Test seam: empty the cache between tests. */
export function _resetContentTextCache(): void {
    cache.clear();
    queued.clear();
    scheduled = false;
}
