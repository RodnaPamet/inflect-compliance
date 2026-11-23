import { getLocale } from 'next-intl/server';

import { dateFormattersFor, type DateFormatters } from '@inflect/ui/lib/format-date';

/**
 * The date helpers in the reader's language, for SERVER components.
 *
 * A server component renders outside the client tree where `<Providers>` binds
 * the active date locale, so it asks next-intl for the request's locale and
 * uses the explicitly bound helpers:
 *
 *     const { formatDateTime } = await getDateFormatters();
 */
export async function getDateFormatters(): Promise<DateFormatters> {
    return dateFormattersFor(await getLocale());
}
