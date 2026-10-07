import { getTranslations } from 'next-intl/server';
import { Skeleton } from '@/components/ui/skeleton';
import { cardVariants } from '@/components/ui/card-variants';
import { cn } from '@inflect/ui/lib/cn';

/**
 * Coverage dashboard loading skeleton.
 */
export default async function CoverageLoading() {
    const t = await getTranslations('coverage');
    return (
        <div className="space-y-section animate-fadeIn" aria-busy="true" aria-label={t('loadingAria')}>
            {/* Header */}
            <div className="space-y-tight">
                <Skeleton className="h-7 w-64" />
                <Skeleton className="h-4 w-96" />
            </div>

            {/* KPI cards */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-default">
                {Array.from({ length: 3 }).map((_, i) => (
                    <div key={i} className={cn(cardVariants(), 'space-y-compact')}>
                        <Skeleton className="h-4 w-24" />
                        <Skeleton className="h-24 w-24 rounded-full mx-auto" />
                        <Skeleton className="h-3 w-32 mx-auto" />
                    </div>
                ))}
            </div>

            {/* Tables */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-default">
                {Array.from({ length: 2 }).map((_, i) => (
                    <div key={i} className={cn(cardVariants(), 'space-y-compact')}>
                        <Skeleton className="h-5 w-48" />
                        {Array.from({ length: 4 }).map((_, j) => (
                            <Skeleton key={j} className="h-10 w-full" />
                        ))}
                    </div>
                ))}
            </div>
        </div>
    );
}
