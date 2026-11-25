'use client';

/**
 * The calendar header's "Sync to my calendar" action (#5937 step 4).
 *
 * A secondary action, so it is an `OverflowAction`: on a phone it is an item
 * of the header's "⋯" menu, beside the view switch that stays visible; from
 * `md` up it is a button. Either opens the panel.
 *
 * The panel is loaded on first open (`next/dynamic`), so the calendar's First
 * Load JS carries this button and nothing behind it. Once opened it stays
 * mounted, so closing plays the modal's exit and a reopen refetches nothing it
 * does not need to.
 */
import * as React from 'react';
import dynamic from 'next/dynamic';
import { useTranslations } from 'next-intl';
import { CalendarSync } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { OverflowAction } from '@/components/layout/PageActions';

const CalendarConnectPanel = dynamic(
    () => import('./CalendarConnectPanel').then((m) => m.CalendarConnectPanel),
    { ssr: false },
);

export function CalendarConnectAction() {
    const t = useTranslations('calendarConnect');
    const [open, setOpen] = React.useState(false);
    const [mounted, setMounted] = React.useState(false);
    const openPanel = React.useCallback(() => {
        setMounted(true);
        setOpen(true);
    }, []);

    return (
        <>
            <OverflowAction label={t('open')} icon={CalendarSync} onSelect={openPanel}>
                <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    icon={<CalendarSync aria-hidden="true" />}
                    onClick={openPanel}
                    id="calendar-connect-open"
                >
                    {t('open')}
                </Button>
            </OverflowAction>
            {mounted && <CalendarConnectPanel open={open} setOpen={setOpen} />}
        </>
    );
}
