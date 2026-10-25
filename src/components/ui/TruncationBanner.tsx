'use client';

/**
 * `<TruncationBanner>` — PR-5 list-page banner.
 *
 * Shown above the list table when the SWR backfill hit the
 * `LIST_BACKFILL_CAP` (5000 rows). The intent is to make the
 * truncation explicit instead of silently showing the user a partial
 * list — they need to know that filters / search are required to see
 * the rest of their data.
 *
 * Renders nothing when the cap didn't fire. Callers use the standard
 * SWR result pattern:
 *
 *   const data = useTenantSWR<CappedList<...>>(...);
 *   <TruncationBanner truncated={data?.truncated ?? false} />
 *
 * Visual: subtle warning surface with an icon, the cap value, and a
 * one-line nudge to refine filters. Token-driven so the dark/light
 * theme switch lands automatically.
 */

import { useTranslations } from 'next-intl';
import { AlertTriangle } from 'lucide-react';
import { LIST_BACKFILL_CAP } from '@/lib/list-backfill-cap';

interface Props {
    truncated: boolean;
    /** Override the displayed cap value if a list uses a different limit. */
    cap?: number;
}

export function TruncationBanner({ truncated, cap = LIST_BACKFILL_CAP }: Props) {
    const t = useTranslations('common.ui');
    if (!truncated) return null;
    return (
        <div
            role="status"
            aria-live="polite"
            data-testid="list-truncation-banner"
            className="mb-3 flex items-start gap-compact rounded-md border border-border-warning bg-bg-warning px-3 py-2 text-sm text-content-warning"
        >
            <AlertTriangle size={16} className="mt-0.5 shrink-0 text-content-warning" aria-hidden="true" />
            <div>
                <span className="font-medium">
                    {t('truncationTitle', { count: cap.toLocaleString() })}
                </span>{' '}
                <span className="text-content-muted">{t('truncationHint')}</span>
            </div>
        </div>
    );
}
