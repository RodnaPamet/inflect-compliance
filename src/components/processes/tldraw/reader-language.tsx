'use client';

/**
 * Every tldraw canvas speaks the reader's language (#5924).
 *
 * tldraw picks its interface language from its own user preferences, which
 * default to the BROWSER's language, not the product's: a Bulgarian reader on
 * an English-language browser saw "Menu" and the whole editor menu in English
 * on every canvas. `<TldrawReaderLanguage />`, rendered inside a `<Tldraw>`,
 * sets tldraw's locale to the product's (next-intl's `useLocale`), and
 * `TLDRAW_TRANSLATIONS`, passed as `overrides.translations`, supplies the
 * Bulgarian tldraw does not ship (`translation-bg.ts`). A language tldraw
 * ships (English, and any other the product adds) needs no override.
 *
 * tldraw keeps the preference in its own local storage, so a reader who picks
 * another language in tldraw's own Language menu keeps it until the next
 * canvas opens, which sets it back to the product's language.
 */
import { useEffect } from 'react';
import { useLocale } from 'next-intl';
import { useEditor, type TLUiOverrides } from 'tldraw';

import { TLDRAW_BG } from './translation-bg';

/** tldraw's locale code for the product's locale ("bg", "en"; a region is dropped). */
export function tldrawLocaleFor(appLocale: string): string {
    return appLocale.toLowerCase().split('-')[0];
}

/** Extra messages per tldraw locale, for `overrides.translations`. Module scope: a stable reference. */
export const TLDRAW_TRANSLATIONS: NonNullable<TLUiOverrides['translations']> = { bg: TLDRAW_BG };

/** Overrides for a canvas that needs nothing else from them. */
export const TLDRAW_READER_OVERRIDES: TLUiOverrides = { translations: TLDRAW_TRANSLATIONS };

export function TldrawReaderLanguage(): null {
    const editor = useEditor();
    const locale = tldrawLocaleFor(useLocale());
    useEffect(() => {
        if (editor.user.getLocale() !== locale) editor.user.updateUserPreferences({ locale });
    }, [editor, locale]);
    return null;
}
