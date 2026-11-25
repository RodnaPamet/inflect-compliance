'use client';

/**
 * The result of a calendar connect, said once (#5937 step 4).
 *
 * The callback ends every connect on `/t/<slug>/calendar?calendar=<outcome>`,
 * with `<outcome>` from the server's closed set (`CALENDAR_CONNECT_OUTCOMES`).
 * This reads it, words it, and takes it OUT of the address:
 *
 *   - the message is kept in state, so removing the parameter does not remove
 *     the message, and a reload (or a shared link) does not say it again;
 *   - the removal is a `replace` to the same page, which never brings the
 *     parameter back, so there is no loop to break;
 *   - a value outside the set is removed and says nothing — the address is
 *     not a channel for arbitrary text, and the callback never reflects the
 *     provider's own words.
 */
import * as React from 'react';
import { useTranslations } from 'next-intl';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { InlineNotice } from '@/components/ui/inline-notice';
import { OUTCOME_COPY, OUTCOME_PARAM, isConnectOutcome, type WordedConnectOutcome } from './connect-copy';

export function CalendarConnectOutcome() {
    const t = useTranslations('calendarConnect');
    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();
    const raw = searchParams.get(OUTCOME_PARAM);

    // Captured while rendering (React's "adjust state on a prop change"), so
    // the message is on screen in the same render that first sees it.
    const [seen, setSeen] = React.useState<string | null>(null);
    const [outcome, setOutcome] = React.useState<WordedConnectOutcome | null>(null);
    if (raw !== null && raw !== seen) {
        setSeen(raw);
        setOutcome(isConnectOutcome(raw) ? raw : null);
    }

    React.useEffect(() => {
        if (raw === null) return;
        const params = new URLSearchParams(searchParams.toString());
        params.delete(OUTCOME_PARAM);
        const qs = params.toString();
        router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    }, [raw, searchParams, router, pathname]);

    if (!outcome) return null;
    const copy = OUTCOME_COPY[outcome];
    return (
        <InlineNotice
            variant={copy.tone}
            id="calendar-connect-outcome"
            onDismiss={() => setOutcome(null)}
        >
            {t(copy.key)}
        </InlineNotice>
    );
}
