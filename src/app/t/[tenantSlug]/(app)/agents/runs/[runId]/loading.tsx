import { getTranslations } from 'next-intl/server';
import { SkeletonCard } from '@/components/ui/skeleton';

/**
 * Run-detail loading skeleton.
 *
 * Required by `tests/guards/detail-route-loading-coverage`: without a sibling
 * `loading.tsx` the route falls back to the nearest ancestor's, which here is
 * the run LIST — a list skeleton flashing where a detail page is about to
 * render reads as the wrong page loading.
 *
 * Cards rather than `SkeletonDetailTabs`, because this page has no tab bar: a
 * skeleton is a promise about the shape that is about to arrive, and promising
 * tabs that never appear is the layout shift it exists to prevent.
 */
export default async function AgentRunDetailLoading() {
    const t = await getTranslations('agents');
    return (
        <div
            role="status"
            aria-live="polite"
            aria-busy="true"
            aria-label={t('runs.detail.loadingAria')}
            className="space-y-section animate-fadeIn"
        >
            <SkeletonCard />
            <SkeletonCard />
        </div>
    );
}
