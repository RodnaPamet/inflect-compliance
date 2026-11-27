'use client';

import { useTranslations } from 'next-intl';
import { isControlCategoryTheme } from '@/lib/controls/control-categories';
import { iso27001DomainKey } from '@/lib/controls/control-taxonomy';
import { useContentText } from '@/lib/content-i18n/use-content-text';

/**
 * A SoA requirement's group, in the reader's language.
 *
 * `SoAEntryDTO.section` is the framework's own section, or else the
 * requirement's category — for ISO 27001 an ISO 27002 theme constant
 * (`ORGANIZATIONAL`) or a taxonomy domain (`Access control`). Both are stored
 * as keys and were shown raw, on screen and on the printed statement. They get
 * the catalogue's labels (`controls.categoryLabels.*`,
 * `controls.isoDomainLabels.*`); any other value is the framework's own text and
 * goes through the catalogue content lookup (#5996). Only the LABEL changes:
 * grouping still keys on the stored value.
 */
export function useSoASectionLabel(): (section: string) => string {
    const tc = useTranslations('controls');
    const content = useContentText();
    return (section) => {
        if (isControlCategoryTheme(section)) return tc(`categoryLabels.${section}`);
        const isoKey = iso27001DomainKey(section);
        return isoKey ? tc(`isoDomainLabels.${isoKey}`) : content(section);
    };
}
