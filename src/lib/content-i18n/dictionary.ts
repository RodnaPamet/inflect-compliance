/**
 * Catalogue content in the reader's language (#5996, owner decisions
 * 2026-11-27).
 *
 * Framework requirements, control templates, their tasks and steps, risk
 * templates and the rows a workspace installed from them are stored in
 * English. They are shown in the VIEWER's language by looking the stored text
 * up in a dictionary keyed by the exact English source text. A text a person
 * edited no longer equals a catalogue string, finds nothing, and is shown as
 * written. So there is no schema change, no backfill, and no way for a
 * translation to overwrite somebody's edit.
 *
 * Server-only: the dictionaries are large. The client asks through
 * `POST /api/t/:slug/content-translations`.
 */
import { bgDictionaries } from '@/data/content-i18n/bg';
import { DEFAULT_LOCALE, type Locale } from '@/lib/locale-constants';
import { CONTENT_TRANSLATION_MAX_CHARS, contentKey } from './limits';

let bgIndex: Map<string, string> | null = null;

function bulgarian(): Map<string, string> {
    if (bgIndex) return bgIndex;
    const index = new Map<string, string>();
    for (const dictionary of Object.values(bgDictionaries())) {
        for (const [source, target] of Object.entries(dictionary)) {
            const key = contentKey(source);
            // An empty target is "not translated yet", never a translation.
            if (key && target.trim() && !index.has(key)) index.set(key, target);
        }
    }
    bgIndex = index;
    return index;
}

/** The text in `locale`, or `null` when the catalogue holds no translation of it. */
export function translateContentText(locale: Locale, text: string): string | null {
    if (locale === DEFAULT_LOCALE) return null;
    if (text.length > CONTENT_TRANSLATION_MAX_CHARS) return null;
    return bulgarian().get(contentKey(text)) ?? null;
}

/** `text` in `locale` where the catalogue translates it, otherwise `text` as stored. */
export function localizeContentText(locale: Locale, text: string): string;
export function localizeContentText(locale: Locale, text: string | null | undefined): string | null | undefined;
export function localizeContentText(locale: Locale, text: string | null | undefined): string | null | undefined {
    if (text === null || text === undefined) return text;
    return translateContentText(locale, text) ?? text;
}

/** The translations of `texts` that exist, keyed by the text as it was asked. */
export function translateContentTexts(locale: Locale, texts: readonly string[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const text of texts) {
        const translated = translateContentText(locale, text);
        if (translated !== null) out[text] = translated;
    }
    return out;
}
