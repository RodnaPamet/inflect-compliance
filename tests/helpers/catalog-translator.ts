/**
 * A plain root-level translator over a real message catalog, for tests that
 * need the copy a component would render without mounting next-intl.
 *
 * Throws on a key the catalog does not hold, so a test cannot pass by reading
 * `undefined`. ICU placeholders are filled naively (`{name}` → value); a test
 * that needs plural or select formatting should render through
 * `NextIntlClientProvider` instead.
 */
import enMessages from '../../messages/en.json';
import bgMessages from '../../messages/bg.json';

type Tree = { [key: string]: string | Tree };

const CATALOGS: Record<'en' | 'bg', Tree> = {
    en: enMessages as Tree,
    bg: bgMessages as Tree,
};

export function catalogValue(locale: 'en' | 'bg', key: string): string {
    let node: string | Tree | undefined = CATALOGS[locale];
    for (const part of key.split('.')) {
        node = typeof node === 'object' ? node[part] : undefined;
    }
    if (typeof node !== 'string') throw new Error(`messages/${locale}.json has no string at ${key}`);
    return node;
}

export function catalogTranslator(locale: 'en' | 'bg') {
    return (key: string, values: Record<string, string | number> = {}): string =>
        catalogValue(locale, key).replace(/\{(\w+)\}/g, (whole, name: string) =>
            name in values ? String(values[name]) : whole,
        );
}
