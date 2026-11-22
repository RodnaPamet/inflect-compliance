import { Skeleton } from '@/components/ui/skeleton';
import { getTranslations } from 'next-intl/server';

/**
 * Clauses loading skeleton — shown via Next.js Suspense while
 * the server component fetches clause data. Uses the shared
 * `<Skeleton>` primitive so the shimmer-sweep (R11-PR2) applies
 * uniformly with every other loading surface.
 */
export default async function ClausesLoading() {
    const t = await getTranslations('clauses');
    return (
        <div
            role="status"
            aria-live="polite"
            aria-busy="true"
            aria-label={t('loadingAria')}
            className="space-y-section p-6 animate-fadeIn"
        >
            {/* Page title */}
            <Skeleton className="h-8 w-1/4" />

            {/* Split pane: list + detail */}
            <div className="flex gap-default">
                {/* Clause list */}
                <div className="w-1/3 space-y-tight">
                    {[...Array(8)].map((_, i) => (
                        // eslint-disable-next-line local/shaded-list-rows -- a loading skeleton, not a card's rows
                        <div
                            key={i}
                            className="rounded border border-border-default p-3 space-y-tight"
                        >
                            <Skeleton className="h-4 w-3/4" />
                            <Skeleton className="h-3 w-1/2" />
                        </div>
                    ))}
                </div>

                {/* Detail panel */}
                <div className="w-2/3 rounded-lg border border-border-default p-5 space-y-default">
                    <Skeleton className="h-6 w-1/2" />
                    <Skeleton className="h-4 w-full" />
                    <Skeleton className="h-4 w-3/4" />
                    <Skeleton className="h-10 w-40" />
                </div>
            </div>
        </div>
    );
}
