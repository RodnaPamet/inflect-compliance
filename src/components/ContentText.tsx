'use client';

import { useContentText } from '@/lib/content-i18n/use-content-text';

/**
 * Catalogue content in the reader's language, as an element (#5996): the
 * stored text where a person wrote or edited it, the catalogue's translation
 * where it is still the catalogue's own. For a table cell or any place a hook
 * is awkward; display only, never an edit field's value.
 */
export function ContentText({ text }: { text: string | null | undefined }) {
    const tc = useContentText();
    return <>{tc(text)}</>;
}
