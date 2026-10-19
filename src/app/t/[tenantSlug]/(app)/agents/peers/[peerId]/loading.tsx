import { getTranslations } from 'next-intl/server';
import { SkeletonDetailTabs } from '@/components/ui/skeleton';

/**
 * A2A peer detail loading skeleton — header + meta strip + tab bar (#3679).
 *
 * Required by `tests/guards/detail-route-loading-coverage`: without it the
 * route falls back to the peers LIST's skeleton, and a table flashing where a
 * detail page is about to render reads as the wrong page loading. Four tabs,
 * the number the page renders, so the bar does not grow on hydration.
 */
export default async function PeerDetailLoading() {
    const t = await getTranslations('agents');
    return (
        <div
            role="status"
            aria-live="polite"
            aria-busy="true"
            aria-label={t('peers.detail.loadingAria')}
            className="space-y-section animate-fadeIn"
        >
            <SkeletonDetailTabs tabCount={4} />
        </div>
    );
}
