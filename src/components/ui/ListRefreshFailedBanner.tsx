'use client';

/**
 * `<ListRefreshFailedBanner>` — shown above a list when its latest fetch failed
 * but older rows are still on screen.
 *
 * List pages fetch through `useTenantSWR`, which keeps the previous key's data
 * while a new key loads. When that load fails, the table goes on showing the
 * rows from before the filter change, with nothing to say they are stale. A
 * page that also shows an error when there is NO data still needs this for
 * the case where there is.
 *
 * Renders nothing unless `show` is true.
 */

import { useTranslations } from 'next-intl';
import { TriangleWarning } from '@inflect/ui/components/ui/icons/nucleo';

interface Props {
    show: boolean;
    /** Fetch the list again. Omit to show the message without a button. */
    onRetry?: () => void;
}

export function ListRefreshFailedBanner({ show, onRetry }: Props) {
    const t = useTranslations('common');
    if (!show) return null;
    return (
        <div
            role="status"
            aria-live="polite"
            data-testid="list-refresh-failed-banner"
            className="mb-3 flex items-start gap-compact rounded-md border border-border-warning bg-bg-warning px-3 py-2 text-sm text-content-warning"
        >
            <TriangleWarning className="mt-0.5 size-4 shrink-0 text-content-warning" aria-hidden="true" />
            <span className="flex-1">{t('ui.listRefreshFailed')}</span>
            {onRetry ? (
                <button type="button" onClick={onRetry} className="font-medium underline underline-offset-2">
                    {t('retry')}
                </button>
            ) : null}
        </div>
    );
}
